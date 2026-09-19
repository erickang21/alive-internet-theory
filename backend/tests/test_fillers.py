from backend.scoring import fillers

LONG_CLEAN_TEXT = "the quick brown fox jumps over a lazy dog near riverbank " * 60
LONG_FILLER_TEXT = "so um i think you know this is uh basically like the story " * 60


def test_skips_non_asr_tracks():
    result = fillers.score_transcript(LONG_CLEAN_TEXT, "standard")
    assert result["applied"] is False
    assert result["deduction"] == 0


def test_skips_short_transcripts():
    result = fillers.score_transcript("um well this is short", "asr")
    assert result["applied"] is False
    assert result["deduction"] == 0


def test_no_deduction_when_fillers_present():
    result = fillers.score_transcript(LONG_FILLER_TEXT, "asr")
    assert result["applied"] is True
    assert result["deduction"] == 0


def test_deducts_for_filler_free_long_transcript():
    result = fillers.score_transcript(LONG_CLEAN_TEXT, "asr")
    assert result["applied"] is True
    assert 0 < result["deduction"] <= fillers.MAX_DEDUCTION


def test_counts_stutters():
    assert fillers.count_fillers("I- I think that that was odd") >= 2
