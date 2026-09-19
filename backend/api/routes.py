from typing import Any, cast

from flask import Blueprint, jsonify, request

from backend.api import indexing
from backend.database import CommunityVoteRepository, EvaluationRepository

api = Blueprint("api", __name__)

VALID_VOTES = {"human", "ai"}


@api.get("/health")
def health():
    return jsonify({"status": "ok"})


@api.get("/video/evaluation")
def get_evaluation():
    video_id = request.args.get("video_id")
    if not video_id:
        return jsonify({"error": "video_id query parameter is required"}), 400

    evaluation = EvaluationRepository().find_by_video_id(video_id)
    if evaluation is None:
        return jsonify({"error": "this video hasn't been analyzed"}), 404

    evaluation["community_votes"] = CommunityVoteRepository().tally(video_id)
    return jsonify(evaluation)


@api.post("/video/evaluation")
def request_evaluation():
    """Return the stored evaluation, or quietly queue the video for indexing."""
    payload: object = request.get_json(silent=True)
    body = cast(dict[str, Any], payload) if isinstance(payload, dict) else {}
    video_id = body.get("video_id")
    if not isinstance(video_id, str) or not video_id:
        return jsonify({"error": "video_id is required and must be a string"}), 400

    repo = EvaluationRepository()
    evaluation = repo.find_by_video_id(video_id)
    if evaluation is None:
        status = indexing.request(video_id)
        # DONE here means the row landed between the read above and now.
        evaluation = repo.find_by_video_id(video_id) if status == indexing.DONE else None
        if evaluation is None:
            if status in (indexing.PENDING, indexing.DONE):
                return jsonify({"status": "indexing"}), 202
            return jsonify({"status": "failed", "detail": status})

    evaluation["community_votes"] = CommunityVoteRepository().tally(video_id)
    return jsonify(evaluation)


@api.post("/video/community-vote")
def community_vote():
    payload: object = request.get_json(silent=True)
    body = cast(dict[str, Any], payload) if isinstance(payload, dict) else {}
    video_id = body.get("video_id")
    voter_id = body.get("voter_id")
    vote = body.get("vote")

    if (
        not isinstance(video_id, str)
        or not isinstance(voter_id, str)
        or not video_id
        or not voter_id
    ):
        return jsonify({"error": "video_id and voter_id are required strings"}), 400
    if not isinstance(vote, str) or vote not in VALID_VOTES:
        return jsonify({"error": f"vote must be one of {sorted(VALID_VOTES)}"}), 400

    repo = CommunityVoteRepository()
    repo.record_vote(video_id, voter_id, vote)
    return jsonify({"video_id": video_id, "community_votes": repo.tally(video_id)}), 201
