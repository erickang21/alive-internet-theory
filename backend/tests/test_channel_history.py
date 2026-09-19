from backend.scoring import channel_history


class FakeEvaluationRepository:
    def __init__(self, evaluations):
        self._evaluations = evaluations

    def find_by_channel_id(self, channel_id, limit=50):
        return self._evaluations


def _install(monkeypatch, evaluations):
    monkeypatch.setattr(
        channel_history, "EvaluationRepository", lambda: FakeEvaluationRepository(evaluations)
    )


def test_needs_enough_prior_evaluations(monkeypatch):
    _install(monkeypatch, [{"video_id": "a", "verdict": "ai_slop"}])
    result = channel_history.score_channel("UC123", "current")
    assert result["applied"] is False
    assert result["deduction"] == 0


def test_excludes_current_video(monkeypatch):
    _install(
        monkeypatch,
        [
            {"video_id": "current", "verdict": "ai_slop"},
            {"video_id": "a", "verdict": "likely_human"},
        ],
    )
    result = channel_history.score_channel("UC123", "current")
    assert result["applied"] is False


def test_clean_channel_deducts_nothing(monkeypatch):
    _install(
        monkeypatch,
        [{"video_id": v, "verdict": "likely_human"} for v in ("a", "b", "c")],
    )
    result = channel_history.score_channel("UC123", "current")
    assert result["applied"] is True
    assert result["deduction"] == 0


def test_flagged_channel_deducts_proportionally(monkeypatch):
    _install(
        monkeypatch,
        [
            {"video_id": "a", "verdict": "ai_slop"},
            {"video_id": "b", "verdict": "possibly_ai"},
            {"video_id": "c", "verdict": "likely_human"},
            {"video_id": "d", "verdict": "likely_human"},
        ],
    )
    result = channel_history.score_channel("UC123", "current")
    assert result["deduction"] == channel_history.MAX_DEDUCTION * 0.5
