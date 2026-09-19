import logging
import threading

logger = logging.getLogger(__name__)

PENDING = "pending"
DONE = "done"
# A core upstream (GPTZero) failed. Reported once, then consumed so the next
# request starts a fresh attempt — the extension bounds how many times it retries.
RETRY = "retry"

_lock = threading.Lock()
# video_id -> PENDING, DONE, RETRY, or the failure detail. In-memory on purpose:
# restarting the backend clears failures so those videos get another attempt.
_jobs: dict[str, str] = {}


def request(video_id: str) -> str:
    with _lock:
        status = _jobs.get(video_id)
        if status == RETRY:
            # Report the retryable failure once and clear it, so the caller's
            # next request kicks off a new attempt instead of a fresh run now.
            del _jobs[video_id]
            return RETRY
        if status is not None:
            return status
        _jobs[video_id] = PENDING
    threading.Thread(target=_run, args=(video_id,), daemon=True).start()
    return PENDING


def _run(video_id: str) -> None:
    # Imported here so the API doesn't load Whisper until a video needs it.
    from backend.analyze import analyze_video
    from backend.scoring import UpstreamScoringError

    logger.info("%s: analyzing", video_id)
    try:
        evaluation = analyze_video(video_id)
    except UpstreamScoringError:
        # Nothing was stored; the extension retries a bounded number of times.
        logger.warning("%s: scoring upstream failed; will retry", video_id)
        _set(video_id, RETRY)
        return
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
