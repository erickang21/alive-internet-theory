"""Text normalization shared by verify.py, evidence.py, and their tests.

`normalize_for_match` is the anti-hallucination check's core assumption: a
quote lifted verbatim out of a source must remain a substring of that source
after normalization, on both sides of the comparison.
"""

import re

# Images first: "![alt](url)" also matches the link pattern once the leading
# "!" is ignored, so stripping links first would leave a stray "!".
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")

_GLYPH_MAP = str.maketrans(
    {
        "‘": "'",  # left single quote
        "’": "'",  # right single quote
        "‚": "'",  # single low-9 quote
        "‛": "'",  # single high-reversed-9 quote
        "“": '"',  # left double quote
        "”": '"',  # right double quote
        "„": '"',  # double low-9 quote
        "‟": '"',  # double high-reversed-9 quote
        "–": "-",  # en dash
        "—": "-",  # em dash
        " ": " ",  # NBSP
    }
)

# Block-level markers at the start of a line: headings, blockquotes, list bullets
# and ordered-list numbers. A quote taken from the visible text of a heading or a
# bullet must still match the source it came from.
_BLOCK_MARKER_RE = re.compile(r"(?m)^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+\.[ \t]+)")
# Inline emphasis and code markers. These are stripped as CHARACTERS rather than
# parsed: both sides of the comparison get the same treatment, so an unbalanced
# marker can't cause a mismatch. Bold in particular lands on exactly the sentences
# a debunk wants to quote, so leaving these in silently drops good citations.
_EMPHASIS_RE = re.compile(r"[*_`~]+")
# Table cell pipes, and the |---|:---:| separator rows they sit above.
_TABLE_SEPARATOR_RE = re.compile(r"(?m)^[ \t]*\|?[ \t:\-|]+\|[ \t:\-|]*$")

_WHITESPACE_RE = re.compile(r"\s+")
_WORD_RE = re.compile(r"[A-Za-z0-9]+")

STOPWORDS: frozenset[str] = frozenset(
    {
        "that",
        "this",
        "these",
        "those",
        "with",
        "from",
        "have",
        "has",
        "had",
        "having",
        "does",
        "did",
        "doing",
        "would",
        "could",
        "should",
        "shall",
        "must",
        "might",
        "will",
        "just",
        "also",
        "their",
        "them",
        "they",
        "your",
        "about",
        "into",
        "over",
        "under",
        "between",
        "through",
        "during",
        "above",
        "below",
        "again",
        "further",
        "once",
        "here",
        "there",
        "when",
        "where",
        "which",
        "while",
        "whom",
        "what",
        "than",
        "then",
        "some",
        "such",
        "only",
        "same",
        "very",
        "more",
        "most",
        "other",
        "each",
        "both",
        "being",
        "been",
        "were",
    }
)


def normalize_for_match(s: str) -> str:
    """Canonicalize markdown/typography noise so quotes compare reliably.

    Every marker that can sit *inside* a sentence has to go, not just links: a
    model asked to quote a source copies the text it can see, which never
    includes the surrounding ``**`` or a leading ``>``.
    """
    s = _IMAGE_RE.sub(r"\1", s)
    s = _LINK_RE.sub(r"\1", s)
    s = _TABLE_SEPARATOR_RE.sub(" ", s)
    s = _BLOCK_MARKER_RE.sub("", s)
    s = _EMPHASIS_RE.sub("", s)
    s = s.replace("|", " ")
    s = s.translate(_GLYPH_MAP)
    s = _WHITESPACE_RE.sub(" ", s)
    return s.casefold().strip()


def keywords(text: str, min_length: int = 4) -> set[str]:
    """Casefolded content words of at least `min_length` chars, stopworded."""
    words = _WORD_RE.findall(text.casefold())
    return {w for w in words if len(w) >= min_length and w not in STOPWORDS}
