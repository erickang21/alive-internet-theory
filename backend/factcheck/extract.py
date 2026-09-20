"""Claim extraction: transcript -> atomic, independently checkable claims.

The transcript is chunked by word count (long-video transcripts blow past any
single LLM context budget worth paying for), chunks are extracted concurrently,
and the overlap between adjacent chunks is collapsed by near-duplicate text
matching. The prompt is the actual filter: it must keep only checkable facts
and drop the surrounding hyperbole/opinion/anecdote a spoken video is full of.
"""

import logging
import threading
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from difflib import SequenceMatcher

from backend.config import config
from backend.factcheck.models import Claim, ClaimKind
from backend.factcheck.text_utils import normalize_for_match

logger = logging.getLogger(__name__)

CHUNK_WORDS = 2500
CHUNK_OVERLAP_WORDS = 200

# Two claims whose normalized text similarity exceeds this are the same claim
# seen twice (once in each of two overlapping chunks) — keep the higher weight.
DEDUPE_THRESHOLD = 0.85

# Mirror the config defaults, so a caller constructing these directly in a test
# gets the same behaviour as the configured pipeline.
DEFAULT_MAX_CLAIMS = 40
DEFAULT_CONCURRENCY = 4

EXTRACTION_MAX_OUTPUT_TOKENS = 4000

_VALID_KINDS: frozenset[str] = frozenset(
    {"statistic", "scientific", "historical", "quote", "causal"}
)

CLAIM_EXTRACTION_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "required": ["claims"],
    "properties": {
        "claims": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["text", "kind", "weight", "search_query", "source_quote"],
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The atomic, self-contained checkable claim.",
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["statistic", "scientific", "historical", "quote", "causal"],
                    },
                    "weight": {
                        "type": "integer",
                        "enum": [1, 2, 3],
                        "description": "3=core thesis, 2=major supporting stat, 1=minor bg.",
                    },
                    "search_query": {
                        "type": "string",
                        "description": "Query engineered to find a primary source.",
                    },
                    "source_quote": {
                        "type": "string",
                        "description": "Verbatim snippet from the transcript chunk.",
                    },
                },
            },
        }
    },
}

# THE PROMPT IS THE PRODUCT. Every few-shot example below is drawn from (or
# modeled directly on) backend/tests/fixtures/transcript.txt so the filter is
# tuned against the real mix of fact and filler a video transcript contains.
EXTRACTION_SYSTEM_PROMPT = """\
You are a fact-extraction engine for a video fact-checking pipeline. Your ONLY job is to pull
atomic, independently checkable factual assertions out of a spoken transcript chunk, and to
aggressively reject everything else.

## What counts as a claim
A claim is a specific, checkable assertion about the world: a statistic, a scientific fact, a
historical event/date, a direct quotation attributed to someone, or a causal claim ("X causes
Y"). Phrase it as a self-contained statement that would still make sense to a stranger with zero
video context — resolve pronouns and vague references ("that number", "this", "it") into their
real subject, and strip the speaker's own framing/hedging around it.

Extract a claim even if you suspect it is FALSE or a well-known myth (e.g. "the Great Wall of
China is visible from the Moon with the naked eye", "lightning never strikes the same place
twice"). Judging truth is a later pipeline stage's job, not yours — your job is only to identify
what is checkable. Likewise extract a claim that explicitly debunks a myth (e.g. "humans use
virtually all of their brain, not just ten percent") — the debunking statement is itself a
checkable assertion.

## What to DROP — never extract these
- Hyperbole / exaggeration: "this is going to blow your mind", "it's absolutely insane how long
  that myth has persisted"
- Opinion / personal takes: "I'd argue that...", "this one drives me crazy", "I think the lesson
  here is..."
- Predictions about the future
- Personal anecdotes: "I remember learning that in third grade", "I've been researching this for
  months"
- Rhetorical questions
- Calls-to-action / channel plugs: "hit subscribe", "let me know in the comments", "thanks for
  watching"
- Pure transition/framing lines with no checkable content: "let's talk about...", "here's
  another one", "moving on to..."

## Few-shot examples

KEEP (weight 3 — core thesis of the segment):
Transcript: "People say we only use ten percent of our brains. The truth is that humans use
virtually all of their brain, and brain imaging studies show activity across essentially the
entire organ over the course of a day."
-> {"text": "Humans use virtually all of their brain over the course of a day, not just ten
percent, as shown by brain imaging studies of activity across the entire organ.", "kind":
"scientific", "weight": 3, "search_query": "brain imaging study percentage of brain used
neuroscience ten percent myth research", "source_quote": "The truth is that humans use virtually
all of their brain, and brain imaging studies show activity across essentially the entire organ
over the course of a day."}

KEEP (weight 2 — major supporting statistic, note the primary-source-oriented query):
Transcript: "According to the World Health Organization, measles vaccination prevented an
estimated 60 million deaths between 2000 and 2023."
-> {"text": "Measles vaccination prevented an estimated 60 million deaths between 2000 and 2023,
according to the World Health Organization.", "kind": "statistic", "weight": 2, "search_query":
"WHO measles vaccination deaths prevented 2000 2023 official estimate report dataset",
"source_quote": "According to the World Health Organization, measles vaccination prevented an
estimated 60 million deaths between 2000 and 2023."}

KEEP (weight 1 — minor background fact):
Transcript: "The Earth's atmosphere is roughly 78 percent nitrogen and 21 percent oxygen, with
argon and carbon dioxide making up most of the remainder."
-> {"text": "Earth's atmosphere is roughly 78% nitrogen and 21% oxygen by volume.", "kind":
"scientific", "weight": 1, "search_query": "Earth atmosphere composition percentage nitrogen
oxygen NASA NOAA data", "source_quote": "The Earth's atmosphere is roughly 78 percent nitrogen
and 21 percent oxygen, with argon and carbon dioxide making up most of the remainder."}

KEEP (a stated myth is still checkable — weight 2):
Transcript: "The Great Wall of China is visible from the Moon with the naked eye. It's the only
man-made structure you can see from that distance."
-> {"text": "The Great Wall of China is visible from the Moon with the naked eye.", "kind":
"scientific", "weight": 2, "search_query": "is the Great Wall of China visible from the Moon
naked eye NASA astronaut", "source_quote": "But here's what most people get wrong: the Great
Wall of China is visible from the Moon with the naked eye."}

DROP (hyperbole, no checkable content):
Transcript: "honestly, some of these are going to blow your mind."
-> no claim extracted.

DROP (personal anecdote):
Transcript: "I remember learning that in third grade and it stuck with me ever since."
-> no claim extracted.

DROP (opinion):
Transcript: "It's absolutely insane how long that myth has persisted."
-> no claim extracted.

DROP (call-to-action):
Transcript: "If you found this useful, hit subscribe, it really helps the channel out more than
you'd think."
-> no claim extracted.

## Output fields, per claim
- text: the atomic claim as a self-contained declarative sentence, stripped of the video's
  rhetorical framing.
- kind: one of statistic | scientific | historical | quote | causal.
- weight: 3 = core thesis of the video/segment, 2 = major supporting statistic or argument, 1 =
  minor background fact.
- search_query: engineered to find PRIMARY sources — name the responsible agency/organization
  (WHO, CDC, NASA, IPCC, an original study, etc.), add terms like "study", "dataset", or
  "official report", and strip the video's own spin/framing. Never just repeat the claim text
  verbatim as the query.
- source_quote: a snippet copied VERBATIM from the transcript chunk you were given (used later
  to find the claim's timestamp) — it must be an exact substring of that transcript, not a
  paraphrase or a reconstruction.

When a sentence mixes a checkable fact with hedging or opinion, extract only the checkable part.
If nothing in the chunk is checkable, return an empty claims list. Never invent a claim that is
not present in the given text."""


def _build_user_prompt(chunk_text: str) -> str:
    return (
        "Extract every atomic, independently checkable factual claim from this "
        "transcript chunk. Follow the system instructions exactly: drop hyperbole, "
        "opinion, prediction, personal anecdote, rhetorical questions, and "
        "calls-to-action.\n\nTRANSCRIPT CHUNK:\n" + chunk_text
    )


@dataclass(slots=True)
class _RawClaim:
    """A claim as extracted from one chunk, before dedupe/cap/id assignment."""

    text: str
    kind: ClaimKind
    weight: int
    search_query: str
    source_quote: str | None
    # (chunk start word index, index within that chunk's LLM output) — an
    # approximation of transcript order good enough for cap/tie-break purposes.
    position: tuple[int, int]


_llm_warned = False
_llm_warned_lock = threading.Lock()


def _warn_llm_unavailable_once() -> None:
    global _llm_warned
    with _llm_warned_lock:
        if _llm_warned:
            return
        _llm_warned = True
    logger.warning("extract_claims: llm.complete unavailable, skipping claim extraction")


def _chunk_ranges(word_count: int) -> list[tuple[int, int]]:
    """Word-index [start, end) ranges covering `word_count` words with overlap."""
    if word_count == 0:
        return []
    step = CHUNK_WORDS - CHUNK_OVERLAP_WORDS
    ranges: list[tuple[int, int]] = []
    start = 0
    while True:
        end = min(start + CHUNK_WORDS, word_count)
        ranges.append((start, end))
        if end >= word_count:
            break
        start += step
    return ranges


def _extract_chunk(chunk_text: str, chunk_start: int) -> list[_RawClaim]:
    from backend.factcheck import llm  # lazy: llm.py may land after this module

    result = llm.complete(
        system=EXTRACTION_SYSTEM_PROMPT,
        user=_build_user_prompt(chunk_text),
        schema=CLAIM_EXTRACTION_SCHEMA,
        schema_name="claim_extraction",
        max_output_tokens=EXTRACTION_MAX_OUTPUT_TOKENS,
    )
    if result is None:
        _warn_llm_unavailable_once()
        return []
    # llm.complete already rejects a non-dict response, but this function
    # promises it never raises, so don't depend on a collaborator for that.
    if not isinstance(result, dict):
        logger.warning("extract: ignoring non-object LLM response (%s)", type(result).__name__)
        return []

    raw_items = result.get("claims") or []
    parsed: list[_RawClaim] = []
    for index, item in enumerate(raw_items):
        try:
            kind = item["kind"]
            if kind not in _VALID_KINDS:
                raise ValueError(f"unknown claim kind {kind!r}")
            text = str(item["text"]).strip()
            search_query = str(item["search_query"]).strip()
            if not text or not search_query:
                raise ValueError("empty text or search_query")
            source_quote = item.get("source_quote")
            source_quote = str(source_quote).strip() if source_quote else None
            parsed.append(
                _RawClaim(
                    text=text,
                    kind=kind,
                    weight=int(item["weight"]),
                    search_query=search_query,
                    source_quote=source_quote or None,
                    position=(chunk_start, index),
                )
            )
        except (KeyError, TypeError, ValueError) as error:
            logger.warning("extract_claims: dropping malformed claim from LLM output: %s", error)
    return parsed


def _dedupe(raw_claims: Sequence[_RawClaim]) -> list[_RawClaim]:
    """Collapse near-duplicate claims (the overlap window sees them twice)."""
    kept: list[_RawClaim] = []
    kept_normalized: list[str] = []
    for candidate in raw_claims:
        candidate_normalized = normalize_for_match(candidate.text)
        merged = False
        for i, existing_normalized in enumerate(kept_normalized):
            ratio = SequenceMatcher(None, candidate_normalized, existing_normalized).ratio()
            if ratio > DEDUPE_THRESHOLD:
                existing = kept[i]
                if candidate.weight > existing.weight or (
                    candidate.weight == existing.weight and candidate.position < existing.position
                ):
                    kept[i] = candidate
                    kept_normalized[i] = candidate_normalized
                merged = True
                break
        if not merged:
            kept.append(candidate)
            kept_normalized.append(candidate_normalized)
    return kept


def extract_claims(transcript: str, *, max_claims: int | None = None) -> list[Claim]:
    words = transcript.split()
    if not words:
        return []

    ranges = _chunk_ranges(len(words))
    chunks = [(" ".join(words[start:end]), start) for start, end in ranges]

    concurrency = max(1, config.factcheck_concurrency)
    raw_claims: list[_RawClaim] = []
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(_extract_chunk, text, start) for text, start in chunks]
        for future in futures:
            raw_claims.extend(future.result())

    deduped = _dedupe(raw_claims)
    deduped.sort(key=lambda c: (-c.weight, c.position))

    cap = max_claims if max_claims is not None else config.factcheck_max_claims
    if cap is not None:
        deduped = deduped[:cap]

    return [
        Claim(
            id=f"c{i}",
            text=rc.text,
            kind=rc.kind,
            weight=rc.weight,
            search_query=rc.search_query,
            source_quote=rc.source_quote,
        )
        for i, rc in enumerate(deduped, start=1)
    ]


def attach_timestamps(claims: list[Claim], segments: list[dict] | None) -> None:
    """Locate each claim's source_quote among `segments` and set timestamp_s.

    `segments` is `[{"start": float, "text": str}, ...]`. Pure function, no I/O:
    mutates `claims` in place. A no-op when segments is falsy.
    """
    if not segments:
        return

    normalized_segments = [
        (segment.get("start"), normalize_for_match(str(segment.get("text", ""))))
        for segment in segments
    ]

    for claim in claims:
        if not claim.source_quote:
            continue
        normalized_quote = normalize_for_match(claim.source_quote)
        if not normalized_quote:
            continue
        for start, normalized_text in normalized_segments:
            if start is None:
                continue
            if normalized_quote in normalized_text:
                claim.timestamp_s = start
                break
