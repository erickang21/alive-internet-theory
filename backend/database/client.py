from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import Engine, create_engine, event, func, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.engine.interfaces import DBAPIConnection
from sqlalchemy.orm import Session
from sqlalchemy.pool import ConnectionPoolEntry

from backend.config import config
from backend.database.models import Channel, CommunityVote, Video

CHANNEL_CACHE_TTL = timedelta(hours=24)
# Bump whenever the cached channel payload changes shape: rows written by older
# code count as a miss and get refetched. Version 1 rows kept 50 uploads dated
# from the flat listing, i.e. midnight precision, which the cadence criterion
# read as a 0.0h median gap between same-day uploads.
CHANNEL_CACHE_VERSION = 2
# Evaluation keys stored as their own `videos` columns rather than inside `data`.
VIDEO_COLUMNS = ("is_educational", "thesis", "hallucinated")
ALEMBIC_INI = Path(__file__).parents[1] / "alembic.ini"


@lru_cache(maxsize=1)
def get_engine() -> Engine:
    path = Path(config.sqlite_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(f"sqlite:///{path}")
    event.listen(engine, "connect", _enable_wal)
    return engine


def _enable_wal(dbapi_connection: DBAPIConnection, _connection_record: ConnectionPoolEntry) -> None:
    # WAL lets readers proceed while another request is writing.
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.close()


def run_migrations() -> None:
    alembic_config = AlembicConfig(ALEMBIC_INI)
    # Keep alembic.ini's logging setup from replacing the app's (see env.py).
    alembic_config.attributes["configure_logger"] = False
    command.upgrade(alembic_config, "head")


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _isoformat(value: datetime) -> str:
    # SQLite hands datetimes back without tzinfo; everything we store is UTC.
    return value.replace(tzinfo=UTC).isoformat()


# Upserts use INSERT … ON CONFLICT rather than get-then-add so two concurrent
# requests for the same key (e.g. a double-clicked vote) can't both insert.


class EvaluationRepository:
    def find_by_video_id(self, video_id: str) -> dict[str, Any] | None:
        with Session(get_engine()) as session:
            video = session.get(Video, video_id)
            return self._to_dict(video) if video else None

    def find_by_channel_id(
        self, channel_id: str, exclude_video_id: str | None = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        query = select(Video).where(Video.channel_id == channel_id).limit(limit)
        if exclude_video_id:
            query = query.where(Video.video_id != exclude_video_id)
        with Session(get_engine()) as session:
            return [self._to_dict(video) for video in session.scalars(query)]

    def upsert(self, evaluation: dict[str, Any]) -> dict[str, Any]:
        now = _utcnow()
        stmt = insert(Video).values(
            video_id=evaluation["video_id"],
            channel_id=evaluation.get("channel_id"),
            data={k: v for k, v in evaluation.items() if k not in VIDEO_COLUMNS},
            **{column: evaluation.get(column) for column in VIDEO_COLUMNS},
            created_at=now,
            updated_at=now,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[Video.video_id],
            set_={
                column: stmt.excluded[column]
                for column in ("channel_id", "data", *VIDEO_COLUMNS, "updated_at")
            },
        )
        with Session(get_engine()) as session, session.begin():
            _ = session.execute(stmt)
        evaluation["updated_at"] = now.isoformat()
        return evaluation

    @staticmethod
    def _to_dict(video: Video) -> dict[str, Any]:
        return {
            **video.data,
            **{column: getattr(video, column) for column in VIDEO_COLUMNS},
            "created_at": _isoformat(video.created_at),
            "updated_at": _isoformat(video.updated_at),
        }


class ChannelCacheRepository:
    def find_by_channel_id(self, channel_id: str) -> dict[str, Any] | None:
        # SQLite has no TTL indexes, so rows past the TTL count as a miss and get
        # overwritten by the next upsert.
        query = select(Channel).where(
            Channel.channel_id == channel_id,
            Channel.cached_at >= _utcnow() - CHANNEL_CACHE_TTL,
            func.json_extract(Channel.data, "$.cache_version") == CHANNEL_CACHE_VERSION,
        )
        with Session(get_engine()) as session:
            channel = session.scalar(query)
            if channel is None:
                return None
            return {**channel.data, "cached_at": _isoformat(channel.cached_at)}

    def upsert(self, channel: dict[str, Any]) -> dict[str, Any]:
        now = _utcnow()
        channel["cache_version"] = CHANNEL_CACHE_VERSION
        stmt = insert(Channel).values(channel_id=channel["channel_id"], data=channel, cached_at=now)
        stmt = stmt.on_conflict_do_update(
            index_elements=[Channel.channel_id],
            set_={"data": stmt.excluded.data, "cached_at": stmt.excluded.cached_at},
        )
        with Session(get_engine()) as session, session.begin():
            _ = session.execute(stmt)
        channel["cached_at"] = now.isoformat()
        return channel


class CommunityVoteRepository:
    def record_vote(self, video_id: str, voter_id: str, vote: str) -> None:
        stmt = insert(CommunityVote).values(
            video_id=video_id, voter_id=voter_id, vote=vote, voted_at=_utcnow()
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[CommunityVote.video_id, CommunityVote.voter_id],
            set_={"vote": stmt.excluded.vote, "voted_at": stmt.excluded.voted_at},
        )
        with Session(get_engine()) as session, session.begin():
            _ = session.execute(stmt)

    def tally(self, video_id: str) -> dict[str, int]:
        query = (
            select(CommunityVote.vote, func.count())
            .where(CommunityVote.video_id == video_id)
            .group_by(CommunityVote.vote)
        )
        with Session(get_engine()) as session:
            return dict(session.execute(query).tuples().all())
