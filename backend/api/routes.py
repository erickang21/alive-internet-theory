import logging

from flask import Blueprint, jsonify, request
from pymongo.errors import PyMongoError

from backend.database import CommunityVoteRepository, DatabaseUnavailableError, EvaluationRepository
from backend.scoring import evaluate_video

api = Blueprint("api", __name__)
logger = logging.getLogger(__name__)

VALID_VOTES = {"human", "ai"}

DB_ERRORS = (DatabaseUnavailableError, PyMongoError)


@api.get("/health")
def health():
    return jsonify({"status": "ok"})


@api.get("/video/evaluation")
def get_evaluation():
    video_id = request.args.get("video_id")
    if not video_id:
        return jsonify({"error": "video_id query parameter is required"}), 400

    # A DB outage means "not cached": the extension falls through to POST,
    # which can still evaluate without persistence.
    try:
        evaluation = EvaluationRepository().find_by_video_id(video_id)
    except DB_ERRORS:
        logger.warning("database unavailable while reading evaluation for %s", video_id)
        evaluation = None
    if evaluation is None:
        return jsonify({"error": "no evaluation for this video yet"}), 404

    try:
        evaluation["community_votes"] = CommunityVoteRepository().tally(video_id)
    except DB_ERRORS:
        evaluation["community_votes"] = {}
    return jsonify(evaluation)


@api.post("/video/evaluation")
def create_evaluation():
    body = request.get_json(silent=True) or {}
    video_id = body.get("video_id")
    transcript = body.get("transcript")
    metadata = body.get("metadata")
    transcript = transcript if isinstance(transcript, dict) else {}
    metadata = metadata if isinstance(metadata, dict) else {}

    if not video_id:
        return jsonify({"error": "video_id is required"}), 400
    if not transcript.get("text"):
        return jsonify({"error": "transcript.text is required"}), 400

    try:
        length_seconds = int(metadata.get("length_seconds") or 0)
    except (TypeError, ValueError):
        length_seconds = 0

    repo = None
    existing = None
    try:
        repo = EvaluationRepository()
        existing = repo.find_by_video_id(video_id)
    except DB_ERRORS:
        logger.warning("database unavailable; evaluating %s without caching", video_id)
        repo = None
    if existing and not body.get("force_refresh"):
        return jsonify(existing)

    evaluation = evaluate_video(
        video_id=video_id,
        transcript=transcript["text"],
        track_kind=transcript.get("kind"),
        channel_id=metadata.get("channel_id"),
        video_length_seconds=length_seconds,
    )
    evaluation["metadata"] = {
        "length_seconds": metadata.get("length_seconds"),
        "publish_date": metadata.get("publish_date"),
        "author": metadata.get("author"),
        "transcript_kind": transcript.get("kind"),
        "transcript_language": transcript.get("language"),
    }
    if repo is not None:
        try:
            repo.upsert(evaluation)
        except DB_ERRORS:
            logger.warning("database unavailable; evaluation for %s not cached", video_id)
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

    try:
        repo = CommunityVoteRepository()
        repo.record_vote(video_id, voter_id, vote)
        tally = repo.tally(video_id)
    except DB_ERRORS:
        return jsonify({"error": "votes need the database, which is unreachable right now"}), 503
    return jsonify({"video_id": video_id, "community_votes": tally}), 201
