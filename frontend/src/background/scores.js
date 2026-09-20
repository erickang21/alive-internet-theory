import { API_BASE_URL } from "../shared/constants.js";

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

/** Records a score the auto-analyze queue just learned, so the next feed rescan marks the
 * tile straight away instead of waiting out this module's miss TTL. */
export function primeScore(videoId, score) {
  cache.set(videoId, { score, expires: Date.now() + MISS_TTL_MS });
}

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
async function fetchScore(videoId) {
  const response = await fetch(
    `${API_BASE_URL}/video/evaluation?video_id=${encodeURIComponent(videoId)}`,
    { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!response.ok) return null;
  return (await response.json()).score ?? null;
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
