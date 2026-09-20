from typing import Any

import requests

from backend.config import config
from backend.retry import retry
from backend.transcripts import Cue, locate

BASE_URL = "https://api.gptzero.me"
MIN_WORDS_FOR_SIGNAL = 75
MAX_DEDUCTION = 50
# The breakdown shows a few example passages, not the whole transcript.
MAX_FLAGGED_PHRASES = 3
PHRASE_TARGET_WORDS = 35

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


def score_transcript(transcript: str, cues: list[Cue] | None = None) -> dict[str, Any]:
    word_count = len(transcript.split())
    if word_count < MIN_WORDS_FOR_SIGNAL:
        return {
            "criterion": "gptzero_transcript",
            "deduction": 0,
            "applied": False,
            "reason": "transcript_too_short",
            "evidence": {"word_count": word_count, "words_needed": MIN_WORDS_FOR_SIGNAL},
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
        "evidence": {
            "predicted_class": prediction.get("predicted_class"),
            "confidence_score": confidence,
            "ai_probability": probabilities.get("ai", 0.0),
            "flagged_sentence_ratio": round(flagged / len(sentences), 3) if sentences else None,
            "flagged_sentences": _flagged_phrases(sentences, cues or []),
        },
    }


def _ai_probability(sentence: dict[str, Any]) -> float:
    probability = sentence.get("generated_prob")
    if probability is None:
        probability = sentence.get("class_probabilities", {}).get("ai", 0.0)
    return float(probability)


def _flagged_phrases(sentences: list[dict[str, Any]], cues: list[Cue]) -> list[dict[str, Any]]:
    """The most AI-looking passages, spread across the transcript.

    A passage is a run of consecutive flagged sentences, grown to about
    PHRASE_TARGET_WORDS so it reads as a phrase rather than a fragment. The transcript is
    split into MAX_FLAGGED_PHRASES equal stretches and each contributes its most confident
    passage, so the examples don't all come from the opening lines; a stretch with nothing
    flagged gives its slot to the best passage left over.
    """
    candidates: list[tuple[float, int, int, float]] = []  # (rank, first, last, confidence)
    for first, sentence in enumerate(sentences):
        if not sentence.get("highlight_sentence_for_ai"):
            continue
        last, words = first, len(sentence.get("sentence", "").split())
        while (
            last + 1 < len(sentences)
            and words < PHRASE_TARGET_WORDS
            and sentences[last + 1].get("highlight_sentence_for_ai")
        ):
            last += 1
            words += len(sentences[last].get("sentence", "").split())
        run = sentences[first : last + 1]
        confidence = sum(map(_ai_probability, run)) / len(run)
        # A fragment at the tail of a run shouldn't beat a full passage on confidence alone.
        rank = confidence * min(1.0, words / PHRASE_TARGET_WORDS)
        candidates.append((rank, first, last, confidence))

    chosen: list[tuple[float, int, int, float]] = []

    def take(pool: list[tuple[float, int, int, float]]) -> None:
        free = [c for c in pool if all(c[2] < o[1] or c[1] > o[2] for o in chosen)]
        if free and len(chosen) < MAX_FLAGGED_PHRASES:
            chosen.append(max(free, key=lambda c: (c[0], -c[1])))

    stretch = len(sentences) / MAX_FLAGGED_PHRASES
    for part in range(MAX_FLAGGED_PHRASES):
        take([c for c in candidates if part * stretch <= c[1] < (part + 1) * stretch])
    for _ in range(MAX_FLAGGED_PHRASES):
        take(candidates)

    phrases: list[dict[str, Any]] = []
    for _, first, last, confidence in sorted(chosen, key=lambda c: c[1]):
        texts = [s.get("sentence", "").strip() for s in sentences[first : last + 1]]
        start = locate(cues, " ".join(texts))
        phrases.append(
            {
                "text": " ".join(texts),
                # None when the passage can't be found in the captions.
                "start_seconds": start if start is not None else locate(cues, texts[0]),
                "ai_probability": round(confidence, 3),
            }
        )
    return phrases
