import logging
from typing import Any

from backend.scoring import fillers, gptzero, youtube

logger = logging.getLogger(__name__)

STARTING_SCORE = 100
LIKELY_HUMAN_THRESHOLD = 75
POSSIBLY_AI_THRESHOLD = 45


def _verdict(score: float) -> str:
    if score >= LIKELY_HUMAN_THRESHOLD:
        return "likely_human"
    if score >= POSSIBLY_AI_THRESHOLD:
        return "possibly_ai"
    return "ai_slop"


def _safe(criterion_name: str, fn, *args) -> dict[str, Any]:
    # One flaky upstream API (GPTZero rate limit, YouTube quota) should degrade
    # that criterion, not fail the whole evaluation.
    try:
        return fn(*args)
    except Exception:
        logger.exception("criterion %s failed", criterion_name)
        return {
            "criterion": criterion_name,
            "deduction": 0,
            "applied": False,
            "detail": "Criterion unavailable (upstream error).",
        }


def evaluate_video(
    video_id: str,
    transcript: str,
    track_kind: str | None,
    channel_id: str | None,
    video_length_seconds: int,
) -> dict[str, Any]:
    breakdown = [
        _safe("gptzero_transcript", gptzero.score_transcript, transcript),
        _safe("filler_words", fillers.score_transcript, transcript, track_kind),
    ]

    if channel_id:
        channel = _safe("channel_fetch", youtube.fetch_channel, channel_id)
        if channel.get("channel_id"):
            breakdown.append(
                _safe("upload_pattern", youtube.score_upload_pattern, channel, video_length_seconds)
            )
            breakdown.append(_safe("account_age", youtube.score_account_age, channel))

    score = max(0.0, STARTING_SCORE - sum(item["deduction"] for item in breakdown))

    return {
        "video_id": video_id,
        "channel_id": channel_id,
        "score": round(score, 1),
        "verdict": _verdict(score),
        "breakdown": breakdown,
    }
