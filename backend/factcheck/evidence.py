"""Evidence gathering: claim -> ranked, fetched, trimmed sources.

Per claim: search -> drop excluded domains -> rank by (tier, original rank)
-> fetch the top few concurrently. `gather_all` processes every claim's search
and every claim's fetches through ONE shared ThreadPoolExecutor so the total
number of in-flight Browserbase calls stays bounded by
`config.factcheck_concurrency`, regardless of how many claims are in flight —
nesting a second pool inside the per-claim path would multiply that bound and
risk tripping Browserbase's 429 concurrency cap.
"""

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

from backend import browserbase
from backend.config import config
from backend.factcheck.models import Claim, Source
from backend.factcheck.text_utils import keywords

logger = logging.getLogger(__name__)

# Mirror the config defaults, so a caller constructing these directly in a test
# gets the same behaviour as the configured pipeline.
DEFAULT_CONCURRENCY = 4
DEFAULT_SOURCES_PER_CLAIM = 3

SEARCH_RESULTS = 6

LEDE_CHARS = 500
EXCERPT_BUDGET = 6000
_EXCERPT_SEPARATOR = "\n\n[...]\n\n"

_MARKDOWN_LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
# A paragraph this dense in link text is a nav menu, breadcrumb or "keep reading"
# strip, not prose. Measured against the VISIBLE text (urls removed), because a
# markdown url is long enough to hide the ratio if left in the denominator.
NAV_LINK_DENSITY = 0.6
# Below this, a short link-heavy line is a heading or a single inline citation
# rather than a menu, so density alone shouldn't condemn it.
NAV_MIN_LINKS = 3

# Bare TLD-style entries in TIER1_DOMAINS (see classify_domain) that apply to
# every host under them, not just one registered domain.
_GENERIC_TIER1_SUFFIXES = frozenset({"gov", "edu", "int"})

TIER1_DOMAINS: frozenset[str] = frozenset(
    {
        "gov",
        "edu",
        "int",
        "who.int",
        "nih.gov",
        "cdc.gov",
        "nature.com",
        "science.org",
        "thelancet.com",
        "nejm.org",
        "pubmed.ncbi.nlm.nih.gov",
        "arxiv.org",
        "sec.gov",
        "bls.gov",
        "worldbank.org",
        "oecd.org",
        "europa.eu",
        "noaa.gov",
        "nasa.gov",
    }
)

TIER2_DOMAINS: frozenset[str] = frozenset(
    {
        "reuters.com",
        "apnews.com",
        "bbc.com",
        "bbc.co.uk",
        "npr.org",
        "ft.com",
        "economist.com",
        "nytimes.com",
        "washingtonpost.com",
        "theguardian.com",
        "snopes.com",
        "politifact.com",
        "factcheck.org",
        "fullfact.org",
    }
)

EXCLUDED_DOMAINS: frozenset[str] = frozenset(
    {
        "reddit.com",
        "quora.com",
        "medium.com",
        "youtube.com",
        "facebook.com",
        "x.com",
        "twitter.com",
        "tiktok.com",
        "pinterest.com",
        "wikipedia.org",
        "substack.com",
    }
)

_BLANK_LINE_RE = re.compile(r"\n\s*\n+")


def _host_of(url: str) -> str:
    """Lowercase host with userinfo, port, and a leading 'www.' stripped."""
    host = urlparse(url).netloc.lower()
    if "@" in host:
        host = host.rsplit("@", 1)[1]
    host = host.split(":", 1)[0]
    if host.startswith("www."):
        host = host[4:]
    return host


def _suffixes(host: str) -> list[str]:
    """Host plus every dotted parent, most specific first.

    e.g. news.bbc.co.uk -> [news.bbc.co.uk, bbc.co.uk, co.uk, uk]
    """
    labels = host.split(".")
    return [".".join(labels[i:]) for i in range(len(labels))]


def classify_domain(url: str) -> tuple[str, int]:
    """(domain, tier) for `url`. Matches a host or any dotted parent/TLD suffix."""
    host = _host_of(url)
    for suffix in _suffixes(host):
        if suffix in TIER1_DOMAINS:
            domain = host if suffix in _GENERIC_TIER1_SUFFIXES else suffix
            return domain, 1
    for suffix in _suffixes(host):
        if suffix in TIER2_DOMAINS:
            return suffix, 2
    return host, 3


def _is_excluded(host: str) -> bool:
    return any(suffix in EXCLUDED_DOMAINS for suffix in _suffixes(host))


def _concurrency() -> int:
    return max(1, config.factcheck_concurrency)


def _sources_per_claim() -> int:
    return max(1, config.sources_per_claim)


def _search_candidates(claim: Claim) -> list[Source]:
    """Ranked, excluded-filtered Source stubs for one claim (not fetched yet)."""
    try:
        raw_results = browserbase.search(claim.search_query, num_results=SEARCH_RESULTS)
    except Exception:
        logger.exception("evidence: search raised for claim %s", claim.id)
        return []

    ranked: list[tuple[int, int, Source]] = []
    for rank, result in enumerate(raw_results):
        url = result.get("url")
        if not url:
            continue
        if _is_excluded(_host_of(url)):
            continue
        domain, tier = classify_domain(url)
        source = Source(url=url, domain=domain, title=result.get("title") or url, tier=tier)
        ranked.append((tier, rank, source))

    ranked.sort(key=lambda item: (item[0], item[1]))
    return [source for _tier, _rank, source in ranked]


def _fetch_source(source: Source) -> Source:
    """Fill fetched_ok/failure/markdown on `source` from a Browserbase fetch."""
    try:
        result = browserbase.fetch_markdown(source.url)
    except Exception:
        logger.exception("evidence: fetch_markdown raised for %s", source.url)
        source.fetched_ok = False
        source.failure = "timeout"
        return source

    # `not result.ok` means unusable regardless of `failure` (failure is None
    # when the key was missing and nothing was even attempted).
    source.fetched_ok = result.ok
    source.failure = result.failure
    if result.ok:
        source.markdown = result.content
    return source


def _gather_all_with_executor(
    claims: list[Claim], executor: ThreadPoolExecutor
) -> dict[str, list[Source]]:
    per_claim_cap = _sources_per_claim()

    # Round 1: search every claim through the shared pool.
    search_futures = {executor.submit(_search_candidates, claim): claim for claim in claims}
    candidates_by_claim: dict[str, list[Source]] = {}
    for future, claim in search_futures.items():
        try:
            candidates_by_claim[claim.id] = future.result()[:per_claim_cap]
        except Exception:
            logger.exception("evidence: unexpected error searching for claim %s", claim.id)
            candidates_by_claim[claim.id] = []

    # Round 2: flatten every claim's fetch jobs into ONE queue on the same
    # pool, so total in-flight fetches are bounded by the pool size no matter
    # how many claims are being processed — never a pool nested inside a pool.
    fetch_futures: dict = {}
    for claim in claims:
        for position, source in enumerate(candidates_by_claim.get(claim.id, [])):
            future = executor.submit(_fetch_source, source)
            fetch_futures[future] = (claim.id, position, source)

    fetched_by_claim: dict[str, list[tuple[int, Source]]] = {claim.id: [] for claim in claims}
    for future, (claim_id, position, source) in fetch_futures.items():
        try:
            fetched = future.result()
        except Exception:
            logger.exception("evidence: unexpected error fetching %s", source.url)
            source.fetched_ok = False
            source.failure = "timeout"
            fetched = source
        fetched_by_claim[claim_id].append((position, fetched))

    return {
        claim_id: [source for _position, source in sorted(items, key=lambda pair: pair[0])]
        for claim_id, items in fetched_by_claim.items()
    }


def gather_evidence(claim: Claim) -> list[Source]:
    """Search, rank, and fetch sources for a single claim. Never raises."""
    with ThreadPoolExecutor(max_workers=_concurrency()) as executor:
        result = _gather_all_with_executor([claim], executor)
    return result.get(claim.id, [])


def gather_all(claims: list[Claim]) -> dict[str, list[Source]]:
    """Search, rank, and fetch sources for every claim, keyed by claim.id.

    Concurrency across claims shares the same bounded pool used for fetches
    (see module docstring) rather than nesting one pool per claim.
    """
    if not claims:
        return {}
    with ThreadPoolExecutor(max_workers=_concurrency()) as executor:
        return _gather_all_with_executor(claims, executor)


def _split_paragraphs(markdown: str) -> list[str]:
    return [p.strip() for p in _BLANK_LINE_RE.split(markdown.strip()) if p.strip()]


def _is_navigation(paragraph: str) -> bool:
    """True for nav menus and link strips, which are never worth citing."""
    links = _MARKDOWN_LINK_RE.findall(paragraph)
    if len(links) < NAV_MIN_LINKS:
        return False
    visible = _MARKDOWN_LINK_RE.sub(r"\1", paragraph).strip()
    if not visible:
        return True
    return sum(len(text) for text in links) / len(visible) > NAV_LINK_DENSITY


def _fingerprint(paragraph: str) -> str:
    # Visible text only, so two copies of the same menu rendered with different
    # urls still collapse to one.
    return re.sub(r"\s+", " ", _MARKDOWN_LINK_RE.sub(r"\1", paragraph)).strip().casefold()


def excerpt_for(markdown: str, claim: Claim) -> str:
    """Trim a fetched page down to the parts relevant to `claim`.

    Keeps the first paragraph (title/lede, capped at LEDE_CHARS) plus whatever
    remaining paragraphs score highest on distinct claim-keyword overlap,
    added back in ORIGINAL DOCUMENT ORDER until EXCERPT_BUDGET is hit. The
    full markdown is untouched (Source.markdown keeps it all) — this is only
    what gets sent to the LLM, so an excerpt is always a substring-safe subset
    of the full text under normalize_for_match.
    """
    if not markdown:
        return ""
    paragraphs = _split_paragraphs(markdown)
    if not paragraphs:
        return ""

    lede = paragraphs[0][:LEDE_CHARS]
    rest = paragraphs[1:]
    if not rest:
        return lede

    claim_keywords = keywords(claim.text) | keywords(claim.search_query)

    scored: list[tuple[int, int, str]] = []
    # A site's nav menu repeats verbatim in several places on the page and is full
    # of the page's own keywords, so it scores well and crowds real prose out of
    # the budget. On a live CDC page it took 49% of the excerpt, the same menu
    # three times over.
    seen: set[str] = set()
    for index, paragraph in enumerate(rest):
        if _is_navigation(paragraph):
            continue
        fingerprint = _fingerprint(paragraph)
        if fingerprint in seen:
            continue
        score = len(claim_keywords & keywords(paragraph))
        if score > 0:
            seen.add(fingerprint)
            scored.append((score, index, paragraph))
    # Highest score first; original order breaks ties so the fill order below
    # is deterministic.
    scored.sort(key=lambda item: (-item[0], item[1]))

    budget = EXCERPT_BUDGET - len(lede)
    chosen: dict[int, str] = {}
    used = 0
    for _score, index, paragraph in scored:
        cost = len(paragraph) + len(_EXCERPT_SEPARATOR)
        if used + cost > budget:
            break
        chosen[index] = paragraph
        used += cost

    ordered = [chosen[i] for i in sorted(chosen)]
    return _EXCERPT_SEPARATOR.join([lede, *ordered]) if ordered else lede
