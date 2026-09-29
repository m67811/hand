"""Data-driven text-to-sign planning for SignBridge.

This module intentionally plans animations rather than claiming to translate a
natural sign language.  Its JSON lexicon can be reviewed and replaced by an
expert-approved RSL, ASL or UzSL corpus without changing the API/frontend.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


LEXICON_PATH = Path(__file__).with_name("data") / "sign_lexicon.json"
WORD_PATTERN = re.compile(r"[^\W_]+(?:['’][^\W_]+)?", re.UNICODE)


def _normalise(value: str) -> str:
    return " ".join(WORD_PATTERN.findall(value.lower().replace("ё", "е").replace("’", "'")))


@dataclass(frozen=True)
class PlannedSign:
    gesture: str
    gloss: str
    source: str
    kind: str = "gesture"
    duration: float = 0.9

    def as_sequence_item(self) -> dict[str, Any]:
        return {
            "gesture": self.gesture,
            "duration": self.duration,
            "label": self.gloss,
            "source": self.source,
            "type": self.kind,
        }


class SignLanguageTranslator:
    """Loads a lexicon and converts input into an inspectable animation plan."""

    def __init__(self, lexicon_path: Path = LEXICON_PATH):
        with lexicon_path.open("r", encoding="utf-8") as file:
            self.lexicon = json.load(file)
        self.word_index: dict[str, tuple[str, str]] = {}
        self.phrase_index: list[tuple[tuple[str, ...], list[str], list[str], str]] = []
        self.gesture_gloss: dict[str, str] = {}
        self._build_indexes()

    def _build_indexes(self) -> None:
        for entry in self.lexicon["gestures"]:
            gesture_id, gloss = entry["id"], entry["gloss"]
            self.gesture_gloss[gesture_id] = gloss
            for terms in entry["terms"].values():
                for term in terms:
                    normalised = _normalise(term)
                    if normalised:
                        self.word_index[normalised] = (gesture_id, gloss)

        for entry in self.lexicon.get("phrases", []):
            for language, terms in entry["terms"].items():
                for term in terms:
                    tokens = tuple(_normalise(term).split())
                    if tokens:
                        self.phrase_index.append((tokens, entry["gesture_ids"], entry["glosses"], language))
        self.phrase_index.sort(key=lambda item: len(item[0]), reverse=True)

    def plan(self, text: str, lang: str | None = None) -> dict[str, Any]:
        tokens = _normalise(text).split()
        requested_language = lang if lang in self.lexicon["languages"] else self.detect_language(text)
        signs: list[PlannedSign] = []
        glosses: list[str] = []
        unknown: list[str] = []
        dropped: list[str] = []
        recognised_tokens = 0
        index = 0
        grammar = self.lexicon.get("grammar", {}).get(requested_language, {})
        drop_words = set(grammar.get("drop", []))

        while index < len(tokens):
            phrase = next((candidate for candidate in self.phrase_index
                           if tuple(tokens[index:index + len(candidate[0])]) == candidate[0]), None)
            if phrase:
                phrase_tokens, gesture_ids, phrase_glosses, _ = phrase
                source = " ".join(phrase_tokens)
                for gesture_id, gloss in zip(gesture_ids, phrase_glosses):
                    signs.append(PlannedSign(gesture_id, gloss, source))
                    glosses.append(gloss)
                recognised_tokens += len(phrase_tokens)
                index += len(phrase_tokens)
            else:
                token = tokens[index]
                if token in drop_words:
                    dropped.append(token)
                    index += 1
                    continue
                match = self.word_index.get(token)
                if match:
                    gesture_id, gloss = match
                    signs.append(PlannedSign(gesture_id, gloss, token))
                    glosses.append(gloss)
                    recognised_tokens += 1
                else:
                    unknown.append(token)
                    # Fallback fingerspelling keeps the output useful and visible.
                    for character in token.upper():
                        if character.isalpha():
                            signs.append(PlannedSign(character, character, token, "letter", 0.48))
                            glosses.append(character)
                index += 1

            signs.append(PlannedSign("PAUSE", "|", "", "pause", 0.28))

        sequence = [sign.as_sequence_item() for sign in signs]
        semantic_tokens = len(tokens) - len(dropped)
        coverage = round(recognised_tokens / semantic_tokens * 100) if semantic_tokens else 0
        return {
            "source_text": text,
            "language": requested_language,
            "glosses": glosses,
            "unknown_words": unknown,
            "dropped_words": dropped,
            "coverage": coverage,
            "sequence": sequence,
            "total_duration": round(sum(item["duration"] for item in sequence), 2),
            "lexicon_version": self.lexicon["schema_version"],
            "notice": self.lexicon["notice"],
        }

    def vocabulary(self) -> dict[str, Any]:
        return {
            "lexicon_version": self.lexicon["schema_version"],
            "languages": self.lexicon["languages"],
            "gesture_count": len(self.lexicon["gestures"]),
            "phrase_count": len(self.lexicon.get("phrases", [])),
            "notice": self.lexicon["notice"],
        }

    @staticmethod
    def detect_language(text: str) -> str:
        if any("\u0400" <= char <= "\u04ff" for char in text):
            return "ru"
        low = text.lower()
        uz_markers = ("salom", "rahmat", "kerak", "menga", "qayerda", "yaxshi", "suv", "yo'q")
        return "uz" if any(marker in low for marker in uz_markers) else "en"


translator = SignLanguageTranslator()
