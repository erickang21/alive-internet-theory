"""The `fact_check` scoring criterion: a thin adapter over the fact-check engine.

CLAUDE.md marks `fact_check` "not scored yet" -- this criterion always reports
deduction=0/applied=False, and the Validity Score it surfaces is deliberately
independent of the AI-slop score math in backend/scoring/engine.py. What this
module adds beyond just calling the engine is:
  - the same "no usable LLM credentials -> skip with one warning" degradation
    backend/factcheck/llm.py already gives every individual LLM call, applied
    once up front so a whole video isn't spent extracting/verifying claims
    that can never get an answer
  - deriving the three legacy `videos` columns (is_educational/thesis/
    hallucinated) the extension already reads, from the engine's richer
    per-claim output, so existing consumers keep working unchanged
"""

import logging
from typing import Any

from backend.config import config
from backend.factcheck.engine import FactCheckEngine
from backend.factcheck.models import ClaimVerdict, ValidityReport
from backend.factcheck.pregate import SOURCE_FALLBACK, PreGateResult, pre_gate

logger = logging.getLogger(__name__)

CRITERION = "fact_check"
DAMAGING_STATUSES = ("false", "misleading")

# Thresholds behind the `is_educational` approximation (see _legacy_fields): a
# video qualifies on volume of checkable content, or on having one claim the
# extractor judged central.
MIN_EDUCATIONAL_CLAIMS = 3
CORE_CLAIM_WEIGHT = 3

# Set on the first credentials failure so the rest of the run skips with one
# warning instead of spending an extraction/verification pass per video that
# can never get an answer. Same pattern as backend/factcheck/llm.py's _disabled.
_credentials_unusable = False


def _credentials_configured() -> bool:
    """Best-effort, network-free check for whether the configured LLM provider has a key.

    This only asks whether a value is present, not whether it's valid -- an
    invalid key still degrades gracefully deeper in the pipeline (llm.complete
    catches it there, and extract.py/verify.py treat a None completion as "no
    claims"/"unverifiable", a normal engine outcome, not a reason to skip the
    whole criterion up front).
    """
    provider = config.factcheck_provider
    if provider == "openai":
        return bool(config.openai_api_key)
    if provider == "gateway":
        return bool(config.gateway_url) and bool(config.browserbase_api_key)
    if provider == "anthropic":
        import anthropic

        client = anthropic.Anthropic()
        return not (
            client.api_key is None and client.auth_token is None and client.credentials is None
        )
    return False


def _disable(reason: str) -> None:
    global _credentials_unusable
    _credentials_unusable = True
    logger.warning(
        "Skipping the fact check for this run: %s. Set OPENAI_API_KEY, BROWSERBASE_API_KEY, "
        "or ANTHROPIC_API_KEY (depending on FACTCHECK_LLM_PROVIDER) in the repo-root or "
        "backend/.env.",
        reason,
    )


def _skipped_entry() -> dict[str, Any]:
    return {
        "criterion": CRITERION,
        "deduction": 0,
        "applied": False,
        "detail": "Skipped: no usable fact-check LLM credentials.",
        "evidence": {
            "is_educational": None,
            "thesis": None,
            "hallucinated": None,
            "validity_score": None,
            "validity_rating": None,
        },
    }


def _pregate_skipped_entry(gate: PreGateResult) -> dict[str, Any]:
    """The breakdown entry for a video the pre-gate ruled out before the engine ran.

    Legacy-field mapping for this path (distinct from `_skipped_entry`, which
    means "we don't know anything"): when the pre-gate actually classified the
    video, it concluded this isn't the kind of thing fact-checking applies to,
    so `is_educational=False` is actual information, not a placeholder. The
    fail-closed fallback gate (`SOURCE_FALLBACK`: the classifier was down or
    had no credentials) determined nothing about the video, so there
    `is_educational` stays None -- storing False would freeze an outage into
    the row as a content verdict. `thesis` and `hallucinated` stay None because
    no claim was ever extracted or verified -- there is nothing to report a
    thesis or a truth value for.
    """
    determined = gate.source != SOURCE_FALLBACK
    return {
        "criterion": CRITERION,
        "deduction": 0,
        "applied": False,
        "detail": f"Not fact-checked: {gate.reason}",
        "evidence": {
            "is_educational": False if determined else None,
            "thesis": None,
            "hallucinated": None,
            "validity_score": None,
            "validity_rating": None,
            "pregate": gate.to_dict(),
        },
    }


def _top_claim_verdict(report: ValidityReport) -> ClaimVerdict | None:
    if not report.verdicts:
        return None
    return max(report.verdicts, key=lambda v: v.claim.weight)


def _legacy_fields(report: ValidityReport) -> dict[str, Any]:
    """Derive the legacy is_educational/thesis/hallucinated columns.

    These approximate the old per-video thesis check from the engine's richer
    per-claim output, so the columns the extension already reads keep working.
    The approximations are deliberately conservative:

    - `is_educational` asks whether checkable content is the video's *point*,
      not whether it contains any. A comedy video with one factual aside
      shouldn't qualify, so it takes several claims or one clear central one.
    - `thesis` is the highest-weight claim's text.
    - `hallucinated` reflects only that one claim, and only when the sources
      actually contradicted it. An `unverifiable` thesis means we couldn't
      check it, which is not the same as the video being wrong.

    All three are None (not these derived values) when the check couldn't run
    at all -- see `_skipped_entry`.
    """
    top = _top_claim_verdict(report)
    is_educational = report.claim_count >= MIN_EDUCATIONAL_CLAIMS or (
        top is not None and top.claim.weight >= CORE_CLAIM_WEIGHT
    )
    thesis = top.claim.text if top else None
    hallucinated = (top.status in DAMAGING_STATUSES) if top else False
    return {"is_educational": is_educational, "thesis": thesis, "hallucinated": hallucinated}


def evidence_for_report(report: ValidityReport) -> dict[str, Any]:
    """The `videos`-table-shaped fields (VIDEO_COLUMNS) derived from a report.

    Shared by `score_transcript` (below) and `backend/factcheck/__main__.py`,
    so a report stored from the standalone CLI looks identical to one stored
    through the normal analyze pipeline.
    """
    return {
        **_legacy_fields(report),
        "validity_score": report.validity_score,
        "validity_rating": report.rating,
    }


def entry_for_report(report: ValidityReport) -> dict[str, Any]:
    """The full breakdown entry for a completed report.

    Shared by `score_transcript` (below) and `backend/factcheck/__main__.py`,
    so a report stored from the standalone CLI is served by
    `GET /video/fact-check` exactly like one stored through the analyze
    pipeline (the route reads `evidence.report`).
    """
    return {
        "criterion": CRITERION,
        "deduction": 0,
        "applied": False,
        "detail": _detail(report),
        "evidence": {**evidence_for_report(report), "report": report.to_dict()},
    }


def _detail(report: ValidityReport) -> str:
    if report.claim_count == 0:
        return "No checkable factual claims were extracted from this video."
    score_text = (
        f"{report.validity_score:.1f}/100" if report.validity_score is not None else "n/a"
    )
    return (
        f"{report.rating} ({score_text}) across {report.claim_count} claim(s) "
        f"({report.verifiable_count} verifiable)."
    )


def score_transcript(
    transcript: str,
    *,
    title: str | None = None,
    description: str | None = None,
    categories: list[str] | None = None,
) -> dict[str, Any]:
    """Fact-check every checkable claim in the transcript via FactCheckEngine.

    Recorded for the breakdown but never scored (deduction=0, applied=False):
    the Validity Score this surfaces is a separate, independent metric from
    the AI-slop score, per CLAUDE.md and the user's own choice to keep them
    apart.

    `title`/`description`/`categories` come straight from the yt-dlp `info`
    dict already in memory in backend/analyze.py -- no extra download. They
    feed the pre-gate (backend/factcheck/pregate.py), which decides whether
    this video is even worth fact-checking BEFORE the engine (claim
    extraction, web search, per-claim verification -- minutes and real API
    budget) is allowed to run. `pre_gate` never raises.
    """
    gate = gate_video(
        transcript, title=title, description=description, categories=categories
    )
    if not gate.is_eligible:
        return entry_for_gate(gate)
    return run_engine(transcript)


def gate_video(
    transcript: str,
    *,
    title: str | None = None,
    description: str | None = None,
    categories: list[str] | None = None,
) -> PreGateResult:
    """The cheap half: is this video worth the engine at all? Never raises.

    Split out so a caller running the check off the critical path
    (backend/factchecks.py) can report the two phases separately -- deciding
    eligibility is seconds, the engine is minutes, and the extension's tab
    says something different for each.
    """
    return pre_gate(
        title=title, description=description, transcript=transcript, categories=categories
    )


def entry_for_gate(gate: PreGateResult) -> dict[str, Any]:
    """The breakdown entry for a video the pre-gate ruled out."""
    return _pregate_skipped_entry(gate)


def run_engine(transcript: str) -> dict[str, Any]:
    """The expensive half: extract, gather sources, verify every claim.

    Assumes the pre-gate already passed. Minutes and real API budget.
    """
    if _credentials_unusable:
        return _skipped_entry()
    if not _credentials_configured():
        _disable("no usable fact-check LLM credentials configured")
        return _skipped_entry()

    report = FactCheckEngine().run(transcript)
    return entry_for_report(report)
