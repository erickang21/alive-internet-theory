import logging
from typing import Any

from backend.database import DatabaseUnavailableError
from backend.scoring import channel_history, fillers, gptzero, youtube

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
    except DatabaseUnavailableError:
        logger.warning("criterion %s skipped: database unavailable", criterion_name)
        return _unavailable(criterion_name, "Criterion unavailable (database unreachable).")
    except Exception:
        logger.exception("criterion %s failed", criterion_name)
        return _unavailable(criterion_name, "Criterion unavailable (upstream error).")


def _unavailable(criterion_name: str, detail: str) -> dict[str, Any]:
    return {
        "criterion": criterion_name,
        "deduction": 0,
        "applied": False,
        "detail": detail,
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
        else:
            breakdown.extend(
                _unavailable(name, "Channel data unavailable (YouTube API not reachable).")
                for name in ("upload_pattern", "account_age")
            )
        breakdown.append(
            _safe("channel_history", channel_history.score_channel, channel_id, video_id)
        )
    else:
        breakdown.extend(
            _unavailable(name, "No channel ID supplied for this video.")
            for name in ("upload_pattern", "account_age", "channel_history")
        )

    score = round(max(0.0, STARTING_SCORE - sum(item["deduction"] for item in breakdown)), 1)

    return {
        "video_id": video_id,
        "channel_id": channel_id,
        "score": score,
        "verdict": _verdict(score),
        "breakdown": breakdown,
    }
