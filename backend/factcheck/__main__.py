"""Run the fact-check engine standalone, independent of `backend.analyze`.

    python -m backend.factcheck <video_id> [--transcript FILE] [--format markdown|json]
        [--max-claims N] [--no-store]

Without --transcript, the transcript comes from the video's stored evaluation
(so `python -m backend.analyze` must have already run for it) -- this module
never calls yt-dlp itself. With --transcript, a raw transcript is read off
disk instead, so the whole engine (and this command) can run with zero
dependency on YouTube or a prior analyze run.
"""

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

from backend.database import EvaluationRepository, run_migrations
from backend.factcheck.engine import FactCheckEngine
from backend.factcheck.models import ValidityReport
from backend.factcheck.report import to_json, to_markdown

logger = logging.getLogger("backend.factcheck")


def _load_transcript(video_id: str, transcript_file: str | None) -> str | None:
    if transcript_file:
        text = Path(transcript_file).read_text(encoding="utf-8")
        return text if text.strip() else None

    evaluation = EvaluationRepository().find_by_video_id(video_id)
    if evaluation is None:
        return None
    transcript = evaluation.get("transcript")
    return transcript if transcript else None


def _store(video_id: str, report: ValidityReport) -> None:
    """Merge the report's fields into the video's stored evaluation, if any.

    Mirrors the derivation in backend/scoring/fact_check.py so a report saved
    from this CLI looks identical to one saved through the normal analyze
    pipeline. If the video has no stored evaluation yet, this creates a bare
    one holding only the fact-check fields -- `python -m backend.analyze`
    fills in the rest (score, verdict, breakdown) on its own run.
    """
    from backend.scoring.fact_check import evidence_for_report

    repo = EvaluationRepository()
    existing = repo.find_by_video_id(video_id) or {"video_id": video_id}
    existing.update(evidence_for_report(report))
    repo.upsert(existing)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fact-check a video's transcript and print/store a validity report."
    )
    parser.add_argument("video_id", help="YouTube video ID (any label works with --transcript)")
    parser.add_argument(
        "--transcript",
        metavar="FILE",
        help="read a raw transcript from this file instead of the stored evaluation",
    )
    parser.add_argument(
        "--format", choices=("markdown", "json"), default="markdown", help="output format"
    )
    parser.add_argument(
        "--max-claims", type=int, default=None, help="override FACTCHECK_MAX_CLAIMS for this run"
    )
    parser.add_argument(
        "--no-store", action="store_true", help="print the report without persisting it"
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    # Migrations run unconditionally, even with --no-store: --transcript FILE
    # skips the database entirely, but the fallback path (no --transcript)
    # still reads the stored evaluation, which needs the schema in place on
    # a brand new database just as much as storing does.
    run_migrations()

    transcript = _load_transcript(args.video_id, args.transcript)
    if not transcript:
        logger.error(
            "%s: no transcript available. Pass --transcript FILE, or analyze the video first "
            "with `python -m backend.analyze %s`.",
            args.video_id,
            args.video_id,
        )
        return 2

    engine = FactCheckEngine(max_claims=args.max_claims, video_id=args.video_id)
    try:
        report = engine.run(transcript)
    except Exception:
        # analyze.py gets this containment from scoring.engine._safe; the CLI has
        # no such wrapper, and a raw traceback is a poor way to report an
        # upstream failure.
        logger.exception("%s: fact check failed", args.video_id)
        return 1

    output: dict[str, Any] | str
    output = to_json(report) if args.format == "json" else to_markdown(report)
    if args.format == "json":
        print(json.dumps(output, indent=2))
    else:
        print(output, end="")

    if not args.no_store:
        _store(args.video_id, report)
        logger.info("%s: stored", args.video_id)

    return 0


if __name__ == "__main__":
    sys.exit(main())
