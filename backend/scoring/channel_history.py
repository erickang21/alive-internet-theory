from typing import Any

from backend.database import EvaluationRepository

MAX_DEDUCTION = 10
MIN_PRIOR_EVALUATIONS = 2
FLAGGED_VERDICTS = {"possibly_ai", "ai_slop"}


def score_channel(channel_id: str, current_video_id: str) -> dict[str, Any]:
    priors = [
        evaluation
        for evaluation in EvaluationRepository().find_by_channel_id(channel_id)
        if evaluation.get("video_id") != current_video_id and evaluation.get("verdict")
    ]

    if len(priors) < MIN_PRIOR_EVALUATIONS:
        return {
            "criterion": "channel_history",
            "deduction": 0,
            "applied": False,
            "detail": "Not enough of this channel's videos evaluated yet.",
        }

    flagged = sum(1 for evaluation in priors if evaluation["verdict"] in FLAGGED_VERDICTS)
    flagged_fraction = flagged / len(priors)
    deduction = round(MAX_DEDUCTION * flagged_fraction, 1)

    return {
        "criterion": "channel_history",
        "deduction": deduction,
        "applied": True,
        "detail": (
            f"{flagged} of this channel's {len(priors)} previously scored videos "
            "looked AI-generated."
        ),
        "evidence": {"prior_evaluations": len(priors), "flagged": flagged},
    }
