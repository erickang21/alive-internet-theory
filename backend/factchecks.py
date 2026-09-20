"""The fact check, run off the critical path.

It used to be step 4 of 7 inside `evaluate_video`, which meant the verdict card
could not appear until minutes of sequential LLM calls had finished -- for a
criterion that is never scored (`deduction: 0, applied: False`; the Validity
Score is deliberately independent of the AI-slop score). Now `analyze_video`
stores the evaluation first and hands the video here, and this module patches
the finished entry into the stored row.

Two consequences worth knowing:

- **The evaluation never waits for this and never fails because of it.** A
  fact check that raises leaves the row exactly as the main analysis wrote it.
- **The phase is in memory, not in the row.** A backend restart mid-check
  loses it, the same way `api/indexing.py` forgets a failure on restart, and
  the row keeps whatever it had. Nothing retries on its own.
"""

import logging
import threading
from typing import Any

from backend.database import EvaluationRepository
from backend.scoring import fact_check

logger = logging.getLogger(__name__)

# The two phases the extension's fact-check tab distinguishes, named as the
# frontend's stages (frontend/src/shared/constants.js FACT_CHECK_STAGES) so the
# service worker passes them straight through instead of translating.
PREGATING = "checking_eligibility"
CHECKING = "fact_checking"

# Separate from api/indexing.py's MAX_CONCURRENT_ANALYSES, which is sized to
# keep yt-dlp off YouTube's bot radar from one residential IP. This work is
# LLM-bound and touches YouTube not at all, so it gets its own budget -- and
# stays small because each check is real API spend.
MAX_CONCURRENT_CHECKS = 2

_lock = threading.Lock()
# video_id -> PREGATING | CHECKING. Absent means "not running": either it never
# started, or it finished and the answer is in the row.
_phases: dict[str, str] = {}
_slots = threading.Semaphore(MAX_CONCURRENT_CHECKS)


def dispatch(
    video_id: str,
    *,
    transcript: str,
    title: str | None = None,
    description: str | None = None,
    categories: list[str] | None = None,
    background: bool = True,
) -> None:
    """Run the fact check for a video whose evaluation is already stored.

    `background=True` (the API) returns immediately and updates the row when
    the check lands. `background=False` (the analyze CLI) runs it inline, so a
    script that exits after its last video doesn't kill the check with it.
    """
    if not transcript:
        return
    with _lock:
        if video_id in _phases:
            logger.info("%s: fact check already running", video_id)
            return
        _phases[video_id] = PREGATING

    args = (video_id, transcript, title, description, categories)
    if background:
        threading.Thread(target=_run, args=args, daemon=True).start()
    else:
        _run(*args)


def phase(video_id: str) -> str | None:
    """PREGATING, CHECKING, or None when nothing is running for this video."""
    with _lock:
        return _phases.get(video_id)


def _run(
    video_id: str,
    transcript: str,
    title: str | None,
    description: str | None,
    categories: list[str] | None,
) -> None:
    try:
        with _slots:
            entry = _check(video_id, transcript, title, description, categories)
        if entry is not None:
            _store(video_id, entry)
    except Exception:
        # The evaluation is already stored and correct; this costs the fact
        # check alone, exactly as engine._safe used to do for it inline.
        logger.exception("%s: fact check failed", video_id)
    finally:
        with _lock:
            _ = _phases.pop(video_id, None)


def _check(
    video_id: str,
    transcript: str,
    title: str | None,
    description: str | None,
    categories: list[str] | None,
) -> dict[str, Any] | None:
    gate = fact_check.gate_video(
        transcript, title=title, description=description, categories=categories
    )
    if not gate.is_eligible:
        logger.info("%s: not fact-checked (%s)", video_id, gate.reason)
        return fact_check.entry_for_gate(gate)

    with _lock:
        _phases[video_id] = CHECKING
    logger.info("%s: fact-checking", video_id)
    entry = fact_check.run_engine(transcript)
    logger.info("%s: fact check done -- %s", video_id, entry.get("detail"))
    return entry


# The fields the fact check owns on the row. They are columns rather than
# `data` keys, so they have to be set explicitly alongside the breakdown entry.
_FACT_FIELDS = ("is_educational", "thesis", "hallucinated", "validity_score", "validity_rating")


def _store(video_id: str, entry: dict[str, Any]) -> None:
    """Patch the finished entry into the stored evaluation.

    Read-modify-write rather than a targeted UPDATE, because the row's payload
    is one JSON blob. The read is the row as stored: `apply_channel_history`
    runs when an evaluation is *served*, never on the way in, so there is no
    read-time criterion here to accidentally freeze into the row.
    """
    repo = EvaluationRepository()
    evaluation = repo.find_by_video_id(video_id)
    if evaluation is None:
        logger.warning("%s: no stored evaluation to attach the fact check to", video_id)
        return

    # find_by_video_id adds these; upsert would fold them into `data`.
    evaluation = {k: v for k, v in evaluation.items() if k not in ("created_at", "updated_at")}
    breakdown = [
        item for item in evaluation.get("breakdown", []) if item.get("criterion") != "fact_check"
    ]
    evaluation["breakdown"] = [*breakdown, entry]
    evidence = entry.get("evidence") or {}
    for field in _FACT_FIELDS:
        evaluation[field] = evidence.get(field)
    _ = repo.upsert(evaluation)
