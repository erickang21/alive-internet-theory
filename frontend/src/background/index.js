import { API_BASE_URL, MESSAGE_TYPES } from "../shared/constants.js";
import { setIndicator } from "./indicator.js";
import { getScores, primeScore } from "./scores.js";

// A request that never settles never calls sendResponse, leaving the content script
// waiting for an answer that cannot arrive.
const REQUEST_TIMEOUT_MS = 20_000;

const HANDLERS = {
  [MESSAGE_TYPES.REQUEST_EVALUATION]: ({ videoId }, tabId) => requestEvaluation(videoId, tabId),
  [MESSAGE_TYPES.RERUN_EVALUATION]: ({ videoId }, tabId) => requestEvaluation(videoId, tabId, true),
  [MESSAGE_TYPES.SUBMIT_VOTE]: submitVote,
  [MESSAGE_TYPES.GET_EVALUATIONS]: getScores,
  [MESSAGE_TYPES.GET_FACT_CHECK]: ({ videoId }) => getFactCheckStatus(videoId),
  [MESSAGE_TYPES.CLEAR_INDICATOR]: async (_message, tabId) => setIndicator(tabId, "idle"),
  [MESSAGE_TYPES.QUEUE_ANALYSIS]: ({ videoId }) => queueAnalysis(videoId),
};

// The service worker owns backend calls: its host_permissions exempt it from
// the CORS and private-network checks a youtube.com content script would hit
// calling 127.0.0.1.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;

  handler(message, sender.tab?.id)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

// Returns the stored evaluation. For a video that isn't stored yet, the backend
// quietly starts indexing it and answers {status: "indexing"} or
// {status: "failed", detail}. `force` re-runs the analysis of a stored video
// (debug mode), which answers {status: "indexing"} until the new result lands.
async function requestEvaluation(videoId, tabId, force = false) {
  const response = await fetch(`${API_BASE_URL}/video/evaluation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: videoId, force }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 202) {
    throw new Error(`Backend returned ${response.status}`);
  }
  const result = await response.json();
  // Drives the toolbar icon: the viewer's only sign of what happened to this video.
  // A failed analysis answers 200 with a status too, so it must not read as a verdict.
  const state = result.status ? (result.status === "indexing" ? "working" : "failed") : "done";
  setIndicator(tabId, state);
  return result;
}

/** Queues one of the feed's videos, for the auto-analyze mode. Same POST as a watched
 * video, so the backend indexes it if it isn't stored and answers the evaluation once it
 * is — but deliberately without touching the toolbar icon, which describes the video the
 * viewer is actually on, not the thirty tiles scrolling past it.
 *
 * Returns `{score}` once there is a verdict and `{status}` while there isn't. */
async function queueAnalysis(videoId) {
  const response = await fetch(`${API_BASE_URL}/video/evaluation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: videoId, force: false }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== 202) {
    throw new Error(`Backend returned ${response.status}`);
  }
  const result = await response.json();
  if (result.status) return { status: result.status, detail: result.detail };
  primeScore(videoId, result.score ?? null);
  return { score: result.score ?? null };
}

// One vote per (video_id, voter_id), so re-voting overwrites; returns the new tally.
async function submitVote({ videoId, voterId, vote }) {
  const response = await fetch(`${API_BASE_URL}/video/community-vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: videoId, voter_id: voterId, vote }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}`);
  }
  return response.json();
}

// GET /video/fact-check?video_id= discriminates the states itself: 404 means
// no evaluation row at all (still indexing, so keep polling); a 200 carries
// either the bare ValidityReport dict (no top-level "status" key, so the
// shapes can't collide), {status: "skipped", pregate} for a video the
// pre-gate genuinely classified as not fact-checkable, or
// {status: "unavailable", detail} when the check couldn't run (no LLM
// credentials, classifier down, a failed check). "unavailable" maps to the
// bridge's terminal "failed" stage rather than "fact_checking": the state is
// remembered in the row until a --force rerun, so polling it again cannot
// change the answer.
async function getFactCheckStatus(videoId) {
  const url = `${API_BASE_URL}/video/fact-check?video_id=${encodeURIComponent(videoId)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status === 404) return { stage: "fact_checking" };
  if (!response.ok) throw new Error(`Backend returned ${response.status}`);

  const body = await response.json();
  if (body?.status === "skipped") {
    return { stage: "skipped_fiction", pregate: body.pregate ?? null };
  }
  if (body?.status === "unavailable") {
    return { stage: "failed", detail: body.detail ?? null };
  }
  return { stage: "complete", report: body };
}
