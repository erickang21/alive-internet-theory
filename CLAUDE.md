# Alive Internet Theory — Developer Reference (CLAUDE.md)

Chrome extension that overlays on a YouTube video/Short and rates it **Likely human / Possibly AI / AI Slop**, based on automated scoring factors.

## Monorepo layout (planned — not yet implemented)

```
frontend/            Chrome extension (overlay UI, top-right of YT watch/shorts pages)
backend/api/         HTTP API: GET /video/evaluation, POST /video/evaluation, POST /video/community-vote
backend/scoring/     Scoring engine (starts at 100, deducts per AI evidence)
backend/database/    Evaluation store, indexed by video ID
```

## Scoring criteria → data source mapping

| Criterion | Deduction | Data source |
|---|---|---|
| GPTZero transcript scan | up to −45 | GPTZero `/v2/predict/text` (see below) |
| Fact check transcript | TBD | GPTZero `/v2/bibliography-scan/text` (hallucination detection; see below) |
| Stutters / filler words (absence ⇒ AI) | −20 | Transcript text analysis (see Transcript section) |
| Upload frequency + video length | up to −10 | YouTube metadata (see YouTube section) |
| Account age | up to −5 | YouTube channel metadata |
| Recursive: author's other videos' AI scores | recursive | Channel uploads list + our own DB of past evaluations |

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

### Hallucination detection — candidate for the "fact check transcript" criterion

`POST /v2/bibliography-scan/text` — body: `{ "document": "<body text + works cited together>" }`
(`/v2/bibliography-scan/files` for PDFs.)

Response arrays:
- `bibliographic_citations[]` — each parsed reference with `status`: `exist | exist_with_issues | fake | unsure | unknown`, plus display-ready `hallucination_label` / `hallucination_explanation`.
- `claims[]` — body statements needing backing: `claim_type` (`cited`/`uncited`), `stance` (graded: strongly support → strongly contradict, `stance_unknown`), display `justification`.
- `sources[]` — what was found, linked back via `citation_id` / `claim_id`.

**Rate limit: 10 req/minute** — much tighter than AI detection; fact check must be async/queued, not per-page-load.
**Caveat:** designed for documents with citations; raw video transcripts rarely have a works-cited section. `claims[]` with `uncited` may still work on transcript prose — needs experimentation. Treat this criterion as experimental (its point value is "?" in the spec).

### AI patterns (optional enrichment for the detail view)

`POST /v3/ai/patterns/stream` — Server-Sent Events, one event per matching sentence (a sentence can fire twice):
```jsonc
{ "sentence_index": 1, "sentence": "…", "interpretability_designation": "ai",
  "patterns": [{ "pattern_id": "negative_parallelisms", "display_name": "Not just X, but Y",
                 "category": "Phrasing & style", "explanation": "…", "relevance": 5, "k_times": 1.6 }] }
```
Pattern list grows per release — **don't hardcode it**. Could power "which phrases look AI" highlights in the overlay's details section.

---

## YouTube metadata (criteria: upload frequency, video length, account age, other videos)

**Decision — split the work:** the extension scrapes video-level data it already has on the page for free (`lengthSeconds`, `channelId`, `publishDate`) and POSTs it with the transcript; the backend uses the official Data API (server-side key) for channel-level data (account age, uploads list), cached per channel in our DB. This keeps the fragile scraped surface limited to what's unavoidable (transcripts).

**Shorts are regular videos:** `youtube.com/shorts/<ID>` ≡ `/watch?v=<ID>`; all endpoints below work identically for Shorts.

### Data API v3 (backend; API key from console.cloud.google.com, env var, no OAuth needed for public reads)

Base: `https://www.googleapis.com/youtube/v3`. **Default quota 10,000 units/day** (resets midnight Pacific).

| Call | Cost | Gives us |
|---|---|---|
| `GET /videos?part=contentDetails,snippet&id=<up to 50 IDs>` | 1 unit | `contentDetails.duration` (ISO 8601, e.g. `PT4M13S`) → **video length**; `snippet.publishedAt`, `snippet.channelId` |
| `GET /channels?part=snippet,contentDetails&id=<CHANNEL_ID>` | 1 unit | `snippet.publishedAt` → **account age**; `contentDetails.relatedPlaylists.uploads` → uploads playlist ID (= channel ID with `UC`→`UU`) |
| `GET /playlistItems?part=contentDetails&playlistId=<UU…>&maxResults=50` | 1 unit/page | `contentDetails.videoId` + `contentDetails.videoPublishedAt` (use this, NOT `snippet.publishedAt`) → **upload frequency** (deltas over latest 50) and **other videos for recursive scoring** |

- Full per-video evaluation = **3 units** (~3,300/day); cache channel data by channel ID with ~24h TTL → ~1–2 units per new video.
- **Avoid `search.list`** (`channelId&order=date`): 100 units/call, lagging index — only useful for server-side `publishedAfter` filtering.
- Unofficial playlist IDs `UUSH…` (Shorts-only) / `UULF…` (long-form only) exist but are undocumented; Shorts appear in the main `UU` uploads playlist anyway (since ~2024).
- Quota table: developers.google.com/youtube/v3/determine_quota_cost

### Extension-side (free, from the page the content script already parses)

`ytInitialPlayerResponse` (same global + same SPA-staleness caveat as transcript retrieval — reuse that plumbing, re-parse on `yt-navigate-finish`):
- `videoDetails.lengthSeconds` (string, seconds), `videoDetails.channelId`, `videoDetails.author`, `viewCount`
- `microformat.playerMicroformatRenderer.publishDate` / `.uploadDate` (ISO 8601), `.category`, `.isShortsEligible`

**Not on the watch page:** channel creation date and upload history — scraping those needs extra fragile requests (`youtubei/v1/browse`, relative date strings), which is why they go through the Data API on the backend instead.

---

## Transcript retrieval (feeds GPTZero + filler-word analysis)

**Decision: fetch transcripts client-side in the extension, on the youtube.com page, and POST the parsed text to our backend.** The browser has a residential IP + real cookies; server-side fetching from cloud IPs is broadly blocked by YouTube. (As of Sept 2026.)

**Official API is a dead end:** Data API v3 `captions.list` (50 quota units) returns only track metadata; `captions.download` (200 units) requires OAuth **as the video owner** → 403 for third-party videos. Cannot be used.

### Extension fetch strategy (in order)

1. **Fast path:** read `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[]` from the watch page (each has `baseUrl`, `languageCode`, `kind` — `"asr"` = auto-generated). Same-origin `fetch(baseUrl + "&fmt=json3")` → JSON events with `segs[].utf8`, `tStartMs`, `dDurationMs`.
   - Caveats: `ytInitialPlayerResponse` goes **stale on SPA navigation** (re-parse on navigation events); `baseUrl` is signed and **expires in hours**; tracks with `exp=xpe` in the URL are **PoToken-gated** and return an empty HTTP 200 to bare fetches — on empty body, fall through to (2).
2. **Primary reliable path:** POST `https://www.youtube.com/youtubei/v1/player` with body `{context: {client: {clientName: "ANDROID", clientVersion: "20.x"}}, videoId}` from a MAIN-world injected script (the endpoint 403s on `chrome-extension://` origins). ANDROID-client caption URLs are signed differently and currently need **no PoToken**; fetch with `&fmt=json3`.
3. **Last resort:** programmatically open the "Show transcript" panel and scrape the DOM (the page's own player handles PoToken).

Shorts expose the same `captionTracks` structure via the same player response (use `/watch?v=<ID>` for the Short's ID if the Shorts page doesn't expose it).

**Server-side fallback (batch/offline only, budget for breakage):** `youtube-transcript-api` (Python, maintained) — works only from residential IPs / rotating residential proxies, and is partially hit by the PoToken issue. npm `youtube-transcript` is abandoned; the Node option is `youtubei.js` (`getTranscript()`), same fragility. All of these are reverse-engineered and can break without notice.

---

## Filler-word criterion notes (−20)

Detection itself is local text analysis over the transcript (no external API): count "um", "uh", "like", "you know", repeated-word stutters ("I- I think") per minute / per 100 words; zero or near-zero fillers on a long spoken transcript ⇒ AI signal.

**Apply this criterion ONLY to auto-generated tracks (`captionTracks[].kind == "asr"`).** YouTube ASR mostly preserves fillers/stutters (though inconsistently — it drops short "uh"s it can't decode), so *presence* of fillers is a solid human signal, but *absence* is weaker evidence than the −20 implies; consider scaling the deduction by transcript length/confidence. Manually-uploaded (`standard`) and translated tracks are filler-stripped by captioning convention — skip the criterion for those rather than falsely flagging a human video as AI.
