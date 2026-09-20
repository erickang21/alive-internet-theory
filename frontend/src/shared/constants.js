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
};

export const FILTER_STATES = ["off", "flag", "block"];
export const DEFAULT_FILTER_STATE = "off";
export const FILTER_STORAGE_KEY = "aitFilterState";
export const DEBUG_STORAGE_KEY = "aitDebug";
export const RERUN_EVENT = "ait-rerun";
// Lower score = more AI, so a video is flagged or blocked when it scores below this.
export const AI_FILTER_THRESHOLD = 45;
