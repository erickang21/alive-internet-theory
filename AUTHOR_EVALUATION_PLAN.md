# Author Evaluation — Plan

A second, independent rating: the **author weight**, 0–100 per channel, separate from the video score. It answers "how likely is this *author* to be posting AI content?" from the channel's public presence. When the weight falls below a threshold, the overlay shows a yellow ⓘ warning under the evaluation text and criteria subtext: **"This author may post AI content."** The video score itself is unaffected.

## Evidence: live probe (2026-09-19)

Run against real channel pages through a Browserbase cloud browser session
([replay](https://www.browserbase.com/sessions/c395c064-9dd7-4d88-9a69-ed5721b13206)):

| | MKBHD (human) | "space facts AI" (AI content farm) |
|---|---|---|
| Joined | Mar 21, 2008 | Apr 1, 2025 |
| External links | 5 (Twitter, Instagram, Reddit, Discord, second channel) | 0 |
| Description | 128 chars, personal, business email | ~800 chars of emoji-bulleted template ("Welcome to… your ultimate destination for mind-blowing…") |
| Subscribers / videos | 21.3M / 1,851 | 39 / 24 |

What the probe established:

- **A rendered browser is required.** Browserbase's no-JS Fetch API returns only YouTube's footer shell; the channel page is fully JS-rendered. This is the gap Browserbase fills — neither yt-dlp nor plain HTTP exposes the About panel's links.
- **YouTube serves Browserbase's datacenter IPs.** No bot wall, no consent wall, on the free plan with no proxies.
- **`ytInitialData.aboutChannelViewModel`** on `youtube.com/channel/<UC…>/about` carries everything needed in one page load: description, **exact join date** (the real channel creation date — strictly better than the oldest-upload proxy the account-age criterion uses today), country, subscriber/video/view counts, and the structured external links with titles.
- The two failure directions we worried about didn't materialize: a link-rich and a link-empty channel both extract cleanly, and the AI channel's description is *over*-polished rather than sloppy — so "templated promo copy" is the AI tell, not typos.

## Data collection — `backend/browserbase.py`

One new module, mirroring how `ytdlp.py` owns all YouTube access:

- `fetch_author_profile(channel_id) -> dict | None`: create a session (`POST /v1/sessions`), connect with Playwright over CDP (`connect_over_cdp` — no local browser download needed), load `https://www.youtube.com/channel/<channel_id>/about`, wait for DOM content, evaluate a small walker that returns the `aboutChannelViewModel` fields, close the session.
- New dependencies: `playwright` (CDP client only) — session creation is one HTTP POST, no SDK needed.
- Config: `BROWSERBASE_API_KEY` in `backend/.env`. **Without a usable key, author evaluation is skipped exactly like the fact check without Anthropic credentials**: one warning on the first video, `weight` stays null, no overlay warning, breakdown says why.
- Any per-channel failure (timeout, consent page, layout change) stores `weight: null` with the error in the breakdown and never fails the video's own analysis.

## Scoring — start at 100, deduct

Same shape as the video engine, per-signal breakdown stored for the detail view. Proposed defaults, all tunable:

| Signal | Deduction | Source |
|---|---|---|
| No external links | −25 | About panel links (absence deducts; presence is never a bonus — links are cheap to fake) |
| Templated promo description | −20 | One Claude classification call (see below) |
| Empty / near-empty description | −15 (instead of the above) | About panel |
| Channel self-describes as AI ("AI-powered", "AI" in name/blurb) | −35 | Name + description |
| Account age: joined < 6 months ago | −15 | Exact join date |
| Account age: joined 6–18 months ago | −8 | Exact join date |
| *(Phase 2)* Author's own track record | proportional | Fraction of the author's videos our DB has already verdicted as AI — the planned recursive criterion lives here naturally |

The description classifier is one small Anthropic call per author (Haiku-class model is enough; existing key, JSON output format): returns `templated_promo | neutral | personal` plus a `self_declared_ai` flag. Direction matters and the probe confirmed it: LLM-written channel blurbs are over-polished and templated, while typos and casual mess lean human — so no "sloppiness" penalty.

**Warning threshold: weight < 50.** Calibration against the probe and the false-positive cases we care about:

- MKBHD: 100 → no warning.
- "space facts AI": 100 −25 −20 −35 −15 = **5** → warning.
- Legit new creator (personal bio, no links yet, 3-month-old account): 60 → no warning.
- Faceless-but-human niche channel (neutral bio, no links, 5-year-old account): 75 → no warning.

## Storage — new `authors` table

Follows the existing model style (Alembic migration, repository class):

```python
class Author(Base):
    __tablename__ = "authors"

    channel_id: Mapped[str] = mapped_column(primary_key=True)
    # Profile from the About panel: description, joined_at, country,
    # links, subscriber/video/view counts.
    data: Mapped[dict[str, Any]]
    weight: Mapped[int | None]
    breakdown: Mapped[dict[str, Any]]
    evaluated_at: Mapped[datetime]
```

Refresh: re-evaluate when `evaluated_at` is older than **7 days** (public presence changes slowly; the `channels` cache stays at 24h because upload cadence moves faster). `--force` re-analysis also refreshes the author.

## Pipeline and API

- `analyze_video` gains one step after channel metadata is known: `ensure_author(channel_id)` — evaluate if missing or stale, otherwise reuse the stored row. So loading a video indexes its author, exactly once per refresh window, whichever video of theirs is opened first.
- Both `/video/evaluation` responses gain an `author` object joined by `channel_id`: `{ "weight": 5, "warning": true, "breakdown": { … } }` (`weight: null, warning: false` when skipped or failed).

## Extension

When `author.warning` is true, the overlay renders one row below the evaluation text and criteria subtext: a yellow info circle and the text **"This author may post AI content."** Nothing else changes; the per-signal breakdown can join the detail view later if wanted.

## Cost and limits

- One Browserbase session per author per 7 days, roughly 20–40 seconds of browser time. Free plan allowances (browser minutes and sessions) cover development; no proxies or Verified sessions needed, which the probe verified live.
- One short Anthropic classification call per author, on the existing key. Model Gateway is not used.

## Open decisions

1. The deduction values and the < 50 threshold above are proposals — sign off or adjust.
2. How hard should self-declared AI channels be hit? −35 treats the channel's own words as the strongest single signal; the honest-disclosure counterargument is that it punishes transparency.
3. Refresh window: 7 days proposed.
4. Phase 2 (track-record deduction from our own verdicts) — include in the first build or ship the profile-based weight first? Plan assumes profile-first.

## Implementation order

1. Migration + `Author` model + repository.
2. `backend/browserbase.py` profile fetcher (with the credential-skip behavior).
3. Description classifier call.
4. Author scoring + breakdown.
5. `analyze_video` and API wiring.
6. Extension warning row.
7. Tests with fixtures captured from the probe (both channels above).
