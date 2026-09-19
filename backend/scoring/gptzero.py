from typing import Any

import requests

from backend.config import config

BASE_URL = "https://api.gptzero.me"
MIN_WORDS_FOR_SIGNAL = 200
MAX_DEDUCTION = 45
SENTENCE_RATIO_FLOOR = 0.02
SENTENCE_RATIO_CEILING = 0.30

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


def predict_text(document: str) -> dict[str, Any]:
    response = _session().post(
        f"{BASE_URL}/v2/predict/text", json={"document": document}, timeout=30
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
    ai_weight = probabilities.get("ai", 0.0) + probabilities.get("mixed", 0.0)
    # Scaled by confidence rather than a flat -45: a shaky "ai" verdict should not
    # tank the score as hard as a certain one.
    document_signal = ai_weight * confidence

    sentences = prediction.get("sentences", [])
    flagged = sum(1 for s in sentences if s.get("highlight_sentence_for_ai"))
    flagged_ratio = flagged / len(sentences) if sentences else 0.0
    # Live testing showed the document model calling a known-AI transcript "human"
    # while still flagging 8% of its sentences (vs 0% on a real human video), so
    # the sentence ratio backstops document-level misses on humanized scripts.
    sentence_signal = _clamp01(
        (flagged_ratio - SENTENCE_RATIO_FLOOR) / (SENTENCE_RATIO_CEILING - SENTENCE_RATIO_FLOOR)
    )

    deduction = round(MAX_DEDUCTION * max(document_signal, sentence_signal), 1)
    if document_signal >= sentence_signal:
        detail = (
            f"GPTZero verdict: {prediction.get('predicted_class', 'unknown')} "
            f"(confidence {confidence:.2f})."
        )
    else:
        detail = (
            f"GPTZero flagged {flagged_ratio:.0%} of sentences as AI-written "
            f"despite a {prediction.get('predicted_class', 'unknown')} document verdict."
        )

    return {
        "criterion": "gptzero_transcript",
        "deduction": deduction,
        "applied": True,
        "detail": detail,
        "evidence": {
            "predicted_class": prediction.get("predicted_class"),
            "confidence_score": confidence,
            "class_probabilities": probabilities,
            "flagged_sentence_ratio": round(flagged_ratio, 3) if sentences else None,
        },
    }


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))
