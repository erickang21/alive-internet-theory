import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

# Shared secrets (e.g. BROWSERBASE_API_KEY) live in the repo-root .env, one
# level above backend/. Load that FIRST, then backend/.env with
# override=True, so a backend-specific value still wins when both set the
# same variable. Neither file is required to exist.
_ = load_dotenv(Path(__file__).parent.parent / ".env")
_ = load_dotenv(Path(__file__).parent / ".env", override=True)


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

    # --- Fact-check engine (backend/factcheck/) ---
    # Browserbase powers web search + page fetch for source evidence.
    browserbase_api_key: str = field(
        default_factory=lambda: os.environ.get("BROWSERBASE_API_KEY", "")
    )
    # Which LLM backend backend/factcheck/llm.py talks to: "openai" (default,
    # works today), "gateway" (Browserbase Model Gateway, OpenAI-compatible),
    # or "anthropic".
    factcheck_provider: str = field(
        default_factory=lambda: os.environ.get("FACTCHECK_LLM_PROVIDER", "openai")
    )
    factcheck_model: str = field(
        default_factory=lambda: os.environ.get("FACTCHECK_MODEL", "gpt-5")
    )
    openai_api_key: str = field(default_factory=lambda: os.environ.get("OPENAI_API_KEY", ""))
    # OpenAI-compatible base URL for the "gateway" provider. Empty by default:
    # Browserbase ships no public REST endpoint for Model Gateway as of
    # 2026-09-19, so this stays unset until one exists.
    gateway_url: str = field(
        default_factory=lambda: os.environ.get("BROWSERBASE_GATEWAY_URL", "")
    )
    factcheck_max_claims: int = field(
        default_factory=lambda: int(os.environ.get("FACTCHECK_MAX_CLAIMS", "40"))
    )
    factcheck_concurrency: int = field(
        default_factory=lambda: int(os.environ.get("FACTCHECK_CONCURRENCY", "4"))
    )
    sources_per_claim: int = field(
        default_factory=lambda: int(os.environ.get("FACTCHECK_SOURCES_PER_CLAIM", "3"))
    )
    enable_stagehand: bool = field(
        default_factory=lambda: os.environ.get("FACTCHECK_ENABLE_STAGEHAND", "0") == "1"
    )


config = Config()
