# Handoff — `feat/factcheck-validity-engine`

Written for whoever picks up this branch next. State as of 2026-09-20.

Pushed through `44bcaee`. Steps 1–3 are done, verified and on the remote.
Steps 4–5 were in progress when this was written; see "In flight" below before
you touch the working tree.

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

## In flight (uncommitted when this was written)

A subagent was building steps 4 + 5 together — the card is inert without the
bridge, so they don't split. Untracked/modified files you may find:

```
frontend/src/content/factCheckBridge.js       + .test.js     NEW
frontend/src/content/factCheckMount.js        + .test.js     NEW
frontend/src/content/factCheckCard.css        moved from src/sidepanel/
frontend/src/content/filterCssSync.test.js    DELETED (intentional)
frontend/build.js, manifest.json              CSS delivery fix
```

**Treat this as unreviewed.** It had not yet made the backend route change
described below, so committing it as-is would bake in the fiction-polls-forever
bug. Either finish it or `git checkout -- .` and redo step 4+5 from the spec.

## Remaining work

### 1. Backend: `/video/fact-check` can't express `skipped_fiction` — BLOCKING

This is the one to fix first, and it's the least obvious thing on the branch.

- Step 3's skip path writes the breakdown entry with `evidence.pregate` and
  **no** `report` key (`backend/scoring/fact_check.py:92-113`).
- `_fact_check_report()` only ever reads `evidence.report`
  (`backend/api/routes.py:95-99`).

So a correctly pre-gated Gaming video returns **404 "no fact-check report is
stored"** — indistinguishable from "never analyzed" (also 404) and from
"fact-check failed for missing credentials" (also 404). Three states, one 404.

Treat that 404 as retryable and fiction videos poll forever. Treat it as
terminal and every correct skip renders to the user as an error. The pre-gate
works perfectly and then has nowhere to report its result.

**Decision taken:** fix the endpoint, don't make the client guess. Keep 404 for
"no evaluation row" only. When a row exists, return a discriminated 200:

| Condition | Response | Bridge stage |
|---|---|---|
| `evidence.pregate.isEligible === false` | `200 {"status":"skipped","pregate":{…}}` | `skipped_fiction` |
| report present | `200` bare report dict — **unchanged** | `complete` |
| neither | `200 {"status":"unavailable",…}` | `failed` |

Leave the success payload byte-identical so `report_from_dict()` and any
existing consumer keep working. Word the `unavailable` case honestly — the
fact-check couldn't run; the *video* didn't fail.

### 2. `backend/api/routes.py` has no tests at all

Every other backend module has one. The routes have none, which is exactly why
the gap above survived. Add `backend/tests/test_routes.py` covering all four
cases in that table.

### 3. Frontend: don't reuse the existing poll loop for the fact-check

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

Regression test to pin it: a video whose evaluation resolves immediately but
whose fact-check is still pending **must** be polled again.

### 4. Verify before committing step 4+5

Two load-bearing claims, neither of which reading the diff will prove:

- **The bridge actually writes `aitFactCheck:<videoId>` records.** Nothing wrote
  them before step 5. If this is wrong the card sits at `idle` forever no matter
  how good everything else is.
- **`npm run build`, then list `dist/` and cross-check every file named in
  `manifest.json` actually exists there.** The CSS change edits both sides.

### 5. Then: fresh-subagent review of the whole chain

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
