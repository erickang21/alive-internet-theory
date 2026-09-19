# Alive Internet Theory — Developer Reference (CLAUDE.md)

Chrome extension that overlays on a YouTube video/Short and rates it **Likely human / Likely AI / AI Slop**, based on automated scoring factors.

## Architecture: analysis runs in the backend, the extension only reads

**A video is analyzed in the background the first time someone opens it**, or when a dev runs the analyze script. The extension itself fetches no transcripts and runs no scoring, and it never shows that indexing is happening.

1. The analysis pipeline (`backend/analyze.py`) uses **yt-dlp for all YouTube data** (metadata, thumbnail, captions, the audio track when Whisper needs it, channel uploads). It transcribes locally with Whisper when captions are missing, scores the video, and writes the evaluation to SQLite. Devs run it directly (`python -m backend.analyze <targets>`) for batches, channels/playlists, and `--force` re-analysis.
2. The extension asks the API for the current video with `POST /video/evaluation`. A stored evaluation comes back with one criterion scored at read time (channel history, see below) and the score and verdict recomputed from the full breakdown; otherwise the API quietly starts the same pipeline in a background thread (`backend/api/indexing.py`) and answers `202 {"status": "indexing"}`. Failures come back as `{"status": "failed", "detail": …}` and are held in memory only, so a backend restart clears them for another attempt. There are no automatic retries; a GPTZero failure degrades that one criterion like any other. `GET /video/evaluation?video_id=…` still serves stored rows without triggering anything; the other write is `POST /video/community-vote`.
3. The extension shows the verdict if there is one, and otherwise "Not analyzed". While a video has no evaluation (indexing, a failed analysis, or an unreachable backend) the content script repeats the request every 30s ± 2s of jitter and stops as soon as a score is on screen, so a verdict that finishes indexing appears without reopening the video. Polling lives in `frontend/src/content/index.js`, not the service worker, because MV3 unloads an idle worker after ~30s. A stored evaluation is fetched once per visit.

```
frontend/                  Chrome extension (overlay, top-right of YT watch/shorts pages; shows results, silently queues unanalyzed videos)
backend/analyze.py         CLI: resolve targets → download → transcript → score → store
backend/ytdlp.py           All YouTube access (target expansion, downloads, channel uploads + 24h cache)
backend/transcripts.py     Caption parsing (json3/vtt), faster-whisper fallback
backend/scoring/           Scoring engine (starts at 100, deducts per AI evidence) + per-criterion modules
backend/factcheck/         Claim extraction → web evidence → verification → Validity Score
backend/browserbase.py     All web access (Browserbase search + fetch, markdown)
backend/api/               Flask API: GET/POST /video/evaluation, GET /video/fact-check, POST /video/community-vote, background indexing
backend/database/          SQLAlchemy models + repositories on SQLite, Alembic migrations
```

Storage: SQLite at `SQLITE_PATH` (default `backend/data/alive_internet_theory.db`), downloaded files at `MEDIA_DIR/<video_id>/` (`video.info.json` with everything yt-dlp extracted, `thumbnail.jpg`, `subtitles.<lang>.<ext>`, and `audio.<ext>` only when Whisper was needed). **Only the first 5 minutes of a video are analyzed** (`ANALYZED_SECONDS` in `backend/ytdlp.py`): captions are cut to that window and the audio is cut to it. **The video itself isn't downloaded**, because no criterion uses it; add a video download back when a video-based criterion needs one. In Docker both live on the `/data` volume, along with the Whisper model cache (`HF_HOME`). The schema changes through Alembic migrations, which the app and the analyze script apply on startup (see README → Changing the database schema).

## Scoring criteria → data source mapping

| Criterion | Deduction | Data source |
|---|---|---|
| GPTZero transcript scan | up to −45 | GPTZero `/v2/predict/text` (see below) |
| Fact check → Validity Score | **not scored yet** (TBD); reported as its own independent score | Claim extraction + Browserbase search/fetch + per-claim verification (see Fact check section) |
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

### AI detection — used for the "up to −45" criterion

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
- A flag should open a conversation — show evidence (per-criterion breakdown in the overlay), don't auto-punish. Our pass/fail detail view aligns with this.
- GPTZero's Cloudflare rejects the default python-requests User-Agent (error 1010), so `backend/scoring/gptzero.py` sends a browser-style one.

### AI patterns (optional enrichment for the detail view)

`POST /v3/ai/patterns/stream` — Server-Sent Events, one event per matching sentence (a sentence can fire twice):
```jsonc
{ "sentence_index": 1, "sentence": "…", "interpretability_designation": "ai",
  "patterns": [{ "pattern_id": "negative_parallelisms", "display_name": "Not just X, but Y",
                 "category": "Phrasing & style", "explanation": "…", "relevance": 5, "k_times": 1.6 }] }
```
Pattern list grows per release — **don't hardcode it**. Could power "which phrases look AI" highlights in the overlay's details section.

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
