from flask import Blueprint, jsonify, request

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

    # Evaluations are written offline by `python -m backend.analyze`; the API
    # only serves them.
    evaluation = EvaluationRepository().find_by_video_id(video_id)
    if evaluation is None:
        return jsonify({"error": "this video hasn't been analyzed"}), 404

    evaluation["community_votes"] = CommunityVoteRepository().tally(video_id)
    return jsonify(evaluation)


@api.post("/video/community-vote")
def community_vote():
    body = request.get_json(silent=True) or {}
    video_id = body.get("video_id")
    voter_id = body.get("voter_id")
    vote = body.get("vote")

    if not video_id or not voter_id:
        return jsonify({"error": "video_id and voter_id are required"}), 400
    if vote not in VALID_VOTES:
        return jsonify({"error": f"vote must be one of {sorted(VALID_VOTES)}"}), 400

    repo = CommunityVoteRepository()
    repo.record_vote(video_id, voter_id, vote)
    return jsonify({"video_id": video_id, "community_votes": repo.tally(video_id)}), 201
