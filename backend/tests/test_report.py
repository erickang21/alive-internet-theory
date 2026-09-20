"""Tests for report.py's Markdown/JSON rendering. No network, no LLM."""

from backend.factcheck.models import Citation, Claim, ClaimVerdict, ValidityReport
from backend.factcheck.report import to_json, to_markdown


def _claim(claim_id: str = "c1", weight: int = 2, timestamp_s: float | None = None) -> Claim:
    return Claim(
        id=claim_id,
        text="The moon is made of green cheese.",
        kind="scientific",
        weight=weight,
        search_query="moon composition",
        timestamp_s=timestamp_s,
    )


def _report(
    verdicts: list[ClaimVerdict],
    validity_score=None,
    rating="Insufficient Verifiable Data",
):
    return ValidityReport(
        video_id="vid123",
        validity_score=validity_score,
        rating=rating,
        claim_count=len(verdicts),
        verifiable_count=sum(1 for v in verdicts if v.truth_score is not None),
        counts_by_status=dict.fromkeys(
            ("verified_true", "mostly_true", "misleading", "false", "unverifiable"), 0
        ),
        verdicts=verdicts,
        low_confidence=False,
        generated_at="2026-09-19T00:00:00+00:00",
        engine_version="1.0.0",
        model="gpt-5",
    )


# --- debunked claim renders blockquote + clickable link ---------------------


def test_false_verdict_renders_blockquote_and_link():
    citation = Citation(
        title="NASA Moon Facts",
        domain="nasa.gov",
        url="https://nasa.gov/moon",
        quote="The moon is rock, not cheese.",
    )
    verdict = ClaimVerdict(
        claim=_claim(timestamp_s=125.0),
        status="false",
        truth_score=0.0,
        reasoning="Contradicted by NASA.",
        debunk="The moon is composed of rock, not cheese.",
        citations=[citation],
        sources_consulted=["https://nasa.gov/moon"],
    )
    report = _report([verdict], validity_score=0.0, rating="High Falsehood / Unreliable")
    md = to_markdown(report)

    assert "## Debunked claims" in md
    assert "> The moon is rock, not cheese." in md
    assert "[NASA Moon Facts](https://nasa.gov/moon)" in md
    assert "nasa.gov" in md
    assert "The moon is composed of rock, not cheese." in md
    assert "[02:05]" in md  # 125s -> 2m05s


# --- validity_score None renders the insufficient-data rating --------------


def test_none_validity_score_renders_insufficient_data():
    verdict = ClaimVerdict(
        claim=_claim(),
        status="unverifiable",
        truth_score=None,
        reasoning="No sources found.",
        unverifiable_reason="no sources were found for this claim",
    )
    report = _report([verdict], validity_score=None, rating="Insufficient Verifiable Data")
    md = to_markdown(report)

    assert "Insufficient Verifiable Data" in md
    assert "## Unverifiable claims" in md
    assert "no sources were found for this claim" in md


# --- empty report doesn't crash ---------------------------------------------


def test_empty_report_does_not_crash():
    report = _report([], validity_score=None, rating="Insufficient Verifiable Data")
    md = to_markdown(report)

    assert "# Fact-check report" in md
    assert "vid123" in md
    assert "No claims were extracted" in md


def test_empty_report_to_json_matches_to_dict():
    report = _report([], validity_score=None, rating="Insufficient Verifiable Data")
    assert to_json(report) == report.to_dict()


# --- timestamps render as [MM:SS] --------------------------------------------


def test_timestamp_renders_as_mm_ss():
    citation = Citation(
        title="Src", domain="example.com", url="https://example.com/x", quote="quoted text here"
    )
    verdict = ClaimVerdict(
        claim=_claim(timestamp_s=61.0),
        status="misleading",
        truth_score=0.25,
        reasoning="Partially wrong.",
        debunk="Only partially accurate.",
        citations=[citation],
    )
    report = _report([verdict], validity_score=25.0, rating="Misleading Content Risk")
    md = to_markdown(report)

    assert "[01:01]" in md


def test_no_timestamp_omits_bracket_marker():
    verdict = ClaimVerdict(
        claim=_claim(timestamp_s=None),
        status="verified_true",
        truth_score=1.0,
        reasoning="Confirmed.",
    )
    report = _report([verdict], validity_score=100.0, rating="Highly Accurate")
    md = to_markdown(report)

    assert "## Verified claims" in md
    assert "[00:00]" not in md


# --- multi-line quote can't break the blockquote -----------------------------


def test_multiline_quote_is_collapsed_in_blockquote():
    citation = Citation(
        title="Src",
        domain="example.com",
        url="https://example.com/x",
        quote="Line one of the quote.\nLine two of the quote.",
    )
    verdict = ClaimVerdict(
        claim=_claim(),
        status="false",
        truth_score=0.0,
        reasoning="Wrong.",
        debunk="It's wrong.",
        citations=[citation],
    )
    report = _report([verdict], validity_score=0.0, rating="High Falsehood / Unreliable")
    md = to_markdown(report)

    # The raw two-line quote text should never appear split across two
    # separate blockquote lines.
    assert "> Line one of the quote. Line two of the quote." in md
    assert "\n> Line two" not in md


# --- to_json delegates to to_dict --------------------------------------------


def test_to_json_delegates_to_dict():
    verdict = ClaimVerdict(
        claim=_claim(),
        status="verified_true",
        truth_score=1.0,
        reasoning="Confirmed.",
    )
    report = _report([verdict], validity_score=100.0, rating="Highly Accurate")
    assert to_json(report) == report.to_dict()
