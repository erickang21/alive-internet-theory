import pytest

from backend.factcheck.text_utils import keywords, normalize_for_match


def test_strips_markdown_links_keeping_visible_text():
    result = normalize_for_match("Check [OpenAI](https://openai.com/about) research")
    assert result == "check openai research"


def test_strips_markdown_images_keeping_alt_text():
    result = normalize_for_match("![a chart of GDP](https://img.example.com/a.png) caption")
    assert result == "a chart of gdp caption"


def test_unifies_curly_quotes_and_em_dash():
    result = normalize_for_match("“Hello” — it’s a – test")
    assert result == "\"hello\" - it's a - test"


def test_nbsp_becomes_space():
    result = normalize_for_match("a b")
    assert result == "a b"


def test_collapses_whitespace_runs():
    result = normalize_for_match("a   b\n\tc")
    assert result == "a b c"


def test_casefolds_and_strips():
    result = normalize_for_match("  SHOUTING text  ")
    assert result == "shouting text"


def test_verbatim_quote_is_substring_of_normalized_messy_blob():
    # This is the anti-hallucination check's core assumption: a quote pulled
    # verbatim out of a source's raw markdown must remain a substring of that
    # source's normalized text, so verify.py's substring check actually works.
    quote = "the study found a 45% increase in output"
    blob = (
        "# Report Title\n\n"
        f"Researchers noted that **{quote}**, according to "
        "[the paper](https://example.com/paper).\n\n"
        "Additional  context   with NBSP and “curly quotes” "
        "— plus an em dash."
    )
    normalized_quote = normalize_for_match(quote)
    normalized_blob = normalize_for_match(blob)
    assert normalized_quote in normalized_blob


def test_keywords_drops_short_and_stopwords():
    result = keywords("The Quick Brown Fox that jumps over the lazy dog")
    assert "quick" in result
    assert "brown" in result
    assert "jumps" in result
    assert "lazy" in result
    # Too short (< 4 chars) or stopworded.
    assert "the" not in result
    assert "fox" not in result
    assert "that" not in result
    assert "over" not in result


def test_keywords_respects_min_length_override():
    result = keywords("AI GDP up", min_length=2)
    assert "ai" in result
    assert "gdp" in result
    assert "up" in result


# --- markdown markers must not break quote matching --------------------------
# Regression: normalize_for_match originally stripped only links and images, so a
# quote taken from the visible text of a **bolded** sentence failed the substring
# check in verify.py. Correct "false" verdicts were silently downgraded to
# "unverifiable" — and bold lands on exactly the sentences a debunk wants to cite.

MARKER_CASES = [
    ("bold", "The Great Wall is **not** visible from the Moon.", "not visible from the Moon"),
    (
        "italic",
        "Warming of *1.1 degrees* since pre-industrial.",
        "1.1 degrees since pre-industrial",
    ),
    ("underscore", "CO2 exceeded __420 ppm__ recently.", "420 ppm recently"),
    ("code", "The value is `420 ppm` today.", "420 ppm today"),
    ("heading", "## Measles Vaccination Impact\nText.", "Measles Vaccination Impact"),
    ("blockquote", "> Prevented 60 million deaths.", "Prevented 60 million deaths"),
    ("bullet", "- Nitrogen is 78 percent of air.", "Nitrogen is 78 percent"),
    ("ordered", "1. Nitrogen is 78 percent of air.", "Nitrogen is 78 percent"),
    ("table", "| Year | Deaths |\n|---|---|\n| 2023 | 60 million |", "2023 60 million"),
    (
        "mixed",
        "## **Key finding:** the wall is *not* visible",
        "Key finding: the wall is not visible",
    ),
]


@pytest.mark.parametrize(
    ("label", "source", "quote"), MARKER_CASES, ids=[c[0] for c in MARKER_CASES]
)
def test_visible_text_quote_matches_through_markdown_markers(label, source, quote):
    assert normalize_for_match(quote) in normalize_for_match(source)


def test_stripping_markers_does_not_make_matching_sloppy():
    # The fix must not turn the substring check into a fuzzy match: fabricated and
    # subtly-altered quotes still have to be rejected.
    source = "The Great Wall is **not** visible from the Moon. It is barely discernible."
    normalized = normalize_for_match(source)
    assert normalize_for_match("NASA confirms the wall IS visible") not in normalized
    assert normalize_for_match("it is barely visible") not in normalized
