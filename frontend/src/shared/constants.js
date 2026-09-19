export const API_BASE_URL = "http://127.0.0.1:5000";

export const VERDICTS = {
  likely_human: { label: "Likely human", className: "ait-verdict-human" },
  possibly_ai: { label: "Possibly AI", className: "ait-verdict-possibly" },
  ai_slop: { label: "AI Slop", className: "ait-verdict-slop" },
};

export const MESSAGE_TYPES = {
  EVALUATE_VIDEO: "ait:evaluate-video",
  FETCH_PLAYER_RESPONSE: "ait:fetch-player-response",
  PLAYER_RESPONSE_RESULT: "ait:player-response-result",
};
