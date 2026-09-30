"""Download the optional MediaPipe hand-landmark model used by SignBridge."""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

from .config import MODELS_DIR


HAND_LANDMARKER_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/latest/hand_landmarker.task"
)
HAND_LANDMARKER_PATH = MODELS_DIR / "hand_landmarker.task"
MIN_MODEL_BYTES = 1_000_000


def download_hand_landmarker(destination: Path = HAND_LANDMARKER_PATH, *, force: bool = False) -> Path:
    """Download the official model atomically and return its local path."""
    if destination.exists() and destination.stat().st_size >= MIN_MODEL_BYTES and not force:
        return destination

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = destination.with_suffix(".download")
    request = Request(HAND_LANDMARKER_URL, headers={"User-Agent": "SignBridge/2.0"})

    try:
        with urlopen(request, timeout=60) as response, temporary_path.open("wb") as output:
            shutil.copyfileobj(response, output)
    except URLError as error:
        temporary_path.unlink(missing_ok=True)
        raise RuntimeError(f"Could not download the hand-landmark model: {error.reason}") from error
    except OSError:
        temporary_path.unlink(missing_ok=True)
        raise

    if temporary_path.stat().st_size < MIN_MODEL_BYTES:
        temporary_path.unlink(missing_ok=True)
        raise RuntimeError("Downloaded hand-landmark model is unexpectedly small.")

    temporary_path.replace(destination)
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description="Download the SignBridge hand-landmark model.")
    parser.add_argument("--force", action="store_true", help="Download the model again even if it exists.")
    args = parser.parse_args()

    try:
        model_path = download_hand_landmarker(force=args.force)
    except (OSError, RuntimeError) as error:
        print(f"[ERROR] {error}", file=sys.stderr)
        return 1

    print(f"[OK] Hand-landmark model is ready: {model_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
