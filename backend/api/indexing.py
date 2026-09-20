import logging
import threading

logger = logging.getLogger(__name__)

PENDING = "pending"
DONE = "done"

# An analysis downloads from YouTube, may run Whisper, and calls GPTZero and Claude, all
# from one residential IP. A feed being auto-analyzed queues dozens of videos at once, so
# they wait for a slot here rather than running together and getting the IP bot-checked.
MAX_CONCURRENT_ANALYSES = 2

_lock = threading.Lock()
# video_id -> PENDING, DONE, or the failure detail. In-memory on purpose:
# restarting the backend clears failures so those videos get another attempt.
_jobs: dict[str, str] = {}
_slots = threading.Semaphore(MAX_CONCURRENT_ANALYSES)


def request(video_id: str, force: bool = False) -> str:
    """Queue the video unless it already has a job. `force` re-runs a finished or
    failed one (the debug "rerun analysis" button); a running job is never doubled."""
    with _lock:
        status = _jobs.get(video_id)
        if status is not None and not (force and status != PENDING):
            return status
        _jobs[video_id] = PENDING
    threading.Thread(target=_run, args=(video_id,), daemon=True).start()
    return PENDING


def is_pending(video_id: str) -> bool:
    with _lock:
        return _jobs.get(video_id) == PENDING


def _run(video_id: str) -> None:
    # Queued threads park here, so a video stays PENDING from the caller's point of view
    # whether it is waiting for a slot or already downloading.
    with _slots:
        _analyze(video_id)


def _analyze(video_id: str) -> None:
    # Imported here so the API doesn't load Whisper until a video needs it.
    from backend.analyze import analyze_video

    logger.info("%s: analyzing", video_id)
    try:
        evaluation = analyze_video(video_id)
    except Exception:
        logger.exception("%s: analysis failed", video_id)
        _set(video_id, "Analysis failed. See the backend logs.")
        return
    if evaluation is None:
        logger.warning("%s: no captions and Whisper heard no speech; not stored", video_id)
        _set(video_id, "This video has no speech to analyze.")
        return
    logger.info("%s: %s (score %s)", video_id, evaluation["verdict"], evaluation["score"])
    _set(video_id, DONE)


def _set(video_id: str, status: str) -> None:
    with _lock:
        _jobs[video_id] = status
