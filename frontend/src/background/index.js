import { API_BASE_URL, MESSAGE_TYPES } from "../shared/constants.js";
import { getCachedScore, putCachedScore } from "../shared/scoreCache.js";

// The service worker owns backend calls: its host_permissions exempt it from
// the CORS and private-network checks a youtube.com content script would hit
// calling 127.0.0.1.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MESSAGE_TYPES.REQUEST_EVALUATION) return false;

  requestEvaluation(message.videoId)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

// Returns the stored evaluation. For a video that isn't stored yet, the backend
// quietly starts indexing it and answers {status: "indexing"} or
// {status: "failed", detail}.
async function requestEvaluation(videoId) {
  const response = await fetch(`${API_BASE_URL}/video/evaluation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: videoId }),
  });
  if (!response.ok && response.status !== 202) {
    throw new Error(`Backend returned ${response.status}`);
  }
  return response.json();
}

// Reads a STORED evaluation only. Deliberately GET, not the POST above: the
// grid asks about every tile on screen, and POST queues analysis for anything
// missing, so scrolling a feed would kick off a yt-dlp download plus Whisper
// per thumbnail. A tile with no evaluation renders normally instead.
async function storedEvaluation(videoId) {
  const url = `${API_BASE_URL}/video/evaluation?video_id=${encodeURIComponent(videoId)}`;
  const response = await fetch(url);
  if (response.status === 404) return null; // not analyzed
  if (!response.ok) throw new Error(`Backend returned ${response.status}`);
  return response.json();
}

// --- GET_FACT_CHECK: the progressive fact-check bridge ------------------------------
//
// GET /video/fact-check?video_id= only ever returns the stored ValidityReport
// (200) or 404 (backend/api/routes.py::_fact_check_report reads nothing but
// evidence.report). That 404 is ambiguous by itself: it's the same response
// whether the video hasn't been analyzed at all yet, the analysis finished but
// the pre-gate ruled it ineligible (backend/scoring/fact_check.py's
// _pregate_skipped_entry never writes a report), or the fact-check criterion
// was skipped for some other reason (e.g. no usable LLM credentials). Only a
// report existing is unambiguous, so a 404 there falls back to the already
// read-only, side-effect-free GET /video/evaluation to look for
// evidence.pregate on the fact_check breakdown entry - present (with
// isEligible false) only on the pre-gate skip path per that module.
async function fetchFactCheckReport(videoId) {
  const url = `${API_BASE_URL}/video/fact-check?video_id=${encodeURIComponent(videoId)}`;
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Backend returned ${response.status}`);
  return response.json();
}

function pregateFromEvaluation(evaluation) {
  const entry = (evaluation?.breakdown ?? []).find((item) => item?.criterion === "fact_check");
  return entry?.evidence?.pregate ?? null;
}

async function getFactCheckStatus(videoId) {
  const report = await fetchFactCheckReport(videoId);
  if (report) return { stage: "complete", report };

  const evaluation = await storedEvaluation(videoId);
  const pregate = evaluation ? pregateFromEvaluation(evaluation) : null;
  if (pregate && pregate.isEligible === false) {
    return { stage: "skipped_fiction", pregate };
  }
  // Either not analyzed yet, or analyzed but the fact-check criterion has
  // nothing to show for a reason other than the pre-gate (e.g. no usable
  // LLM credentials) - the frozen FACT_CHECK_STAGES contract has no separate
  // "permanently skipped" stage, so both read as "still working".
  return { stage: "fact_checking" };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MESSAGE_TYPES.GET_FACT_CHECK) return false;

  getFactCheckStatus(message.videoId)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

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
    .then(() => lookupScore(videoId))
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

// Cold-start layer, underneath the in-memory Map above: that Map is wiped
// every time MV3 recycles this worker (~30s idle), so without this a
// revisited video would re-fetch from the network every single time. The
// persistent cache survives worker restarts, so it's checked first; a
// successful network lookup (found OR a real "not analyzed" 404) is written
// through so the next cold start is instant too.
async function lookupScore(videoId) {
  const persisted = await getCachedScore(videoId).catch(() => null);
  if (persisted !== null) return persisted.score;

  let evaluation;
  try {
    evaluation = await storedEvaluation(videoId);
  } catch {
    // Network error: same as "not analyzed" for this call, but NOT a
    // successful lookup, so it isn't written through to the persistent miss
    // cache - a transient backend outage shouldn't get pinned as a real miss.
    return null;
  }

  const score = evaluation?.score ?? null;
  const verdict = score === null ? null : (evaluation?.verdict ?? null);
  await putCachedScore(videoId, { score, verdict }).catch(() => {
    // Persistence is best-effort; the in-memory cache above still works this
    // session even if chrome.storage is unavailable or over quota.
  });
  return score;
}
