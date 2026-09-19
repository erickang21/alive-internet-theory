from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, MetaData
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    # Named constraints let Alembic's SQLite batch mode find and alter them later.
    metadata = MetaData(
        naming_convention={
            "ix": "ix_%(column_0_label)s",
            "uq": "uq_%(table_name)s_%(column_0_name)s",
            "ck": "ck_%(table_name)s_%(constraint_name)s",
            "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
            "pk": "pk_%(table_name)s",
        }
    )
    type_annotation_map = {
        datetime: DateTime(timezone=True),
        dict[str, Any]: JSON,
    }


class Video(Base):
    __tablename__ = "videos"

    video_id: Mapped[str] = mapped_column(primary_key=True)
    channel_id: Mapped[str | None] = mapped_column(index=True)
    # The rest of the evaluation as the API returns it: score, verdict,
    # breakdown, metadata.
    data: Mapped[dict[str, Any]]
    # Fact check results; null when the video isn't educational (thesis,
    # hallucinated) or the check couldn't run (all three).
    is_educational: Mapped[bool | None]
    thesis: Mapped[str | None]
    hallucinated: Mapped[bool | None]
    created_at: Mapped[datetime]
    updated_at: Mapped[datetime]


class Channel(Base):
    __tablename__ = "channels"

    channel_id: Mapped[str] = mapped_column(primary_key=True)
    # Channel info from yt-dlp: title, oldest upload, recent uploads.
    data: Mapped[dict[str, Any]]
    cached_at: Mapped[datetime]


class CommunityVote(Base):
    __tablename__ = "community_votes"

    video_id: Mapped[str] = mapped_column(primary_key=True)
    voter_id: Mapped[str] = mapped_column(primary_key=True)
    vote: Mapped[str]
    voted_at: Mapped[datetime]
