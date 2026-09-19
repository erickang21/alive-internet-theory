import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")


@dataclass(frozen=True)
class Config:
    gptzero_api_key: str = field(default_factory=lambda: os.environ.get("GPTZERO_API_KEY", ""))
    youtube_api_key: str = field(default_factory=lambda: os.environ.get("YOUTUBE_API_KEY", ""))
    mongodb_uri: str = field(default_factory=lambda: os.environ.get("MONGODB_URI", ""))
    mongodb_db_name: str = field(
        default_factory=lambda: os.environ.get("MONGODB_DB_NAME", "alive_internet_theory")
    )
    flask_debug: bool = field(default_factory=lambda: os.environ.get("FLASK_DEBUG", "0") == "1")
    port: int = field(default_factory=lambda: int(os.environ.get("PORT", "5000")))


config = Config()
