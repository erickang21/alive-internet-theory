# Alive Internet Theory — Developer Reference (CLAUDE.md)

Chrome extension that embeds a verdict card in YouTube's watch page (floating on Shorts) and rates the video **Likely human / Likely AI / Heavy AI Use**, based on automated scoring factors.

## Architecture: analysis runs in the backend, the extension only reads

**A video is analyzed in the background the first time someone opens it**, or when a dev runs the analyze script. The extension itself fetches no transcripts and runs no scoring; all it shows of the indexing is the card's loading skeleton.

1. The analysis pipeline (`backend/analyze.py`) uses **yt-dlp for all YouTube data** (metadata, thumbnail, captions, the audio track when Whisper needs it, channel uploads). It transcribes locally with Whisper when captions are missing, scores the video, and writes the evaluation to SQLite. Devs run it directly (`python -m backend.analyze <targets>`) for batches, channels/playlists, and `--force` re-analysis.
2. The extension asks the API for the current video with `POST /video/evaluation`. A stored evaluation comes back with one criterion scored at read time (channel history, see below) and the score and verdict recomputed from the full breakdown; otherwise the API quietly starts the same pipeline in a background thread (`backend/api/indexing.py`) and answers `202 {"status": "indexing"}`. **Analyses are capped at `MAX_CONCURRENT_ANALYSES` (2)** by a semaphore: a thread is still spawned per video, but it parks until a slot frees, so a feed being auto-analyzed queues rather than running dozens of yt-dlp downloads and Whisper runs at once off one residential IP. A parked video reads as `pending` like any other. Failures come back as `{"status": "failed", "detail": …}` and are held in memory only, so a backend restart clears them for another attempt. There are no automatic retries; a GPTZero failure degrades that one criterion like any other. `POST /video/evaluation` with `"force": true` re-runs the analysis of a stored video (`indexing.request(video_id, force=True)`; a job that is already running is never doubled), and while that rerun is pending the API answers `{"status": "indexing"}` instead of the old row. `GET /video/evaluation?video_id=…` still serves stored rows without triggering anything; the other write is `POST /video/community-vote`.
3. **The card goes up with the page, as a skeleton**, and the answer fills it in: a verdict, or the error container when there is no analysis to wait for. The request starts on load, so the skeleton always stands for something in flight. While a video is indexing the content script repeats the request every 5–7s (5s plus up to 2s of jitter) and stops as soon as a score is on screen — the original 30s interval made a verdict that landed in seconds sit invisible until the next tick, so a verdict that finishes indexing appears without reopening the video. Polling lives in `frontend/src/content/index.jsx`, not the service worker, because MV3 unloads an idle worker after ~30s. A stored evaluation is fetched once per visit.

```
frontend/                  Chrome extension (verdict card in the watch page, breakdown/settings popover, feed filter; silently queues unanalyzed videos)
backend/analyze.py         CLI: resolve targets → download → transcript → score → store
backend/ytdlp.py           All YouTube access (target expansion, downloads, channel uploads + 24h cache)
backend/transcripts.py     Caption parsing (json3/vtt), faster-whisper fallback
backend/scoring/           Scoring engine (starts at 100, deducts per AI evidence) + per-criterion modules
backend/factcheck/         Claim extraction → web evidence → verification → Validity Score
backend/browserbase.py     All web access (Browserbase search + fetch, markdown)
backend/api/               Flask API: GET/POST /video/evaluation, GET /video/fact-check, POST /video/community-vote, background indexing
backend/database/          SQLAlchemy models + repositories on SQLite, Alembic migrations
```

Storage: SQLite at `SQLITE_PATH` (default `backend/data/alive_internet_theory.db`), downloaded files at `MEDIA_DIR/<video_id>/` (`video.info.json` with everything yt-dlp extracted, `thumbnail.jpg`, `subtitles.<lang>.<ext>`, and `audio.<ext>` only when Whisper was needed — the voice check downloads its own 60-second excerpt and deletes it again, so it leaves nothing behind). **Only the first 5 minutes of a video are analyzed** (`ANALYZED_SECONDS` in `backend/ytdlp.py`): captions are cut to that window and the audio is cut to it. **The video itself isn't downloaded**, because no criterion uses it; add a video download back when a video-based criterion needs one. In Docker both live on the `/data` volume, along with the Whisper model cache (`HF_HOME`). The schema changes through Alembic migrations, which the app and the analyze script apply on startup (see README → Changing the database schema).

## Frontend UI (`frontend/src/`)

React 18 + styled-components, bundled by esbuild (`jsx: "automatic"`, minified, `NODE_ENV` defined). Both verified to run inside YouTube's Trusted Types page without a policy. Only the tile decoration still ships as a stylesheet (`dist/filter.css`); everything else is styled-components.

- **`ui/tokens.js`**: the `--ait-*` custom properties on `[data-ait-root]`, as a `createGlobalStyle`. They stay CSS variables rather than a styled-components theme object so they can alias YouTube's live `--yt-sys-color-baseline--*` values (the old `--yt-spec-*` family is gone) and flip with `html[dark]` without any JS. Radii follow YouTube: 12px containers, 8px tabs/chips/marks, 4px thumbnail badges.
- **`ui/frame.jsx`**: the shell every state of the card shares — `Shell`, `Body`, `Headline`, the meter `Track` with its segment separators, and the feedback `Footer` rule. The verdict, the skeleton and the error container are the same box with different contents, which is the whole reason the card doesn't jump when an answer lands.
- **`ui/Skeleton.jsx`**: the loading state — `frame.jsx`'s rows with a placeholder in every slot, at the heights the real values occupy, under an **Evaluating video...** heading in the verdict's own type scale (`role="status"` announces it, so nothing is hidden for screen readers). One sheen sweep (`--ait-skeleton` under `--ait-skeleton-sheen`) runs on every bone with a per-row phase offset, so it reads as a single wave rolling down the card rather than blinking blocks; the sweep rests off the left edge, so `prefers-reduced-motion` leaves plain bones instead of a frozen highlight. Two details keep the box from moving when the verdict lands, both measured: the thumbs are left out rather than drawn as circles, so the footer row carries their height itself (`min-height`), and the score bone is centred rather than baseline-aligned, since a block's baseline is its bottom edge and beside real text it made the headline 6px taller.
- **`ui/ErrorCard.jsx`**: the same shell saying why no score is coming — `failed` (the backend gave up on this video) or `offline` (nothing answered at all), each with the backend's own text as the detail and a retry. Only `failed` forces a fresh analysis on retry, since a stored failure is remembered until the backend restarts.
- **`ui/Card.jsx`**: the verdict card — label, score as a percentage, 5-segment meter, community sentence, feedback thumbs, "View breakdown". It owns the vote state and portals the panel into `document.body`, so both feedback rows share one vote without a store. `ui/Ring.jsx` is the rainbow ring that draws once when a verdict lands while the viewer is watching.
- **`ui/Panel.jsx`**: the popover under the masthead (YouTube menu surface, no scrim) with Breakdown and Settings tabs and the feedback row as a footer. Close X, click outside, and Escape close it; Tab is trapped inside; the card restores focus to its link. `ui/Breakdown.jsx` holds the per-criterion config and the accordion (its **Text-to-speech likelihood** row is main's `elevenlabs_voice` criterion). **The backend sends fields, never prose**: a criterion returns `evidence` plus, when it had nothing to say, a `reason` key (`transcript_too_short`, `needs_auto_captions`, `no_audio`, `no_credentials`, `not_educational`, `upstream_error`, …). Breakdown.jsx owns every sentence, and `ui/format.js` owns every value, so a duration reads the same in the summary and the rows — the old split emitted "981 days old" beside "2.7 years ago" for one number. Each expanded row reads: a sentence stating the finding, the stats as `Label: value` lines, then an `about` note below the rule (first letter flush with it) explaining what that check looks at, linking out to GPTZero and ElevenLabs. The summary never repeats a stat. Evaluations stored before this fall back to their own `detail`; `ui/Settings.jsx` the switches.
- **`ui/hooks.js`**: `useVote` (tally, selection, submit, the memoized anonymous `voterId`, and the per-video `vote:<id>` key), `useFilterState`, `useDebugMode`, `useDismiss`.
- **`content/mount.js`**: the one imperative piece left. It keeps a `[data-ait-mount]` container (`display: contents`, so the card itself is the flow element) anchored above `#donation-shelf`/`#related` using the anchor's own parent, since YouTube moves both into `#below` in single-column layouts, and re-anchors from a rAF-coalesced `MutationObserver`. Shorts have no side column, so the card floats top-right there.
- **`content/index.jsx`**: polling and mounting, as a three-state swap in one mount point. The skeleton goes up with the page (`showSkeleton`) because the request goes out with it; `indexing` keeps it there, an evaluation replaces it with the card, and anything else — a `failed` status, an unreachable backend, a dead service worker — replaces it with `ErrorCard`, because a skeleton with nothing behind it is a lie. A transport error keeps polling, so a backend that comes back puts the skeleton up again on its own; a `failed` status does not, since the backend remembers it until it restarts. **Silence is an error too**: a request that hasn't answered within `SILENCE_MS` (2s) swaps the skeleton for the error container without touching the request, because the route only reads SQLite and spawns a thread, so a healthy backend is never near that. It's a display deadline, not a timeout — the 20s fetch timeout and the 25s reply timeout still bound the request itself, and whatever it finally answers replaces the error. `restart(force)` re-runs from the skeleton up and serves both the error container's retry and debug mode's re-analyze.
- **Feed filter** (`content/filter.js`, `videoScanner.js`, `filterRenderer.js`, `shared/filterState.js`, `background/scores.js`): stays imperative, because it decorates YouTube's own tiles rather than rendering our own tree. `chrome.storage.local["aitFilterState"]` is the source of truth, so the filter applies on load, on navigation and on storage changes with no UI open. With flags on, an AI-leaning tile is marked and a likely-human one is left untouched, since labelling what you do want doubles the noise for nothing. The thumbnail darkens behind a corner pill — 50% for **Heavy AI Use** with a warning triangle, 30% for **Likely AI** with a question mark — so the title and channel keep full contrast and the two bands separate before the label is read. A hidden note beside the title carries the verdict for screen readers, since the mark is visual only. Bands use the backend's thresholds. "Remove" hides only the Heavy AI Use band (`AI_FILTER_THRESHOLD`). An unanalyzed tile (`null` score) always renders normally. Scores come from `GET /video/evaluation` (never POST: browsing a feed must not queue its tiles for indexing), fanned out 4 at a time with a cache where only misses expire; under the in-memory cache (wiped whenever MV3 recycles the worker) sits a persistent `chrome.storage.local` layer (`shared/scoreCache.js`) written through only on a found score or a real "not analyzed" 404, never on a server error, so a transient outage can't get pinned as a miss.
- **Auto-analyze** (`content/autoAnalyze.js`, `shared/autoAnalyze.js`, `MESSAGE_TYPES.QUEUE_ANALYSIS`): the one thing that *does* POST from a feed, behind the `chrome.storage.local["aitAutoAnalyze"]` switch. An `IntersectionObserver` (200px margin) queues each tile **as it scrolls into view**, so the work is bounded by what you actually look at rather than by how far YouTube has lazy-loaded; ids are sent 3 at a time and each one only once per time the mode is on. The background handler is deliberately *not* `requestEvaluation`: it must not touch the toolbar icon, which describes the watched video, not the thirty tiles scrolling past it. Videos still `indexing` are re-asked every 15s — that, not a DOM change, is what turns a queued tile into a flagged one — and a real score is handed to `scores.primeScore` so the next rescan marks the tile immediately instead of waiting out that module's 60s miss TTL. Its only visible effect is through the flags, so with **AI flags** off it fills the database silently.
- **Fact check** (`ui/FactCheck.jsx`, `content/factCheckBridge.js`, `shared/factCheckState.js`): the Validity Score section at the bottom of the verdict card. It never shares the score poll above — that poll's whole design is to stop the moment a verdict settles, minutes before a fact check has anything to say — so the bridge runs its own 30s loop against `GET /video/fact-check` (via the worker's `GET_FACT_CHECK` handler) and stops on any terminal stage: `complete`, `skipped_fiction` (a genuine pre-gate verdict), or `failed` (a 404 keeps polling as `fact_checking`, an `unavailable` answer lands as `failed` with a retry). The bridge writes stage records into `chrome.storage.local` and `FactCheck.jsx` renders from them through `shared/factCheckState.js`, which is what lets a result written minutes after the verdict appear without a reload; `idle` (no record yet) renders nothing at all, not an empty section. Everything shown is model output or scraped page text, so it all renders through JSX text nodes, and citation hrefs pass an http/https allow-list first.
- **Toolbar** (`manifest.action`, `background/indicator.js`): `popup.html` renders `<Settings>` on its own React root, which is the only way to reach the settings off a watch page; its layout ships as a real `dist/popup.css`, because Chrome measures the popup before any script runs and a width that arrives with styled-components leaves it sized to nothing. The icon is a solid rounded square drawn into an `OffscreenCanvas` and pushed with `chrome.action.setIcon`, **per tab**, so it always describes the video that tab is showing: grey with nothing to show, a pulsing amber square while the video answers `{status: "indexing"}`, and green once it has a verdict, which it stays. **A failed analysis answers 200 with `{status: "failed"}`, so anything that isn't an evaluation must not read as a verdict**: it turns red, and the content script stops polling, since a failure is remembered until the backend restarts. Each state also sets its own tooltip. `requestEvaluation` sets it from `sender.tab.id`, and the content script sends `CLEAR_INDICATOR` on **every** change of video, so each one runs its own cycle instead of inheriting the last one's colour until its first answer lands. Working tabs expire after `STALE_MS` so a closed tab can't pulse forever, and the module redraws the idle square on load in case a worker died mid-pulse. `icons/` holds the grey resting icon as `default_icon`.
- All backend calls go through the service worker (`background/index.js`, one listener with a `HANDLERS` map). `npm test` runs the filter's unit tests (`node --test`).

## Scoring criteria → data source mapping

| Criterion | Deduction | Data source |
|---|---|---|
| GPTZero transcript scan | up to −50 | GPTZero `/v2/predict/text` (see below) |
| ElevenLabs voice scan (`elevenlabs_voice`) | up to −40 | ElevenLabs AI speech classifier over the audio (see below) |
| Fact check → Validity Score | **not scored yet** (TBD); reported as its own independent score | Claim extraction + Browserbase search/fetch + per-claim verification (see Fact check section) |
| Stutters / filler words (absence ⇒ AI) | up to −20 | Transcript text analysis, ASR tracks only (see Filler-word section) |
| Upload frequency + video length | up to −10 | Exact upload timestamps of the channel's latest 19 uploads via yt-dlp (see yt-dlp section) |
| Account age | up to −5 | Exact timestamp of the channel's **oldest upload** via yt-dlp, a proxy because the creation date isn't available |
| Channel history (`channel_history`) | **+10 to −10** | Average score of the channel's other stored evaluations (see below) |

---

## Channel history (`backend/scoring/channel_history.py`) — the one read-time criterion

A video gains up to **+10** when the channel's other analyzed videos look human and loses up to **−10** when they look like AI. The average of their scores maps linearly onto that range, with the likely-human threshold (75) as the neutral point: an average of 100 gives +10, 75 gives 0, 50 or below gives −10. The swing scales by `min(n / 5, 1)`, so one sibling can move the score by at most ±2 and five or more move the full ±10. The newest 20 siblings by publish date count, so a channel that recently turned to AI stops coasting on its old videos.

**It is scored when an evaluation is served, not when it is stored** (`engine.apply_channel_history`, called from both `/video/evaluation` routes). Everything else is frozen at analysis time, but this criterion depends on what else we have analyzed since, and freezing it would leave every channel's first video permanently without a history. Two consequences: the stored `score`/`verdict` (and the score the analyze script logs) are the pre-adjustment numbers, and stored scores are therefore free of this criterion, so a channel's reputation can't feed on itself — siblings contribute their own content and channel signals only.

A bonus is stored as a negative `deduction`, like the filler-word criterion's natural-rate bonus, and the engine clamps the total to 0–100, so a video already at 100 gains nothing.

## GPTZero API (source: GPTZero API Workshop slides — authoritative for this project)

- **Base URL:** `https://api.gptzero.me`
- **Auth:** header `x-api-key: YOUR_KEY` (key granted via hackathon form; store as env var, never commit)
- **Docs:** gptzero.stoplight.io

### AI detection — used for the "up to −50" criterion

`POST /v2/predict/text` — `Content-Type: application/json`, body: `{ "document": "<transcript text>" }`
(`POST /v2/predict/files` also exists: up to 50 files multipart, PDF/DOCX/TXT — not needed for transcripts.)

Response (document level):
```jsonc
{
  "predicted_class": "ai" | "human" | "mixed",
  "document_classification": "AI_ONLY" | "MIXED" | ...,
  "confidence_category": "high" | ...,
  "confidence_score": 0.9994,
  "class_probabilities": { "human": 0, "ai": 0.0006, "mixed": 0.9994 },  // sums to 1
  "subclass": {                     // leaf classes: human | polished | concatenated | pure_ai | ai_paraphrased
    "ai":    { "predicted_class": "pure_ai",      "class_probabilities": { "pure_ai": 1, "ai_paraphrased": 0 } },
    // or "mixed": { "predicted_class": "concatenated", "class_probabilities": { "concatenated": 1, "polished": 0 } }
  },
  "sentences": [ {                  // separate, WEAKER classifier — document model is the strongest signal
    "sentence": "…",
    "generated_prob": 0.9999,
    "class_probabilities": { "human": 0.00001, "ai": 0.99997, "paraphrased": 0.00002 },
    "highlight_sentence_for_ai": true
  } ]
}
```

Scoring guidance: deduct from `class_probabilities.ai` / `mixed` weighted by `confidence_score`; use document-level fields, not sentence-level, as the primary signal.

**Design constraints (from slides):**
- **Short text = low confidence.** Under ~200 words, report "not enough signal" instead of a number (relevant for Shorts with tiny transcripts).
- Formatting is deliberately ignored by the model — don't build tricks around whitespace.
- **Rate limit: 30,000 req/hour** (AI detection).
- A flag should open a conversation — show evidence (per-criterion breakdown in the popover), don't auto-punish. Our pass/fail detail view aligns with this.
- GPTZero's Cloudflare rejects the default python-requests User-Agent (error 1010), so `backend/scoring/gptzero.py` sends a browser-style one.

### AI patterns (optional enrichment for the detail view)

`POST /v3/ai/patterns/stream` — Server-Sent Events, one event per matching sentence (a sentence can fire twice):
```jsonc
{ "sentence_index": 1, "sentence": "…", "interpretability_designation": "ai",
  "patterns": [{ "pattern_id": "negative_parallelisms", "display_name": "Not just X, but Y",
                 "category": "Phrasing & style", "explanation": "…", "relevance": 5, "k_times": 1.6 }] }
```
Pattern list grows per release — **don't hardcode it**. Could power "which phrases look AI" highlights in the breakdown's "Likely AI phrases" section (see Frontend UI).

---

## ElevenLabs AI speech classifier (`backend/scoring/elevenlabs.py`) — the one audio criterion

Every other criterion reads the transcript or the channel. This one listens to the audio, so it catches a synthesized narrator reading a human-written script.

- **Endpoint:** `POST https://api.elevenlabs.io/v1/moderation/ai-speech-classification`, multipart field `file`. Response is `{"probability": <float>}`.
- **No API key.** Unauthenticated requests succeed, and sending an *invalid* `xi-api-key` is a 401 — so send no key header at all. There is nothing to configure.
- **Undocumented.** It is absent from ElevenLabs' public OpenAPI spec and has no API-reference page (the classifier is presented as a web tool). Nothing about it is contractual: it may change shape, start requiring auth, or rate-limit without notice. `engine._safe` degrades it to "unavailable" if it does.
- **Only the first 60 seconds are classified**, which is measured, not assumed: 75s of silence ahead of speech returns exactly the silence value. So a video that opens on a long music intro is judged on the intro. `CLASSIFIED_SECONDS = 60` is why `download_audio` takes a cut length.
- yt-dlp's raw webm/opus is accepted as-is — **no transcode**, and a 60s `ffmpeg -t 60 -c copy` cut reads identically to the full track while uploading ~6× less.

**It deducts on a hit and never awards a bonus on a miss.** The classifier detects *only ElevenLabs* audio (99% precision / 80% recall, and not Eleven v3), so a high reading is strong evidence while a low one is almost none: an OpenAI or PlayHT voice measures 0.02, exactly like a real person. This is the deliberate difference from the filler-word criterion, which does pay a bonus.

Measured calibration: human speech, silence, white/pink noise and a chord all land at 0.02–0.05; genuine ElevenLabs samples land at 0.98; values look clamped to `[0.02, 0.98]`. `DETECTION_THRESHOLD = 0.5` therefore sits in an empty gap. Crucially the signal **survives YouTube** — Opus 130k and 70k, AAC, and narration mixed under a music bed all still read 0.98 — so the docs' "unmodified audio" caveat does not bite here. Real videos do land in between: an ElevenLabs-narrated horror-story upload measured 0.82, i.e. −25.8.

**Audio lifecycle.** Only the Whisper fallback leaves audio on disk, so `analyze_video` downloads a 60-second excerpt for captioned videos and **deletes it in a `finally`** once scoring is done; Whisper-path audio is left alone, since it predates this criterion and `metadata.media.audio` points at it. The criterion itself takes a path and does no I/O, and a failed audio download is caught in `analyze.py` so it costs one criterion rather than the whole video. Note the cost: every analyzed video now downloads its **full** audio track before cutting (a ranged download is throttled — see the yt-dlp section), which for a multi-hour video is a real transfer.

---

## Fact check → Validity Score — `backend/factcheck/`

The transcript goes through a five-stage pipeline that extracts individual factual
claims, gathers live web evidence for each one, and scores the video's overall
factual accuracy. The old single-thesis Anthropic check is gone.

```
backend/browserbase.py     All web access: POST /v1/search, POST /v1/fetch (markdown)
backend/factcheck/
  engine.py                FactCheckEngine.run() orchestrates the five stages
  extract.py      (M1)     transcript → atomic claims + significance weight + search query
  evidence.py     (M2)     claim → ranked, fetched, trimmed sources
  verify.py       (M3)     claim × sources → status, debunk, verified citations
  validity.py     (M4)     weighted Validity Score + rating bands (pure, no I/O)
  report.py       (M5)     markdown report + JSON payload
  llm.py                   provider shim: openai (default) | gateway | anthropic
  models.py, text_utils.py dataclasses + normalize_for_match
  __main__.py              standalone CLI
```

**Validity Score** — `V = Σ(wᵢ·sᵢ) / Σwᵢ × 100` over *verifiable* claims only.
Weights: 3 = core thesis, 2 = major supporting stat, 1 = minor background.
Scores: verified_true 1.0, mostly_true 0.75, misleading 0.25, false 0.0,
unverifiable excluded from **both** numerator and denominator.
Bands: ≥85 Highly Accurate · 65–84 Mostly Reliable · 40–64 Misleading Content Risk ·
<40 High Falsehood / Unreliable. No verifiable claims ⇒ score `null`,
"Insufficient Verifiable Data". Under 3 verifiable claims sets `low_confidence`.

**The Validity Score is independent of the AI-slop score.** Being wrong and being
AI-generated are different questions. The `fact_check` breakdown entry stays
`applied: false, deduction: 0` — choosing a deduction is still an open decision.

**Anti-hallucination is enforced in code, not prompt** (`verify.py::_validate_citations`).
For every citation the model proposes: the `source_index` must resolve to a page we
actually fetched; the quote must survive a `normalize_for_match` substring check against
that source's **full** markdown (not the trimmed excerpt the model saw); and the emitted
url/domain/title come from **our** `Source` record, never model output — so a URL cannot
be fabricated even in principle. Quotes under 4 words / 20 chars are rejected ("the"
substring-matches any page). A `false`/`misleading` verdict left with zero surviving
citations is **downgraded to `unverifiable`** rather than trusted. `normalize_for_match`
strips markdown links, emphasis, headings, blockquotes, bullets and table pipes, because
a model quotes the *visible* text of a `**bolded**` sentence.

**Source tiering** (`evidence.py`): Tier 1 = any `.gov/.edu/.int` plus named agencies and
journals; Tier 2 = established outlets and fact-checkers; Tier 3 = everything else.
Reddit, Quora, Medium, YouTube, social media, Substack and Wikipedia are excluded
outright — citing a forum thread is worse than saying "unverifiable". Results rank by
(tier, original rank).

**Trimming matters**: a real CDC page came back at 39,382 chars. `excerpt_for` keeps the
lede plus the paragraphs richest in claim keywords, in document order, within a 6,000-char
budget (~85% reduction), dropping nav menus and duplicate blocks that otherwise ate ~half
the budget. `Source.markdown` keeps the full text so quote verification stays sound.

**Concurrency**: `gather_all` runs every claim's searches and fetches through ONE shared
`ThreadPoolExecutor`, never a pool nested in a pool, so total in-flight Browserbase calls
stay bounded by `FACTCHECK_CONCURRENCY`.

**Legacy columns** `is_educational` / `thesis` / `hallucinated` are still written, derived
from the report so the extension keeps working: `is_educational` = ≥3 claims or one
weight-3 claim; `thesis` = highest-weight claim; `hallucinated` = that claim rated
false/misleading (an *unverifiable* thesis is **not** hallucinated — we couldn't check it,
which isn't the same as the video being wrong). All three are null when the check
couldn't run.

**Degradation**: no usable LLM credentials ⇒ one warning, the criterion is skipped for the
rest of the run, everything else still scores and stores. Nothing in this pipeline may
raise into `analyze.py`. Adding a key later doesn't backfill — rerun with `--force`.

**Auth**: `BROWSERBASE_API_KEY` (browsing) + one LLM key. `FACTCHECK_LLM_PROVIDER`
defaults to `openai` (`OPENAI_API_KEY`). Browserbase **Model Gateway has no public REST
endpoint** — it routes inside Stagehand only — so the `gateway` provider needs
`BROWSERBASE_GATEWAY_URL` set and raises a clear error otherwise. `anthropic` remains
selectable. **Never** set `BROWSERBASE_PROJECT_ID`; the API key resolves the project.

Rejected alternative: GPTZero `/v2/bibliography-scan/text`. It expects documents with a
works-cited section (which transcripts don't have) and is limited to 10 req/minute.

**CLI / API**
```
python -m backend.factcheck <video_id> [--transcript FILE] [--format markdown|json]
                                       [--max-claims N] [--no-store]
GET /video/fact-check?video_id=…&format=json|markdown
GET /video/evaluation?video_id=…      # now also carries validity_score, validity_rating
```

---

## yt-dlp: all YouTube data (`backend/ytdlp.py`)

**Decision:** the YouTube Data API is gone. yt-dlp supplies video metadata, thumbnail, captions, the audio track (only for Whisper), and channel upload history, with no API key and no quota.

**Runtime requirements:** `yt-dlp[default]` (bundles `yt-dlp-ejs`), **ffmpeg** (converts thumbnails to jpg and cuts the audio to the analyzed window), and **Deno** (yt-dlp needs a JS runtime for YouTube's player challenges). The Docker image includes both. YouTube breaks yt-dlp regularly, so the first fix to try is `pip install -U "yt-dlp[default]"` (or rebuilding the image with `--no-cache`).

**Where to run it:** YouTube bot-checks cloud IPs. Run the analyze script from a residential connection (a dev machine), not a cloud host.

**Don't use `download_ranges` / `--download-sections` for partial downloads.** A ranged download is handed to ffmpeg, which fetches the stream in one long request that YouTube throttles to about playback speed. We measured 0.11 MB/s (60s of 720p video took 36s), against 6.3 MB/s for yt-dlp's own chunked downloader. To get the first N minutes, download the whole stream and cut it locally with `ffmpeg -t N -c copy`, which takes a fraction of a second (`download_audio` / `_cut`).

**Video metadata** (full `extract_info` on the watch URL): `timestamp` (exact upload time, to the second; `upload_date` is the same instant as `YYYYMMDD`), `duration`, `channel_id`, `channel`, `title`, `categories`, `view_count`, and more. The full dict is saved as `video.info.json`. Shorts are regular videos (`/shorts/<ID>` ≡ `/watch?v=<ID>`).

**Captions:** `automatic_captions` holds the ASR track under `<lang>-orig` (original language), plus machine translations under keys like `en-de` or `en-en`. Never use the translations. `subtitles` holds creator-uploaded tracks; livestream replays list `live_chat` there, which is excluded. We pick the tracks ourselves from `extract_info(process=False)` and pass exact escaped keys, because `subtitleslangs` entries are **case-insensitive full-match regexes** (so `en-[A-Z]{2}` also matches `en-de`). The `filepath` in `requested_subtitles` is the pre-move path, so we build paths from our own output template. We prefer ASR over uploaded captions for the transcript.

**Channel data** (`fetch_channel`, cached per channel for 24h in the `channels` table):
- The cached payload carries a `cache_version`. **Bump `CHANNEL_CACHE_VERSION`** (`backend/database/client.py`) whenever its shape changes: a mismatched row counts as a miss and is refetched, instead of being scored by newer code. Rows from before the version check held 50 uploads dated to midnight from the flat listing, which read as a 0.0h median gap between a channel's same-day uploads.
- The uploads playlist (`UC…` → `UU…`) is listed with `extract_flat` **only for video IDs and order** (newest first). **Never use flat-entry dates.** Flat entries only have YouTube's relative dates ("3 days ago"), and even with `youtubetab:approximate_date` those came out up to 2 days wrong for recent uploads and months wrong for old ones.
- Exact timestamps come from a **full extraction of each upload** (1.3–2.4s each, measured on different days): the latest 19 (`RECENT_UPLOADS`) for cadence (median gap), plus the oldest for account age, so 20 extractions. The listing walk itself takes 9–22s for a channel with 1,848 uploads, because finding the oldest upload means reading the whole list. Uploads that fail to extract (members-only, age-restricted, removed) are skipped with a warning.
- **No channel creation date** is available from yt-dlp, including the About tab. Account age uses the oldest upload's exact timestamp. For MKBHD that's within about a week of the real creation date, but it undercounts channels that sat empty before their first public upload.
- A bare channel URL expands to one nested playlist per tab (Videos, Live, Shorts); `resolve_video_ids` recurses into them.

---

## Transcripts (`backend/transcripts.py`)

1. Use the ASR (`<lang>-orig`) caption track if present, otherwise the creator-uploaded one (English first). Formats: json3 (join `events[].segs[].utf8`), or VTT when json3 isn't offered (strip tags, dedupe the rolling repeated lines of auto-caption VTT).
2. **If there are no captions or they're blank**, download the audio track (`download_audio`: ~4s for a 16-minute video's 16 MB track), cut it to the first 5 minutes, and transcribe it locally with **faster-whisper** (`small` model, CPU int8, VAD filter). That takes about 80s per 5 minutes of audio on CPU. The first run also downloads about 460 MB of weights to the Hugging Face cache. A transcript has `kind` `asr`, `standard`, or `whisper`.
3. Every transcript covers only the first 5 minutes: json3 events and VTT cues from 5:00 on are dropped, and the audio is cut to the same window.

## Filler-word criterion notes (up to −20)

Detection is local text analysis over the transcript (no external API): count "um", "uh", "like", "you know", repeated-word stutters ("I- I think") per 100 words. Zero or near-zero fillers on a long spoken transcript ⇒ AI signal.

**Apply this criterion ONLY to ASR transcripts (`kind == "asr"`).** YouTube ASR mostly preserves fillers and stutters (inconsistently: it drops short "uh"s it can't decode), so *presence* of fillers is a solid human signal, but *absence* is weaker evidence, and the deduction scales with transcript length. Uploaded (`standard`) tracks are filler-stripped by captioning convention, and Whisper (`whisper`) drops most fillers too, so the criterion skips both rather than falsely flagging a human video as AI.
