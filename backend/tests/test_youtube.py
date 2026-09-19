from datetime import UTC, datetime, timedelta

from backend.scoring import youtube


def _channel(gap_hours, count=10, created_days_ago=1000):
    start = datetime(2026, 1, 1, tzinfo=UTC)
    uploads = [
        {"video_id": f"v{i}", "published_at": (start + timedelta(hours=gap_hours * i)).isoformat()}
        for i in range(count)
    ]
    created = datetime.now(UTC) - timedelta(days=created_days_ago)
    return {
        "channel_id": "UC123",
        "created_at": created.isoformat(),
        "recent_uploads": uploads,
    }


def test_upload_pattern_flags_rapid_long_form_uploads():
    result = youtube.score_upload_pattern(_channel(gap_hours=4), video_length_seconds=600)
    assert result["applied"] is True
    assert 0 < result["deduction"] <= youtube.UPLOAD_PATTERN_MAX_DEDUCTION


def test_upload_pattern_ignores_shorts_cadence():
    result = youtube.score_upload_pattern(_channel(gap_hours=4), video_length_seconds=45)
    assert result["deduction"] == 0


def test_upload_pattern_excludes_shorts_from_cadence():
    # Human pattern: multiple Shorts a day alongside weekly long-form uploads.
    start = datetime(2026, 1, 1, tzinfo=UTC)
    uploads = [
        {
            "video_id": f"s{i}",
            "published_at": (start + timedelta(hours=6 * i)).isoformat(),
            "length_seconds": 40,
        }
        for i in range(30)
    ] + [
        {
            "video_id": f"l{i}",
            "published_at": (start + timedelta(days=7 * i)).isoformat(),
            "length_seconds": 900,
        }
        for i in range(6)
    ]
    channel = {
        "channel_id": "UC123",
        "created_at": "2020-01-01T00:00:00+00:00",
        "recent_uploads": uploads,
    }
    result = youtube.score_upload_pattern(channel, video_length_seconds=900)
    assert result["applied"] is True
    assert result["deduction"] == 0


def test_parse_duration_seconds():
    assert youtube._parse_duration_seconds("PT4M13S") == 253
    assert youtube._parse_duration_seconds("PT1H2M3S") == 3723
    assert youtube._parse_duration_seconds("P1DT2H") == 93600
    assert youtube._parse_duration_seconds("PT45S") == 45
    assert youtube._parse_duration_seconds(None) is None
    assert youtube._parse_duration_seconds("garbage") is None


def test_upload_pattern_accepts_weekly_cadence():
    result = youtube.score_upload_pattern(_channel(gap_hours=168), video_length_seconds=600)
    assert result["deduction"] == 0


def test_upload_pattern_needs_enough_uploads():
    result = youtube.score_upload_pattern(_channel(gap_hours=4, count=3), video_length_seconds=600)
    assert result["applied"] is False


def test_account_age_deducts_for_new_channels():
    result = youtube.score_account_age(_channel(gap_hours=24, created_days_ago=10))
    assert 0 < result["deduction"] <= youtube.ACCOUNT_AGE_MAX_DEDUCTION


def test_account_age_ignores_old_channels():
    result = youtube.score_account_age(_channel(gap_hours=24, created_days_ago=2000))
    assert result["deduction"] == 0


def test_fetch_channel_works_without_database(monkeypatch):
    def unavailable_repo():
        raise youtube.DatabaseUnavailableError("no db")

    monkeypatch.setattr(youtube, "ChannelCacheRepository", unavailable_repo)
    monkeypatch.setattr(
        youtube,
        "_get",
        lambda path, params: (
            {
                "items": [
                    {
                        "snippet": {"publishedAt": "2020-01-01T00:00:00Z", "title": "Test"},
                        "contentDetails": {"relatedPlaylists": {"uploads": "UU123"}},
                    }
                ]
            }
            if path == "channels"
            else {"items": []}
        ),
    )

    channel = youtube.fetch_channel("UC123")
    assert channel["channel_id"] == "UC123"
    assert channel["recent_uploads"] == []
