"""Analyze YouTube videos and store their evaluations for the API to serve.

    python -m backend.analyze TARGET [TARGET ...] [--limit N] [--force]

TARGET is a video URL, Shorts URL, or bare video ID, or a channel or playlist
URL (expanded to its newest --limit videos).
"""

import argparse
import logging
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from backend import transcripts, ytdlp
from backend.config import config
from backend.database import EvaluationRepository, run_migrations
from backend.scoring import elevenlabs, evaluate_video

logger = logging.getLogger("backend.analyze")


def analyze_video(video_id: str) -> dict[str, Any] | None:
    """Returns None, storing nothing, when the video has no speech to analyze."""
    download = ytdlp.fetch_video(video_id)
    transcript = transcripts.get_transcript(download)
    if not transcript["text"]:
        return None
    info = download.info

    # Only the Whisper fallback leaves audio on disk, so a captioned video needs its own
    # download: just the minute the voice check listens to, deleted once it has scored.
    audio_path: Path | None = transcript.get("audio_path")
    temporary_audio = audio_path is None
    if temporary_audio:
        try:
            audio_path = ytdlp.download_audio(video_id, elevenlabs.CLASSIFIED_SECONDS)
        except Exception:
            # One flaky audio fetch should cost us this criterion, not the whole video.
            logger.exception("%s: couldn't download audio for the voice check", video_id)
            audio_path = None

    try:
        evaluation = evaluate_video(
            video_id=video_id,
            transcript=transcript["text"],
            track_kind=transcript["kind"],
            channel_id=info.get("channel_id"),
            video_length_seconds=int(info.get("duration") or 0),
            cues=transcript.get("cues"),
            audio_path=audio_path,
        )
    finally:
        if temporary_audio and audio_path:
            audio_path.unlink(missing_ok=True)
    timestamp = info.get("timestamp")
    evaluation["metadata"] = {
        "title": info.get("title"),
        "author": info.get("channel"),
        "length_seconds": info.get("duration"),
        "analyzed_seconds": min(info.get("duration") or 0, ytdlp.ANALYZED_SECONDS),
        "publish_date": datetime.fromtimestamp(timestamp, UTC).isoformat() if timestamp else None,
        "transcript_kind": transcript["kind"],
        "transcript_language": transcript["language"],
        # Relative to MEDIA_DIR.
        "media": {
            "audio": _media_path(transcript.get("audio_path")),
            "info_json": _media_path(download.info_json_path),
            "thumbnail": _media_path(download.thumbnail_path),
            "subtitles": [_media_path(track.path) for track in download.subtitles],
        },
    }
    return EvaluationRepository().upsert(evaluation)


def _media_path(path: Path | None) -> str | None:
    return str(path.relative_to(config.media_dir)) if path else None


def _elapsed(started: float) -> str:
    minutes, seconds = divmod(round(time.monotonic() - started), 60)
    return f"{minutes}m {seconds:02d}s" if minutes else f"{seconds}s"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Analyze YouTube videos and store their evaluations."
    )
    _ = parser.add_argument(
        "targets", nargs="+", help="video URLs or IDs, or channel/playlist URLs"
    )
    _ = parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="newest videos to take from each channel or playlist (default: 10)",
    )
    _ = parser.add_argument(
        "--force", action="store_true", help="re-analyze videos that already have an evaluation"
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S"
    )
    # Per-run chatter (migration context, every HTTP request) that hides the stages.
    for noisy in ("alembic", "httpx", "httpx2"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    run_migrations()
    repo = EvaluationRepository()

    failures = 0
    video_ids: list[str] = []
    for target in args.targets:
        try:
            found = ytdlp.resolve_video_ids(target, args.limit)
        except Exception:
            logger.exception("%s: couldn't resolve to videos", target)
            failures += 1
            continue
        if not found:
            logger.error("%s: no videos found", target)
            failures += 1
        video_ids += [video_id for video_id in found if video_id not in video_ids]
    logger.info("queued %d video%s", len(video_ids), "" if len(video_ids) == 1 else "s")

    analyzed = skipped = 0
    for index, video_id in enumerate(video_ids, start=1):
        tag = f"[{index}/{len(video_ids)}] {video_id}"
        if not args.force and repo.find_by_video_id(video_id):
            logger.info("%s: already analyzed, skipping (--force to redo)", tag)
            skipped += 1
            continue
        logger.info("%s: starting", tag)
        started = time.monotonic()
        try:
            evaluation = analyze_video(video_id)
        except Exception:
            logger.exception("%s: failed after %s", tag, _elapsed(started))
            failures += 1
            continue
        if evaluation is None:
            logger.warning("%s: no captions and Whisper heard no speech; not stored", tag)
            skipped += 1
            continue
        analyzed += 1
        logger.info(
            "%s: done in %s, %s (score %s)",
            tag,
            _elapsed(started),
            evaluation["verdict"],
            evaluation["score"],
        )

    logger.info("finished: %d analyzed, %d skipped, %d failed", analyzed, skipped, failures)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
