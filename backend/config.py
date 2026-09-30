"""Application settings shared by the API, launcher and deployment files."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = PROJECT_ROOT / "frontend"
MODELS_DIR = PROJECT_ROOT / "models"


def _read_int(name: str, default: int, minimum: int = 1) -> int:
    """Read a positive integer environment variable with a safe fallback."""
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(value, minimum)


def _read_float(name: str, default: float, minimum: float = 0.0) -> float:
    """Read a bounded float environment variable with a safe fallback."""
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(value, minimum)


def _read_bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def _read_origins() -> tuple[str, ...]:
    raw = os.getenv(
        "SIGNBRIDGE_CORS_ORIGINS",
        "http://localhost:8000,http://127.0.0.1:8000",
    )
    origins = tuple(origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip())
    return origins or ("http://localhost:8000",)


@dataclass(frozen=True, slots=True)
class Settings:
    """Runtime values that can be changed without editing Python files."""

    app_name: str
    app_version: str
    environment: str
    cors_origins: tuple[str, ...]
    enforce_websocket_origin: bool
    max_text_length: int
    max_ws_message_bytes: int
    max_frame_bytes: int
    max_frame_width: int
    max_frame_height: int
    max_audio_bytes: int
    gesture_frame_interval: float
    avatar_request_interval: float


def load_settings() -> Settings:
    environment = os.getenv("SIGNBRIDGE_ENV", "development").strip().lower()
    return Settings(
        app_name="SignBridge API",
        app_version=os.getenv("SIGNBRIDGE_VERSION", "2.0.0"),
        environment=environment,
        cors_origins=_read_origins(),
        enforce_websocket_origin=_read_bool(
            "SIGNBRIDGE_ENFORCE_WS_ORIGIN",
            default=environment == "production",
        ),
        max_text_length=_read_int("SIGNBRIDGE_MAX_TEXT_LENGTH", 500),
        max_ws_message_bytes=_read_int("SIGNBRIDGE_MAX_WS_MESSAGE_BYTES", 1_600_000),
        max_frame_bytes=_read_int("SIGNBRIDGE_MAX_FRAME_BYTES", 1_200_000),
        max_frame_width=_read_int("SIGNBRIDGE_MAX_FRAME_WIDTH", 1280),
        max_frame_height=_read_int("SIGNBRIDGE_MAX_FRAME_HEIGHT", 720),
        max_audio_bytes=_read_int("SIGNBRIDGE_MAX_AUDIO_BYTES", 4_000_000),
        gesture_frame_interval=_read_float("SIGNBRIDGE_GESTURE_FRAME_INTERVAL", 1 / 15),
        avatar_request_interval=_read_float("SIGNBRIDGE_AVATAR_REQUEST_INTERVAL", 0.35),
    )


settings = load_settings()
