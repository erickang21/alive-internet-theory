import { API_BASE_URL, MESSAGE_TYPES } from "../shared/constants.js";
import { setIndexing } from "./indicator.js";
import { getScores } from "./scores.js";

const HANDLERS = {
  [MESSAGE_TYPES.REQUEST_EVALUATION]: (message) => requestEvaluation(message.videoId),
  [MESSAGE_TYPES.SUBMIT_VOTE]: submitVote,
  [MESSAGE_TYPES.GET_EVALUATIONS]: getScores,
  [MESSAGE_TYPES.RERUN_EVALUATION]: (message) => requestEvaluation(message.videoId, true),
};

// The service worker owns backend calls: its host_permissions exempt it from
// the CORS and private-network checks a youtube.com content script would hit
// calling 127.0.0.1.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return false;

  handler(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

// Returns the stored evaluation. For a video that isn't stored yet, the backend
// quietly starts indexing it and answers {status: "indexing"} or
// {status: "failed", detail}. `force` re-runs the analysis of a stored video
// (debug mode), which answers {status: "indexing"} until the new result lands.
async function requestEvaluation(videoId, force = false) {
  const response = await fetch(`${API_BASE_URL}/video/evaluation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: videoId, force }),
  });
  if (!response.ok && response.status !== 202) {
    throw new Error(`Backend returned ${response.status}`);
  }
  const result = await response.json();
  // Drives the toolbar spinner: the viewer's only sign that a video is being analyzed.
  setIndexing(videoId, result.status === "indexing");
  return result;
}

// One vote per (video_id, voter_id), so re-voting overwrites; returns the new tally.
async function submitVote({ videoId, voterId, vote }) {
  const response = await fetch(`${API_BASE_URL}/video/community-vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: videoId, voter_id: voterId, vote }),
  });
  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}`);
  }
  return response.json();
}

// --- GET_EVALUATIONS: batch score lookup for the tile-grid AI filter ----------------
//
// There is no backend batch endpoint yet — the API only exposes
// `GET /video/evaluation?video_id=`. A `POST /video/evaluations` accepting
// `{video_ids: [...]}` and returning scores in one round trip would replace this
// fan-out entirely; until Backend adds it, we fan out through a small bounded queue
// so a 30-tile grid page doesn't fire 30 simultaneous requests. (Backend handoff.)

// Score cache, keyed by video id. A scrolled-past tile that scrolls back into view is
// never refetched. Unbounded for the lifetime of the service worker, which is fine for
// real evaluations: the backend writes them offline, so a score never changes under us.
//
// A MISS is different. A video that 404s now can be analyzed by a dev minutes later
// while this same worker is still warm, so caching "not analyzed" forever would pin the
// tile as unfiltered for the rest of the session. Misses therefore get a short TTL.
const scoreCache = new Map();
const missExpiry = new Map();
const MISS_TTL_MS = 60_000;

// Promises for ids currently being fetched, so concurrent GET_EVALUATIONS calls for
// the same id (e.g. two tabs, or a re-scan that races an in-flight one) share the one
// request instead of each starting their own.
const inFlight = new Map();

// Bounded concurrency for the fan-out queue. The gate is module-level, not per call:
// a mutation-observer rescan can overlap an in-flight navigation rescan with a disjoint
// id set, and a per-call pool would let each have its own 4 workers.
const MAX_CONCURRENT_LOOKUPS = 4;
let activeLookups = 0;
const waiting = [];

function acquireSlot() {
  if (activeLookups < MAX_CONCURRENT_LOOKUPS) {
    activeLookups += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next();
  else activeLookups -= 1;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MESSAGE_TYPES.GET_EVALUATIONS) return false;

  getScores(Array.isArray(message.videoIds) ? message.videoIds : [])
    .then((scores) => sendResponse({ ok: true, scores }))
    .catch(() => sendResponse({ ok: true, scores: {} })); // never throw past the listener
  return true;
});

async function getScores(videoIds) {
  const uniqueIds = Array.from(new Set(videoIds.filter(Boolean)));
  // Every lookup passes through the shared semaphore, so total in-flight fetches stay
  // capped across overlapping GET_EVALUATIONS calls, not just within one.
  await Promise.all(uniqueIds.map((id) => scoreFor(id)));

  const scores = {};
  for (const id of uniqueIds) scores[id] = scoreCache.has(id) ? scoreCache.get(id) : null;
  return scores;
}

function isCached(videoId) {
  if (!scoreCache.has(videoId)) return false;
  const expiresAt = missExpiry.get(videoId);
  if (expiresAt === undefined) return true; // a real score, cached for good
  if (Date.now() < expiresAt) return true;
  scoreCache.delete(videoId);
  missExpiry.delete(videoId);
  return false;
}

async function scoreFor(videoId) {
  if (isCached(videoId)) return scoreCache.get(videoId);
  if (inFlight.has(videoId)) return inFlight.get(videoId);

  const promise = acquireSlot()
    .then(() => getEvaluation(videoId))
    .then((evaluation) => evaluation?.score ?? null)
    .catch(() => null) // network error -> null, same as "not analyzed"
    .then((score) => {
      scoreCache.set(videoId, score);
      if (score === null) missExpiry.set(videoId, Date.now() + MISS_TTL_MS);
      else missExpiry.delete(videoId);
      releaseSlot();
      inFlight.delete(videoId);
      return score;
    });

  inFlight.set(videoId, promise);
  return promise;
}
