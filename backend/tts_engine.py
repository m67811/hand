"""
SignBridge - Text-to-Speech Engine
Converts text to speech output (multi-language support).
Also maps text to sign language avatar animations via the planner.
"""

from __future__ import annotations

import logging
import tempfile
import uuid
from pathlib import Path

from .sign_language import translator


logger = logging.getLogger(__name__)

# TTS backends (tries in order)
TTS_BACKEND: str | None = None


def _init_tts() -> None:
    global TTS_BACKEND
    try:
        from gtts import gTTS  # noqa: F401
        TTS_BACKEND = 'gtts'
        logger.info("Using gTTS backend")
        return
    except ImportError:
        pass

    try:
        import pyttsx3  # noqa: F401
        TTS_BACKEND = 'pyttsx3'
        logger.info("Using pyttsx3 backend")
        return
    except ImportError:
        pass

    logger.warning("No text-to-speech backend is available")


_init_tts()

# Language detection mappings
LANGUAGE_MAP = {
    'ru': 'Russian',
    'uz': 'Uzbek',
    'en': 'English',
}


def detect_language(text: str) -> str:
    """Detect the source language using the same rules as the planner."""
    return translator.detect_language(text)


def text_to_speech(text: str, lang: str | None = None, output_path: str | None = None) -> str | None:
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
        output_path = str(Path(tempfile.gettempdir()) / f"signbridge_tts_{uuid.uuid4().hex}.mp3")

    if TTS_BACKEND == 'gtts':
        try:
            from gtts import gTTS
            tts = gTTS(text=text, lang=gtts_lang, slow=False)
            tts.save(output_path)
            return output_path if Path(output_path).exists() else None
        except Exception as e:
            logger.warning("gTTS failed, trying the offline backend: %s", e)
            return _pyttsx3_speak(text, output_path)

    elif TTS_BACKEND == 'pyttsx3':
        return _pyttsx3_speak(text, output_path)

    return None


# Cache the pyttsx3 engine to avoid expensive re-initialization on each call.
_pyttsx3_engine = None
_pyttsx3_init_failed = False


def _pyttsx3_speak(text: str, output_path: str) -> str | None:
    """Fallback TTS using pyttsx3 with a cached engine instance."""
    global _pyttsx3_engine, _pyttsx3_init_failed

    if _pyttsx3_init_failed:
        return None

    try:
        if _pyttsx3_engine is None:
            import pyttsx3
            _pyttsx3_engine = pyttsx3.init()
        _pyttsx3_engine.save_to_file(text, output_path)
        _pyttsx3_engine.runAndWait()
        return output_path if Path(output_path).exists() else None
    except Exception as e:
        logger.warning("pyttsx3 failed: %s", e)
        _pyttsx3_init_failed = True
        _pyttsx3_engine = None
        return None


def text_to_avatar_plan(text: str, lang: str | None = None) -> dict:
    """Return a data-driven, inspectable sign-animation plan."""
    return translator.plan(text, lang)


def text_to_avatar_sequence(text: str, lang: str | None = None) -> list[dict]:
    """
    Convert text to a sequence of avatar animation commands.
    Returns list of {gesture: str, duration: float, label: str}
    """
    return text_to_avatar_plan(text, lang)["sequence"]


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    # Test TTS
    test_texts = [
        ("Hello! This is SignBridge.", 'en'),
        ("Привет! Это СайнБридж.", 'ru'),
        ("Salom! Bu SignBridge platformasi.", 'uz'),
    ]

    for text, lang in test_texts:
        logger.info("Generating TTS: [%s] %s", lang, text)
        path = text_to_speech(text, lang, f"test_{lang}.mp3")
        if path:
            logger.info("  Saved to %s", path)
        seq = text_to_avatar_sequence(text)
        logger.info("  Avatar sequence: %s...", [s['gesture'] for s in seq[:5]])
