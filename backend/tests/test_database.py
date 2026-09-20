"""Tests for the repository layer against a real temporary SQLite database.

find_scores_by_channel_id feeds the read-time channel-history criterion via
json_extract paths; a typo in either path would fail silently (siblings all
filter out and the criterion quietly stops applying), so this runs the real
SQL rather than a fake.
"""

from types import SimpleNamespace

import pytest

from backend.database import client as db_client
from backend.database.models import Base


@pytest.fixture
def repo(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        db_client, "config", SimpleNamespace(sqlite_path=str(tmp_path / "test.db"))
    )
    db_client.get_engine.cache_clear()
    Base.metadata.create_all(db_client.get_engine())
    yield db_client.EvaluationRepository()
    db_client.get_engine().dispose()
    db_client.get_engine.cache_clear()


def _evaluation(video_id: str, channel_id: str, **data) -> dict:
    return {"video_id": video_id, "channel_id": channel_id, "verdict": "likely_human", **data}


def test_find_scores_returns_only_the_two_channel_history_fields(repo):
    repo.upsert(
        _evaluation(
            "a", "UC1", score=90.5, metadata={"publish_date": "2026-01-01T00:00:00+00:00"}
        )
    )
    repo.upsert(_evaluation("b", "UC1", score=70))

    siblings = repo.find_scores_by_channel_id("UC1")

    assert sorted(siblings, key=lambda s: s["score"]) == [
        {"score": 70, "metadata": {"publish_date": None}},
        {"score": 90.5, "metadata": {"publish_date": "2026-01-01T00:00:00+00:00"}},
    ]


def test_find_scores_skips_scoreless_rows_and_other_channels(repo):
    repo.upsert(_evaluation("scoreless", "UC1"))
    repo.upsert(_evaluation("other-channel", "UC2", score=50))
    repo.upsert(_evaluation("kept", "UC1", score=80))

    assert repo.find_scores_by_channel_id("UC1") == [
        {"score": 80, "metadata": {"publish_date": None}}
    ]


def test_find_scores_excludes_the_video_being_served(repo):
    repo.upsert(_evaluation("self", "UC1", score=10))
    repo.upsert(_evaluation("sibling", "UC1", score=20))

    assert repo.find_scores_by_channel_id("UC1", exclude_video_id="self") == [
        {"score": 20, "metadata": {"publish_date": None}}
    ]
