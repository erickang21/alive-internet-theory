"""Tests for backend/scoring/fact_check.py — the adapter over FactCheckEngine.

No network, no LLM: `FactCheckEngine` itself is replaced with a fake that
returns a canned `ValidityReport`, so these tests exercise only the adapter's
own logic (the credential gate, legacy-field derivation, and the
breakdown-entry contract backend/scoring/engine.py depends on).
"""

import dataclasses

import pytest

from backend.factcheck.models import Claim, ClaimVerdict, ValidityReport
from backend.scoring import fact_check


@pytest.fixture(autouse=True)
def _reset_credentials_flag():
    """Every test starts with a clean module-level degradation flag."""
    fact_check._credentials_unusable = False
    yield
    fact_check._credentials_unusable = False


def _config(**overrides):
    return dataclasses.replace(fact_check.config, **overrides)


def _openai_credentials_present(monkeypatch, **overrides):
    monkeypatch.setattr(
        fact_check,
        "config",
        _config(factcheck_provider="openai", openai_api_key="sk-real", **overrides),
    )


def _no_credentials(monkeypatch):
    monkeypatch.setattr(
        fact_check, "config", _config(factcheck_provider="openai", openai_api_key="")
    )


def _claim(claim_id: str = "c1", weight: int = 2, text: str = "Some claim") -> Claim:
    return Claim(id=claim_id, text=text, kind="statistic", weight=weight, search_query="q")


def _verdict(claim: Claim, status: str = "verified_true", truth_score: float | None = 1.0):
    return ClaimVerdict(claim=claim, status=status, truth_score=truth_score, reasoning="r")


def _report(verdicts: list[ClaimVerdict], video_id: str = "v1") -> ValidityReport:
    verifiable = [v for v in verdicts if v.truth_score is not None]
    return ValidityReport(
        video_id=video_id,
        validity_score=50.0 if verifiable else None,
        rating="Mostly Reliable" if verifiable else "Insufficient Verifiable Data",
        claim_count=len(verdicts),
        verifiable_count=len(verifiable),
        counts_by_status=dict.fromkeys(
            ("verified_true", "mostly_true", "misleading", "false", "unverifiable"), 0
        ),
        verdicts=verdicts,
        low_confidence=False,
        generated_at="2026-09-19T00:00:00+00:00",
        engine_version="1.0.0",
        model="gpt-5",
    )


def _install_fake_engine(monkeypatch, report: ValidityReport):
    class _FakeEngine:
        def __init__(self, *args, **kwargs):
            pass

        def run(self, transcript, **kwargs):
            return report

    monkeypatch.setattr(fact_check, "FactCheckEngine", _FakeEngine)


def _install_poison_engine(monkeypatch):
    """A FactCheckEngine that raises if constructed — proves it was never called."""

    class _Poison:
        def __init__(self, *args, **kwargs):
            raise AssertionError("FactCheckEngine must not run without usable credentials")

    monkeypatch.setattr(fact_check, "FactCheckEngine", _Poison)


# --- always deduction=0 / applied=False -----------------------------------------


def test_always_deduction_zero_and_not_applied_on_success(monkeypatch):
    claim = _claim(weight=3)
    _openai_credentials_present(monkeypatch)
    _install_fake_engine(monkeypatch, _report([_verdict(claim, status="false", truth_score=0.0)]))

    result = fact_check.score_transcript("t")

    assert result["deduction"] == 0
    assert result["applied"] is False


def test_always_deduction_zero_and_not_applied_when_skipped(monkeypatch):
    _no_credentials(monkeypatch)
    _install_poison_engine(monkeypatch)

    result = fact_check.score_transcript("t")

    assert result["deduction"] == 0
    assert result["applied"] is False


# --- no credentials degrades exactly like the old code ---------------------------


def test_no_credentials_returns_skipped_entry_with_none_fields_and_warns_once(monkeypatch, caplog):
    _no_credentials(monkeypatch)
    _install_poison_engine(monkeypatch)

    with caplog.at_level("WARNING"):
        first = fact_check.score_transcript("t")
        second = fact_check.score_transcript("t")

    for result in (first, second):
        assert result["criterion"] == "fact_check"
        assert result["deduction"] == 0
        assert result["applied"] is False
        assert result["evidence"] == {
            "is_educational": None,
            "thesis": None,
            "hallucinated": None,
            "validity_score": None,
            "validity_rating": None,
        }
    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warnings) == 1
    assert fact_check._credentials_unusable is True


def test_gateway_provider_without_url_is_treated_as_unconfigured(monkeypatch):
    monkeypatch.setattr(
        fact_check,
        "config",
        _config(factcheck_provider="gateway", gateway_url="", browserbase_api_key="bb-real"),
    )
    _install_poison_engine(monkeypatch)

    result = fact_check.score_transcript("t")

    assert result["evidence"]["is_educational"] is None
    assert fact_check._credentials_unusable is True


def test_unusable_flag_short_circuits_subsequent_calls_without_rechecking_config(monkeypatch):
    _no_credentials(monkeypatch)
    _install_poison_engine(monkeypatch)
    fact_check.score_transcript("t")
    assert fact_check._credentials_unusable is True

    # Even if credentials "become" configured mid-run, the flag alone decides
    # -- matching the old Anthropic-specific code's "skip for the rest of the
    # run" behavior.
    _openai_credentials_present(monkeypatch)
    result = fact_check.score_transcript("t")

    assert result["evidence"]["is_educational"] is None


# --- legacy field derivation -----------------------------------------------------


def test_zero_claims_yields_not_educational_and_hallucinated_false_not_none(monkeypatch):
    _openai_credentials_present(monkeypatch)
    _install_fake_engine(monkeypatch, _report([]))

    result = fact_check.score_transcript("t")
    evidence = result["evidence"]

    assert evidence["is_educational"] is False
    assert evidence["thesis"] is None
    # False (not None): the check DID run, it just found nothing checkable.
    assert evidence["hallucinated"] is False


def test_thesis_is_text_of_highest_weight_claim(monkeypatch):
    _openai_credentials_present(monkeypatch)
    low = _claim("c1", weight=1, text="A minor background fact.")
    high = _claim("c2", weight=3, text="The core thesis of the video.")
    verdicts = [_verdict(low, status="verified_true"), _verdict(high, status="verified_true")]
    _install_fake_engine(monkeypatch, _report(verdicts))

    result = fact_check.score_transcript("t")

    assert result["evidence"]["is_educational"] is True
    assert result["evidence"]["thesis"] == "The core thesis of the video."


def test_hallucinated_true_when_top_claim_is_false(monkeypatch):
    _openai_credentials_present(monkeypatch)
    top = _claim("c1", weight=3, text="A false core claim.")
    verdicts = [_verdict(top, status="false", truth_score=0.0)]
    _install_fake_engine(monkeypatch, _report(verdicts))

    result = fact_check.score_transcript("t")

    assert result["evidence"]["hallucinated"] is True


def test_hallucinated_true_when_top_claim_is_misleading(monkeypatch):
    _openai_credentials_present(monkeypatch)
    top = _claim("c1", weight=3, text="A misleading core claim.")
    verdicts = [_verdict(top, status="misleading", truth_score=0.25)]
    _install_fake_engine(monkeypatch, _report(verdicts))

    result = fact_check.score_transcript("t")

    assert result["evidence"]["hallucinated"] is True


def test_hallucinated_false_when_top_claim_verified_true(monkeypatch):
    _openai_credentials_present(monkeypatch)
    top = _claim("c1", weight=3, text="A verified core claim.")
    verdicts = [_verdict(top, status="verified_true", truth_score=1.0)]
    _install_fake_engine(monkeypatch, _report(verdicts))

    result = fact_check.score_transcript("t")

    assert result["evidence"]["hallucinated"] is False


def test_hallucinated_false_when_top_claim_unverifiable(monkeypatch):
    _openai_credentials_present(monkeypatch)
    top = _claim("c1", weight=3, text="An unverifiable core claim.")
    verdicts = [_verdict(top, status="unverifiable", truth_score=None)]
    _install_fake_engine(monkeypatch, _report(verdicts))

    result = fact_check.score_transcript("t")

    assert result["evidence"]["hallucinated"] is False


# --- evidence carries validity score/rating and the full report ------------------


def test_evidence_includes_validity_score_rating_and_full_report(monkeypatch):
    _openai_credentials_present(monkeypatch)
    claim = _claim(weight=2)
    report = _report([_verdict(claim, status="verified_true")])
    _install_fake_engine(monkeypatch, report)

    result = fact_check.score_transcript("t")
    evidence = result["evidence"]

    assert evidence["validity_score"] == report.validity_score
    assert evidence["validity_rating"] == report.rating
    assert evidence["report"] == report.to_dict()


def test_detail_mentions_rating_and_claim_counts(monkeypatch):
    _openai_credentials_present(monkeypatch)
    claim = _claim(weight=2)
    report = _report([_verdict(claim, status="verified_true")])
    _install_fake_engine(monkeypatch, report)

    result = fact_check.score_transcript("t")

    assert report.rating in result["detail"]
    assert str(report.claim_count) in result["detail"]


# --- evidence_for_report() is what __main__.py's --no-store-free path stores -----


def test_evidence_for_report_matches_video_columns_shape():
    claim = _claim(weight=3, text="Top claim.")
    report = _report([_verdict(claim, status="false", truth_score=0.0)])

    fields = fact_check.evidence_for_report(report)

    assert fields == {
        "is_educational": True,
        "thesis": "Top claim.",
        "hallucinated": True,
        "validity_score": report.validity_score,
        "validity_rating": report.rating,
    }


# --- is_educational must mean "checkable content is the point" ---------------
# It approximates the old per-video classification. A single minor factual aside
# in a comedy video shouldn't make it "educational", so it takes either several
# claims or one the extractor judged central (weight 3).


def test_one_minor_claim_is_not_educational():
    report = _report([_verdict(_claim(weight=1))])
    assert fact_check._legacy_fields(report)["is_educational"] is False


def test_a_single_core_claim_is_educational():
    report = _report([_verdict(_claim(weight=fact_check.CORE_CLAIM_WEIGHT))])
    assert fact_check._legacy_fields(report)["is_educational"] is True


def test_several_minor_claims_are_educational():
    verdicts = [
        _verdict(_claim(claim_id=f"c{i}", weight=1))
        for i in range(fact_check.MIN_EDUCATIONAL_CLAIMS)
    ]
    assert fact_check._legacy_fields(_report(verdicts))["is_educational"] is True


def test_unverifiable_thesis_is_not_reported_as_hallucinated():
    # "we couldn't check it" is not "the video is wrong".
    report = _report([_verdict(_claim(weight=3), status="unverifiable", truth_score=None)])
    fields = fact_check._legacy_fields(report)
    assert fields["hallucinated"] is False


def test_false_thesis_is_reported_as_hallucinated():
    report = _report([_verdict(_claim(weight=3), status="false", truth_score=0.0)])
    assert fact_check._legacy_fields(report)["hallucinated"] is True
