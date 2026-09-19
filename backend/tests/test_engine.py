"""Tests for backend/factcheck/engine.py — orchestration only, no network/LLM.

engine.py imports extract/evidence/verify eagerly at module level and keeps
direct references to them (`engine.extract`, `engine.evidence`,
`engine.verify` ARE `backend.factcheck.extract` etc, not lazy attribute
lookups), so patching functions directly on those module objects is enough —
no sys.modules dance needed here (that's only required for modules that do
`from backend.factcheck import X` lazily inside a function, like verify.py).
"""

from backend.factcheck import engine, validity
from backend.factcheck.models import Claim, ClaimVerdict, Source


def _claim(claim_id: str = "c1", weight: int = 2, text: str = "Some claim") -> Claim:
    return Claim(id=claim_id, text=text, kind="statistic", weight=weight, search_query="q")


def _verdict(claim: Claim, status: str = "verified_true", truth_score: float | None = 1.0):
    return ClaimVerdict(claim=claim, status=status, truth_score=truth_score, reasoning="r")


def _fake_extract_claims(claims: list[Claim]):
    def _fn(transcript, max_claims=None):
        return claims

    return _fn


# --- zero claims -------------------------------------------------------------


def test_zero_claims_returns_empty_report_without_touching_evidence_or_verify(monkeypatch):
    touched = []
    monkeypatch.setattr(engine.extract, "extract_claims", lambda transcript, max_claims=None: [])
    monkeypatch.setattr(
        engine.evidence, "gather_all", lambda claims: touched.append("evidence") or {}
    )
    monkeypatch.setattr(
        engine.verify, "verify_all", lambda claims, sources: touched.append("verify") or []
    )

    report = engine.FactCheckEngine(video_id="v0").run("some transcript")

    assert report.claim_count == 0
    assert report.verifiable_count == 0
    assert report.validity_score is None
    assert report.rating == "Insufficient Verifiable Data"
    assert report.verdicts == []
    assert report.video_id == "v0"
    # Zero claims short-circuits before ever gathering evidence or verifying.
    assert touched == []


def test_empty_transcript_never_raises(monkeypatch):
    monkeypatch.setattr(engine.extract, "extract_claims", lambda transcript, max_claims=None: [])
    monkeypatch.setattr(engine.evidence, "gather_all", lambda claims: {})
    monkeypatch.setattr(engine.verify, "verify_all", lambda claims, sources: [])

    report = engine.FactCheckEngine().run("")

    assert report.claim_count == 0
    assert report.rating == "Insufficient Verifiable Data"


# --- happy path ----------------------------------------------------------------


def test_happy_path_score_matches_validity_compute_validity(monkeypatch):
    claim_a = _claim("c1", weight=3)
    claim_b = _claim("c2", weight=1)
    verdict_a = _verdict(claim_a, status="verified_true", truth_score=1.0)
    verdict_b = _verdict(claim_b, status="false", truth_score=0.0)

    monkeypatch.setattr(engine.extract, "extract_claims", _fake_extract_claims([claim_a, claim_b]))
    monkeypatch.setattr(engine.extract, "attach_timestamps", lambda claims, segments: None)
    source = Source(
        url="https://nasa.gov/x",
        domain="nasa.gov",
        title="t",
        tier=1,
        fetched_ok=True,
        markdown="x" * 300,
    )
    monkeypatch.setattr(
        engine.evidence, "gather_all", lambda claims: {c.id: [source] for c in claims}
    )
    monkeypatch.setattr(engine.verify, "verify_all", lambda claims, sources: [verdict_a, verdict_b])

    report = engine.FactCheckEngine(video_id="v1").run("transcript text")

    expected_score, expected_rating, expected_low_conf = validity.compute_validity(
        [verdict_a, verdict_b]
    )
    assert report.validity_score == expected_score
    assert report.rating == expected_rating
    assert report.low_confidence == expected_low_conf
    assert report.video_id == "v1"
    assert report.claim_count == 2
    assert report.verifiable_count == 2
    assert [v.status for v in report.verdicts] == ["verified_true", "false"]


def test_all_unverifiable_verdicts_yield_insufficient_data(monkeypatch):
    claim = _claim()
    unverifiable = ClaimVerdict(
        claim=claim, status="unverifiable", truth_score=None, reasoning="no sources"
    )
    monkeypatch.setattr(engine.extract, "extract_claims", _fake_extract_claims([claim]))
    monkeypatch.setattr(engine.extract, "attach_timestamps", lambda claims, segments: None)
    monkeypatch.setattr(engine.evidence, "gather_all", lambda claims: {claim.id: []})
    monkeypatch.setattr(engine.verify, "verify_all", lambda claims, sources: [unverifiable])

    report = engine.FactCheckEngine().run("t")

    assert report.claim_count == 1
    assert report.verifiable_count == 0
    assert report.validity_score is None
    assert report.rating == "Insufficient Verifiable Data"


# --- wiring: arguments flow through correctly -----------------------------------


def test_attach_timestamps_receives_the_segments_argument(monkeypatch):
    claim = _claim()
    received = {}

    def fake_attach(claims, segments):
        received["segments"] = segments

    monkeypatch.setattr(engine.extract, "extract_claims", _fake_extract_claims([claim]))
    monkeypatch.setattr(engine.extract, "attach_timestamps", fake_attach)
    monkeypatch.setattr(engine.evidence, "gather_all", lambda claims: {})
    monkeypatch.setattr(engine.verify, "verify_all", lambda claims, sources: [_verdict(claim)])

    segments = [{"start": 1.0, "text": "hi"}]
    engine.FactCheckEngine().run("t", segments=segments)

    assert received["segments"] == segments


def test_max_claims_is_passed_through_to_extract_claims(monkeypatch):
    received = {}

    def fake_extract(transcript, max_claims=None):
        received["max_claims"] = max_claims
        return []

    monkeypatch.setattr(engine.extract, "extract_claims", fake_extract)
    monkeypatch.setattr(engine.evidence, "gather_all", lambda claims: {})
    monkeypatch.setattr(engine.verify, "verify_all", lambda claims, sources: [])

    engine.FactCheckEngine(max_claims=7).run("t")

    assert received["max_claims"] == 7


def test_check_transcript_wrapper_delegates_to_engine(monkeypatch):
    monkeypatch.setattr(engine.extract, "extract_claims", lambda transcript, max_claims=None: [])
    monkeypatch.setattr(engine.evidence, "gather_all", lambda claims: {})
    monkeypatch.setattr(engine.verify, "verify_all", lambda claims, sources: [])

    report = engine.check_transcript("t", video_id="v2", max_claims=5)

    assert report.video_id == "v2"
    assert report.claim_count == 0
