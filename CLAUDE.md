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

_TODO: pending research — endpoints, params, quota costs, and extension-side scraping fallback._

---

## Transcript retrieval (feeds GPTZero + filler-word analysis)

_TODO: pending research — timedtext/captions options, formats, filler-word preservation._

---

## Filler-word criterion notes (−20)

Detection itself is local text analysis over the transcript (no external API): count "um", "uh", "like", "you know", repeated-word stutters ("I- I think") per minute / per 100 words; zero or near-zero fillers on a long spoken transcript ⇒ AI signal. Key dependency: whether the transcript source preserves fillers (see Transcript section).
