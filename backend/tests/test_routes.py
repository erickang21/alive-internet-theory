"""Tests for the API routes, centred on GET /video/fact-check's response contract.

The route discriminates states that used to share one 404 (see HANDOFF.md):
404 is only "no evaluation row"; with a row, a stored report serves unchanged,
a genuine pre-gate skip answers {"status": "skipped"}, and a check that never
ran answers {"status": "unavailable"}. The old conflation is what left the
extension's bridge polling forever, which is why this file exists.
"""

import pytest
from flask import Flask

from backend.api import routes
from backend.factcheck.models import ValidityReport

STATUSES = ("verified_true", "mostly_true", "misleading", "false", "unverifiable")


def _report_dict(video_id: str = "vid1") -> dict:
    return ValidityReport(
        video_id=video_id,
        validity_score=88.0,
        rating="Highly Accurate",
        claim_count=0,
        verifiable_count=0,
        counts_by_status=dict.fromkeys(STATUSES, 0),
        verdicts=[],
        low_confidence=False,
        generated_at="2026-09-20T00:00:00+00:00",
        engine_version="1.0.0",
        model="gpt-5",
    ).to_dict()


def _entry(evidence: dict, detail: str = "detail text") -> dict:
    return {
        "criterion": "fact_check",
        "deduction": 0,
        "applied": False,
        "detail": detail,
        "evidence": evidence,
    }


def _pregate(source: str = "category") -> dict:
    return {
        "isEligible": False,
        "category": "gaming",
        "reason": "Gaming is not fact-checked.",
        "source": source,
    }


@pytest.fixture
def rows(monkeypatch: pytest.MonkeyPatch) -> dict:
    stored: dict[str, dict] = {}

    class FakeEvaluationRepository:
        def find_by_video_id(self, video_id: str) -> dict | None:
            return stored.get(video_id)

    monkeypatch.setattr(routes, "EvaluationRepository", FakeEvaluationRepository)
    return stored


@pytest.fixture
def client():
    app = Flask(__name__)
    app.register_blueprint(routes.api)
    return app.test_client()


# --- request validation ------------------------------------------------------


def test_fact_check_requires_video_id(client, rows):
    assert client.get("/video/fact-check").status_code == 400


def test_fact_check_rejects_unknown_format(client, rows):
    response = client.get("/video/fact-check?video_id=vid1&format=xml")
    assert response.status_code == 400


def test_evaluation_requires_video_id(client, rows):
    assert client.get("/video/evaluation").status_code == 400


# --- the four states of GET /video/fact-check --------------------------------


def test_no_evaluation_row_is_404(client, rows):
    response = client.get("/video/fact-check?video_id=missing")
    assert response.status_code == 404
    assert client.get("/video/evaluation?video_id=missing").status_code == 404


def test_stored_report_serves_unchanged(client, rows):
    report = _report_dict()
    rows["vid1"] = {"video_id": "vid1", "breakdown": [_entry({"report": report})]}

    response = client.get("/video/fact-check?video_id=vid1")
    assert response.status_code == 200
    # Byte-identical success payload: no wrapper, no added keys, so
    # report_from_dict and every existing consumer keep working.
    assert response.get_json() == report


def test_stored_report_renders_markdown(client, rows):
    rows["vid1"] = {"video_id": "vid1", "breakdown": [_entry({"report": _report_dict()})]}

    response = client.get("/video/fact-check?video_id=vid1&format=markdown")
    assert response.status_code == 200
    assert response.mimetype == "text/markdown"
    assert "Highly Accurate" in response.get_data(as_text=True)


def test_pregate_skip_is_200_skipped(client, rows):
    pregate = _pregate(source="category")
    rows["vid1"] = {"video_id": "vid1", "breakdown": [_entry({"pregate": pregate})]}

    response = client.get("/video/fact-check?video_id=vid1")
    assert response.status_code == 200
    assert response.get_json() == {"status": "skipped", "pregate": pregate}


def test_fallback_pregate_is_unavailable_not_skipped(client, rows):
    # The fail-closed fallback gate (classifier down, no credentials) never
    # classified the video, so it must not read as a statement about content.
    entry = _entry({"pregate": _pregate(source="fallback")}, detail="Not fact-checked: unknown.")
    rows["vid1"] = {"video_id": "vid1", "breakdown": [entry]}

    response = client.get("/video/fact-check?video_id=vid1")
    assert response.status_code == 200
    assert response.get_json() == {"status": "unavailable", "detail": "Not fact-checked: unknown."}


def test_credentials_skip_is_unavailable_with_detail(client, rows):
    detail = "Skipped: no usable fact-check LLM credentials."
    rows["vid1"] = {"video_id": "vid1", "breakdown": [_entry({"is_educational": None}, detail)]}

    response = client.get("/video/fact-check?video_id=vid1")
    assert response.status_code == 200
    assert response.get_json() == {"status": "unavailable", "detail": detail}


def test_row_without_fact_check_entry_is_unavailable(client, rows):
    rows["vid1"] = {"video_id": "vid1", "breakdown": [{"criterion": "gptzero", "deduction": 10}]}

    response = client.get("/video/fact-check?video_id=vid1")
    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "unavailable"
    assert body["detail"]
