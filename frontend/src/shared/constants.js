export const API_BASE_URL = "http://127.0.0.1:5000";

export const VERDICTS = {
  likely_human: { label: "Likely human", className: "ait-verdict-human" },
  likely_ai: { label: "Likely AI", className: "ait-verdict-possibly" },
  ai_slop: { label: "AI Slop", className: "ait-verdict-slop" },
};

export const MESSAGE_TYPES = {
  REQUEST_EVALUATION: "ait:request-evaluation",
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
