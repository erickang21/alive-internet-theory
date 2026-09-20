"""The only module in this project that talks to the open web.

Wraps the Browserbase Search/Fetch API (https://api.browserbase.com). Everything
else that needs a web page — the fact-check engine included — goes through
`search()` / `fetch_markdown()` rather than calling `requests` directly, so retry
and failure-classification behavior lives in one place.
"""

import logging
import random
import time
from dataclasses import dataclass
from typing import Any, Literal

import requests

from backend.config import config

logger = logging.getLogger(__name__)

BASE_URL = "https://api.browserbase.com"
TIMEOUT = 60  # the API's hard cap on a /v1/fetch call
DEFAULT_NUM_RESULTS = 10

MAX_ATTEMPTS = 3
RETRYABLE_STATUS_CODES = frozenset({429, 502, 504})
BACKOFF_BASE_S = 1.0
BACKOFF_CAP_S = 10.0

# Below this many characters, a "successful" fetch is treated as empty rather
# than trusted as real page content.
#
# Measured: nature.com answers 200 with a 209-char JS-required shell, which
# cleared the old 200-char threshold by nine characters and reached
# verification as a real source - a citation then "passed" the substring check
# while quoting a browser error message, because that text genuinely is in the
# fetched markdown. Real articles here run 230,000+ chars (frontiersin 235,708,
# ncbi 232,517), so anything under a kilobyte is an interstitial, not an
# article, and is useless for quote verification even when it is genuine.
MIN_CONTENT_CHARS = 1000

# Interstitials that mean "we got a page, but not the article" split by what
# they imply: a subscription wall vs. a bot/human check.
PAYWALL_PHRASES = (
    "subscribe to continue",
    "you have reached your article limit",
    "cookies to continue",
)
BLOCKED_PHRASES = (
    "enable javascript",
    "verify you are human",
    "access denied",
    # nature.com's client-side shell. It never says "javascript" outright, so
    # the phrase above misses it; matched on the fragment that avoids the
    # apostrophe, whose encoding varies between fetches.
    "required part of this site",
)

Failure = Literal["paywall", "blocked", "timeout", "not_found", "too_large", "empty"]

# Set once the key is found missing, so a whole run degrades with one warning
# instead of one per call. Same pattern as backend/scoring/fact_check.py.
_disabled = False


@dataclass(slots=True)
class FetchResult:
    url: str
    ok: bool
    content: str | None
    status_code: int | None
    failure: Failure | None


def _api_key() -> str:
    return config.browserbase_api_key


def _ensure_enabled() -> bool:
    global _disabled
    if _disabled:
        return False
    if not _api_key():
        _disabled = True
        logger.warning(
            "Browserbase is disabled: no API key. Set BROWSERBASE_API_KEY in .env."
        )
        return False
    return True


def _session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "X-BB-API-Key": _api_key(),
            "Content-Type": "application/json",
        }
    )
    return session


def _backoff_delay(attempt: int) -> float:
    # Full jitter: a random wait between 0 and the exponential cap, so
    # concurrent callers don't retry in lockstep against the same 429.
    cap = min(BACKOFF_CAP_S, BACKOFF_BASE_S * (2**attempt))
    return random.uniform(0, cap)


def _post_with_retry(
    session: requests.Session, url: str, body: dict[str, Any]
) -> requests.Response | None:
    for attempt in range(MAX_ATTEMPTS):
        last_attempt = attempt == MAX_ATTEMPTS - 1
        try:
            response = session.post(url, json=body, timeout=TIMEOUT)
        except requests.RequestException as error:
            logger.warning("browserbase request to %s failed: %s", url, error)
            if last_attempt:
                return None
            time.sleep(_backoff_delay(attempt))
            continue
        if response.status_code in RETRYABLE_STATUS_CODES and not last_attempt:
            time.sleep(_backoff_delay(attempt))
            continue
        return response
    return None


def classify_failure(status_code: int | None, content: str | None) -> Failure | None:
    """Pure classification of a fetch outcome. None means "looks fine"."""
    if status_code == 404:
        return "not_found"
    if status_code in (401, 403):
        return "blocked"
    if status_code == 502:
        return "too_large"
    # 429 (concurrency cap) that survives every retry is folded in here: it's
    # the same "transient capacity" bucket as a timeout.
    if status_code in (504, 429):
        return "timeout"
    # A client-side timeout exception has no status code AND no content at
    # all -- that combination is the real timeout signal. A 200 response
    # whose inner JSON simply omits `statusCode` (but still carries good
    # content) must NOT be discarded as a timeout: fall through to the
    # content-based checks below instead.
    if status_code is None and not content:
        return "timeout"

    if not content:
        return "empty"
    lowered = content.lower()
    if any(phrase in lowered for phrase in PAYWALL_PHRASES):
        return "paywall"
    if any(phrase in lowered for phrase in BLOCKED_PHRASES):
        return "blocked"
    if len(content) < MIN_CONTENT_CHARS:
        return "empty"
    return None


def search(query: str, num_results: int = DEFAULT_NUM_RESULTS) -> list[dict[str, Any]]:
    if not _ensure_enabled():
        return []
    response = _post_with_retry(
        _session(), f"{BASE_URL}/v1/search", {"query": query, "numResults": num_results}
    )
    if response is None or not response.ok:
        return []
    try:
        return response.json().get("results", [])
    except ValueError:
        logger.warning("browserbase /v1/search returned non-JSON content")
        return []


def fetch_markdown(url: str) -> FetchResult:
    if not _ensure_enabled():
        # Not attempted, so no specific Failure applies — just "no result".
        return FetchResult(url=url, ok=False, content=None, status_code=None, failure=None)

    response = _post_with_retry(
        _session(),
        f"{BASE_URL}/v1/fetch",
        {"url": url, "format": "markdown", "allowRedirects": True},
    )
    if response is None:
        return FetchResult(url=url, ok=False, content=None, status_code=None, failure="timeout")

    if not response.ok:
        # An outer HTTP failure from the /v1/fetch call itself (bad url, or
        # retries exhausted on 429/502/504) — no JSON body to read.
        failure = classify_failure(response.status_code, None)
        return FetchResult(
            url=url, ok=False, content=None, status_code=response.status_code, failure=failure
        )

    try:
        payload = response.json()
    except ValueError:
        return FetchResult(
            url=url, ok=False, content=None, status_code=response.status_code, failure="empty"
        )

    # The outer call succeeded (200); statusCode/content describe the fetched
    # page itself, which can still be a 404, a paywall, etc.
    inner_status = payload.get("statusCode")
    content = payload.get("content")
    failure = classify_failure(inner_status, content)
    if failure is not None:
        return FetchResult(
            url=url, ok=False, content=content, status_code=inner_status, failure=failure
        )
    return FetchResult(url=url, ok=True, content=content, status_code=inner_status, failure=None)
