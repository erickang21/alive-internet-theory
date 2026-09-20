# Handoff — `feat/factcheck-validity-engine`

Written for whoever picks up this branch next. State as of 2026-09-20.

Pushed through `2ae1d3c`. The extension side is complete and verified:
**211 frontend tests, 238 backend tests, `eslint` clean, working tree clean.**

One blocking backend change remains before this branch is shippable — see
"Remaining work" below. Start there.

## What this branch does

Adds a claim-level fact-checker to the backend, gates it behind a cheap
fiction/non-fiction pre-gate, and gives the extension a persistent AI-score
cache so revisited videos flag instantly. The Validity Score it produces is
**independent of the AI-slop score** — being wrong and being AI-generated are
different questions, which is why the `fact_check` breakdown entry stays
`applied: false, deduction: 0`.

## Done and pushed

| Commit | What |
|---|---|
| `fa68082` | Merge of `origin/main`. 3 conflicts resolved. |
| `6352c49` | Persistent `aitScore:` cache (`frontend/src/shared/scoreCache.js`). |
| `44bcaee` | Pre-gate now gates the fact-check engine. |
| `4cb0b14` | This document. |
| `2ae1d3c` | Fact-check card mounted + the bridge that feeds it; CSS delivery fixed. |

### Two bugs found on `main` during the merge, both fixed here

Both were proven by execution, not by reading:

1. **Every tile score was `null`.** `scoreFor()` in the service worker called an
   undefined `getEvaluation()`. The `ReferenceError` was swallowed by a
   `.catch(() => null)`, so the grid filter could never flag or block anything —
   it looked like it worked because "no score" and "score didn't load" render
   identically. Fixed by adding `storedEvaluation()` using **GET**, not POST
   (POST would queue an indexing job per thumbnail).
2. **`MESSAGE_TYPES` was missing `GET_EVALUATIONS` and `SET_FILTER_STATE`.**
   Batch requests went out as `type: undefined` and worked only because
   `undefined !== undefined` is false — meaning *any* typeless message hit the
   batch handler. Main's own `constants.test.js` was red.

### What step 3 actually guarantees

Verified by poisoning both `FactCheckEngine` and `llm.complete` to raise if
touched:

- A **Gaming** video reaches **neither** — Tier 1 is free in fact, not just in theory.
- An **Education** video reaches the engine with **zero** LLM pre-gate calls.
- An **ambiguous** category with the LLM down fails closed as `unknown`, not as
  "fiction". It never asserts something it didn't determine.

One behaviour change worth knowing: the gate runs *before* the credentials
check, so a sub-40-word transcript now short-circuits as `insufficient_signal`
rather than reporting missing credentials.

### What the card + bridge commit does (`2ae1d3c`)

The card had no data source — **nothing** wrote `aitFactCheck:<videoId>` records,
so it would have sat at `idle` forever however well the UI worked.

- `frontend/src/content/factCheckBridge.js` — polls the backend, maps the
  response to a stage, writes the record. Its tests read back through the real
  `factCheckState` module (`getFactCheckState("v1").stage`), so "it writes
  records" is proven end-to-end rather than asserted against a mock.
- `frontend/src/content/factCheckMount.js` — per-video lifecycle. One video
  mounted at a time; tears down card, subscription and timer before starting
  the next, so a fast navigation can't leave two bridges writing.
- CSS delivery fixed **at the cause**: `build.js` globs `src/content/*.css`,
  the manifest registers them, and the inline `FILTER_CSS` duplicate plus its
  drift-guard test are deleted. Net deletion, not a third copy of the workaround.
  Verified by building clean and cross-checking all five manifest-referenced
  files exist in `dist/`.

This was written by a subagent that stalled mid-edit. Its production code was
complete and correct; what it hadn't finished was a **test-isolation** fix:
`factCheckMount.js` keeps module-level singleton state, and `index.test.js`
gives each test a fresh `index.js` via a `?case=` query-string import — which
does *not* give it a fresh `factCheckMount.js`, since the module cache is keyed
per specifier. A second test reusing the same video id therefore hit the
`videoId === mountedVideoId` early return and never started its bridge.
`teardownGlobals()` now calls `unmountFactCheck()` first, while the fake DOM
still exists. Worth knowing if you add tests here: same trap, same fix.

## Remaining work

### 1. DONE — `/video/fact-check` now discriminates its states

Implemented exactly per the table below, with one amendment found in review: a
pre-gate whose `source` is `"fallback"` (the fail-closed gate — classifier down
or no LLM credentials) never classified the video, so it serves as
`unavailable`, not `skipped`, and `_pregate_skipped_entry` no longer stores
`is_educational=False` for it. 404 is now only "no evaluation row". The worker
maps the response directly and lost its fallback `GET /video/evaluation` round
trip; the bridge treats `unavailable` as a terminal `failed` with the backend's
own wording.

| Condition | Response | Bridge stage |
|---|---|---|
| `evidence.pregate.isEligible === false` (genuinely classified) | `200 {"status":"skipped","pregate":{…}}` | `skipped_fiction` |
| report present | `200` bare report dict — **unchanged** | `complete` |
| neither, or a fallback-sourced pregate | `200 {"status":"unavailable","detail":…}` | `failed` |

The success payload stayed byte-identical (`report_from_dict()` and existing
consumers unaffected), pinned by a test.

### 2. DONE — `backend/tests/test_routes.py` exists

Covers all rows of the table plus 404, the fallback-pregate amendment, the
markdown path, and byte-identity of the report payload.

### 2b. Also fixed in the same pass (from the end-to-end review)

The full review write-up lives in the project's shared files
(`factcheck-branch-review-2026-09-20.md`); the bugs it found are fixed on this
branch: `openai` added to requirements.txt (lazy imports made a fresh install
crash at first fact-check, not at startup); `python -m backend.factcheck`'s
default mode reads the `transcript` key analyze.py now stores, and `_store`
refuses to invent a bare evaluation row (which 500'd both /video/evaluation
routes and blocked indexing forever) and writes the report into the breakdown
entry the route reads; the feed filter's fresh-score pass merges over the
cached pass instead of clobbering it when the worker is unreachable.

### 3. DONE — but don't undo it: the fact-check must not share the poll loop

`poll()` in `frontend/src/content/index.js:188-192` unschedules itself
permanently the moment `showEvaluation()` returns true. The AI score is stored
offline and lands on the **first** tick; a fact-check takes minutes. So hanging
the fact-check off that loop — the natural reading of "reuse main's 30s ± jitter
cadence" — stops polling on tick 1 and strands the card at `fact_checking`
forever.

Reuse the *constants* (`POLL_INTERVAL_MS`, `POLL_JITTER_MS`) and the jitter
formula, not the loop. Give the fact-check its own timer whose terminal
condition is `complete` / `skipped_fiction` / `failed`. Both timers must be
independently cancelled on `yt-navigate-finish`, or a stale timer writes records
for the previous video.

This is how it's built now, and it's pinned by a regression test: *"the
fact-check bridge keeps polling after the AI-score poll settles on tick 1"* in
`index.test.js`. If that test ever starts looking redundant, it isn't.

### 4. Fresh review of the whole chain

Steps 1–5 have not had a single reviewer look at them end to end. The individual
pieces were each verified, but the seams between them are where the one real
defect so far turned up (step 3 ↔ step 5, item 1 above) — so review the seams,
not just the modules.

## Open decisions / known debt

- **The fact-check deduction is still TBD.** `applied: false, deduction: 0` is
  deliberate, not an oversight — nobody has decided what being wrong should cost
  an AI-slop score, or whether it should cost anything.
- **The manifest has no host permission for youtube.com** (only
  `http://127.0.0.1:5000/*`). So `chrome.tabs.sendMessage` can never reach the
  content script, and a `content_scripts` match does **not** grant it. This is
  *why* `chrome.storage.local` is the source of truth between the panel and the
  page rather than messaging. Don't "simplify" it back to messaging without
  adding the permission.
- **MV3 kills the service worker after ~30s idle.** That's why polling lives in
  the content script and why the score cache had to become persistent.
- **`core.autocrlf=true` on this checkout.** Many pre-existing files are CRLF and
  already fail `prettier --check`. Write new files LF; don't mass-reformat.

## Conventions this branch follows

- Frontend: vanilla ES modules + esbuild, **no framework**, `node:test` built in,
  zero new deps. Tests live next to their module as `<name>.test.js`.
- Anti-hallucination in the fact-checker is enforced **in code, not prompt**
  (`verify.py::_validate_citations`): a quote must survive a substring check
  against the source's *full* markdown, and the emitted URL comes from our own
  `Source` record, so a citation cannot be fabricated even in principle.
- **Never set `BROWSERBASE_PROJECT_ID`** — the API key resolves the project.
  Browserbase's Model Gateway has no public REST endpoint (verified by probing
  five candidate hosts); it routes inside Stagehand only.
