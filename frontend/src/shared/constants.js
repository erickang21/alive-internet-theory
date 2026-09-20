export const API_BASE_URL = "http://127.0.0.1:5000";

export const VERDICTS = {
  likely_human: { label: "Likely human", className: "ait-verdict-human" },
  likely_ai: { label: "Likely AI", className: "ait-verdict-possibly" },
  ai_slop: { label: "AI Slop", className: "ait-verdict-slop" },
};

export const MESSAGE_TYPES = {
  REQUEST_EVALUATION: "ait:request-evaluation",
  // Batch score lookup behind the tile-grid filter, and the panel's optional
  // instant-update nudge. Both were referenced by the content script and the
  // service worker (and asserted by constants.test.js) without ever being
  // defined, so every batch request went out as `type: undefined` and was
  // handled only because `undefined !== undefined` is false.
  GET_EVALUATIONS: "ait:get-evaluations",
  SET_FILTER_STATE: "ait:set-filter-state",
  // Progressive fact-check bridge (content script -> background -> backend).
  // Content scripts run on youtube.com, and the manifest's host permission is
  // scoped to 127.0.0.1:5000 only, so the fetch has to go through the
  // background worker, same as REQUEST_EVALUATION/GET_EVALUATIONS above.
  GET_FACT_CHECK: "ait:get-fact-check",
};

// Tri-state AI video filter. Cycle order for the sidebar's single-button
// control: off -> flag -> block -> off.
export const FILTER_STATES = ["off", "flag", "block"];
export const DEFAULT_FILTER_STATE = "off";
export const FILTER_STORAGE_KEY = "aitFilterState";
// Lower score = more AI (scoring starts at 100, deductions subtract). A
// video is filtered (flagged/blocked) when its score is below this.
export const AI_FILTER_THRESHOLD = 45;

// Advances to the next filter state. Unknown/garbage input (null,
// undefined, "", a number, an object, a state that isn't in FILTER_STATES)
// resets to DEFAULT_FILTER_STATE rather than throwing, since this drives a
// UI click handler that must never crash on a corrupt stored value.
export function nextFilterState(state) {
  const index = FILTER_STATES.indexOf(state);
  if (index === -1) return DEFAULT_FILTER_STATE;
  return FILTER_STATES[(index + 1) % FILTER_STATES.length];
}

// --- Progressive fact-check ------------------------------------------------
// The fact-check runs in the backend and takes minutes, so the extension reads
// its progress out of chrome.storage.local rather than holding a connection
// open. Storage is the UI's ground truth; the full report stays re-fetchable
// from GET /video/fact-check, which is what makes eviction below safe.

export const FACT_CHECK_STAGES = [
  "idle",
  "checking_eligibility",
  "fact_checking",
  "complete",
  "skipped_fiction",
  "failed",
];

export const FACT_CHECK_KEY_PREFIX = "aitFactCheck:";
export const FACT_CHECK_SCHEMA_VERSION = 1;
// chrome.storage.local caps at 10MB without `unlimitedStorage`, and a 40-claim
// report runs 30-60KB, so an unbounded cache starts failing writes silently.
export const FACT_CHECK_MAX_RECORDS = 50;

// --- Persistent AI score cache ---------------------------------------------
// The service worker's in-memory score Map is wiped whenever MV3 recycles it
// (~30s idle), so a revisited video re-fetches every time. This durable cache
// survives that, keyed the same way as the fact-check cache above.

export const SCORE_KEY_PREFIX = "aitScore:";
export const SCORE_SCHEMA_VERSION = 1;
// Records are ~100 bytes (far smaller than a fact-check report), but still
// bounded so a long browsing session can't grow chrome.storage.local unbounded.
export const SCORE_MAX_RECORDS = 200;
// A `null` score means "not analyzed YET", which stops being true the moment a
// dev runs the analyzer, so - unlike a real score - it expires. Matches the
// service worker's existing in-memory miss TTL.
export const SCORE_MISS_TTL_MS = 60_000;
