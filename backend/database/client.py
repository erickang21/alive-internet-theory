from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

from pymongo import ASCENDING, MongoClient
from pymongo.database import Database

from backend.config import config

CHANNEL_CACHE_TTL_SECONDS = 24 * 60 * 60


@lru_cache(maxsize=1)
def get_client() -> MongoClient:
    # Credentials go in as kwargs rather than spliced into the URI so special
    # characters in the password never need URL-encoding.
    auth: dict[str, str] = {}
    if config.mongodb_username:
        auth = {"username": config.mongodb_username, "password": config.mongodb_password}
    return MongoClient(config.mongodb_uri, **auth)


def get_database() -> Database:
    db = get_client()[config.mongodb_db_name]
    _ensure_indexes(db)
    return db


_indexes_ensured = False


def _ensure_indexes(db: Database) -> None:
    global _indexes_ensured
    if _indexes_ensured:
        return
    db.videos.create_index([("video_id", ASCENDING)], unique=True)
    db.videos.create_index([("channel_id", ASCENDING)])
    db.channels.create_index([("channel_id", ASCENDING)], unique=True)
    # TTL index lets Atlas expire cached channel data instead of us checking staleness.
    db.channels.create_index(
        [("cached_at", ASCENDING)], expireAfterSeconds=CHANNEL_CACHE_TTL_SECONDS
    )
    db.community_votes.create_index([("video_id", ASCENDING), ("voter_id", ASCENDING)], unique=True)
    _indexes_ensured = True


def _utcnow() -> datetime:
    return datetime.now(UTC)


class EvaluationRepository:
    def __init__(self, db: Database | None = None) -> None:
        self._collection = (db or get_database()).videos

    def find_by_video_id(self, video_id: str) -> dict[str, Any] | None:
        return self._collection.find_one({"video_id": video_id}, {"_id": 0})

    def find_by_channel_id(self, channel_id: str, limit: int = 50) -> list[dict[str, Any]]:
        cursor = self._collection.find({"channel_id": channel_id}, {"_id": 0}).limit(limit)
        return list(cursor)

    def upsert(self, evaluation: dict[str, Any]) -> dict[str, Any]:
        evaluation["updated_at"] = _utcnow()
        self._collection.update_one(
            {"video_id": evaluation["video_id"]},
            {"$set": evaluation, "$setOnInsert": {"created_at": _utcnow()}},
            upsert=True,
        )
        return evaluation


class ChannelCacheRepository:
    def __init__(self, db: Database | None = None) -> None:
        self._collection = (db or get_database()).channels

    def find_by_channel_id(self, channel_id: str) -> dict[str, Any] | None:
        return self._collection.find_one({"channel_id": channel_id}, {"_id": 0})

    def upsert(self, channel: dict[str, Any]) -> dict[str, Any]:
        channel["cached_at"] = _utcnow()
        self._collection.update_one(
            {"channel_id": channel["channel_id"]}, {"$set": channel}, upsert=True
        )
        return channel


class CommunityVoteRepository:
    def __init__(self, db: Database | None = None) -> None:
        self._collection = (db or get_database()).community_votes

    def record_vote(self, video_id: str, voter_id: str, vote: str) -> None:
        self._collection.update_one(
            {"video_id": video_id, "voter_id": voter_id},
            {"$set": {"vote": vote, "voted_at": _utcnow()}},
            upsert=True,
        )

    def tally(self, video_id: str) -> dict[str, int]:
        pipeline = [
            {"$match": {"video_id": video_id}},
            {"$group": {"_id": "$vote", "count": {"$sum": 1}}},
        ]
        return {row["_id"]: row["count"] for row in self._collection.aggregate(pipeline)}
