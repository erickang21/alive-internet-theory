import { API_BASE_URL } from "../shared/constants.js";
import { getCachedScore, putCachedScore } from "../shared/scoreCache.js";

const MAX_CONCURRENT_LOOKUPS = 4;
const MISS_TTL_MS = 60_000;
// Without this a hung request keeps its slot for good, and four of them deadlock the
// queue for the rest of the session.
const REQUEST_TIMEOUT_MS = 10_000;

// A stored score never changes under us, but a video that isn't analyzed yet can be
// minutes later, so only misses expire.
const cache = new Map();
const inFlight = new Map();
const waiting = [];
let active = 0;

export async function getScores({ videoIds }) {
  const ids = [...new Set((Array.isArray(videoIds) ? videoIds : []).filter(Boolean))];
  const scores = await Promise.all(ids.map(scoreFor));
  return Object.fromEntries(ids.map((id, index) => [id, scores[index]]));
}

function scoreFor(videoId) {
  const cached = cache.get(videoId);
  if (cached && (cached.score !== null || Date.now() < cached.expires)) {
    return Promise.resolve(cached.score);
  }
  if (!inFlight.has(videoId)) {
    const lookup = acquire()
      .then(() => fetchScore(videoId))
      .catch(() => null)
      .then((score) => {
        cache.set(videoId, { score, expires: Date.now() + MISS_TTL_MS });
        inFlight.delete(videoId);
        release();
        return score;
      });
    inFlight.set(videoId, lookup);
  }
  return inFlight.get(videoId);
}

// GET, not POST: browsing a feed must never queue its tiles for indexing.
//
// The in-memory Map above is wiped whenever MV3 recycles this worker (~30s
// idle), so a persistent chrome.storage layer sits underneath it: checked
// before the network, written through after a successful lookup (a found
// score, or a real "not analyzed" 404 with its own short TTL). Server errors
// and network failures are NOT written through - a transient outage shouldn't
// get pinned as a real miss - and persistence itself is best-effort, so the
// in-memory cache still works this session if chrome.storage is unavailable.
async function fetchScore(videoId) {
  const persisted = await getCachedScore(videoId).catch(() => null);
  if (persisted !== null) return persisted.score;

  const response = await fetch(
    `${API_BASE_URL}/video/evaluation?video_id=${encodeURIComponent(videoId)}`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (response.status === 404) {
    await putCachedScore(videoId, { score: null, verdict: null }).catch(() => {});
    return null;
  }
  if (!response.ok) return null;

  const evaluation = await response.json();
  const score = evaluation.score ?? null;
  const verdict = score === null ? null : (evaluation.verdict ?? null);
  await putCachedScore(videoId, { score, verdict }).catch(() => {});
  return score;
}

function acquire() {
  if (active < MAX_CONCURRENT_LOOKUPS) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active -= 1;
}
