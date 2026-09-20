"""Everything we pull from YouTube goes through yt-dlp: expanding targets into
video IDs, downloading a video with its thumbnail and captions, and a channel's
upload history."""

import logging
import re
import subprocess
import time
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import islice
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

from backend.config import config
from backend.database import ChannelCacheRepository

if TYPE_CHECKING:
    # The stubs' TypedDict of YoutubeDL options, so option names and values are checked.
    from yt_dlp import _Params  # pyright: ignore[reportPrivateUsage]

logger = logging.getLogger(__name__)

# Recent uploads fully extracted for the cadence criterion (~1.3-2.4s each).
RECENT_UPLOADS = 20
# Only the first 5 minutes of a video are analyzed.
ANALYZED_SECONDS = 5 * 60
AUDIO_FORMAT = "ba/b"


class _YtDlpLogger:
    """Sends yt-dlp's own console output to DEBUG.

    Its failures reach us as exceptions, which we log or handle (e.g. skipped
    uploads), so its ERROR lines would only duplicate or contradict ours.
    """

    def __init__(self, ydl: object = None) -> None:
        # The stubs' logger protocol requires this parameter (typed ambiguously
        # there, hence `object`); yt-dlp never passes it.
        super().__init__()

    def debug(self, message: str) -> None:
        logger.debug("yt-dlp: %s", message)

    def info(self, message: str) -> None:
        self.debug(message)

    def warning(self, message: str, *, once: bool = False, only_once: bool = False) -> None:
        self.debug(message)

    def error(self, message: str) -> None:
        self.debug(message)

    def stdout(self, message: str) -> None:
        self.debug(message)

    def stderr(self, message: str) -> None:
        self.debug(message)


QUIET: "_Params" = {
    "quiet": True,
    "no_warnings": True,
    "noprogress": True,
    "logger": _YtDlpLogger(),
}


@dataclass(frozen=True)
class SubtitleTrack:
    path: Path
    language: str
    kind: str  # "asr" (auto-generated) or "standard" (uploaded by the creator)


@dataclass(frozen=True)
class Download:
    video_id: str
    info: dict[str, Any]
    info_json_path: Path
    thumbnail_path: Path | None
    subtitles: list[SubtitleTrack]


def resolve_video_ids(target: str, limit: int) -> list[str]:
    """Video URLs and bare IDs map to themselves; channel and playlist URLs
    expand to their newest `limit` videos."""
    with YoutubeDL(QUIET) as ydl:
        youtube = ydl.get_info_extractor("Youtube")
        if youtube.suitable(target) and (video_id := youtube.get_temp_id(target)):
            return [video_id]
    params: _Params = {**QUIET, "extract_flat": "in_playlist", "playlistend": limit}
    with YoutubeDL(params) as ydl:
        info = _as_dict(ydl.extract_info(target, download=False))
    return list(islice(_flatten_video_ids(info), limit))


def _as_dict(info: object) -> dict[str, Any]:
    # yt-dlp's info dicts carry many more keys than the stubs' TypedDict
    # declares, so read them as plain dicts.
    return cast(dict[str, Any], info)


def _flatten_video_ids(info: dict[str, Any]) -> Iterator[str]:
    entries: Iterable[dict[str, Any] | None] = info.get("entries") or []
    for entry in entries:
        if entry is None:
            continue
        if entry.get("entries") is not None:
            # A bare channel URL expands to one playlist per tab (Videos, Shorts, Live).
            yield from _flatten_video_ids(entry)
        elif entry.get("ie_key") == "Youtube":
            yield entry["id"]


def fetch_video(video_id: str) -> Download:
    """Metadata, captions, and thumbnail. Audio is fetched separately by
    download_audio, for Whisper or the voice check."""
    out_dir = Path(config.media_dir) / video_id
    params: _Params = {
        **QUIET,
        # The stubs type this as str; yt-dlp treats it as a flag.
        "skip_download": True,  # pyright: ignore[reportAssignmentType]
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
        "progress_hooks": [_progress_logger()],
    }
    with YoutubeDL(params) as ydl:
        logger.info("metadata: fetching")
        # Pick caption tracks from the raw metadata before downloading anything.
        raw = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", process=False)
        raw_info = _as_dict(raw)
        logger.info(
            'metadata: "%s" by %s, %s long',
            raw_info.get("title"),
            raw_info.get("channel"),
            _clock(raw_info.get("duration") or 0),
        )
        tracks = _pick_subtitle_tracks(raw_info)
        # yt-dlp matches these as case-insensitive regexes, so escape the exact
        # keys. With no tracks, an empty list would mean "English by default".
        ydl.params["subtitleslangs"] = [re.escape(lang) for lang in tracks]
        ydl.params["writesubtitles"] = ydl.params["writeautomaticsub"] = bool(tracks)
        captions = ", ".join(
            f"{lang} ({'auto-generated' if kind == 'asr' else 'uploaded'})"
            for lang, (_, kind) in tracks.items()
        )
        logger.info("download: thumbnail, captions: %s", captions or "none available")
        started = time.monotonic()
        info = _as_dict(ydl.sanitize_info(ydl.process_ie_result(raw, download=True)))
    logger.info("download: done in %.0fs", time.monotonic() - started)

    requested: dict[str, dict[str, Any]] = info.get("requested_subtitles") or {}
    subtitles = [
        # yt-dlp reports the pre-move path in requested_subtitles, so build the
        # final one from our own template.
        SubtitleTrack(out_dir / f"subtitles.{lang}.{sub['ext']}", *tracks[lang])
        for lang, sub in requested.items()
        if lang in tracks
    ]
    thumbnail_path = out_dir / "thumbnail.jpg"
    return Download(
        video_id=video_id,
        info=info,
        info_json_path=out_dir / "video.info.json",
        thumbnail_path=thumbnail_path if thumbnail_path.exists() else None,
        subtitles=[track for track in subtitles if track.path.exists()],
    )


def download_audio(video_id: str, seconds: int = ANALYZED_SECONDS) -> Path:
    """The first `seconds` of the audio track, for Whisper or the voice check.

    Downloads the whole track and cuts it locally: a ranged download goes through
    ffmpeg, which YouTube throttles to about playback speed (0.1 MB/s measured,
    vs 6 MB/s for yt-dlp's own chunked downloader).
    """
    out_dir = Path(config.media_dir) / video_id
    params: _Params = {
        **QUIET,
        "format": AUDIO_FORMAT,
        "outtmpl": str(out_dir / "audio.%(ext)s"),
        "progress_hooks": [_progress_logger()],
    }
    logger.info("audio: downloading the audio track")
    started = time.monotonic()
    with YoutubeDL(params) as ydl:
        info = _as_dict(ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}"))
    path = Path(info["requested_downloads"][0]["filepath"])
    if (info.get("duration") or 0) > seconds:
        _cut(path, seconds)
    logger.info(
        "audio: first %s ready in %.0fs (%.1f MB)",
        _clock(min(info.get("duration") or 0, seconds)),
        time.monotonic() - started,
        path.stat().st_size / 1e6,
    )
    return path


def _cut(path: Path, seconds: int) -> None:
    """Keep only the first `seconds` of a media file, copying the stream as is."""
    cut = path.with_name(f"{path.stem}.cut{path.suffix}")
    command = ["ffmpeg", "-y", "-v", "error", "-i", str(path), "-t", str(seconds)]
    # A stream copy takes a fraction of a second; an ffmpeg that stalls on a
    # truncated download would otherwise hold an analysis slot forever.
    _ = subprocess.run([*command, "-c", "copy", str(cut)], check=True, timeout=60)
    _ = cut.replace(path)


def _progress_logger() -> Callable[[Mapping[str, Any]], None]:
    """Log each file's download at 25% steps (yt-dlp's own progress bar is off)."""
    logged: dict[str, int] = {}

    def hook(progress: Mapping[str, Any]) -> None:
        filename = str(progress.get("filename") or "")
        label = _stream_label(filename, progress.get("info_dict") or {})
        if progress.get("status") == "finished":
            size = progress.get("total_bytes") or progress.get("downloaded_bytes") or 0
            logger.info("download: %s done (%.1f MB)", label, size / 1e6)
            return
        total = progress.get("total_bytes") or progress.get("total_bytes_estimate")
        if progress.get("status") != "downloading" or not total:
            return
        quarter = int(progress.get("downloaded_bytes", 0) / total * 4)
        if 0 < quarter < 4 and quarter > logged.get(filename, 0):
            logged[filename] = quarter
            logger.info("download: %s %d%%", label, quarter * 25)

    return hook


def _stream_label(filename: str, fmt: Mapping[str, Any]) -> str:
    if filename.endswith((".json3", ".vtt", ".srv3", ".ttml")):
        return "captions"
    if fmt.get("vcodec") == "none":
        return "audio stream"
    if fmt.get("acodec") == "none":
        return "video stream"
    return "video"


def _clock(seconds: float) -> str:
    minutes, secs = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def _pick_subtitle_tracks(info: dict[str, Any]) -> dict[str, tuple[str, str]]:
    """Map the caption keys to download to (language, kind).

    Auto captions in the video's original language ("<lang>-orig") keep speech
    fillers. Uploaded captions are the fallback, English first. YouTube's
    machine translations ("en-de", "en-en") are never used.
    """
    tracks: dict[str, tuple[str, str]] = {}
    auto: dict[str, Any] = info.get("automatic_captions") or {}
    asr = next((lang for lang in auto if lang.endswith("-orig")), None)
    if asr:
        tracks[asr] = (asr.removesuffix("-orig"), "asr")
    # Livestream replays list their chat log as a "live_chat" subtitle track.
    uploaded: dict[str, Any] = info.get("subtitles") or {}
    manual = sorted(
        (lang for lang in uploaded if lang != "live_chat"),
        key=lambda lang: not lang.startswith("en"),
    )
    if manual:
        tracks[manual[0]] = (manual[0], "standard")
    return tracks


def fetch_channel(channel_id: str) -> dict[str, Any]:
    repo = ChannelCacheRepository()
    cached = repo.find_by_channel_id(channel_id)
    if cached:
        logger.info("channel: using cached upload dates for %s", cached.get("title") or channel_id)
        return cached

    # The uploads playlist (UC… → UU…) lists every public upload newest-first.
    # Its flat entries only carry YouTube's relative dates ("3 days ago"), which
    # can be off by days, so the listing is used just for IDs and order and each
    # upload we need is fully extracted for its exact timestamp (~1.3s each).
    params: _Params = {**QUIET, "extract_flat": "in_playlist"}
    logger.info("channel: listing uploads")
    with YoutubeDL(params) as ydl:
        playlist = _as_dict(
            ydl.extract_info(
                f"https://www.youtube.com/playlist?list=UU{channel_id[2:]}", download=False
            )
        )
    entries: Iterable[dict[str, Any] | None] = playlist.get("entries") or []
    video_ids: list[str] = [entry["id"] for entry in entries if entry]

    wanted = video_ids[:RECENT_UPLOADS]
    # yt-dlp can't see a channel's creation date; its oldest upload is the
    # closest stand-in.
    if len(video_ids) > RECENT_UPLOADS:
        wanted.append(video_ids[-1])
    logger.info(
        "channel: %s has %d upload%s; fetching exact dates for %d of them",
        playlist.get("channel"),
        len(video_ids),
        "" if len(video_ids) == 1 else "s",
        len(wanted),
    )
    started = time.monotonic()
    fetched: list[dict[str, Any] | None] = []
    with YoutubeDL(QUIET) as ydl:
        for count, video_id in enumerate(wanted, start=1):
            fetched.append(_fetch_upload(ydl, video_id))
            if count % 10 == 0 and count < len(wanted):
                logger.info("channel: %d/%d upload dates fetched", count, len(wanted))
    logger.info("channel: done in %.0fs", time.monotonic() - started)
    recent = fetched[:RECENT_UPLOADS]
    oldest = fetched[RECENT_UPLOADS] if len(fetched) > RECENT_UPLOADS else None

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
        info = _as_dict(
            ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        )
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
