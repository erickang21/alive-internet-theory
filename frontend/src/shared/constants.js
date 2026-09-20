export const API_BASE_URL = "http://127.0.0.1:5000";

export const VERDICTS = {
  likely_human: { label: "Likely human", className: "ait-verdict-human" },
  likely_ai: { label: "Likely AI", className: "ait-verdict-possibly" },
  ai_slop: { label: "AI Slop", className: "ait-verdict-slop" },
};

export const MESSAGE_TYPES = {
  REQUEST_EVALUATION: "ait:request-evaluation",
};

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
