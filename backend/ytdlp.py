"""Everything we pull from YouTube goes through yt-dlp: expanding targets into
video IDs, downloading a video with its thumbnail and captions, and a channel's
upload history."""

import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import islice
from pathlib import Path
from typing import Any

from yt_dlp import YoutubeDL
from yt_dlp.extractor.youtube import YoutubeIE
from yt_dlp.utils import DownloadError

from backend.config import config
from backend.database import ChannelCacheRepository

logger = logging.getLogger(__name__)

RECENT_UPLOADS = 50
VIDEO_FORMAT = "bv*[height<=720]+ba/b[height<=720]/b"
QUIET = {"quiet": True, "no_warnings": True, "noprogress": True}


@dataclass(frozen=True)
class SubtitleTrack:
    path: Path
    language: str
    kind: str  # "asr" (auto-generated) or "standard" (uploaded by the creator)


@dataclass(frozen=True)
class Download:
    info: dict[str, Any]
    video_path: Path
    info_json_path: Path
    thumbnail_path: Path | None
    subtitles: list[SubtitleTrack]


def resolve_video_ids(target: str, limit: int) -> list[str]:
    """Video URLs and bare IDs map to themselves; channel and playlist URLs
    expand to their newest `limit` videos."""
    if YoutubeIE.suitable(target):
        return [YoutubeIE.get_temp_id(target)]
    with YoutubeDL({**QUIET, "extract_flat": "in_playlist", "playlistend": limit}) as ydl:
        info = ydl.extract_info(target, download=False)
    return list(islice(_flatten_video_ids(info), limit))


def _flatten_video_ids(info: dict[str, Any]):
    for entry in info.get("entries") or []:
        if entry is None:
            continue
        if entry.get("entries") is not None:
            # A bare channel URL expands to one playlist per tab (Videos, Shorts, Live).
            yield from _flatten_video_ids(entry)
        elif entry.get("ie_key") == "Youtube":
            yield entry["id"]


def download_video(video_id: str) -> Download:
    out_dir = Path(config.media_dir) / video_id
    params = {
        **QUIET,
        # YouTube serves video and audio separately; ffmpeg merges them.
        "format": VIDEO_FORMAT,
        "merge_output_format": "mp4",
        # Everything yt-dlp knows about the video, as video.info.json.
        "writeinfojson": True,
        "writethumbnail": True,
        "postprocessors": [
            {"key": "FFmpegThumbnailsConvertor", "format": "jpg", "when": "before_dl"}
        ],
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitlesformat": "json3/vtt/best",
        "outtmpl": {
            "default": str(out_dir / "video.%(ext)s"),
            "thumbnail": str(out_dir / "thumbnail.%(ext)s"),
            "subtitle": str(out_dir / "subtitles.%(ext)s"),
        },
    }
    with YoutubeDL(params) as ydl:
        # Pick caption tracks from the raw metadata before downloading anything.
        raw = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", process=False)
        tracks = _pick_subtitle_tracks(raw)
        # yt-dlp matches these as case-insensitive regexes, so escape the exact
        # keys. With no tracks, an empty list would mean "English by default".
        ydl.params["subtitleslangs"] = [re.escape(lang) for lang in tracks]
        ydl.params["writesubtitles"] = ydl.params["writeautomaticsub"] = bool(tracks)
        info = ydl.sanitize_info(ydl.process_ie_result(raw, download=True))

    subtitles = [
        # yt-dlp reports the pre-move path in requested_subtitles, so build the
        # final one from our own template.
        SubtitleTrack(out_dir / f"subtitles.{lang}.{sub['ext']}", *tracks[lang])
        for lang, sub in (info.get("requested_subtitles") or {}).items()
        if lang in tracks
    ]
    thumbnail_path = out_dir / "thumbnail.jpg"
    return Download(
        info=info,
        video_path=Path(info["requested_downloads"][0]["filepath"]),
        info_json_path=out_dir / "video.info.json",
        thumbnail_path=thumbnail_path if thumbnail_path.exists() else None,
        subtitles=[track for track in subtitles if track.path.exists()],
    )


def _pick_subtitle_tracks(info: dict[str, Any]) -> dict[str, tuple[str, str]]:
    """Map the caption keys to download to (language, kind).

    Auto captions in the video's original language ("<lang>-orig") keep speech
    fillers. Uploaded captions are the fallback, English first. YouTube's
    machine translations ("en-de", "en-en") are never used.
    """
    tracks: dict[str, tuple[str, str]] = {}
    auto = info.get("automatic_captions") or {}
    asr = next((lang for lang in auto if lang.endswith("-orig")), None)
    if asr:
        tracks[asr] = (asr.removesuffix("-orig"), "asr")
    # Livestream replays list their chat log as a "live_chat" subtitle track.
    manual = sorted(
        (lang for lang in info.get("subtitles") or {} if lang != "live_chat"),
        key=lambda lang: not lang.startswith("en"),
    )
    if manual:
        tracks[manual[0]] = (manual[0], "standard")
    return tracks


def fetch_channel(channel_id: str) -> dict[str, Any]:
    repo = ChannelCacheRepository()
    cached = repo.find_by_channel_id(channel_id)
    if cached:
        return cached

    # The uploads playlist (UC… → UU…) lists every public upload newest-first.
    # Its flat entries only carry YouTube's relative dates ("3 days ago"), which
    # can be off by days, so the listing is used just for IDs and order and each
    # upload we need is fully extracted for its exact timestamp (~1.3s each).
    with YoutubeDL({**QUIET, "extract_flat": "in_playlist"}) as ydl:
        playlist = ydl.extract_info(
            f"https://www.youtube.com/playlist?list=UU{channel_id[2:]}", download=False
        )
    video_ids = [entry["id"] for entry in playlist.get("entries") or [] if entry]

    with YoutubeDL(QUIET) as ydl:
        recent = [_fetch_upload(ydl, video_id) for video_id in video_ids[:RECENT_UPLOADS]]
        # yt-dlp can't see a channel's creation date; its oldest upload is the
        # closest stand-in.
        oldest = _fetch_upload(ydl, video_ids[-1]) if len(video_ids) > RECENT_UPLOADS else None

    uploads = [upload for upload in recent if upload]
    dated = [upload for upload in [*uploads, oldest] if upload and upload["published_at"]]
    return repo.upsert(
        {
            "channel_id": channel_id,
            "title": playlist.get("channel"),
            "upload_count": len(video_ids),
            "oldest_upload_at": min((u["published_at"] for u in dated), default=None),
            "recent_uploads": uploads,
        }
    )


def _fetch_upload(ydl: YoutubeDL, video_id: str) -> dict[str, Any] | None:
    try:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
    except DownloadError as error:
        # Members-only, age-restricted (needs a login), or removed since listing.
        logger.warning("skipping upload %s: %s", video_id, error)
        return None
    return {
        "video_id": video_id,
        "title": info.get("title"),
        "published_at": _isoformat(info.get("timestamp")),
        "duration": info.get("duration"),
    }


def _isoformat(timestamp: float | None) -> str | None:
    return datetime.fromtimestamp(timestamp, UTC).isoformat() if timestamp else None
