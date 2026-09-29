"""
SignBridge — Text-to-Speech Engine
Converts text/gestures to speech output (multi-language support).
Also maps text to sign language avatar animations.
"""

import os
import io
import threading
import tempfile
from pathlib import Path

# TTS backends (tries in order)
TTS_BACKEND = None


def _init_tts():
    global TTS_BACKEND
    try:
        from gtts import gTTS
        TTS_BACKEND = 'gtts'
        print("[TTS] Using gTTS (online)")
        return
    except ImportError:
        pass

    try:
        import pyttsx3
        TTS_BACKEND = 'pyttsx3'
        print("[TTS] Using pyttsx3 (offline)")
        return
    except ImportError:
        pass

    print("[TTS] WARNING: No TTS backend available!")


_init_tts()

# Sign language avatar gesture mappings
# Maps words/phrases to animation sequences
AVATAR_ANIMATIONS = {
    # Common phrases
    "hello": ["wave"],
    "hi": ["wave"],
    "salom": ["wave"],
    "привет": ["wave"],
    "goodbye": ["wave", "open_palm"],
    "yes": ["thumbs_up", "point_up"],
    "no": ["fist", "shake_head"],
    "да": ["thumbs_up"],
    "нет": ["fist"],
    "ha": ["thumbs_up"],
    "yo'q": ["fist"],
    "good": ["thumbs_up"],
    "bad": ["thumbs_down"],
    "thank you": ["open_palm", "bow"],
    "please": ["open_palm"],
    "sorry": ["fist", "chest_tap"],
    "help": ["wave", "point"],
    "stop": ["open_palm"],
    "go": ["point"],
    "come": ["wave_inward"],
    "water": ["W", "A", "T", "E", "R"],
    "food": ["F", "O", "O", "D"],
    "school": ["S", "C", "H", "O", "O", "L"],
    "teacher": ["T", "E", "A", "C", "H", "E", "R"],
    "student": ["S", "T", "U", "D", "E", "N", "T"],
}

# Language detection mappings
LANGUAGE_MAP = {
    'ru': 'Russian',
    'uz': 'Uzbek',
    'en': 'English',
}


def detect_language(text: str) -> str:
    """Simple heuristic language detection."""
    # Cyrillic → Russian
    if any('\u0400' <= c <= '\u04FF' for c in text):
        return 'ru'
    # Common Uzbek words
    uz_markers = ["salom", "yaxshi", "rahmat", "ha", "yo'q", "o'", "g'"]
    if any(m in text.lower() for m in uz_markers):
        return 'uz'
    return 'en'


def text_to_speech(text: str, lang: str = None, output_path: str = None) -> str:
    """
    Convert text to speech audio file.
    Returns path to the generated .mp3 file.
    """
    if not text or not text.strip():
        return None

    if lang is None:
        lang = detect_language(text)

    # Map internal lang codes to gTTS codes
    gtts_lang_map = {
        'ru': 'ru',
        'uz': 'uz',
        'en': 'en',
    }
    gtts_lang = gtts_lang_map.get(lang, 'en')

    if output_path is None:
        output_path = os.path.join(tempfile.gettempdir(), 'signbridge_tts.mp3')

    if TTS_BACKEND == 'gtts':
        try:
            from gtts import gTTS
            tts = gTTS(text=text, lang=gtts_lang, slow=False)
            tts.save(output_path)
            return output_path
        except Exception as e:
            print(f"[TTS] gTTS error: {e}, trying pyttsx3...")
            return _pyttsx3_speak(text, output_path)

    elif TTS_BACKEND == 'pyttsx3':
        return _pyttsx3_speak(text, output_path)

    return None


def _pyttsx3_speak(text: str, output_path: str) -> str:
    """Fallback TTS using pyttsx3."""
    try:
        import pyttsx3
        engine = pyttsx3.init()
        engine.save_to_file(text, output_path)
        engine.runAndWait()
        return output_path
    except Exception as e:
        print(f"[TTS] pyttsx3 error: {e}")
        return None


def play_audio(filepath: str):
    """Play audio file in a background thread."""
    if not filepath or not os.path.exists(filepath):
        return

    def _play():
        try:
            import pygame
            pygame.mixer.init()
            pygame.mixer.music.load(filepath)
            pygame.mixer.music.play()
            while pygame.mixer.music.get_busy():
                import time
                time.sleep(0.1)
        except Exception:
            # Fallback: use system default player
            try:
                os.startfile(filepath)
            except Exception as e:
                print(f"[Audio] Playback error: {e}")

    t = threading.Thread(target=_play, daemon=True)
    t.start()


def text_to_avatar_sequence(text: str) -> list[dict]:
    """
    Convert text to a sequence of avatar animation commands.
    Returns list of {gesture: str, duration: float, label: str}
    """
    words = text.lower().strip().split()
    sequence = []

    for word in words:
        # Remove punctuation
        clean = word.strip('.,!?;:')

        if clean in AVATAR_ANIMATIONS:
            anims = AVATAR_ANIMATIONS[clean]
            for anim in anims:
                sequence.append({
                    'gesture': anim,
                    'duration': 0.8,
                    'label': clean,
                    'type': 'gesture' if len(anim) > 1 else 'letter'
                })
        else:
            # Fingerspell letter by letter
            for char in clean.upper():
                if char.isalpha():
                    sequence.append({
                        'gesture': char,
                        'duration': 0.5,
                        'label': char,
                        'type': 'letter'
                    })
                elif char == ' ':
                    sequence.append({
                        'gesture': 'PAUSE',
                        'duration': 0.3,
                        'label': ' ',
                        'type': 'pause'
                    })

        # Word pause
        sequence.append({
            'gesture': 'PAUSE',
            'duration': 0.4,
            'label': '|',
            'type': 'pause'
        })

    return sequence


def speak_async(text: str, lang: str = None):
    """Async TTS: generate and play audio in background."""
    def _worker():
        path = text_to_speech(text, lang)
        if path:
            play_audio(path)

    t = threading.Thread(target=_worker, daemon=True)
    t.start()


if __name__ == '__main__':
    # Test TTS
    test_texts = [
        ("Hello! This is SignBridge.", 'en'),
        ("Привет! Это СайнБридж.", 'ru'),
        ("Salom! Bu SignBridge platformasi.", 'uz'),
    ]

    for text, lang in test_texts:
        print(f"Generating TTS: [{lang}] {text}")
        path = text_to_speech(text, lang, f"test_{lang}.mp3")
        if path:
            print(f"  ✓ Saved to {path}")
        seq = text_to_avatar_sequence(text)
        print(f"  Avatar sequence: {[s['gesture'] for s in seq[:5]]}...")
