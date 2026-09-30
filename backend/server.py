"""FastAPI application for SignBridge.

The server deliberately separates the interactive API from static frontend
assets. It can sit behind a reverse proxy, while the frontend can still be
opened directly at the root URL for a simple local install.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .config import FRONTEND_DIR, MODELS_DIR, settings
from .gesture_engine import GestureEngine
from .sign_language import translator
from .tts_engine import detect_language, text_to_avatar_plan, text_to_speech


logger = logging.getLogger(__name__)


class TextRequest(BaseModel):
    """Validated text input shared by the translation and TTS endpoints."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    text: str = Field(min_length=1, max_length=settings.max_text_length)
    lang: Literal["en", "ru", "uz"] | None = None

    @field_validator("text")
    @classmethod
    def reject_blank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Text must not be empty.")
        return value


class RequestThrottle:
    """Small per-connection throttle for CPU-intensive websocket messages."""

    def __init__(self, interval_seconds: float) -> None:
        self.interval_seconds = interval_seconds
        self._last_request = 0.0

    def allow(self) -> bool:
        now = time.monotonic()
        if now - self._last_request < self.interval_seconds:
            return False
        self._last_request = now
        return True


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create the shared gesture engine once and release it cleanly."""
    classifier_path = MODELS_DIR / "gesture_model.pkl"
    engine = GestureEngine(str(classifier_path) if classifier_path.exists() else None)

    app.state.gesture_engine = engine
    app.state.engine_lock = asyncio.Lock()
    app.state.gesture_connections: set[WebSocket] = set()
    app.state.avatar_connections: set[WebSocket] = set()

    logger.info(
        "SignBridge started in %s mode with recognition=%s",
        settings.environment,
        engine.recognition_mode,
    )
    try:
        yield
    finally:
        engine.release()
        logger.info("SignBridge stopped")


app = FastAPI(
    title=settings.app_name,
    description="Real-time gesture recognition and inspectable text-to-sign planning.",
    version=settings.app_version,
    lifespan=lifespan,
)

app.add_middleware(GZipMiddleware, minimum_size=1_000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    max_age=600,
)


@app.middleware("http")
async def add_security_headers(request, call_next):
    """Apply browser-safe defaults without blocking camera access for this origin."""
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
    return response


def _get_engine() -> GestureEngine:
    engine = getattr(app.state, "gesture_engine", None)
    if engine is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Recognition engine is starting.")
    return engine


def _origin_is_allowed(websocket: WebSocket) -> bool:
    """Optionally enforce the configured origins for browser websocket clients."""
    if not settings.enforce_websocket_origin:
        return True

    origin = websocket.headers.get("origin", "").rstrip("/")
    return "*" in settings.cors_origins or origin in settings.cors_origins


async def _accept_websocket(websocket: WebSocket) -> bool:
    if not _origin_is_allowed(websocket):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Origin is not allowed.")
        return False
    await websocket.accept()
    return True


async def _send_ws_error(websocket: WebSocket, code: str, message: str) -> None:
    await websocket.send_json({"type": "error", "code": code, "message": message})


def _decode_frame(encoded_frame: str) -> np.ndarray:
    """Decode a bounded base64 JPEG frame and reject oversized images early."""
    if len(encoded_frame) > settings.max_ws_message_bytes:
        raise ValueError("Frame message is too large.")

    try:
        image_bytes = base64.b64decode(encoded_frame, validate=True)
    except (ValueError, TypeError) as error:
        raise ValueError("Frame is not valid base64 JPEG data.") from error

    if len(image_bytes) > settings.max_frame_bytes:
        raise ValueError("Decoded frame is too large.")

    frame = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError("Frame could not be decoded as an image.")

    height, width = frame.shape[:2]
    if width > settings.max_frame_width or height > settings.max_frame_height:
        raise ValueError(
            f"Frame resolution must not exceed {settings.max_frame_width}x{settings.max_frame_height}."
        )
    return frame


def _encode_annotated_frame(frame: np.ndarray) -> str:
    success, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
    if not success:
        raise RuntimeError("Could not encode annotated frame.")
    return base64.b64encode(buffer).decode("ascii")


async def _build_tts_payload(text: str, language: str | None) -> str | None:
    """Generate temporary audio without blocking the event loop and clean it up."""
    audio_path_value = await asyncio.to_thread(text_to_speech, text, language)
    if not audio_path_value:
        return None

    audio_path = Path(audio_path_value)
    try:
        if not audio_path.exists() or audio_path.stat().st_size > settings.max_audio_bytes:
            return None
        audio_bytes = await asyncio.to_thread(audio_path.read_bytes)
        return base64.b64encode(audio_bytes).decode("ascii")
    finally:
        audio_path.unlink(missing_ok=True)


def _plan_response(text: str, language: str | None) -> dict[str, Any]:
    return {"text": text, **text_to_avatar_plan(text, language)}


@app.get("/health", tags=["system"])
@app.get("/api/v1/health", tags=["system"])
async def health() -> dict[str, Any]:
    engine = _get_engine()
    return {
        "status": "ok",
        "version": settings.app_version,
        "environment": settings.environment,
        "recognition_mode": engine.recognition_mode,
        "model_ready": engine.is_model_ready,
        "gesture_connections": len(app.state.gesture_connections),
        "avatar_connections": len(app.state.avatar_connections),
        "timestamp": time.time(),
    }


@app.get("/ready", tags=["system"])
@app.get("/api/v1/ready", tags=["system"])
async def readiness() -> dict[str, Any]:
    engine = _get_engine()
    return {"status": "ready", "recognition_mode": engine.recognition_mode}


@app.get("/vocabulary", tags=["translation"])
@app.get("/api/v1/vocabulary", tags=["translation"])
async def vocabulary() -> dict[str, Any]:
    return translator.vocabulary()


@app.post("/translate", tags=["translation"])
@app.post("/api/v1/translate", tags=["translation"])
async def translate_to_avatar(request: TextRequest) -> dict[str, Any]:
    return _plan_response(request.text, request.lang)


@app.post("/tts", tags=["translation"])
@app.post("/api/v1/tts", tags=["translation"])
async def generate_tts(request: TextRequest) -> dict[str, Any]:
    audio_base64 = await _build_tts_payload(request.text, request.lang)
    if not audio_base64:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Text-to-speech is currently unavailable.",
        )
    return {
        "audio_base64": audio_base64,
        "format": "mp3",
        "text": request.text,
        "lang": request.lang or detect_language(request.text),
    }


@app.post("/clear-word", tags=["recognition"])
@app.post("/api/v1/clear-word", tags=["recognition"])
async def clear_word() -> dict[str, str]:
    _get_engine().clear_word()
    return {"status": "cleared"}


@app.websocket("/ws/gesture")
async def gesture_websocket(websocket: WebSocket) -> None:
    """Receive bounded JPEG frames and return recognition results in real time."""
    if not await _accept_websocket(websocket):
        return

    app.state.gesture_connections.add(websocket)
    throttle = RequestThrottle(settings.gesture_frame_interval)
    logger.info("Gesture websocket connected. total=%s", len(app.state.gesture_connections))

    try:
        while True:
            raw_message = await websocket.receive_text()
            if len(raw_message.encode("utf-8")) > settings.max_ws_message_bytes:
                await websocket.close(code=status.WS_1009_MESSAGE_TOO_BIG, reason="Message is too large.")
                return

            try:
                message = json.loads(raw_message)
            except json.JSONDecodeError:
                await _send_ws_error(websocket, "invalid_json", "Message must be valid JSON.")
                continue

            if not isinstance(message, dict):
                await _send_ws_error(websocket, "invalid_message", "Message must be a JSON object.")
                continue

            message_type = message.get("type")
            if message_type == "clear":
                _get_engine().clear_word()
                await websocket.send_json({"type": "cleared"})
                continue
            if message_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            encoded_frame = message.get("frame")
            if not isinstance(encoded_frame, str):
                await _send_ws_error(websocket, "missing_frame", "A base64 JPEG frame is required.")
                continue
            if not throttle.allow():
                continue

            try:
                frame = _decode_frame(encoded_frame)
            except ValueError as error:
                await _send_ws_error(websocket, "invalid_frame", str(error))
                continue

            try:
                async with app.state.engine_lock:
                    result = await asyncio.to_thread(_get_engine().process_frame, frame)
                annotated_frame = await asyncio.to_thread(_encode_annotated_frame, result["annotated_frame"])
            except Exception:
                logger.exception("Gesture frame processing failed")
                await _send_ws_error(websocket, "processing_error", "Frame processing failed.")
                continue

            await websocket.send_json(
                {
                    "type": "gesture_result",
                    "gesture": result["gesture"],
                    "confidence": round(result["confidence"], 3),
                    "gesture_type": result["type"],
                    "translation": result["translation"],
                    "word": result["word"],
                    "landmarks": result["landmarks_detected"],
                    "annotated_frame": annotated_frame,
                    "timestamp": time.time(),
                }
            )
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Gesture websocket failed")
    finally:
        app.state.gesture_connections.discard(websocket)
        logger.info("Gesture websocket disconnected. total=%s", len(app.state.gesture_connections))


@app.websocket("/ws/avatar")
async def avatar_websocket(websocket: WebSocket) -> None:
    """Return an inspectable animation plan and optional TTS audio for text."""
    if not await _accept_websocket(websocket):
        return

    app.state.avatar_connections.add(websocket)
    throttle = RequestThrottle(settings.avatar_request_interval)
    logger.info("Avatar websocket connected. total=%s", len(app.state.avatar_connections))

    try:
        while True:
            raw_message = await websocket.receive_text()
            if len(raw_message.encode("utf-8")) > settings.max_ws_message_bytes:
                await websocket.close(code=status.WS_1009_MESSAGE_TOO_BIG, reason="Message is too large.")
                return

            try:
                payload = json.loads(raw_message)
                request = TextRequest.model_validate(payload)
            except (json.JSONDecodeError, ValueError) as error:
                await _send_ws_error(websocket, "invalid_request", str(error))
                continue

            if not throttle.allow():
                await _send_ws_error(websocket, "rate_limited", "Please wait before sending more text.")
                continue

            plan = _plan_response(request.text, request.lang)
            try:
                audio_base64 = await _build_tts_payload(request.text, request.lang)
            except Exception:
                logger.exception("Avatar TTS generation failed")
                audio_base64 = None

            await websocket.send_json(
                {
                    "type": "animation",
                    **plan,
                    "audio_base64": audio_base64 or "",
                    "timestamp": time.time(),
                }
            )
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Avatar websocket failed")
    finally:
        app.state.avatar_connections.discard(websocket)
        logger.info("Avatar websocket disconnected. total=%s", len(app.state.avatar_connections))


# This mount must be declared after API and websocket routes so the frontend can
# be served from the same origin without shadowing /docs or /api/v1 routes.
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
