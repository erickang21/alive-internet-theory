"""Fiction vs non-fiction pre-gate: decide whether a video is worth fact-checking.

The full pipeline (claim extraction, web search, per-claim verification) costs
minutes and a lot of API budget per video. Most YouTube videos are not the kind
of thing a fact-check can say anything useful about, so this module stops them
before any of that starts.

Two tiers, and the first one is the point:

  Tier 1  YouTube's own `categories`, which yt-dlp already puts in
          video.info.json and which nothing else reads. Free, instant, and it
          decides in BOTH directions - it bypasses obvious entertainment AND
          fast-paths obvious non-fiction, skipping the LLM at either end.
  Tier 2  One small structured LLM call, only for genuinely ambiguous
          categories, over the title, a truncated description, and the opening
          few sentences of the transcript.

`pre_gate` never raises, for any input.
"""

import logging
import re
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

# Below this, there isn't enough spoken content to classify OR to fact-check,
# so we answer without spending an LLM call.
MIN_TRANSCRIPT_WORDS = 40
MAX_DESCRIPTION_CHARS = 1000
TRANSCRIPT_SENTENCES = 8
CLASSIFY_MAX_OUTPUT_TOKENS = 300

# --- Tier 1: YouTube's own category labels ----------------------------------

BYPASS_CATEGORIES: frozenset[str] = frozenset(
    {
        "Gaming",
        "Comedy",
        "Film & Animation",
        "Music",
        "Pets & Animals",
        "Autos & Vehicles",
    }
)

PROCEED_CATEGORIES: frozenset[str] = frozenset(
    {
        "News & Politics",
        "Education",
        "Science & Technology",
        "Nonprofits & Activism",
    }
)

# Everything else falls through to Tier 2 on purpose. "Entertainment" and
# "People & Blogs" in particular are where video-essay and commentary channels
# land, and those are exactly the videos worth checking - hard-coding them
# either way would be the single biggest source of wrong answers here.

# --- Taxonomy ----------------------------------------------------------------

NON_FICTION_CATEGORIES: frozenset[str] = frozenset(
    {
        "news",
        "educational",
        "science",
        "commentary",
        "political",
        "historical",
        "health",
    }
)

FICTION_CATEGORIES: frozenset[str] = frozenset(
    {
        "fiction",
        "gaming",
        "comedy",
        "satire",
        "entertainment_vlog",
        "music",
        "storytelling",
        "creative",
    }
)

CATEGORY_INSUFFICIENT_SIGNAL = "insufficient_signal"
CATEGORY_UNKNOWN = "unknown"

# Every value the classifier is allowed to return.
TAXONOMY: tuple[str, ...] = tuple(
    sorted(NON_FICTION_CATEGORIES | FICTION_CATEGORIES)
    + [CATEGORY_INSUFFICIENT_SIGNAL, CATEGORY_UNKNOWN]
)

SOURCE_CATEGORY = "category"
SOURCE_LLM = "llm"
SOURCE_FALLBACK = "fallback"

# User-facing. The extension renders `reason` verbatim, so these are sentences,
# not log lines.
REASON_BYPASS_CATEGORY = (
    "YouTube lists this video under {category}, which is entertainment rather than "
    "factual content."
)
REASON_PROCEED_CATEGORY = (
    "YouTube lists this video under {category}, so it was sent straight to fact-checking."
)
REASON_INSUFFICIENT = (
    "There isn't enough spoken content in this video to check any factual claims."
)
# Deliberately worded as "couldn't classify", NOT as fiction: we fail closed to
# protect the API budget, but saying "this is fiction" would be a claim we have
# not actually made.
REASON_UNKNOWN = (
    "This video couldn't be classified, so fact-checking was skipped rather than guessed at."
)

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

CLASSIFY_SYSTEM_PROMPT = """You route YouTube videos to a fact-checking pipeline.

Decide whether a video's main purpose is to assert checkable facts about the real world, \
or to entertain. Answer with one category.

NON-FICTION (worth fact-checking):
  news               reporting on real events
  educational        explainers, tutorials with factual claims, documentaries
  science            scientific or technical explanation
  commentary         analysis or opinion built on factual claims about the world
  political          political argument or advocacy making factual claims
  historical         accounts of real past events
  health             medical, nutritional, or fitness claims

FICTION / ENTERTAINMENT (not worth fact-checking):
  fiction            scripted or invented narrative
  gaming             gameplay, let's plays, game commentary
  comedy             jokes, sketches, bits
  satire             deliberate parody, not intended as literal truth
  entertainment_vlog personal daily life, travel, lifestyle
  music              music videos, performances
  storytelling       personal anecdotes and reaction content
  creative           art, craft, or making content with no factual thesis

Judge by the video's MAIN PURPOSE. A comedy sketch that mentions a real statistic is \
still comedy. A science explainer with jokes in it is still science. When a video argues \
about the real world using facts, prefer commentary over entertainment_vlog, even if the \
presenter is informal."""

CLASSIFY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "category": {"type": "string", "enum": list(TAXONOMY)},
        "reason": {
            "type": "string",
            "description": "One sentence, addressed to a viewer, explaining the call.",
        },
    },
    "required": ["category", "reason"],
    "additionalProperties": False,
}


@dataclass(slots=True)
class PreGateResult:
    is_eligible: bool
    category: str
    reason: str
    source: str

    def to_dict(self) -> dict[str, Any]:
        # camelCase at the boundary: this crosses into chrome.storage.local.
        return {
            "isEligible": self.is_eligible,
            "category": self.category,
            "reason": self.reason,
            "source": self.source,
        }


def is_eligible_category(category: str) -> bool:
    """Eligibility is derived from the taxonomy, never from a second model field."""
    return category in NON_FICTION_CATEGORIES


def pre_gate(
    *,
    title: str | None,
    description: str | None,
    transcript: str | None,
    categories: list[str] | None,
) -> PreGateResult:
    """Decide whether `video` should go through the fact-check engine."""
    title = title or ""
    description = description or ""
    transcript = transcript or ""

    # 1. Nothing to work with. Answered without an LLM call because a transcript
    #    this short can't support a fact-check either way.
    if len(transcript.split()) < MIN_TRANSCRIPT_WORDS:
        return PreGateResult(False, CATEGORY_INSUFFICIENT_SIGNAL, REASON_INSUFFICIENT, SOURCE_LLM)

    # 2/3. YouTube already told us, for free.
    #
    # Bypass is checked across ALL categories before proceed, so a video tagged
    # both "Gaming" and "Education" resolves the same way whichever order
    # yt-dlp happened to list them in. Iterating once and returning on the
    # first hit made the answer depend on list order.
    known = _known_categories(categories)
    for category in known:
        if category in BYPASS_CATEGORIES:
            return _tier1_result(category, REASON_BYPASS_CATEGORY)
    for category in known:
        if category in PROCEED_CATEGORIES:
            return _tier1_result(category, REASON_PROCEED_CATEGORY)

    # 4. Ambiguous or unlabelled - ask the model.
    return _classify(title, description, transcript)


def _known_categories(categories: Any) -> list[str]:
    """The string entries of `categories`, tolerating any shape a caller passes.

    A bare string is rejected rather than iterated: `for c in "Education"`
    yields characters, none of which match, which would silently throw away the
    free Tier 1 signal and pay for an LLM call instead.
    """
    if isinstance(categories, str):
        logger.warning("pre_gate: `categories` was a string (%r); expected a list", categories)
        return [categories]
    if not isinstance(categories, (list, tuple, set, frozenset)):
        if categories is not None:
            logger.warning("pre_gate: ignoring `categories` of type %s", type(categories).__name__)
        return []
    return [c for c in categories if isinstance(c, str)]


def _tier1_result(category: str, reason_template: str) -> PreGateResult:
    # Eligibility is derived from the taxonomy here too, exactly as Tier 2 does
    # it, so the stored category can never contradict the decision (a "skipped"
    # card labelled "educational").
    taxonomy = _taxonomy_for_youtube_category(category)
    return PreGateResult(
        is_eligible_category(taxonomy),
        taxonomy,
        reason_template.format(category=category),
        SOURCE_CATEGORY,
    )


# YouTube's labels are coarser than our taxonomy; map the unambiguous ones so the
# stored category is always a taxonomy value regardless of which tier decided.
_YOUTUBE_TO_TAXONOMY = {
    "Gaming": "gaming",
    "Comedy": "comedy",
    "Film & Animation": "fiction",
    "Music": "music",
    "Pets & Animals": "entertainment_vlog",
    "Autos & Vehicles": "entertainment_vlog",
    "News & Politics": "news",
    "Education": "educational",
    "Science & Technology": "science",
    "Nonprofits & Activism": "commentary",
}


def _taxonomy_for_youtube_category(category: str) -> str:
    return _YOUTUBE_TO_TAXONOMY.get(category, CATEGORY_UNKNOWN)


def _opening_sentences(transcript: str) -> str:
    sentences = _SENTENCE_SPLIT_RE.split(transcript.strip())
    return " ".join(sentences[:TRANSCRIPT_SENTENCES])


def _build_user_prompt(title: str, description: str, transcript: str) -> str:
    return (
        f"Title: {title}\n\n"
        f"Description: {description[:MAX_DESCRIPTION_CHARS]}\n\n"
        f"Transcript opening: {_opening_sentences(transcript)}"
    )


def _unknown() -> PreGateResult:
    # Fail closed: a broken or unavailable classifier must never spend the
    # engine's API budget on a guess.
    return PreGateResult(False, CATEGORY_UNKNOWN, REASON_UNKNOWN, SOURCE_FALLBACK)


def _classify(title: str, description: str, transcript: str) -> PreGateResult:
    from backend.factcheck import llm  # lazy, matching extract.py

    try:
        result = llm.complete(
            system=CLASSIFY_SYSTEM_PROMPT,
            user=_build_user_prompt(title, description, transcript),
            schema=CLASSIFY_SCHEMA,
            schema_name="pre_gate",
            max_output_tokens=CLASSIFY_MAX_OUTPUT_TOKENS,
        )
    except Exception:
        logger.exception("pre_gate: classifier raised; treating as unclassified")
        return _unknown()

    if not isinstance(result, dict):
        return _unknown()

    category = result.get("category")
    if category not in NON_FICTION_CATEGORIES and category not in FICTION_CATEGORIES:
        # Includes the model echoing insufficient_signal/unknown, and anything
        # outside the taxonomy that slipped past the schema.
        return _unknown()

    reason = result.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        reason = REASON_UNKNOWN if category == CATEGORY_UNKNOWN else f"Classified as {category}."

    return PreGateResult(is_eligible_category(category), category, reason.strip(), SOURCE_LLM)
