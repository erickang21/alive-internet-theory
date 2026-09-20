import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any, ParamSpec

from backend import ytdlp
from backend.scoring import channel_history, elevenlabs, fillers, gptzero, youtube
from backend.transcripts import Cue

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
            "reason": "upstream_error",
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
    # The breakdown carries fields now, not prose, so the log says what it was given.
    note = result.get("reason") or result.get("evidence") or ""
    logger.info("score: %s %s, %s", criterion_name, outcome, note)
    return result


def evaluate_video(
    video_id: str,
    transcript: str,
    track_kind: str | None,
    channel_id: str | None,
    video_length_seconds: int,
    audio_path: Path | None,
    cues: list[Cue] | None = None,
) -> dict[str, Any]:
    breakdown = [
        _run("gptzero_transcript", gptzero.score_transcript, transcript, cues),
        _run("elevenlabs_voice", elevenlabs.score_audio, audio_path),
        _run("filler_words", fillers.score_transcript, transcript, track_kind),
    ]
    # The fact check is NOT here. It is minutes of sequential LLM calls, it is
    # never scored (deduction 0, applied False -- the Validity Score is its own
    # metric), and running it inline meant the verdict card couldn't appear
    # until it finished. backend/factchecks.py runs it after this evaluation is
    # stored and patches its entry into the row; everything below is
    # independent of it and never waits.
    if channel_id:
        channel = _safe("channel_fetch", ytdlp.fetch_channel, channel_id)
        if channel.get("channel_id"):
            breakdown.append(
                _run("upload_pattern", youtube.score_upload_pattern, channel, video_length_seconds)
            )
            breakdown.append(_run("account_age", youtube.score_account_age, channel))

    score = _score(breakdown)

    return {
        "video_id": video_id,
        "channel_id": channel_id,
        "score": score,
        "verdict": _verdict(score),
        "breakdown": breakdown,
        # Filled in later by backend/factchecks.py, which patches this row when
        # the check finishes. They stay None if it never ran (no credentials,
        # upstream error) or if the pre-gate ruled the video out.
        "is_educational": None,
        "thesis": None,
        "hallucinated": None,
        # Validity Score from the fact-check engine: independent of `score`
        # above (fact_check is never applied to the AI-slop deduction math).
        "validity_score": None,
        "validity_rating": None,
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
