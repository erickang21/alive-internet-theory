from typing import Any, cast

from flask import Blueprint, jsonify, request

from backend.community_votes.repository import VALID_VOTES, CommunityVoteRepository
from backend.database import EvaluationRepository

community_votes_api = Blueprint("community_votes_api", __name__)


@community_votes_api.post("/video/community-vote")
def post_vote():
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
    if EvaluationRepository().find_by_video_id(video_id) is None:
        return jsonify({"error": "this video hasn't been analyzed"}), 404

    repo = CommunityVoteRepository()
    repo.record_vote(video_id, voter_id, vote)
    return jsonify({"video_id": video_id, "community_votes": repo.overview(video_id)}), 201


@community_votes_api.get("/video/community-votes")
def get_overview():
    video_id = request.args.get("video_id")
    if not video_id:
        return jsonify({"error": "video_id query parameter is required"}), 400
    if EvaluationRepository().find_by_video_id(video_id) is None:
        return jsonify({"error": "this video hasn't been analyzed"}), 404

    overview = CommunityVoteRepository().overview(video_id)
    return jsonify({"video_id": video_id, "community_votes": overview})
