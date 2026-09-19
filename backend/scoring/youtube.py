import logging
import re
from datetime import UTC, datetime
from statistics import median
from typing import Any

import requests
from sqlalchemy.exc import SQLAlchemyError

from backend.config import config
from backend.database import ChannelCacheRepository

logger = logging.getLogger(__name__)

BASE_URL = "https://www.googleapis.com/youtube/v3"

UPLOAD_PATTERN_MAX_DEDUCTION = 10
ACCOUNT_AGE_MAX_DEDUCTION = 5

# Sustained faster-than-daily uploads of long-form video is beyond most human
# production capacity; tune against real channels.
SUSPICIOUS_MEDIAN_GAP_HOURS = 20
SHORT_VIDEO_SECONDS = 90
YOUNG_ACCOUNT_DAYS = 180


def _get(path: str, params: dict[str, Any]) -> dict[str, Any]:
    response = requests.get(
        f"{BASE_URL}/{path}", params={**params, "key": config.youtube_api_key}, timeout=15
    )
    response.raise_for_status()
    return response.json()


def fetch_channel(channel_id: str) -> dict[str, Any]:
    # The channel cache is an optimization; a missing database should not stop
    # the YouTube criteria from running.
    repo = None
    try:
        repo = ChannelCacheRepository()
        cached = repo.find_by_channel_id(channel_id)
        if cached:
            return cached
    except (SQLAlchemyError, OSError):
        logger.warning("channel cache unavailable; fetching %s uncached", channel_id)
        repo = None

    data = _get("channels", {"part": "snippet,contentDetails", "id": channel_id})
    item = data["items"][0]
    uploads_playlist_id = item["contentDetails"]["relatedPlaylists"]["uploads"]

    playlist = _get(
        "playlistItems",
        {"part": "contentDetails", "playlistId": uploads_playlist_id, "maxResults": 50},
    )
    uploads = [
        {
            "video_id": entry["contentDetails"]["videoId"],
            # videoPublishedAt, not snippet.publishedAt: the latter is when the
            # video was added to the playlist, which lags for older uploads.
            "published_at": entry["contentDetails"].get("videoPublishedAt"),
        }
        for entry in playlist.get("items", [])
    ]

    # Shorts share the channel's uploads playlist, so cadence needs per-video
    # durations to avoid flagging humans who post daily Shorts plus weekly
    # long-form videos. One videos.list call covers all 50 IDs (1 quota unit).
    if uploads:
        videos = _get(
            "videos",
            {"part": "contentDetails", "id": ",".join(u["video_id"] for u in uploads)},
        )
        durations = {
            item["id"]: _parse_duration_seconds(item["contentDetails"].get("duration"))
            for item in videos.get("items", [])
        }
        for upload in uploads:
            upload["length_seconds"] = durations.get(upload["video_id"])

    channel = {
        "channel_id": channel_id,
        "created_at": item["snippet"]["publishedAt"],
        "title": item["snippet"].get("title"),
        "recent_uploads": uploads,
    }
    if repo is not None:
        try:
            repo.upsert(channel)
        except (SQLAlchemyError, OSError):
            logger.warning("channel cache unavailable; %s not cached", channel_id)
    return channel


_DURATION_PATTERN = re.compile(r"^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$")


def _parse_duration_seconds(value: str | None) -> int | None:
    match = _DURATION_PATTERN.match(value or "")
    if not match:
        return None
    days, hours, minutes, seconds = (int(group or 0) for group in match.groups())
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def _parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def score_upload_pattern(channel: dict[str, Any], video_length_seconds: int) -> dict[str, Any]:
    uploads = channel.get("recent_uploads", [])
    # Only long-form uploads count toward the cadence: daily Shorts are normal
    # human output. Uploads with unknown duration (cache entries predating the
    # duration fetch) pass through until the 24h channel cache refreshes.
    long_form = [
        u
        for u in uploads
        if u.get("length_seconds") is None or u["length_seconds"] > SHORT_VIDEO_SECONDS
    ]
    timestamps = sorted(_parse_iso(u["published_at"]) for u in long_form if u["published_at"])
    if len(timestamps) < 5:
        return {
            "criterion": "upload_pattern",
            "deduction": 0,
            "applied": False,
            "detail": "Too few long-form uploads to judge posting cadence.",
        }

    gaps_hours = [
        (later - earlier).total_seconds() / 3600
        for earlier, later in zip(timestamps, timestamps[1:], strict=False)
    ]
    median_gap = median(gaps_hours)

    deduction = 0.0
    if median_gap < SUSPICIOUS_MEDIAN_GAP_HOURS and video_length_seconds > SHORT_VIDEO_SECONDS:
        intensity = 1 - median_gap / SUSPICIOUS_MEDIAN_GAP_HOURS
        deduction = round(UPLOAD_PATTERN_MAX_DEDUCTION * intensity, 1)

    return {
        "criterion": "upload_pattern",
        "deduction": deduction,
        "applied": True,
        "detail": (
            f"Median gap between long-form uploads: {median_gap:.1f}h "
            f"over last {len(timestamps)} videos."
        ),
        "evidence": {"median_gap_hours": round(median_gap, 1), "uploads_sampled": len(timestamps)},
    }


def score_account_age(channel: dict[str, Any]) -> dict[str, Any]:
    created_at = _parse_iso(channel["created_at"])
    age_days = (datetime.now(UTC) - created_at).days

    deduction = 0.0
    if age_days < YOUNG_ACCOUNT_DAYS:
        deduction = round(ACCOUNT_AGE_MAX_DEDUCTION * (1 - age_days / YOUNG_ACCOUNT_DAYS), 1)

    return {
        "criterion": "account_age",
        "deduction": deduction,
        "applied": True,
        "detail": f"Channel is {age_days} days old.",
        "evidence": {"age_days": age_days},
    }
