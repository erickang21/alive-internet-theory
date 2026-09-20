from pathlib import Path
from typing import Any

import requests

from backend.retry import retry

BASE_URL = "https://api.elevenlabs.io"
# The classifier only listens to the first minute, so uploading more is wasted time.
CLASSIFIED_SECONDS = 60
MAX_DEDUCTION = 40
# Measured: real speech, silence and noise all land at 0.02-0.05, ElevenLabs voices at
# 0.98, so the midpoint sits in an empty gap rather than anywhere near a real reading.
DETECTION_THRESHOLD = 0.5


@retry(on=requests.HTTPError, attempts=3)
def classify_audio(audio_path: Path) -> float:
    """Probability that ElevenLabs generated this audio, judged on its first minute."""
    # The endpoint takes no API key, and rejects an invalid one with a 401, so send none.
    with audio_path.open("rb") as audio:
        response = requests.post(
            f"{BASE_URL}/v1/moderation/ai-speech-classification",
            files={"file": (audio_path.name, audio)},
            timeout=120,
        )
    response.raise_for_status()
    return float(response.json()["probability"])


def score_audio(audio_path: Path | None) -> dict[str, Any]:
    if audio_path is None or not audio_path.exists():
        return {
            "criterion": "elevenlabs_voice",
            "deduction": 0,
            "applied": False,
            "reason": "no_audio",
        }

    probability = classify_audio(audio_path)
    if probability < DETECTION_THRESHOLD:
        return {
            "criterion": "elevenlabs_voice",
            "deduction": 0,
            "applied": True,
            # Never a bonus: the classifier only knows ElevenLabs voices, so every other
            # synthetic voice reads exactly like a real person here.
            "evidence": {"probability": round(probability, 4)},
        }

    # Scaled to 1.0 rather than the 0.98 the API seems to cap at, so the deduction never
    # depends on a ceiling we inferred from samples instead of reading in a spec.
    confidence = (probability - DETECTION_THRESHOLD) / (1 - DETECTION_THRESHOLD)
    return {
        "criterion": "elevenlabs_voice",
        "deduction": round(MAX_DEDUCTION * confidence, 1),
        "applied": True,
        "evidence": {"probability": round(probability, 4)},
    }
