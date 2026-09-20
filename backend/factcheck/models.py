"""Shared data contract for the fact-check engine.

Every dataclass is `slots=True` and exposes `to_dict()` for JSON serialization
(nested dataclasses recursed via `dataclasses.asdict`, no datetime objects).
"""

import dataclasses
from dataclasses import dataclass, field
from typing import Any, Literal

ClaimKind = Literal["statistic", "scientific", "historical", "quote", "causal"]
Status = Literal["verified_true", "mostly_true", "misleading", "false", "unverifiable"]
Failure = Literal["paywall", "blocked", "timeout", "not_found", "too_large", "empty"]

# Only "unverifiable" maps to None; every other status has a fixed numeric score.
TRUTH_SCORES: dict[Status, float | None] = {
    "verified_true": 1.0,
    "mostly_true": 0.75,
    "misleading": 0.25,
    "false": 0.0,
    "unverifiable": None,
}


def truth_score_for(status: Status) -> float | None:
    return TRUTH_SCORES[status]


@dataclass(slots=True)
class Claim:
    id: str
    text: str
    kind: ClaimKind
    weight: int  # 1|2|3
    search_query: str
    source_quote: str | None = None
    timestamp_s: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


@dataclass(slots=True)
class Source:
    url: str
    domain: str
    title: str
    tier: int  # 1|2|3
    markdown: str | None = None
    fetched_ok: bool = False
    failure: Failure | None = None

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


@dataclass(slots=True)
class Citation:
    title: str
    domain: str
    url: str
    quote: str

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


@dataclass(slots=True)
class ClaimVerdict:
    claim: Claim
    status: Status
    truth_score: float | None
    reasoning: str
    debunk: str | None = None
    citations: list[Citation] = field(default_factory=list)
    unverifiable_reason: str | None = None
    sources_consulted: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        validate_verdict(self)

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)


def validate_verdict(v: ClaimVerdict) -> None:
    """Enforce `truth_score is None <=> status == "unverifiable"`."""
    is_unverifiable = v.status == "unverifiable"
    has_score = v.truth_score is not None
    if is_unverifiable and has_score:
        raise ValueError(
            f"ClaimVerdict with status 'unverifiable' must have truth_score=None, "
            f"got {v.truth_score!r}"
        )
    if not is_unverifiable and not has_score:
        raise ValueError(
            f"ClaimVerdict with status {v.status!r} must have a non-None truth_score"
        )


@dataclass(slots=True)
class ValidityReport:
    video_id: str | None
    validity_score: float | None
    rating: str
    claim_count: int
    verifiable_count: int
    counts_by_status: dict[str, int]
    verdicts: list[ClaimVerdict]
    low_confidence: bool
    generated_at: str  # ISO8601 UTC
    engine_version: str
    model: str

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)
