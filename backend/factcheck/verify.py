"""Claim verification against fetched sources — the anti-hallucination boundary.

The LLM proposes a verdict and quotes; this module is the code (not prompt)
that decides whether each quote is real. A citation only survives if its
source_index resolves to a source we actually fetched AND its quote is a
verbatim substring of that source's FULL markdown (not the trimmed excerpt
sent to the model) after `normalize_for_match`. A "false"/"misleading"
verdict that ends up with zero surviving citations is downgraded to
"unverifiable" rather than trusted on the model's word alone.
"""

import logging

from backend.factcheck.models import Citation, Claim, ClaimVerdict, Source, truth_score_for
from backend.factcheck.text_utils import normalize_for_match

logger = logging.getLogger(__name__)

MAX_OUTPUT_TOKENS = 1200
DAMAGING_STATUSES = ("false", "misleading")
CITATIONS_FAILED_REASON = "citations failed verification"

# A citation has to quote enough text to actually support the verdict. Tuned to
# admit a terse real statistic ("CO2 exceeded 420 ppm in 2023") while rejecting
# filler like "the", which would substring-match any page ever fetched.
MIN_QUOTE_WORDS = 4
MIN_QUOTE_CHARS = 20

VERIFY_SYSTEM_PROMPT = """You are a fact-checking assistant. You will be given a claim \
extracted from a video transcript and numbered excerpts from independently fetched web \
sources. Decide whether the claim is supported by those sources.

Rules:
- Base your verdict ONLY on the provided source excerpts. Never reason from prior \
knowledge or general familiarity with the topic.
- If the sources do not clearly confirm or contradict the claim, answer "unverifiable" \
rather than guessing.
- Every quote you cite MUST be copied VERBATIM (character-for-character) from the source \
text given to you. Do not paraphrase, summarize, or lightly edit a quote.
- Reference sources by their index number as given.
- Only use status "false" or "misleading" when you can back it with a verbatim quote that \
contradicts or undermines the claim; otherwise prefer "unverifiable" or a weaker status.
"""

VERIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {
            "type": "string",
            "enum": ["verified_true", "mostly_true", "misleading", "false", "unverifiable"],
        },
        "reasoning": {"type": "string"},
        "debunk": {"type": ["string", "null"]},
        "citations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "source_index": {"type": "integer"},
                    "quote": {"type": "string"},
                },
                "required": ["source_index", "quote"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["status", "reasoning", "debunk", "citations"],
    "additionalProperties": False,
}


def _usable_sources(sources: list[Source]) -> list[Source]:
    return [s for s in sources if s.fetched_ok and s.markdown]


def _unverifiable_verdict(claim: Claim, reason: str, sources_consulted: list[str]) -> ClaimVerdict:
    return ClaimVerdict(
        claim=claim,
        status="unverifiable",
        truth_score=None,
        reasoning=reason,
        debunk=None,
        citations=[],
        unverifiable_reason=reason,
        sources_consulted=sources_consulted,
    )


def _no_sources_reason(sources: list[Source]) -> str:
    if not sources:
        return "no sources were found for this claim"
    distinct_failures = sorted({s.failure for s in sources if s.failure})
    if distinct_failures:
        return "all source fetches failed (" + ", ".join(distinct_failures) + ")"
    return "no usable source content was fetched for this claim"


def _build_user_message(claim: Claim, usable: list[Source]) -> str:
    from backend.factcheck.evidence import excerpt_for  # lazy: evidence.py owned in parallel

    lines = [
        f"Claim ({claim.kind}, weight {claim.weight}): {claim.text}",
    ]
    if claim.source_quote:
        lines.append(f"As stated in the video: \"{claim.source_quote}\"")
    lines.append("")
    lines.append("Sources:")
    for i, src in enumerate(usable):
        excerpt = excerpt_for(src.markdown or "", claim)
        lines.append(
            f"\n[{i}] url={src.url} domain={src.domain} tier={src.tier}\n{excerpt}"
        )
    return "\n".join(lines)


def _is_substantive(quote: str) -> bool:
    """Reject quotes too short to be evidence of anything.

    The substring check alone is not enough: "the" appears in every document, so a
    one-word quote would let a model substantiate any verdict against any source,
    and a non-empty citation list suppresses the downgrade that would otherwise
    catch it. A citation has to carry enough text to actually support the claim.
    """
    words = normalize_for_match(quote).split()
    return len(words) >= MIN_QUOTE_WORDS and sum(len(w) for w in words) >= MIN_QUOTE_CHARS


def _validate_citations(
    raw_citations: list[dict],
    usable: list[Source],
    claim_id: str,
) -> list[Citation]:
    """Enforce the anti-hallucination rule. Returns only citations that pass all checks."""
    kept: list[Citation] = []
    seen: set[tuple[int, str]] = set()
    dropped = 0
    # Normalizing a full fetched page runs six regex passes over it, each an
    # uninterruptible GIL hold; done per citation it stalls every API request
    # thread in the process, so each source is normalized at most once.
    normalized_pages: dict[int, str] = {}
    for raw in raw_citations:
        # The list itself can contain anything the model emitted, including bare
        # strings, so don't assume a dict before asking it for keys.
        if not isinstance(raw, dict):
            dropped += 1
            continue
        idx = raw.get("source_index")
        quote = raw.get("quote")
        # bool is a subclass of int, so `source_index: true` would otherwise pass
        # the type check and silently read usable[1].
        if isinstance(idx, bool) or not isinstance(idx, int):
            dropped += 1
            continue
        if not isinstance(quote, str) or not _is_substantive(quote):
            dropped += 1
            continue
        if idx < 0 or idx >= len(usable):
            dropped += 1
            continue
        src = usable[idx]
        if not src.markdown:
            dropped += 1
            continue
        if idx not in normalized_pages:
            normalized_pages[idx] = normalize_for_match(src.markdown)
        normalized_quote = normalize_for_match(quote)
        if normalized_quote not in normalized_pages[idx]:
            dropped += 1
            continue
        # Citing the same passage twice doesn't make it better evidence, but it
        # does inflate the citation count in the stored report.
        fingerprint = (idx, normalized_quote)
        if fingerprint in seen:
            dropped += 1
            continue
        seen.add(fingerprint)
        # url/domain/title come from OUR Source record, never the model's output.
        kept.append(Citation(title=src.title, domain=src.domain, url=src.url, quote=quote))

    if dropped:
        logger.warning(
            "verify_claim: dropped %d/%d citation(s) that failed verification for claim %s",
            dropped,
            len(raw_citations),
            claim_id,
        )
    return kept


def verify_claim(claim: Claim, sources: list[Source]) -> ClaimVerdict:
    """Verify a single claim against its candidate sources. Never raises."""
    usable = _usable_sources(sources)
    sources_consulted = [s.url for s in usable]

    if not usable:
        reason = _no_sources_reason(sources)
        return _unverifiable_verdict(claim, reason, sources_consulted)

    try:
        from backend.factcheck import llm  # lazy: llm.py owned in parallel

        result = llm.complete(
            system=VERIFY_SYSTEM_PROMPT,
            user=_build_user_message(claim, usable),
            schema=VERIFY_SCHEMA,
            schema_name="claim_verdict",
            max_output_tokens=MAX_OUTPUT_TOKENS,
        )
    except Exception:
        logger.exception("verify_claim: llm.complete raised for claim %s", claim.id)
        result = None

    if result is None:
        return _unverifiable_verdict(
            claim, "LLM unavailable for verification", sources_consulted
        )
    # Same belt-and-braces as extract.py: this function's contract is that it
    # never raises, whatever a collaborator hands back.
    if not isinstance(result, dict):
        logger.warning("verify_claim: non-object LLM response for claim %s", claim.id)
        return _unverifiable_verdict(claim, "malformed verification response", sources_consulted)

    status = result.get("status")
    if status not in ("verified_true", "mostly_true", "misleading", "false", "unverifiable"):
        logger.warning(
            "verify_claim: model returned unrecognized status %r for claim %s", status, claim.id
        )
        return _unverifiable_verdict(
            claim, "model returned an unrecognized verdict", sources_consulted
        )

    reasoning = result.get("reasoning") or ""
    raw_debunk = result.get("debunk")
    raw_citations = result.get("citations") or []

    citations = _validate_citations(raw_citations, usable, claim.id)

    unverifiable_reason: str | None = None
    if status in DAMAGING_STATUSES and not citations:
        status = "unverifiable"
        unverifiable_reason = CITATIONS_FAILED_REASON

    debunk: str | None = None
    if status in DAMAGING_STATUSES:
        debunk = raw_debunk if isinstance(raw_debunk, str) and raw_debunk.strip() else reasoning

    truth_score = truth_score_for(status)

    return ClaimVerdict(
        claim=claim,
        status=status,
        truth_score=truth_score,
        reasoning=reasoning,
        debunk=debunk,
        citations=citations,
        unverifiable_reason=unverifiable_reason,
        sources_consulted=sources_consulted,
    )


def verify_all(
    claims: list[Claim],
    sources_by_claim: dict[str, list[Source]],
) -> list[ClaimVerdict]:
    """Verify every claim. A single claim's failure never aborts the batch."""
    verdicts: list[ClaimVerdict] = []
    for claim in claims:
        sources = sources_by_claim.get(claim.id, [])
        try:
            verdicts.append(verify_claim(claim, sources))
        except Exception:
            logger.exception("verify_all: verify_claim failed unexpectedly for claim %s", claim.id)
            verdicts.append(
                _unverifiable_verdict(
                    claim, "verification failed unexpectedly", [s.url for s in sources]
                )
            )
    return verdicts
