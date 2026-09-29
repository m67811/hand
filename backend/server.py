"""
SignBridge — FastAPI WebSocket Server
Handles real-time gesture detection via WebSocket frames.
Endpoints:
  WS  /ws/gesture        — receive base64 frames, return gesture results
  WS  /ws/avatar         — receive text, return avatar animation sequence
  GET /health            — health check
  POST /tts              — generate TTS audio
  POST /translate        — translate text to avatar sequence
"""

import asyncio
import base64
import json
import os
import time
import traceback
from typing import Optional

import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

# ── Internal modules ──────────────────────────────────────────────────────────
import sys
sys.path.insert(0, os.path.dirname(__file__))

from gesture_engine import GestureEngine
from tts_engine import (
    text_to_speech, text_to_avatar_sequence, detect_language, speak_async
)

# ──────────────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="SignBridge API",
    description="Real-time Sign Language Translation Platform",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve frontend
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), '..', 'frontend')
if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

# ── Globals ───────────────────────────────────────────────────────────────────
gesture_engine: Optional[GestureEngine] = None
active_connections: list[WebSocket] = []


@app.on_event("startup")
async def startup_event():
    global gesture_engine
    model_path = os.path.join(os.path.dirname(__file__), '..', 'models', 'gesture_model.pkl')
    gesture_engine = GestureEngine(model_path=model_path if os.path.exists(model_path) else None)
    print("[OK] SignBridge server started!")
    print(f"   Model: {'LOADED' if gesture_engine.static_model else 'Rule-based fallback'}")


@app.on_event("shutdown")
async def shutdown_event():
    if gesture_engine:
        gesture_engine.release()


# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": "loaded" if (gesture_engine and gesture_engine.static_model) else "rule-based",
        "timestamp": time.time()
    }


@app.get("/")
async def root():
    index_path = os.path.join(FRONTEND_DIR, 'index.html')
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return {"message": "SignBridge API is running", "docs": "/docs"}


# ── Pydantic models ───────────────────────────────────────────────────────────
class TTSRequest(BaseModel):
    text: str
    lang: Optional[str] = None


class TranslateRequest(BaseModel):
    text: str
    lang: Optional[str] = None


# ── REST endpoints ────────────────────────────────────────────────────────────
@app.post("/tts")
async def generate_tts(req: TTSRequest):
    """Generate TTS audio and return path."""
    path = text_to_speech(req.text, req.lang)
    if not path:
        raise HTTPException(status_code=500, detail="TTS generation failed")

    # Read and return as base64
    with open(path, 'rb') as f:
        audio_b64 = base64.b64encode(f.read()).decode()

    return JSONResponse({
        "audio_base64": audio_b64,
        "format": "mp3",
        "text": req.text,
        "lang": req.lang or detect_language(req.text)
    })


@app.post("/translate")
async def translate_to_avatar(req: TranslateRequest):
    """Convert text to avatar animation sequence."""
    sequence = text_to_avatar_sequence(req.text)
    return JSONResponse({
        "text": req.text,
        "sequence": sequence,
        "total_duration": sum(s['duration'] for s in sequence)
    })


@app.post("/clear-word")
async def clear_word():
    """Clear the accumulated word buffer."""
    if gesture_engine:
        gesture_engine.clear_word()
    return {"status": "cleared"}


# ── WebSocket: Gesture Detection ──────────────────────────────────────────────
@app.websocket("/ws/gesture")
async def gesture_websocket(websocket: WebSocket):
    """
    WebSocket endpoint for real-time gesture detection.
    Client sends: JSON { "frame": "<base64 JPEG>" }
    Server returns: JSON {
        gesture, confidence, type, translation, word, landmarks_detected
    }
    """
    await websocket.accept()
    active_connections.append(websocket)
    print(f"[WS] New gesture connection. Total: {len(active_connections)}")

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)

            if msg.get("type") == "clear":
                if gesture_engine:
                    gesture_engine.clear_word()
                await websocket.send_text(json.dumps({"type": "cleared"}))
                continue

            if msg.get("type") == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
                continue

            frame_b64 = msg.get("frame")
            if not frame_b64:
                continue

            # Decode frame
            try:
                img_bytes = base64.b64decode(frame_b64)
                nparr = np.frombuffer(img_bytes, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if frame is None:
                    continue
            except Exception as e:
                print(f"[WS] Frame decode error: {e}")
                continue

            # Process frame
            try:
                result = gesture_engine.process_frame(frame)

                # Encode annotated frame back
                _, buf = cv2.imencode('.jpg', result['annotated_frame'],
                                      [cv2.IMWRITE_JPEG_QUALITY, 75])
                annotated_b64 = base64.b64encode(buf).decode()

                response = {
                    "gesture": result['gesture'],
                    "confidence": round(result['confidence'], 3),
                    "type": result['type'],
                    "translation": result['translation'],
                    "word": result['word'],
                    "landmarks": result['landmarks_detected'],
                    "annotated_frame": annotated_b64,
                    "timestamp": time.time()
                }
                await websocket.send_text(json.dumps(response))

            except Exception as e:
                print(f"[WS] Processing error: {e}")
                traceback.print_exc()

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS] Connection error: {e}")
    finally:
        active_connections.remove(websocket)
        print(f"[WS] Connection closed. Remaining: {len(active_connections)}")


# ── WebSocket: Avatar (Text → Sign) ──────────────────────────────────────────
@app.websocket("/ws/avatar")
async def avatar_websocket(websocket: WebSocket):
    """
    WebSocket for text-to-sign animation.
    Client sends: JSON { "text": "Hello world", "lang": "en" }
    Server returns animation sequence frames.
    """
    await websocket.accept()
    print("[WS] New avatar connection")

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)

            text = msg.get("text", "")
            lang = msg.get("lang")

            if not text:
                continue

            # Generate animation sequence
            sequence = text_to_avatar_sequence(text)

            # Send TTS audio
            audio_path = text_to_speech(text, lang)
            audio_b64 = ""
            if audio_path and os.path.exists(audio_path):
                with open(audio_path, 'rb') as f:
                    audio_b64 = base64.b64encode(f.read()).decode()

            response = {
                "type": "animation",
                "text": text,
                "sequence": sequence,
                "total_duration": sum(s['duration'] for s in sequence),
                "audio_base64": audio_b64,
                "timestamp": time.time()
            }
            await websocket.send_text(json.dumps(response))

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS Avatar] Error: {e}")
    finally:
        print("[WS] Avatar connection closed")


# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info"
    )
