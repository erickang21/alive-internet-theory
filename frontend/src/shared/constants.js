export const API_BASE_URL = "http://127.0.0.1:5000";

export const VERDICTS = {
  likely_human: { label: "Likely human", className: "ait-verdict-human" },
  likely_ai: { label: "Likely AI", className: "ait-verdict-possibly" },
  ai_slop: { label: "AI Slop", className: "ait-verdict-slop" },
};

export const MESSAGE_TYPES = {
  REQUEST_EVALUATION: "ait:request-evaluation",
};
