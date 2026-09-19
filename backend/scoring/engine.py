import logging
from typing import Any

from backend import ytdlp
from backend.scoring import fact_check, fillers, gptzero, youtube

logger = logging.getLogger(__name__)

STARTING_SCORE = 100
LIKELY_HUMAN_THRESHOLD = 75
POSSIBLY_AI_THRESHOLD = 45


class UpstreamScoringError(Exception):
    """A core criterion's upstream failed (e.g. GPTZero timed out).

    Raised instead of degrading the criterion so the caller stores nothing and
    the request can be retried, rather than persisting a misleadingly perfect
    score built without the scan that carries most of the signal.
    """


def _verdict(score: float) -> str:
    if score >= LIKELY_HUMAN_THRESHOLD:
        return "likely_human"
    if score >= POSSIBLY_AI_THRESHOLD:
        return "possibly_ai"
    return "ai_slop"


def _safe(criterion_name: str, fn, *args) -> dict[str, Any]:
    # One flaky upstream (GPTZero rate limit, YouTube blocking yt-dlp) should degrade
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
    # GPTZero is the bulk of the score, so a flaky upstream here isn't degraded
    # like the others: it aborts the evaluation (nothing stored) for a retry.
    try:
        gptzero_result = gptzero.score_transcript(transcript)
    except Exception as error:
        logger.exception("criterion gptzero_transcript failed")
        raise UpstreamScoringError("gptzero_transcript") from error

    breakdown = [
        gptzero_result,
        _safe("filler_words", fillers.score_transcript, transcript, track_kind),
    ]
    fact_check_result = _safe("fact_check", fact_check.score_transcript, transcript)
    breakdown.append(fact_check_result)

    if channel_id:
        channel = _safe("channel_fetch", ytdlp.fetch_channel, channel_id)
        if channel.get("channel_id"):
            breakdown.append(
                _safe("upload_pattern", youtube.score_upload_pattern, channel, video_length_seconds)
            )
            breakdown.append(_safe("account_age", youtube.score_account_age, channel))

    score = max(0.0, STARTING_SCORE - sum(item["deduction"] for item in breakdown))
    facts = fact_check_result.get("evidence", {})

    return {
        "video_id": video_id,
        "channel_id": channel_id,
        "score": round(score, 1),
        "verdict": _verdict(score),
        "breakdown": breakdown,
        # None when the fact check couldn't run (no API key, upstream error).
        "is_educational": facts.get("is_educational"),
        "thesis": facts.get("thesis"),
        "hallucinated": facts.get("hallucinated"),
    }
