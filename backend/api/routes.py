from typing import Any, cast

from flask import Blueprint, Response, jsonify, request

from backend import factchecks
from backend.api import indexing
from backend.database import CommunityVoteRepository, EvaluationRepository
from backend.factcheck.report import report_from_dict, to_markdown
from backend.scoring import apply_channel_history

api = Blueprint("api", __name__)

VALID_VOTES = {"human", "ai"}
VALID_FACT_CHECK_FORMATS = {"json", "markdown"}


def _serve(evaluation: dict[str, Any]) -> dict[str, Any]:
    """Finish a stored evaluation: the channel-history criterion is scored here, on
    the channel's other stored videos, so it reflects everything analyzed so far."""
    video_id = evaluation["video_id"]
    channel_id = evaluation.get("channel_id")
    siblings = (
        EvaluationRepository().find_by_channel_id(channel_id, exclude_video_id=video_id)
        if channel_id
        else []
    )
    evaluation = apply_channel_history(evaluation, siblings)
    evaluation["community_votes"] = CommunityVoteRepository().tally(video_id)
    return evaluation


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

    return jsonify(_serve(evaluation))


@api.post("/video/evaluation")
def request_evaluation():
    """Return the stored evaluation, or quietly queue the video for indexing."""
    payload: object = request.get_json(silent=True)
    body = cast(dict[str, Any], payload) if isinstance(payload, dict) else {}
    video_id = body.get("video_id")
    if not isinstance(video_id, str) or not video_id:
        return jsonify({"error": "video_id is required and must be a string"}), 400

    if body.get("force") is True:
        _ = indexing.request(video_id, force=True)
    # A rerun keeps the old row until the new one lands, so don't serve it meanwhile.
    if indexing.is_pending(video_id):
        return jsonify({"status": "indexing"}), 202

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

    return jsonify(_serve(evaluation))


@api.get("/video/fact-check")
def get_fact_check():
    video_id = request.args.get("video_id")
    if not video_id:
        return jsonify({"error": "video_id query parameter is required"}), 400

    fmt = request.args.get("format", "json")
    if fmt not in VALID_FACT_CHECK_FORMATS:
        return jsonify({"error": f"format must be one of {sorted(VALID_FACT_CHECK_FORMATS)}"}), 400

    evaluation = EvaluationRepository().find_by_video_id(video_id)
    if evaluation is None:
        return jsonify({"error": "this video hasn't been analyzed"}), 404

    # A row exists, so 404 is over: the analysis ran, and the answer is one of
    # three states. A report serves as before (bare dict, so existing consumers
    # keep working); a pre-gate skip and a check that couldn't run each get a
    # discriminated 200 -- the report dict has no top-level "status" key, so the
    # shapes can't collide. A fallback-sourced pre-gate is not a classification
    # (the classifier was down or had no credentials), so it reads as
    # "unavailable", never as a statement about the video's content.
    entry = _fact_check_entry(evaluation)
    evidence = (entry or {}).get("evidence") or {}

    report_dict = evidence.get("report")
    if report_dict is not None:
        if fmt == "markdown":
            return Response(to_markdown(report_from_dict(report_dict)), mimetype="text/markdown")
        return jsonify(report_dict)

    # The check now runs after the evaluation is stored, so a row with no report
    # is the normal state for the first minutes of a video's life rather than a
    # dead end. While a job is in flight the phase is the answer, and it is
    # checked before the two terminal shapes below so a rerun can't serve a
    # stale "unavailable" while the new check is already running.
    running = factchecks.phase(video_id)
    if running is not None:
        return jsonify({"status": "running", "phase": running})

    pregate = evidence.get("pregate")
    if (
        isinstance(pregate, dict)
        and pregate.get("isEligible") is False
        and pregate.get("source") != "fallback"
    ):
        return jsonify({"status": "skipped", "pregate": pregate})

    # `detail` is prose the criterion wrote for a human. `reason` is a machine
    # key (engine._safe writes "upstream_error"; older rows carry
    # "no_credentials") and must NOT be substituted for it -- this endpoint's
    # answer goes straight into the extension's Fact check tab, and the contract
    # is that the backend sends fields and the frontend owns every sentence.
    # It rides along as its own field so the tab can say something better than
    # the fallback once it holds the wording for these keys.
    entry = entry or {}
    return jsonify(
        {
            "status": "unavailable",
            "detail": entry.get("detail") or "The fact check didn't run for this video.",
            "reason": entry.get("reason"),
        }
    )


def _fact_check_entry(evaluation: dict) -> dict | None:
    for item in evaluation.get("breakdown", []):
        if item.get("criterion") == "fact_check":
            return item
    return None


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
