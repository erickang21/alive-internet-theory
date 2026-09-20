import pytest

from backend.factcheck.models import Claim, ClaimVerdict
from backend.factcheck.validity import (
    MIN_CONFIDENT_CLAIMS,
    RATING_HIGHLY_ACCURATE,
    RATING_INSUFFICIENT,
    RATING_MISLEADING,
    RATING_MOSTLY_RELIABLE,
    RATING_UNRELIABLE,
    build_report,
    compute_validity,
)


def _claim(weight: int, claim_id: str = "c1") -> Claim:
    return Claim(
        id=claim_id,
        text="Some claim text",
        kind="statistic",
        weight=weight,
        search_query="some query",
    )


def _verdict(status: str, truth_score: float | None, weight: int = 1, claim_id: str = "c1"):
    return ClaimVerdict(
        claim=_claim(weight, claim_id),
        status=status,
        truth_score=truth_score,
        reasoning="because",
    )


# --- normal mix -------------------------------------------------------------


def test_normal_mix_of_weights_and_statuses():
    verdicts = [
        _verdict("verified_true", 1.0, weight=3, claim_id="a"),
        _verdict("misleading", 0.25, weight=2, claim_id="b"),
        _verdict("false", 0.0, weight=1, claim_id="c"),
    ]
    # weighted = 3*1.0 + 2*0.25 + 1*0.0 = 3.5; weight_sum = 6
    # score = 3.5 / 6 * 100 = 58.333... -> rounds to 58.3
    score, rating, low_confidence = compute_validity(verdicts)
    assert score == 58.3
    assert rating == RATING_MISLEADING
    assert low_confidence is False  # 3 verifiable claims, not < MIN_CONFIDENT_CLAIMS


# --- zero verifiable claims --------------------------------------------------


def test_zero_verifiable_count_returns_insufficient_data():
    score, rating, low_confidence = compute_validity([])
    assert (score, rating, low_confidence) == (None, RATING_INSUFFICIENT, False)


def test_every_claim_unverifiable_returns_insufficient_data():
    verdicts = [
        _verdict("unverifiable", None, claim_id="a"),
        _verdict("unverifiable", None, claim_id="b"),
    ]
    score, rating, low_confidence = compute_validity(verdicts)
    assert (score, rating, low_confidence) == (None, RATING_INSUFFICIENT, False)


# --- band boundaries ----------------------------------------------------------


@pytest.mark.parametrize(
    "truth_score, expected_score, expected_rating",
    [
        (0.850, 85.0, RATING_HIGHLY_ACCURATE),
        (0.849, 84.9, RATING_MOSTLY_RELIABLE),
        (0.650, 65.0, RATING_MOSTLY_RELIABLE),
        (0.649, 64.9, RATING_MISLEADING),
        (0.400, 40.0, RATING_MISLEADING),
        (0.399, 39.9, RATING_UNRELIABLE),
    ],
)
def test_band_boundaries(truth_score, expected_score, expected_rating):
    # A single weight-1 claim makes the weighted average equal truth_score
    # exactly, so we can hit each boundary precisely.
    verdicts = [_verdict("mostly_true", truth_score, weight=1)]
    score, rating, _ = compute_validity(verdicts)
    assert score == expected_score
    assert rating == expected_rating


# --- low_confidence threshold -------------------------------------------------


def test_low_confidence_true_at_two_verifiable_claims():
    assert MIN_CONFIDENT_CLAIMS == 3
    verdicts = [
        _verdict("verified_true", 1.0, claim_id="a"),
        _verdict("verified_true", 1.0, claim_id="b"),
    ]
    _, _, low_confidence = compute_validity(verdicts)
    assert low_confidence is True


def test_low_confidence_false_at_three_verifiable_claims():
    verdicts = [
        _verdict("verified_true", 1.0, claim_id="a"),
        _verdict("verified_true", 1.0, claim_id="b"),
        _verdict("verified_true", 1.0, claim_id="c"),
    ]
    _, _, low_confidence = compute_validity(verdicts)
    assert low_confidence is False


# --- zero-weight guard ---------------------------------------------------------


def test_zero_weight_sum_does_not_raise():
    verdicts = [_verdict("mostly_true", 0.75, weight=0)]
    # Must not raise ZeroDivisionError.
    score, rating, low_confidence = compute_validity(verdicts)
    assert (score, rating, low_confidence) == (None, RATING_INSUFFICIENT, False)


# --- ClaimVerdict invariant ------------------------------------------------


def test_false_status_with_none_truth_score_raises():
    with pytest.raises(ValueError):
        ClaimVerdict(
            claim=_claim(1),
            status="false",
            truth_score=None,
            reasoning="because",
        )


def test_unverifiable_status_with_non_none_truth_score_raises():
    with pytest.raises(ValueError):
        ClaimVerdict(
            claim=_claim(1),
            status="unverifiable",
            truth_score=0.5,
            reasoning="because",
        )


# --- build_report --------------------------------------------------------------


def test_build_report_assembles_counts_and_metadata():
    verdicts = [
        _verdict("verified_true", 1.0, claim_id="a"),
        _verdict("unverifiable", None, claim_id="b"),
    ]
    report = build_report("vid123", verdicts, "gpt-5")
    assert report.video_id == "vid123"
    assert report.claim_count == 2
    assert report.verifiable_count == 1
    assert report.counts_by_status == {
        "verified_true": 1,
        "mostly_true": 0,
        "misleading": 0,
        "false": 0,
        "unverifiable": 1,
    }
    assert report.model == "gpt-5"
    assert report.engine_version == "1.0.0"
    assert report.generated_at  # non-empty ISO8601 string
