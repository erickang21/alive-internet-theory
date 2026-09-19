"""Validity scoring: weighted average of verdict truth scores, plus rating bands.

Pure and side-effect free — no I/O, no logging, no imports beyond stdlib and
`backend.factcheck.models`. `report.py` (owned elsewhere) calls `build_report`
to assemble the final API payload.
"""

from datetime import UTC, datetime

from backend.factcheck.models import ClaimVerdict, Status, ValidityReport

ENGINE_VERSION = "1.0.0"

# Rating bands, inclusive lower bound, applied to the ROUNDED score.
BAND_HIGHLY_ACCURATE = 85.0
BAND_MOSTLY_RELIABLE = 65.0
BAND_MISLEADING = 40.0

RATING_HIGHLY_ACCURATE = "Highly Accurate"
RATING_MOSTLY_RELIABLE = "Mostly Reliable"
RATING_MISLEADING = "Misleading Content Risk"
RATING_UNRELIABLE = "High Falsehood / Unreliable"
RATING_INSUFFICIENT = "Insufficient Verifiable Data"

# Below this many verifiable claims, the score is real but shaky.
MIN_CONFIDENT_CLAIMS = 3


def compute_validity(verdicts: list[ClaimVerdict]) -> tuple[float | None, str, bool]:
    """Weighted mean of truth_score over verifiable claims, scaled to 0-100.

    Verdicts with truth_score=None (status "unverifiable") are excluded from
    both the numerator and the denominator.
    """
    verifiable = [v for v in verdicts if v.truth_score is not None]
    if not verifiable:
        return None, RATING_INSUFFICIENT, False

    weight_sum = sum(v.claim.weight for v in verifiable)
    if weight_sum == 0:
        # Weights are documented as 1|2|3, but nothing in the type system
        # enforces that — guard the division rather than trust callers.
        return None, RATING_INSUFFICIENT, False

    weighted_sum = sum(v.claim.weight * v.truth_score for v in verifiable)
    score = round(weighted_sum / weight_sum * 100, 1)
    rating = _rating_for(score)
    low_confidence = len(verifiable) < MIN_CONFIDENT_CLAIMS
    return score, rating, low_confidence


def _rating_for(score: float) -> str:
    if score >= BAND_HIGHLY_ACCURATE:
        return RATING_HIGHLY_ACCURATE
    if score >= BAND_MOSTLY_RELIABLE:
        return RATING_MOSTLY_RELIABLE
    if score >= BAND_MISLEADING:
        return RATING_MISLEADING
    return RATING_UNRELIABLE


def build_report(
    video_id: str | None,
    verdicts: list[ClaimVerdict],
    model: str,
) -> ValidityReport:
    """Assemble the full report from a list of verdicts."""
    validity_score, rating, low_confidence = compute_validity(verdicts)
    verifiable_count = sum(1 for v in verdicts if v.truth_score is not None)

    counts_by_status: dict[str, int] = dict.fromkeys(
        ("verified_true", "mostly_true", "misleading", "false", "unverifiable"), 0
    )
    for v in verdicts:
        status: Status = v.status
        counts_by_status[status] += 1

    return ValidityReport(
        video_id=video_id,
        validity_score=validity_score,
        rating=rating,
        claim_count=len(verdicts),
        verifiable_count=verifiable_count,
        counts_by_status=counts_by_status,
        verdicts=verdicts,
        low_confidence=low_confidence,
        generated_at=datetime.now(UTC).isoformat(),
        engine_version=ENGINE_VERSION,
        model=model,
    )
