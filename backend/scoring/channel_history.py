from statistics import mean
from typing import Any

MAX_ADJUSTMENT = 10
# An average at the likely-human threshold is neutral: +10 at 100, -10 at 50 or below.
NEUTRAL_SCORE = 75
FULL_SWING_POINTS = 25
# One past video is thin evidence, so the swing ramps up with the sample size.
FULL_CONFIDENCE_VIDEOS = 5
RECENT_VIDEOS = 20


def _published_at(video: dict[str, Any]) -> str:
    return video.get("metadata", {}).get("publish_date") or ""


def score_channel_history(siblings: list[dict[str, Any]]) -> dict[str, Any]:
    """Reward or punish a video for the channel's other evaluations.

    Siblings are scored without this criterion (it is applied when an evaluation is
    served, never stored), so a channel's reputation can't feed on itself.
    """
    # Newest uploads first, so a channel that turned to AI recently stops coasting
    # on its old videos. Uploads we have no publish date for sort last.
    recent = sorted(siblings, key=_published_at, reverse=True)[:RECENT_VIDEOS]
    if not recent:
        return {
            "criterion": "channel_history",
            "deduction": 0,
            "applied": False,
            "detail": "No other videos from this channel have been analyzed yet.",
        }

    average = mean(video["score"] for video in recent)
    intensity = max(-1.0, min(1.0, (average - NEUTRAL_SCORE) / FULL_SWING_POINTS))
    confidence = min(len(recent) / FULL_CONFIDENCE_VIDEOS, 1.0)
    adjustment = round(MAX_ADJUSTMENT * intensity * confidence, 1)

    return {
        "criterion": "channel_history",
        # A good track record is a bonus, which the engine sums as a negative deduction.
        "deduction": -adjustment if adjustment else 0.0,
        "applied": True,
        "detail": (
            f"{len(recent)} other analyzed video{'' if len(recent) == 1 else 's'} "
            f"from this channel average {average:.1f}/100."
        ),
        "evidence": {"videos_sampled": len(recent), "average_score": round(average, 1)},
    }
