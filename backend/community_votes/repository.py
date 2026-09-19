from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session

from backend.database.client import get_engine
from backend.database.models import CommunityVote

# A vote answers "was this evaluation right?", not "is this video AI?".
VALID_VOTES = ("agree", "disagree")


class CommunityVoteRepository:
    def record_vote(self, video_id: str, voter_id: str, vote: str) -> None:
        # INSERT … ON CONFLICT rather than get-then-add so two concurrent
        # requests for the same voter (e.g. a double-clicked vote) can't both insert.
        stmt = insert(CommunityVote).values(
            video_id=video_id, voter_id=voter_id, vote=vote, voted_at=datetime.now(UTC)
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[CommunityVote.video_id, CommunityVote.voter_id],
            set_={"vote": stmt.excluded.vote, "voted_at": stmt.excluded.voted_at},
        )
        with Session(get_engine()) as session, session.begin():
            _ = session.execute(stmt)

    def overview(self, video_id: str) -> dict[str, Any]:
        query = (
            select(CommunityVote.vote, func.count())
            .where(CommunityVote.video_id == video_id)
            .group_by(CommunityVote.vote)
        )
        with Session(get_engine()) as session:
            counts = dict(session.execute(query).tuples().all())
        votes = {vote: counts.get(vote, 0) for vote in VALID_VOTES}
        consensus = None
        if votes["agree"] != votes["disagree"]:
            consensus = "agree" if votes["agree"] > votes["disagree"] else "disagree"
        return {"votes": votes, "total": sum(votes.values()), "consensus": consensus}
