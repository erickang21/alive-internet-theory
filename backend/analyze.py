"""Analyze YouTube videos and store their evaluations for the API to serve.

    python -m backend.analyze TARGET [TARGET ...] [--limit N] [--force]

TARGET is a video URL, Shorts URL, or bare video ID, or a channel or playlist
URL (expanded to its newest --limit videos).
"""

import argparse
import logging
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from backend import transcripts, ytdlp
from backend.config import config
from backend.database import EvaluationRepository, run_migrations
from backend.scoring import evaluate_video

logger = logging.getLogger("backend.analyze")


def analyze_video(video_id: str) -> dict[str, Any] | None:
    """Returns None, storing nothing, when the video has no speech to analyze."""
    download = ytdlp.download_video(video_id)
    transcript = transcripts.get_transcript(download)
    if not transcript["text"]:
        return None
    info = download.info

    evaluation = evaluate_video(
        video_id=video_id,
        transcript=transcript["text"],
        track_kind=transcript["kind"],
        channel_id=info.get("channel_id"),
        video_length_seconds=int(info.get("duration") or 0),
    )
    timestamp = info.get("timestamp")
    evaluation["metadata"] = {
        "title": info.get("title"),
        "author": info.get("channel"),
        "length_seconds": info.get("duration"),
        "publish_date": datetime.fromtimestamp(timestamp, UTC).isoformat() if timestamp else None,
        "transcript_kind": transcript["kind"],
        "transcript_language": transcript["language"],
        # Relative to MEDIA_DIR.
        "media": {
            "video": _media_path(download.video_path),
            "info_json": _media_path(download.info_json_path),
            "thumbnail": _media_path(download.thumbnail_path),
            "subtitles": [_media_path(track.path) for track in download.subtitles],
        },
    }
    return EvaluationRepository().upsert(evaluation)


def _media_path(path: Path | None) -> str | None:
    return str(path.relative_to(config.media_dir)) if path else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Analyze YouTube videos and store their evaluations."
    )
    parser.add_argument("targets", nargs="+", help="video URLs or IDs, or channel/playlist URLs")
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="newest videos to take from each channel or playlist (default: 10)",
    )
    parser.add_argument(
        "--force", action="store_true", help="re-analyze videos that already have an evaluation"
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    run_migrations()
    repo = EvaluationRepository()

    failures = 0
    for target in args.targets:
        try:
            video_ids = ytdlp.resolve_video_ids(target, args.limit)
        except Exception:
            logger.exception("%s: couldn't resolve to videos", target)
            failures += 1
            continue

        for video_id in video_ids:
            if not args.force and repo.find_by_video_id(video_id):
                logger.info("%s: already analyzed, skipping (--force to redo)", video_id)
                continue
            logger.info("%s: analyzing", video_id)
            try:
                evaluation = analyze_video(video_id)
            except Exception:
                logger.exception("%s: analysis failed", video_id)
                failures += 1
                continue
            if evaluation is None:
                logger.warning("%s: no captions and Whisper heard no speech; not stored", video_id)
                continue
            logger.info("%s: %s (score %s)", video_id, evaluation["verdict"], evaluation["score"])

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
