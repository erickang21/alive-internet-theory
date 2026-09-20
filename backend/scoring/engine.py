import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any, ParamSpec

from backend import ytdlp
from backend.scoring import channel_history, elevenlabs, fact_check, fillers, gptzero, youtube

logger = logging.getLogger(__name__)

P = ParamSpec("P")

STARTING_SCORE = 100
LIKELY_HUMAN_THRESHOLD = 75
LIKELY_AI_THRESHOLD = 45


def _score(breakdown: list[dict[str, Any]]) -> float:
    raw_score = STARTING_SCORE - sum(item["deduction"] for item in breakdown)
    # Negative deductions are bonuses (e.g. a natural filler rate), so clamp both ends.
    return round(min(100.0, max(0.0, raw_score)), 1)


def _verdict(score: float) -> str:
    if score >= LIKELY_HUMAN_THRESHOLD:
        return "likely_human"
    if score >= LIKELY_AI_THRESHOLD:
        return "likely_ai"
    return "ai_slop"


def _safe(
    criterion_name: str,
    fn: Callable[P, dict[str, Any]],
    *args: P.args,
    **kwargs: P.kwargs,
) -> dict[str, Any]:
    # One flaky upstream (GPTZero rate limit, YouTube blocking yt-dlp) should degrade
    # that criterion, not fail the whole evaluation.
    try:
        return fn(*args, **kwargs)
    except Exception:
        logger.exception("criterion %s failed", criterion_name)
        return {
            "criterion": criterion_name,
            "deduction": 0,
            "applied": False,
            "detail": "Criterion unavailable (upstream error).",
        }


def _run(
    criterion_name: str,
    fn: Callable[P, dict[str, Any]],
    *args: P.args,
    **kwargs: P.kwargs,
) -> dict[str, Any]:
    logger.info("score: running %s", criterion_name)
    result = _safe(criterion_name, fn, *args, **kwargs)
    deduction = result["deduction"]
    outcome = ("-" + str(deduction) if deduction else "0") if result["applied"] else "n/a"
    logger.info("score: %s %s, %s", criterion_name, outcome, result["detail"])
    return result


def evaluate_video(
    video_id: str,
    transcript: str,
    track_kind: str | None,
    channel_id: str | None,
    video_length_seconds: int,
    audio_path: Path | None,
) -> dict[str, Any]:
    breakdown = [
        _run("gptzero_transcript", gptzero.score_transcript, transcript),
        _run("elevenlabs_voice", elevenlabs.score_audio, audio_path),
        _run("filler_words", fillers.score_transcript, transcript, track_kind),
    ]
    fact_check_result = _run("fact_check", fact_check.score_transcript, transcript)
    breakdown.append(fact_check_result)

    if channel_id:
        channel = _safe("channel_fetch", ytdlp.fetch_channel, channel_id)
        if channel.get("channel_id"):
            breakdown.append(
                _run("upload_pattern", youtube.score_upload_pattern, channel, video_length_seconds)
            )
            breakdown.append(_run("account_age", youtube.score_account_age, channel))

    score = _score(breakdown)
    facts = fact_check_result.get("evidence", {})

    return {
        "video_id": video_id,
        "channel_id": channel_id,
        "score": score,
        "verdict": _verdict(score),
        "breakdown": breakdown,
        # None when the fact check couldn't run (no API key, upstream error).
        "is_educational": facts.get("is_educational"),
        "thesis": facts.get("thesis"),
        "hallucinated": facts.get("hallucinated"),
        # Validity Score from the fact-check engine: independent of `score`
        # above (fact_check is never applied to the AI-slop deduction math).
        "validity_score": facts.get("validity_score"),
        "validity_rating": facts.get("validity_rating"),
    }


def apply_channel_history(
    evaluation: dict[str, Any], siblings: list[dict[str, Any]]
) -> dict[str, Any]:
    """Add the channel-history criterion to a stored evaluation and rescore it.

    This one criterion is applied when an evaluation is served rather than when it is
    stored, because it depends on which of the channel's videos have been analyzed so
    far: the first video of a channel would otherwise be stuck with an empty history.
    """
    breakdown = [*evaluation["breakdown"], channel_history.score_channel_history(siblings)]
    score = _score(breakdown)
    return {**evaluation, "breakdown": breakdown, "score": score, "verdict": _verdict(score)}
