from datetime import UTC, datetime
from statistics import median
from typing import Any

UPLOAD_PATTERN_MAX_DEDUCTION = 10
ACCOUNT_AGE_MAX_DEDUCTION = 5

# Sustained faster-than-daily uploads of long-form video is beyond most human
# production capacity; tune against real channels.
SUSPICIOUS_MEDIAN_GAP_HOURS = 20
SHORT_VIDEO_SECONDS = 90
YOUNG_ACCOUNT_DAYS = 180


def _parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def score_upload_pattern(channel: dict[str, Any], video_length_seconds: int) -> dict[str, Any]:
    uploads = channel.get("recent_uploads", [])
    timestamps = sorted(_parse_iso(u["published_at"]) for u in uploads if u["published_at"])
    if len(timestamps) < 5:
        return {
            "criterion": "upload_pattern",
            "deduction": 0,
            "applied": False,
            "detail": "Too few uploads to judge posting cadence.",
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
            f"Median gap between uploads: {_format_gap(median_gap)} "
            f"over last {len(timestamps)} videos."
        ),
        "evidence": {"median_gap_hours": round(median_gap, 1), "uploads_sampled": len(timestamps)},
    }


def _format_gap(hours: float) -> str:
    # Hours stop being readable past two days.
    return f"{hours / 24:.1f} days" if hours > 48 else f"{hours:.1f}h"


def score_account_age(channel: dict[str, Any]) -> dict[str, Any]:
    oldest_upload_at = channel.get("oldest_upload_at")
    if not oldest_upload_at:
        return {
            "criterion": "account_age",
            "deduction": 0,
            "applied": False,
            "detail": "No public uploads to date the channel by.",
        }

    # YouTube's channel creation date isn't available through yt-dlp, so the
    # oldest upload stands in for it. That undercounts channels that sat empty
    # before their first upload.
    age_days = (datetime.now(UTC) - _parse_iso(oldest_upload_at)).days

    deduction = 0.0
    if age_days < YOUNG_ACCOUNT_DAYS:
        deduction = round(ACCOUNT_AGE_MAX_DEDUCTION * (1 - age_days / YOUNG_ACCOUNT_DAYS), 1)

    return {
        "criterion": "account_age",
        "deduction": deduction,
        "applied": True,
        "detail": f"Channel's oldest upload is {age_days} days old.",
        "evidence": {"oldest_upload_age_days": age_days},
    }
