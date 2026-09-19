import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

_ = load_dotenv(Path(__file__).parent / ".env")


@dataclass(frozen=True)
class Config:
    gptzero_api_key: str = field(default_factory=lambda: os.environ.get("GPTZERO_API_KEY", ""))
    sqlite_path: str = field(
        default_factory=lambda: os.environ.get(
            "SQLITE_PATH", str(Path(__file__).parent / "data" / "alive_internet_theory.db")
        )
    )
    # Downloaded videos, thumbnails, and captions, one directory per video ID.
    media_dir: str = field(
        default_factory=lambda: os.environ.get(
            "MEDIA_DIR", str(Path(__file__).parent / "data" / "media")
        )
    )
    host: str = field(default_factory=lambda: os.environ.get("HOST", "127.0.0.1"))
    flask_debug: bool = field(default_factory=lambda: os.environ.get("FLASK_DEBUG", "0") == "1")
    port: int = field(default_factory=lambda: int(os.environ.get("PORT", "5000")))


config = Config()
