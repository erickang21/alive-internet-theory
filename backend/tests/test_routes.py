import pytest

from backend.api import routes
from backend.api.app import create_app
from backend.database import DatabaseUnavailableError


class FakeEvaluationRepository:
    store = {}

    def find_by_video_id(self, video_id):
        return self.store.get(video_id)

    def upsert(self, evaluation):
        self.store[evaluation["video_id"]] = evaluation
        return evaluation


class FakeCommunityVoteRepository:
    votes = {}

    def record_vote(self, video_id, voter_id, vote):
        self.votes.setdefault(video_id, {})[voter_id] = vote

    def tally(self, video_id):
        counts = {}
        for vote in self.votes.get(video_id, {}).values():
            counts[vote] = counts.get(vote, 0) + 1
        return counts


class UnavailableRepository:
    def __init__(self):
        raise DatabaseUnavailableError("no db configured")


def fake_evaluate_video(video_id, transcript, track_kind, channel_id, video_length_seconds):
    fake_evaluate_video.calls += 1
    return {
        "video_id": video_id,
        "channel_id": channel_id,
        "score": 88.0,
        "verdict": "likely_human",
        "breakdown": [],
    }


@pytest.fixture
def client(monkeypatch):
    FakeEvaluationRepository.store = {}
    FakeCommunityVoteRepository.votes = {}
    fake_evaluate_video.calls = 0
    monkeypatch.setattr(routes, "EvaluationRepository", FakeEvaluationRepository)
    monkeypatch.setattr(routes, "CommunityVoteRepository", FakeCommunityVoteRepository)
    monkeypatch.setattr(routes, "evaluate_video", fake_evaluate_video)
    return create_app().test_client()


@pytest.fixture
def db_down_client(monkeypatch):
    fake_evaluate_video.calls = 0
    monkeypatch.setattr(routes, "EvaluationRepository", UnavailableRepository)
    monkeypatch.setattr(routes, "CommunityVoteRepository", UnavailableRepository)
    monkeypatch.setattr(routes, "evaluate_video", fake_evaluate_video)
    return create_app().test_client()


def _post_evaluation(client, video_id="vid1"):
    return client.post(
        "/video/evaluation",
        json={
            "video_id": video_id,
            "transcript": {"text": "hello world", "kind": "asr", "language": "en"},
            "metadata": {"channel_id": "UC123", "length_seconds": 300},
        },
    )


def test_health(client):
    assert client.get("/health").status_code == 200


def test_get_requires_video_id(client):
    assert client.get("/video/evaluation").status_code == 400


def test_get_unknown_video_is_404(client):
    assert client.get("/video/evaluation?video_id=nope").status_code == 404


def test_post_requires_transcript(client):
    response = client.post("/video/evaluation", json={"video_id": "vid1"})
    assert response.status_code == 400


def test_evaluate_once_then_serve_from_cache(client):
    first = _post_evaluation(client)
    assert first.status_code == 201
    assert fake_evaluate_video.calls == 1

    second = _post_evaluation(client)
    assert second.status_code == 200
    assert fake_evaluate_video.calls == 1
    assert second.get_json()["video_id"] == "vid1"

    cached = client.get("/video/evaluation?video_id=vid1")
    assert cached.status_code == 200
    assert cached.get_json()["score"] == 88.0


def test_force_refresh_re_evaluates(client):
    _post_evaluation(client)
    response = client.post(
        "/video/evaluation",
        json={
            "video_id": "vid1",
            "transcript": {"text": "hello world"},
            "metadata": {},
            "force_refresh": True,
        },
    )
    assert response.status_code == 201
    assert fake_evaluate_video.calls == 2


def test_post_still_evaluates_when_db_down(db_down_client):
    response = _post_evaluation(db_down_client)
    assert response.status_code == 201
    assert response.get_json()["verdict"] == "likely_human"
    assert fake_evaluate_video.calls == 1


def test_get_returns_404_when_db_down(db_down_client):
    assert db_down_client.get("/video/evaluation?video_id=vid1").status_code == 404


def test_vote_validation(client):
    response = client.post(
        "/video/community-vote", json={"video_id": "vid1", "voter_id": "u1", "vote": "banana"}
    )
    assert response.status_code == 400


def test_vote_tally(client):
    response = client.post(
        "/video/community-vote", json={"video_id": "vid1", "voter_id": "u1", "vote": "ai"}
    )
    assert response.status_code == 201
    assert response.get_json()["community_votes"] == {"ai": 1}


def test_vote_returns_503_when_db_down(db_down_client):
    response = db_down_client.post(
        "/video/community-vote", json={"video_id": "vid1", "voter_id": "u1", "vote": "ai"}
    )
    assert response.status_code == 503
