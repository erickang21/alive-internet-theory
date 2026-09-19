import logging
import threading

logger = logging.getLogger(__name__)

PENDING = "pending"
DONE = "done"

_lock = threading.Lock()
# video_id -> PENDING, DONE, or the failure detail. In-memory on purpose:
# restarting the backend clears failures so those videos get another attempt.
_jobs: dict[str, str] = {}


def request(video_id: str) -> str:
    with _lock:
        status = _jobs.get(video_id)
        if status is not None:
            return status
        _jobs[video_id] = PENDING
    threading.Thread(target=_run, args=(video_id,), daemon=True).start()
    return PENDING


def _run(video_id: str) -> None:
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
