import pytest

from backend.scoring import engine


def _criterion(name, deduction, applied=True):
    return {"criterion": name, "deduction": deduction, "applied": applied, "detail": ""}


@pytest.fixture
def stub_criteria(monkeypatch):
    def install(gptzero=0, fillers=0, upload=0, age=0, history=0):
        monkeypatch.setattr(
            engine.gptzero, "score_transcript", lambda t: _criterion("gptzero_transcript", gptzero)
        )
        monkeypatch.setattr(
            engine.fillers, "score_transcript", lambda t, k: _criterion("filler_words", fillers)
        )
        monkeypatch.setattr(engine.youtube, "fetch_channel", lambda c: {"channel_id": c})
        monkeypatch.setattr(
            engine.youtube,
            "score_upload_pattern",
            lambda c, s: _criterion("upload_pattern", upload),
        )
        monkeypatch.setattr(
            engine.youtube, "score_account_age", lambda c: _criterion("account_age", age)
        )
        monkeypatch.setattr(
            engine.channel_history,
            "score_channel",
            lambda c, v: _criterion("channel_history", history),
        )

    return install


def _evaluate(channel_id="UC123"):
    return engine.evaluate_video(
        video_id="vid1",
        transcript="text",
        track_kind="asr",
        channel_id=channel_id,
        video_length_seconds=600,
    )


def test_perfect_score_is_likely_human(stub_criteria):
    stub_criteria()
    result = _evaluate()
    assert result["score"] == 100
    assert result["verdict"] == "likely_human"
    assert len(result["breakdown"]) == 5


def test_deductions_sum_and_verdict_bands(stub_criteria):
    stub_criteria(gptzero=30, fillers=10)
    result = _evaluate()
    assert result["score"] == 60
    assert result["verdict"] == "possibly_ai"

    stub_criteria(gptzero=45, fillers=20)
    assert _evaluate()["verdict"] == "ai_slop"


def test_score_never_goes_negative(stub_criteria):
    stub_criteria(gptzero=45, fillers=20, upload=10, age=5, history=25)
    result = _evaluate()
    assert result["score"] == 0
    assert result["verdict"] == "ai_slop"


def test_failing_criterion_degrades_not_crashes(stub_criteria, monkeypatch):
    stub_criteria(fillers=5)

    def boom(transcript):
        raise RuntimeError("GPTZero down")

    monkeypatch.setattr(engine.gptzero, "score_transcript", boom)
    result = _evaluate()
    gptzero_entry = next(
        item for item in result["breakdown"] if item["criterion"] == "gptzero_transcript"
    )
    assert gptzero_entry["applied"] is False
    assert result["score"] == 95


def test_missing_channel_id_skips_channel_criteria(stub_criteria):
    stub_criteria()
    result = _evaluate(channel_id=None)
    skipped = {item["criterion"] for item in result["breakdown"] if not item["applied"]}
    assert {"upload_pattern", "account_age", "channel_history"} <= skipped
    assert result["score"] == 100


def test_channel_fetch_failure_keeps_channel_criteria_visible(stub_criteria, monkeypatch):
    stub_criteria()

    def boom(channel_id):
        raise RuntimeError("quota exceeded")

    monkeypatch.setattr(engine.youtube, "fetch_channel", boom)
    result = _evaluate()
    criteria = {item["criterion"] for item in result["breakdown"]}
    assert {"upload_pattern", "account_age", "channel_history"} <= criteria
