from flask import Blueprint, jsonify, request

from backend.database import CommunityVoteRepository, EvaluationRepository
from backend.scoring import evaluate_video

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
        return jsonify({"error": "no evaluation for this video yet"}), 404

    evaluation["community_votes"] = CommunityVoteRepository().tally(video_id)
    return jsonify(evaluation)


@api.post("/video/evaluation")
def create_evaluation():
    body = request.get_json(silent=True) or {}
    video_id = body.get("video_id")
    transcript = body.get("transcript", {})
    metadata = body.get("metadata", {})

    if not video_id:
        return jsonify({"error": "video_id is required"}), 400
    if not transcript.get("text"):
        return jsonify({"error": "transcript.text is required"}), 400

    repo = EvaluationRepository()
    existing = repo.find_by_video_id(video_id)
    if existing and not body.get("force_refresh"):
        return jsonify(existing)

    evaluation = evaluate_video(
        video_id=video_id,
        transcript=transcript["text"],
        track_kind=transcript.get("kind"),
        channel_id=metadata.get("channel_id"),
        video_length_seconds=int(metadata.get("length_seconds") or 0),
    )
    evaluation["metadata"] = {
        "length_seconds": metadata.get("length_seconds"),
        "publish_date": metadata.get("publish_date"),
        "author": metadata.get("author"),
        "transcript_kind": transcript.get("kind"),
        "transcript_language": transcript.get("language"),
    }
    repo.upsert(evaluation)
    return jsonify(evaluation), 201


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
