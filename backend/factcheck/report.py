"""Renders a `ValidityReport` as Markdown (for humans) or a plain dict (for the API)."""

import re
from typing import Any

from backend.factcheck.models import Citation, Claim, ClaimVerdict, ValidityReport

DEBUNKED_STATUSES = ("false", "misleading")
VERIFIED_STATUSES = ("verified_true", "mostly_true")

STATUS_LABELS: dict[str, str] = {
    "verified_true": "Verified true",
    "mostly_true": "Mostly true",
    "misleading": "Misleading",
    "false": "False",
    "unverifiable": "Unverifiable",
}

_NEWLINE_RE = re.compile(r"\s*\n\s*")


def _collapse(text: str) -> str:
    """Collapse embedded newlines so a multi-line quote can't break a blockquote."""
    return _NEWLINE_RE.sub(" ", text).strip()


def _timestamp(seconds: float | None) -> str | None:
    if seconds is None:
        return None
    total = max(0, int(seconds))
    return f"[{total // 60:02d}:{total % 60:02d}]"


def _score_line(report: ValidityReport) -> str:
    if report.validity_score is None:
        line = f"**{report.rating}**"
    else:
        line = f"**{report.rating}** — {report.validity_score:.1f}/100"
    if report.low_confidence:
        line += " _(low confidence: few verifiable claims)_"
    return line


def _metrics_table(report: ValidityReport) -> list[str]:
    lines = [
        "| Metric | Count |",
        "|---|---|",
        f"| Claims found | {report.claim_count} |",
        f"| Verifiable | {report.verifiable_count} |",
    ]
    for status, count in report.counts_by_status.items():
        label = STATUS_LABELS.get(status, status)
        lines.append(f"| {label} | {count} |")
    return lines


def _citation_link(v: ClaimVerdict) -> str | None:
    if not v.citations:
        return None
    c = v.citations[0]
    title = c.title or c.domain or c.url
    return f"[{title}]({c.url}) ({c.domain})"


def _debunked_section(verdicts: list[ClaimVerdict]) -> list[str]:
    debunked = [v for v in verdicts if v.status in DEBUNKED_STATUSES]
    lines = ["## Debunked claims", ""]
    if not debunked:
        lines.append("_None found._")
        return lines
    for v in debunked:
        ts = _timestamp(v.claim.timestamp_s)
        header = f"- **{_collapse(v.claim.text)}**"
        if ts:
            header += f" {ts}"
        lines.append(header)
        if v.debunk:
            lines.append(f"  - {_collapse(v.debunk)}")
        if v.citations:
            quote = _collapse(v.citations[0].quote)
            lines.append(f"  > {quote}")
            link = _citation_link(v)
            if link:
                lines.append(f"  - Source: {link}")
        lines.append("")
    return lines


def _verified_section(verdicts: list[ClaimVerdict]) -> list[str]:
    verified = [v for v in verdicts if v.status in VERIFIED_STATUSES]
    lines = ["## Verified claims", ""]
    if not verified:
        lines.append("_None found._")
        return lines
    for v in verified:
        label = STATUS_LABELS.get(v.status, v.status)
        lines.append(f"- {_collapse(v.claim.text)} — _{label}_")
    return lines


def _unverifiable_section(verdicts: list[ClaimVerdict]) -> list[str]:
    unverifiable = [v for v in verdicts if v.status == "unverifiable"]
    lines = ["## Unverifiable claims", ""]
    if not unverifiable:
        lines.append("_None found._")
        return lines
    for v in unverifiable:
        reason = _collapse(v.unverifiable_reason) if v.unverifiable_reason else "no reason given"
        lines.append(f"- {_collapse(v.claim.text)} — {reason}")
    return lines


def to_markdown(report: ValidityReport) -> str:
    lines: list[str] = [
        f"# Fact-check report{f' — {report.video_id}' if report.video_id else ''}",
        "",
        _score_line(report),
        "",
        *_metrics_table(report),
        "",
    ]
    if not report.verdicts:
        lines.append("_No claims were extracted from this video._")
        return "\n".join(lines) + "\n"

    lines.extend(_debunked_section(report.verdicts))
    lines.append("")
    lines.extend(_verified_section(report.verdicts))
    lines.append("")
    lines.extend(_unverifiable_section(report.verdicts))
    lines.append("")
    return "\n".join(lines) + "\n"


def to_json(report: ValidityReport) -> dict[str, Any]:
    return report.to_dict()


def report_from_dict(data: dict[str, Any]) -> ValidityReport:
    """Reconstruct a `ValidityReport` of real dataclass objects from `to_dict()` output.

    Needed to re-render `to_markdown` for a report that round-tripped through
    storage as plain JSON (e.g. `GET /video/fact-check?format=markdown`),
    since `to_markdown` walks attributes (`v.claim.text`, `v.citations[0].url`,
    ...), not dict keys.
    """
    verdicts = [_verdict_from_dict(v) for v in data.get("verdicts", [])]
    return ValidityReport(
        video_id=data.get("video_id"),
        validity_score=data.get("validity_score"),
        rating=data.get("rating", ""),
        claim_count=data.get("claim_count", len(verdicts)),
        verifiable_count=data.get("verifiable_count", 0),
        counts_by_status=data.get("counts_by_status") or {},
        verdicts=verdicts,
        low_confidence=data.get("low_confidence", False),
        generated_at=data.get("generated_at", ""),
        engine_version=data.get("engine_version", ""),
        model=data.get("model", ""),
    )


def _verdict_from_dict(data: dict[str, Any]) -> ClaimVerdict:
    claim_data = data["claim"]
    claim = Claim(
        id=claim_data["id"],
        text=claim_data["text"],
        kind=claim_data["kind"],
        weight=claim_data["weight"],
        search_query=claim_data["search_query"],
        source_quote=claim_data.get("source_quote"),
        timestamp_s=claim_data.get("timestamp_s"),
    )
    citations = [
        Citation(title=c["title"], domain=c["domain"], url=c["url"], quote=c["quote"])
        for c in data.get("citations") or []
    ]
    return ClaimVerdict(
        claim=claim,
        status=data["status"],
        truth_score=data.get("truth_score"),
        reasoning=data.get("reasoning", ""),
        debunk=data.get("debunk"),
        citations=citations,
        unverifiable_reason=data.get("unverifiable_reason"),
        sources_consulted=data.get("sources_consulted") or [],
    )
