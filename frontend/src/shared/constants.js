export const API_BASE_URL = "http://127.0.0.1:5000";

export const VERDICTS = {
  likely_human: { label: "Likely human", tone: "human", agreeVote: "human" },
  likely_ai: { label: "Likely AI", tone: "possibly", agreeVote: "ai" },
  ai_slop: { label: "Heavy AI Use", tone: "slop", agreeVote: "ai" },
};

export const MESSAGE_TYPES = {
  REQUEST_EVALUATION: "ait:request-evaluation",
  SUBMIT_VOTE: "ait:submit-vote",
  GET_EVALUATIONS: "ait:get-evaluations",
  RERUN_EVALUATION: "ait:rerun-evaluation",
  CLEAR_INDICATOR: "ait:clear-indicator",
  // Progressive fact-check bridge (content script -> background -> backend).
  // Content scripts run on youtube.com, and the manifest's host permission is
  // scoped to 127.0.0.1:5000 only, so the fetch has to go through the
  // background worker, same as REQUEST_EVALUATION/GET_EVALUATIONS above.
  GET_FACT_CHECK: "ait:get-fact-check",
};

export const FILTER_STATES = ["off", "flag", "block"];
export const DEFAULT_FILTER_STATE = "off";
export const FILTER_STORAGE_KEY = "aitFilterState";
export const DEBUG_STORAGE_KEY = "aitDebug";
export const RERUN_EVENT = "ait-rerun";
// Lower score = more AI, so a video is flagged or blocked when it scores below this.
export const AI_FILTER_THRESHOLD = 45;

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
