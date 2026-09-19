from typing import Any

import requests

from backend.config import config
from backend.retry import retry

BASE_URL = "https://api.gptzero.me"
MIN_WORDS_FOR_SIGNAL = 75
MAX_DEDUCTION = 50

# GPTZero's Cloudflare rejects default python-requests User-Agents with error 1010,
# so we present a browser-style one.
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)


def _session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "x-api-key": config.gptzero_api_key,
            "User-Agent": BROWSER_USER_AGENT,
        }
    )
    return session


@retry(on=requests.HTTPError, attempts=5)
def predict_text(document: str) -> dict[str, Any]:
    response = _session().post(
        f"{BASE_URL}/v2/predict/text",
        json={"document": document[: min(len(document), 45000)]},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["documents"][0]


def score_transcript(transcript: str) -> dict[str, Any]:
    word_count = len(transcript.split())
    if word_count < MIN_WORDS_FOR_SIGNAL:
        return {
            "criterion": "gptzero_transcript",
            "deduction": 0,
            "applied": False,
            "detail": f"Transcript too short for a reliable verdict ({word_count} words).",
        }

    prediction = predict_text(transcript)
    probabilities = prediction.get("class_probabilities", {})
    confidence = prediction.get("confidence_score", 0.0)
    ai_weight = probabilities.get("ai", 0.0) + (probabilities.get("mixed", 0.0) / 2)
    # Scaled by confidence rather than a flat -45: a shaky "ai" verdict should not
    # tank the score as hard as a certain one.
    deduction = round(MAX_DEDUCTION * ai_weight * confidence, 1)

    sentences = prediction.get("sentences", [])
    flagged = sum(1 for s in sentences if s.get("highlight_sentence_for_ai"))

    return {
        "criterion": "gptzero_transcript",
        "deduction": deduction,
        "applied": True,
        "detail": (
            f"GPTZero verdict: {prediction.get('predicted_class', 'unknown')} "
            f"(confidence {confidence:.2f})."
        ),
        "evidence": {
            "predicted_class": prediction.get("predicted_class"),
            "confidence_score": confidence,
            "class_probabilities": probabilities,
            "flagged_sentence_ratio": round(flagged / len(sentences), 3) if sentences else None,
        },
    }
