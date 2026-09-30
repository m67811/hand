"""
SignBridge - Text-to-Speech Engine
Converts text/gestures to speech output (multi-language support).
Also maps text to sign language avatar animations.
"""

import logging
import os
import threading
import tempfile
import uuid
from pathlib import Path

from .sign_language import translator


logger = logging.getLogger(__name__)

# TTS backends (tries in order)
TTS_BACKEND = None


def _init_tts():
    global TTS_BACKEND
    try:
        from gtts import gTTS
        TTS_BACKEND = 'gtts'
        logger.info("Using gTTS backend")
        return
    except ImportError:
        pass

    try:
        import pyttsx3
        TTS_BACKEND = 'pyttsx3'
        logger.info("Using pyttsx3 backend")
        return
    except ImportError:
        pass

    logger.warning("No text-to-speech backend is available")


_init_tts()

# Gesture vocabulary used by the avatar.  These are visual, educational
# approximations; a production interpreter must be validated by native users
# of the chosen sign language (ASL/RSL/UzSL are not interchangeable).
AVATAR_ANIMATIONS = {
    # greetings / politeness
    "hello": ["wave"], "hi": ["wave"], "привет": ["wave"], "здравствуйте": ["wave"], "salom": ["wave"],
    "goodbye": ["goodbye"], "пока": ["goodbye"], "прощай": ["goodbye"], "xayr": ["goodbye"],
    "please": ["please"], "пожалуйста": ["please"], "iltimos": ["please"],
    "thanks": ["thank_you"], "thank": ["thank_you"], "спасибо": ["thank_you"], "rahmat": ["thank_you"],
    "sorry": ["sorry"], "извините": ["sorry"], "прости": ["sorry"], "kechirasiz": ["sorry"],
    "yes": ["yes"], "да": ["yes"], "ha": ["yes"], "no": ["no"], "нет": ["no"], "yo'q": ["no"],
    "good": ["good"], "хорошо": ["good"], "yaxshi": ["good"], "bad": ["bad"], "плохо": ["bad"], "yomon": ["bad"],
    "stop": ["stop"], "стоп": ["stop"], "to'xta": ["stop"], "wait": ["wait"], "ждите": ["wait"], "подождите": ["wait"], "kuting": ["wait"],
    # people / conversation
    "i": ["me"], "me": ["me"], "я": ["me"], "меня": ["me"], "men": ["me"],
    "you": ["you"], "ты": ["you"], "вы": ["you"], "siz": ["you"],
    "name": ["name"], "имя": ["name"], "ism": ["name"], "friend": ["friend"], "друг": ["friend"], "друзья": ["friend"], "do'st": ["friend"],
    "mother": ["mother"], "мама": ["mother"], "ona": ["mother"], "father": ["father"], "папа": ["father"], "отец": ["father"], "ota": ["father"],
    "family": ["family"], "семья": ["family"], "oila": ["family"],
    "understand": ["understand"], "понимаю": ["understand"], "понял": ["understand"], "tushundim": ["understand"],
    "again": ["again"], "снова": ["again"], "ещё": ["again"], "yana": ["again"], "slow": ["slow"], "медленно": ["slow"], "sekin": ["slow"],
    # needs / everyday life
    "want": ["want"], "хочу": ["want"], "xohlayman": ["want"], "need": ["need"], "нужно": ["need"], "нужен": ["need"], "kerak": ["need"],
    "help": ["help"], "помогите": ["help"], "помощь": ["help"], "yordam": ["help"],
    "water": ["water"], "вода": ["water"], "suv": ["water"], "drink": ["drink"], "пить": ["drink"], "ichish": ["drink"],
    "food": ["food"], "еда": ["food"], "ovqat": ["food"], "eat": ["eat"], "есть": ["eat"], "кушать": ["eat"], "yemoq": ["eat"],
    "home": ["home"], "дом": ["home"], "uy": ["home"], "school": ["school"], "школа": ["school"], "maktab": ["school"],
    "work": ["work"], "работа": ["work"], "ish": ["work"], "money": ["money"], "деньги": ["money"], "pul": ["money"],
    "phone": ["phone"], "телефон": ["phone"], "call": ["phone"], "звонок": ["phone"], "qo'ng'iroq": ["phone"],
    # questions / time / directions
    "who": ["who"], "кто": ["who"], "kim": ["who"], "what": ["what"], "что": ["what"], "nima": ["what"],
    "where": ["where"], "где": ["where"], "qayerda": ["where"], "when": ["when"], "когда": ["when"], "qachon": ["when"],
    "how": ["how"], "как": ["how"], "qanday": ["how"], "why": ["why"], "почему": ["why"], "nega": ["why"],
    "today": ["today"], "сегодня": ["today"], "bugun": ["today"], "tomorrow": ["tomorrow"], "завтра": ["tomorrow"], "ertaga": ["tomorrow"],
    "morning": ["morning"], "утро": ["morning"], "ertalab": ["morning"], "night": ["night"], "ночь": ["night"], "kecha": ["night"],
    "left": ["left"], "налево": ["left"], "chap": ["left"], "right": ["right"], "направо": ["right"], "o'ng": ["right"],
    # wellbeing / emergency / emotions
    "doctor": ["doctor"], "врач": ["doctor"], "доктор": ["doctor"], "shifokor": ["doctor"],
    "hospital": ["hospital"], "больница": ["hospital"], "kasalxona": ["hospital"], "pain": ["pain"], "боль": ["pain"], "болит": ["pain"], "og'riq": ["pain"],
    "emergency": ["emergency"], "срочно": ["emergency"], "опасность": ["emergency"], "tez": ["emergency"],
    "bathroom": ["bathroom"], "туалет": ["bathroom"], "hojatxona": ["bathroom"],
    "love": ["love"], "любовь": ["love"], "люблю": ["love"], "sevgi": ["love"],
    "peace": ["peace"], "мир": ["peace"], "tinchlik": ["peace"], "happy": ["happy"], "счастлив": ["happy"], "радость": ["happy"], "xursand": ["happy"],
    "sad": ["sad"], "грустно": ["sad"], "xafa": ["sad"],
}

# Phrases are consumed before individual words so that a sentence has useful
# signs instead of being fingerspelled one character at a time.
AVATAR_PHRASES = {
    "thank you": ["thank_you"], "спасибо большое": ["thank_you"], "i need help": ["me", "need", "help"],
    "мне нужна помощь": ["me", "need", "help"], "мне плохо": ["me", "bad"], "я не понимаю": ["me", "no", "understand"],
    "how are you": ["how", "you"], "как дела": ["how", "you"], "what is your name": ["what", "you", "name"],
    "where is the bathroom": ["where", "bathroom"], "где туалет": ["where", "bathroom"],
    "call a doctor": ["phone", "doctor"], "вызовите врача": ["phone", "doctor"], "мне нужна вода": ["me", "need", "water"],
}

ANIMATION_GESTURES = {gesture for gestures in AVATAR_ANIMATIONS.values() for gesture in gestures}
ANIMATION_GESTURES.update(gesture for gestures in AVATAR_PHRASES.values() for gesture in gestures)

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


def _pyttsx3_speak(text: str, output_path: str) -> str | None:
    """Fallback TTS using pyttsx3."""
    try:
        import pyttsx3
        engine = pyttsx3.init()
        engine.save_to_file(text, output_path)
        engine.runAndWait()
        return output_path if Path(output_path).exists() else None
    except Exception as e:
        logger.warning("pyttsx3 failed: %s", e)
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


def text_to_avatar_plan(text: str, lang: str = None) -> dict:
    """Return a data-driven, inspectable sign-animation plan."""
    return translator.plan(text, lang)


def text_to_avatar_sequence(text: str, lang: str = None) -> list[dict]:
    """
    Convert text to a sequence of avatar animation commands.
    Returns list of {gesture: str, duration: float, label: str}
    """
    return text_to_avatar_plan(text, lang)["sequence"]


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
