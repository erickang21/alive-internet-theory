import re
from typing import Any

MAX_DEDUCTION = 20
FILLER_WORDS = {"um", "uh", "uhm", "erm", "hmm", "like", "y'know"}
FILLER_PHRASES = ("you know", "i mean", "sort of", "kind of")
STUTTER_PATTERN = re.compile(r"\b(\w+)[-,]?\s+\1\b", re.IGNORECASE)

# Below this rate on a long ASR transcript, the absence of fillers reads as scripted/AI.
HUMAN_FILLER_RATE_PER_100_WORDS = 0.5
MIN_WORDS_FOR_SIGNAL = 300
FULL_CONFIDENCE_WORDS = 1500


def count_fillers(text: str) -> int:
    lowered = text.lower()
    words = re.findall(r"[a-z']+", lowered)
    count = sum(1 for word in words if word in FILLER_WORDS)
    count += sum(lowered.count(phrase) for phrase in FILLER_PHRASES)
    count += len(STUTTER_PATTERN.findall(text))
    return count


def score_transcript(transcript: str, track_kind: str | None) -> dict[str, Any]:
    # ASR mostly preserves fillers, so their absence means something; manually
    # uploaded or translated tracks strip fillers by convention, so scoring those
    # would falsely flag human videos.
    if track_kind != "asr":
        return {
            "criterion": "filler_words",
            "deduction": 0,
            "applied": False,
            "detail": "Skipped: only reliable on auto-generated (ASR) caption tracks.",
        }

    word_count = len(transcript.split())
    if word_count < MIN_WORDS_FOR_SIGNAL:
        return {
            "criterion": "filler_words",
            "deduction": 0,
            "applied": False,
            "detail": f"Transcript too short to judge filler absence ({word_count} words).",
        }

    filler_count = count_fillers(transcript)
    rate = filler_count / word_count * 100
    if rate >= HUMAN_FILLER_RATE_PER_100_WORDS:
        deduction = 0.0
        detail = f"Natural filler rate ({rate:.2f} per 100 words) — reads as human speech."
    else:
        # Absence is weaker evidence than presence, so scale by transcript length:
        # ASR drops some fillers, and short-ish transcripts amplify that noise.
        shortfall = 1 - rate / HUMAN_FILLER_RATE_PER_100_WORDS
        length_confidence = min(word_count / FULL_CONFIDENCE_WORDS, 1.0)
        deduction = round(MAX_DEDUCTION * shortfall * length_confidence, 1)
        detail = f"Suspiciously few fillers ({rate:.2f} per 100 words) for spoken audio."

    return {
        "criterion": "filler_words",
        "deduction": deduction,
        "applied": True,
        "detail": detail,
        "evidence": {"filler_count": filler_count, "rate_per_100_words": round(rate, 2)},
    }
