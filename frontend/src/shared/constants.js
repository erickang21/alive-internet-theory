export const API_BASE_URL = "http://127.0.0.1:5000";

// How many times the extension re-attempts indexing after a retryable upstream
// scoring failure (GPTZero) before giving up.
export const MAX_INDEXING_RETRIES = 3;

export const VERDICTS = {
  likely_human: { label: "Likely human", className: "ait-verdict-human" },
  possibly_ai: { label: "Possibly AI", className: "ait-verdict-possibly" },
  ai_slop: { label: "AI Slop", className: "ait-verdict-slop" },
};

export const MESSAGE_TYPES = {
  REQUEST_EVALUATION: "ait:request-evaluation",
};
