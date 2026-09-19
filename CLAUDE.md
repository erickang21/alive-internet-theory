# Alive Internet Theory — Developer Reference (CLAUDE.md)

Chrome extension that overlays on a YouTube video/Short and rates it **Likely human / Possibly AI / AI Slop**, based on automated scoring factors.

## Architecture: analysis is offline, the extension only reads

**Devs decide which videos get analyzed and when.** Nothing is analyzed on page load.

1. A dev runs the analyze script (`python -m backend.analyze <targets>`), which uses **yt-dlp for all YouTube data** (metadata, video, thumbnail, captions, channel uploads). It transcribes locally with Whisper when captions are missing, scores the video, and writes the evaluation to SQLite.
2. The Flask API is read-only for evaluations: `GET /video/evaluation?video_id=…`. The only write left is `POST /video/community-vote`.
3. The extension looks up the current video and shows the stored verdict, or "Not analyzed" on a 404. It fetches no transcripts and runs no scoring.

```
frontend/                  Chrome extension (read-only overlay, top-right of YT watch/shorts pages)
backend/analyze.py         CLI: resolve targets → download → transcript → score → store
backend/ytdlp.py           All YouTube access (target expansion, downloads, channel uploads + 24h cache)
backend/transcripts.py     Caption parsing (json3/vtt), faster-whisper fallback
backend/scoring/           Scoring engine (starts at 100, deducts per AI evidence) + per-criterion modules
backend/api/               Flask API: GET /video/evaluation, POST /video/community-vote
backend/database/          SQLAlchemy models + repositories on SQLite, Alembic migrations
```

Storage: SQLite at `SQLITE_PATH` (default `backend/data/alive_internet_theory.db`), downloaded files at `MEDIA_DIR/<video_id>/` (`video.info.json` with everything yt-dlp extracted, `thumbnail.jpg`, `subtitles.<lang>.<ext>`, and `audio.<ext>` only when Whisper was needed). **Only the first 5 minutes of a video are analyzed** (`ANALYZED_SECONDS` in `backend/ytdlp.py`): captions are cut to that window and the audio is cut to it. **The video itself isn't downloaded**, because no criterion uses it; add a video download back when a video-based criterion needs one. In Docker both live on the `/data` volume, along with the Whisper model cache (`HF_HOME`). The schema changes through Alembic migrations, which the app and the analyze script apply on startup (see README → Changing the database schema).

## Scoring criteria → data source mapping

| Criterion | Deduction | Data source |
|---|---|---|
| GPTZero transcript scan | up to −45 | GPTZero `/v2/predict/text` (see below) |
| Fact check (`fact_check`) | **not scored yet** (TBD) | Claude Opus 5 + web search over the transcript (see Fact check section) |
| Stutters / filler words (absence ⇒ AI) | up to −20 | Transcript text analysis, ASR tracks only (see Filler-word section) |
| Upload frequency + video length | up to −10 | Exact upload timestamps of the channel's latest 20 uploads via yt-dlp (see yt-dlp section) |
| Account age | up to −5 | Exact timestamp of the channel's **oldest upload** via yt-dlp, a proxy because the creation date isn't available |
| Recursive: author's other videos' AI scores | recursive | Channel uploads list + our own DB of past evaluations (not built yet) |

---

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

## Fact check (hallucination detection) — `backend/scoring/fact_check.py`

The transcript goes through an LLM (Claude, `claude-opus-5`, Anthropic Python SDK) to produce three fields, stored as their own `videos` columns and returned by the API:

- `is_educational` (bool): is the video non-fiction whose main purpose is checkable factual claims? Only educational content is fact-checked. Fiction, comedy, music, gaming and vlogs are not.
- `thesis` (string): the main thesis in one sentence. Set only when educational.
- `hallucinated` (bool): **false only when independent third-party sources confirm the thesis is correct**. True when they contradict it or when nothing independent confirms it. Set only when educational.

All three are null when the check couldn't run. **Without usable Anthropic credentials** (none configured, a placeholder or invalid key, or an `ant` profile with no credentials file), the first video logs one warning and the fact check is skipped for the rest of the run without sending more requests. The breakdown says "Skipped: no usable Anthropic credentials." Everything else still runs and is stored. Adding a key later doesn't backfill: rerun those videos with `--force`. The breakdown entry also carries a justification and source URLs as evidence.

Two calls: (1) classification with a JSON-schema `output_config.format`; (2) for educational videos only, verification with the server-side `web_search_20260209` tool (max 5 searches). The verdict comes back through a `strict` `report_verdict` tool, because JSON output formats don't mix reliably with web-search citations. The verify loop resumes `pause_turn` up to 5 times. Both calls set `fallbacks="default"` (beta `server-side-fallback-2026-07-01`) so a safety decline re-runs on Anthropic's recommended fallback model; a final `refusal` fails the criterion.

**Not scored yet:** the entry has `applied: false, deduction: 0`, so it shows as "n/a" with its detail text in the overlay. Choosing a deduction is an open decision.

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
