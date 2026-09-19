"""Orchestrates the fact-check pipeline: transcript -> ValidityReport.

extract_claims -> attach_timestamps -> evidence.gather_all -> verify.verify_all
-> validity.build_report. Every stage already degrades gracefully on its own
(a missing LLM/Browserbase credential yields empty claims/sources/verdicts,
never a raised exception), so this module's only job is wiring them together
and logging one line per stage for observability into a run.
"""

import logging

from backend.config import config
from backend.factcheck import evidence, extract, verify
from backend.factcheck.models import ValidityReport
from backend.factcheck.validity import build_report

logger = logging.getLogger(__name__)


class FactCheckEngine:
    def __init__(self, *, max_claims: int | None = None, video_id: str | None = None) -> None:
        self.max_claims = max_claims
        self.video_id = video_id

    def run(self, transcript: str, *, segments: list[dict] | None = None) -> ValidityReport:
        """Run the full pipeline. Never raises; zero claims -> a valid empty report."""
        claims = extract.extract_claims(transcript, max_claims=self.max_claims)
        logger.info(
            "factcheck[%s]: extracted %d claim(s) from the transcript",
            self.video_id or "-",
            len(claims),
        )
        if not claims:
            report = build_report(self.video_id, [], model=config.factcheck_model)
            logger.info(
                "factcheck[%s]: no claims to verify, score=%s (%s)",
                self.video_id or "-",
                report.validity_score,
                report.rating,
            )
            return report

        extract.attach_timestamps(claims, segments)

        sources_by_claim = evidence.gather_all(claims)
        fetched_ok = sum(
            1 for sources in sources_by_claim.values() for source in sources if source.fetched_ok
        )
        total_sources = sum(len(sources) for sources in sources_by_claim.values())
        logger.info(
            "factcheck[%s]: fetched %d/%d usable source(s) across %d claim(s)",
            self.video_id or "-",
            fetched_ok,
            total_sources,
            len(claims),
        )

        verdicts = verify.verify_all(claims, sources_by_claim)
        counts_by_status: dict[str, int] = {}
        for verdict in verdicts:
            counts_by_status[verdict.status] = counts_by_status.get(verdict.status, 0) + 1
        logger.info(
            "factcheck[%s]: verdicts by status: %s", self.video_id or "-", counts_by_status
        )

        report = build_report(self.video_id, verdicts, model=config.factcheck_model)
        logger.info(
            "factcheck[%s]: final validity score=%s rating=%r",
            self.video_id or "-",
            report.validity_score,
            report.rating,
        )
        return report


def check_transcript(
    transcript: str,
    *,
    video_id: str | None = None,
    max_claims: int | None = None,
    segments: list[dict] | None = None,
) -> ValidityReport:
    """Convenience wrapper: `FactCheckEngine(...).run(transcript, segments=segments)`."""
    return FactCheckEngine(max_claims=max_claims, video_id=video_id).run(
        transcript, segments=segments
    )
