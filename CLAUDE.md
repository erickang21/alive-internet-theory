# Alive Internet Theory — Developer Reference (CLAUDE.md)

Chrome extension that embeds a verdict card in YouTube's watch page (floating on Shorts) and rates the video **Likely human / Likely AI / AI Slop**, based on automated scoring factors.

## Architecture: analysis runs in the backend, the extension only reads

**A video is analyzed in the background the first time someone opens it**, or when a dev runs the analyze script. The extension itself fetches no transcripts and runs no scoring, and it never shows that indexing is happening.

1. The analysis pipeline (`backend/analyze.py`) uses **yt-dlp for all YouTube data** (metadata, thumbnail, captions, the audio track when Whisper needs it, channel uploads). It transcribes locally with Whisper when captions are missing, scores the video, and writes the evaluation to SQLite. Devs run it directly (`python -m backend.analyze <targets>`) for batches, channels/playlists, and `--force` re-analysis.
2. The extension asks the API for the current video with `POST /video/evaluation`. A stored evaluation comes back with one criterion scored at read time (channel history, see below) and the score and verdict recomputed from the full breakdown; otherwise the API quietly starts the same pipeline in a background thread (`backend/api/indexing.py`) and answers `202 {"status": "indexing"}`. Failures come back as `{"status": "failed", "detail": …}` and are held in memory only, so a backend restart clears them for another attempt. There are no automatic retries; a GPTZero failure degrades that one criterion like any other. `POST /video/evaluation` with `"force": true` re-runs the analysis of a stored video (`indexing.request(video_id, force=True)`; a job that is already running is never doubled), and while that rerun is pending the API answers `{"status": "indexing"}` instead of the old row. `GET /video/evaluation?video_id=…` still serves stored rows without triggering anything; the other write is `POST /video/community-vote`.
3. The extension shows the verdict if there is one, and otherwise injects nothing. While a video has no evaluation (indexing, a failed analysis, or an unreachable backend) the content script repeats the request every 5–7s (5s plus up to 2s of jitter) and stops as soon as a score is on screen — the original 30s interval made a verdict that landed in seconds sit invisible until the next tick, so a verdict that finishes indexing appears without reopening the video. Polling lives in `frontend/src/content/index.js`, not the service worker, because MV3 unloads an idle worker after ~30s. A stored evaluation is fetched once per visit.

```
frontend/                  Chrome extension (verdict card in the watch page, breakdown/settings popover, feed filter; silently queues unanalyzed videos)
backend/analyze.py         CLI: resolve targets → download → transcript → score → store
backend/ytdlp.py           All YouTube access (target expansion, downloads, channel uploads + 24h cache)
backend/transcripts.py     Caption parsing (json3/vtt), faster-whisper fallback
backend/scoring/           Scoring engine (starts at 100, deducts per AI evidence) + per-criterion modules
backend/api/               Flask API: GET/POST /video/evaluation, POST /video/community-vote, background indexing
backend/database/          SQLAlchemy models + repositories on SQLite, Alembic migrations
```

Storage: SQLite at `SQLITE_PATH` (default `backend/data/alive_internet_theory.db`), downloaded files at `MEDIA_DIR/<video_id>/` (`video.info.json` with everything yt-dlp extracted, `thumbnail.jpg`, `subtitles.<lang>.<ext>`, and `audio.<ext>` only when Whisper was needed — the voice check downloads its own 60-second excerpt and deletes it again, so it leaves nothing behind). **Only the first 5 minutes of a video are analyzed** (`ANALYZED_SECONDS` in `backend/ytdlp.py`): captions are cut to that window and the audio is cut to it. **The video itself isn't downloaded**, because no criterion uses it; add a video download back when a video-based criterion needs one. In Docker both live on the `/data` volume, along with the Whisper model cache (`HF_HOME`). The schema changes through Alembic migrations, which the app and the analyze script apply on startup (see README → Changing the database schema).

## Frontend UI (`frontend/src/`)

React 18 + styled-components, bundled by esbuild (`jsx: "automatic"`, minified, `NODE_ENV` defined). Both verified to run inside YouTube's Trusted Types page without a policy. Only the tile decoration still ships as a stylesheet (`dist/filter.css`); everything else is styled-components.

- **`ui/tokens.js`**: the `--ait-*` custom properties on `[data-ait-root]`, as a `createGlobalStyle`. They stay CSS variables rather than a styled-components theme object so they can alias YouTube's live `--yt-sys-color-baseline--*` values (the old `--yt-spec-*` family is gone) and flip with `html[dark]` without any JS. Radii follow YouTube: 12px containers, 8px tabs/chips/marks, 4px thumbnail badges.
- **`ui/Card.jsx`**: the verdict card — label, score as a percentage, 5-segment meter, community sentence, feedback thumbs, "View breakdown". It owns the vote state and portals the panel into `document.body`, so both feedback rows share one vote without a store. `ui/Ring.jsx` is the rainbow ring that draws once when a verdict lands while the viewer is watching.
- **`ui/Panel.jsx`**: the popover under the masthead (YouTube menu surface, no scrim) with Breakdown and Settings tabs and the feedback row as a footer. Close X, click outside, and Escape close it; Tab is trapped inside; the card restores focus to its link. `ui/Breakdown.jsx` holds the per-criterion config and the accordion (its **Text-to-speech likelihood** row is main's `elevenlabs_voice` criterion). **The backend sends fields, never prose**: a criterion returns `evidence` plus, when it had nothing to say, a `reason` key (`transcript_too_short`, `needs_auto_captions`, `no_audio`, `no_credentials`, `not_educational`, `upstream_error`, …). Breakdown.jsx owns every sentence, and `ui/format.js` owns every value, so a duration reads the same in the summary and the rows — the old split emitted "981 days old" beside "2.7 years ago" for one number. Each expanded row reads: a sentence stating the finding, the stats as `Label: value` lines, then an `about` note below the rule (first letter flush with it) explaining what that check looks at, linking out to GPTZero and ElevenLabs. The summary never repeats a stat. Evaluations stored before this fall back to their own `detail`; `ui/Settings.jsx` the switches.
- **`ui/hooks.js`**: `useVote` (tally, selection, submit, the memoized anonymous `voterId`, and the per-video `vote:<id>` key), `useFilterState`, `useDebugMode`, `useDismiss`.
- **`content/mount.js`**: the one imperative piece left. It keeps a `[data-ait-mount]` container (`display: contents`, so the card itself is the flow element) anchored above `#donation-shelf`/`#related` using the anchor's own parent, since YouTube moves both into `#below` in single-column layouts, and re-anchors from a rAF-coalesced `MutationObserver`. Shorts have no side column, so the card floats top-right there.
- **`content/index.jsx`**: polling and mounting. **Nothing is injected until the video has a verdict** — an unanalyzed video (or an unreachable backend) leaves the page untouched while the content script repeats the request every 5–7s.
- **Feed filter** (`content/filter.js`, `videoScanner.js`, `filterRenderer.js`, `shared/filterState.js`, `background/scores.js`): stays imperative, because it decorates YouTube's own tiles rather than rendering our own tree. `chrome.storage.local["aitFilterState"]` is the source of truth, so the filter applies on load, on navigation and on storage changes with no UI open. With flags on, an AI-leaning tile is marked and a likely-human one is left untouched, since labelling what you do want doubles the noise for nothing. The thumbnail darkens behind a corner pill — 50% for **AI Slop** with a warning triangle, 30% for **Likely AI** with a question mark — so the title and channel keep full contrast and the two bands separate before the label is read. A hidden note beside the title carries the verdict for screen readers, since the mark is visual only. Bands use the backend's thresholds. "Remove" hides only the AI Slop band (`AI_FILTER_THRESHOLD`). An unanalyzed tile (`null` score) always renders normally. Scores come from `GET /video/evaluation` (never POST: browsing a feed must not queue its tiles for indexing), fanned out 4 at a time with a cache where only misses expire.
- **Toolbar** (`manifest.action`, `background/indicator.js`): `popup.html` renders `<Settings>` on its own React root, which is the only way to reach the settings off a watch page; its layout ships as a real `dist/popup.css`, because Chrome measures the popup before any script runs and a width that arrives with styled-components leaves it sized to nothing. The icon is a solid rounded square drawn into an `OffscreenCanvas` and pushed with `chrome.action.setIcon`, **per tab**, so it always describes the video that tab is showing: grey with nothing to show, a pulsing amber square while the video answers `{status: "indexing"}`, and green once it has a verdict, which it stays. **A failed analysis answers 200 with `{status: "failed"}`, so anything that isn't an evaluation must not read as a verdict**: it turns red, and the content script stops polling, since a failure is remembered until the backend restarts. Each state also sets its own tooltip. `requestEvaluation` sets it from `sender.tab.id`, and the content script sends `CLEAR_INDICATOR` on **every** change of video, so each one runs its own cycle instead of inheriting the last one's colour until its first answer lands. Working tabs expire after `STALE_MS` so a closed tab can't pulse forever, and the module redraws the idle square on load in case a worker died mid-pulse. `icons/` holds the grey resting icon as `default_icon`.
- All backend calls go through the service worker (`background/index.js`, one listener with a `HANDLERS` map). `npm test` runs the filter's unit tests (`node --test`).

## Scoring criteria → data source mapping

| Criterion | Deduction | Data source |
|---|---|---|
| GPTZero transcript scan | up to −50 | GPTZero `/v2/predict/text` (see below) |
| ElevenLabs voice scan (`elevenlabs_voice`) | up to −40 | ElevenLabs AI speech classifier over the audio (see below) |
| Fact check (`fact_check`) | **not scored yet** (TBD) | Claude Opus 5 + web search over the transcript (see Fact check section) |
| Stutters / filler words (absence ⇒ AI) | up to −20 | Transcript text analysis, ASR tracks only (see Filler-word section) |
| Upload frequency + video length | up to −10 | Exact upload timestamps of the channel's latest 20 uploads via yt-dlp (see yt-dlp section) |
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

## Fact check (hallucination detection) — `backend/scoring/fact_check.py`

The transcript goes through an LLM (Claude, `claude-opus-5`, Anthropic Python SDK) to produce three fields, stored as their own `videos` columns and returned by the API:

- `is_educational` (bool): is the video non-fiction whose main purpose is checkable factual claims? Only educational content is fact-checked. Fiction, comedy, music, gaming and vlogs are not.
- `thesis` (string): the main thesis in one sentence. Set only when educational.
- `hallucinated` (bool): **false only when independent third-party sources confirm the thesis is correct**. True when they contradict it or when nothing independent confirms it. Set only when educational.

All three are null when the check couldn't run. **Without usable Anthropic credentials** (none configured, a placeholder or invalid key, or an `ant` profile with no credentials file), the first video logs one warning and the fact check is skipped for the rest of the run without sending more requests. The breakdown says "Skipped: no usable Anthropic credentials." Everything else still runs and is stored. Adding a key later doesn't backfill: rerun those videos with `--force`. The breakdown entry also carries a justification and source URLs as evidence.

Two calls: (1) classification with a JSON-schema `output_config.format`; (2) for educational videos only, verification with the server-side `web_search_20260209` tool (max 5 searches). The verdict comes back through a `strict` `report_verdict` tool, because JSON output formats don't mix reliably with web-search citations. The verify loop resumes `pause_turn` up to 5 times. Both calls set `fallbacks="default"` (beta `server-side-fallback-2026-07-01`) so a safety decline re-runs on Anthropic's recommended fallback model; a final `refusal` fails the criterion.

**Not scored yet:** the entry has `applied: false, deduction: 0`, so the breakdown shows it as "n/a" with its detail text. Choosing a deduction is an open decision.

Rejected alternative: GPTZero `/v2/bibliography-scan/text`. It expects documents with a works-cited section (which transcripts don't have) and is limited to 10 req/minute.

Auth: `ANTHROPIC_API_KEY`, or an `ant auth login` profile for venv runs (a set `ANTHROPIC_API_KEY`, even a placeholder, overrides the profile).

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
- Exact timestamps come from a **full extraction of each upload** (1.3–2.4s each, measured on different days): the latest 20 (`RECENT_UPLOADS`) for cadence (median gap), plus the oldest for account age, so 21 extractions. The listing walk itself takes 9–22s for a channel with 1,848 uploads, because finding the oldest upload means reading the whole list. Uploads that fail to extract (members-only, age-restricted, removed) are skipped with a warning.
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
