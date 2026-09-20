// Per-video AI-score cache, backed by chrome.storage.local.
//
// The service worker keeps a fast in-memory Map of scores, but MV3 kills that
// worker after ~30s idle, so a revisited video would otherwise re-fetch every
// time. This module is the durable layer underneath it: a video seen once
// stays flaggable across service-worker restarts without a network round trip.
//
// Two TTLs, because the two cases are not the same claim:
//   - a REAL score is durable. Evaluations are written offline by a dev running
//     the analyzer and don't change afterwards, so once cached it never expires.
//   - a `null` score means "not analyzed YET", which stops being true the
//     moment a dev runs the analyzer on it, so it expires after
//     SCORE_MISS_TTL_MS and is treated as an outright miss afterwards.
//
// `verdict` travels alongside `score` (never cached separately) because the
// backend recomputes the verdict at READ time - channel history is a
// read-time criterion - so caching only the number would let the overlay and
// the tile filter disagree about a video whose channel history changed since
// the score was cached.

import {
  SCORE_KEY_PREFIX,
  SCORE_MAX_RECORDS,
  SCORE_MISS_TTL_MS,
  SCORE_SCHEMA_VERSION,
  VERDICTS,
} from "./constants.js";

// Used when chrome.storage is unavailable: unit tests, and any page that loads
// this module outside an extension.
const memoryStore = new Map();

function storageArea() {
  try {
    return globalThis.chrome?.storage?.local ?? null;
  } catch {
    // Accessing chrome can throw in some sandboxed contexts.
    return null;
  }
}

export function scoreKey(videoId) {
  return `${SCORE_KEY_PREFIX}${videoId}`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidVerdict(value) {
  return value === null || Object.prototype.hasOwnProperty.call(VERDICTS, value);
}

/**
 * Throws if a record breaks an invariant, so an inconsistent one can't be
 * stored or read back. Mirrors factCheckState.js's validateRecord.
 */
function validateRecord(record) {
  if (!isPlainObject(record)) {
    throw new Error("score record must be an object");
  }
  if (record.schemaVersion !== SCORE_SCHEMA_VERSION) {
    throw new Error(`unknown score schemaVersion: ${record.schemaVersion}`);
  }
  if (record.score !== null && typeof record.score !== "number") {
    throw new Error("`score` must be a number or null");
  }
  if (!isValidVerdict(record.verdict)) {
    throw new Error(`unknown verdict: ${record.verdict}`);
  }
  if ((record.score === null) !== (record.verdict === null)) {
    throw new Error("`verdict` must be null exactly when `score` is null");
  }
}

function makeRecord(videoId, score, verdict) {
  return {
    videoId,
    score,
    verdict,
    updatedAt: new Date().toISOString(),
    schemaVersion: SCORE_SCHEMA_VERSION,
  };
}

// A real score is durable and never expires; a null (miss) record expires
// after SCORE_MISS_TTL_MS so a video that gets analyzed later isn't pinned as
// "not analyzed" for the rest of the session.
function isExpired(record) {
  if (record.score !== null) return false;
  const updatedAt = Date.parse(record.updatedAt ?? "");
  if (Number.isNaN(updatedAt)) return true; // unparsable timestamp: treat as stale
  return Date.now() - updatedAt > SCORE_MISS_TTL_MS;
}

/**
 * Coerce whatever came out of storage into a usable record, or null.
 *
 * Anything unrecognizable - a stale schemaVersion, a shape-invalid record, a
 * non-object, an expired miss - reads back as a MISS rather than reaching a
 * caller as garbage.
 */
function normalize(videoId, raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.schemaVersion !== SCORE_SCHEMA_VERSION) return null;
  try {
    validateRecord(raw);
  } catch {
    return null;
  }
  if (isExpired(raw)) return null;
  return { ...raw, videoId };
}

function toPublic(record) {
  return record ? { score: record.score, verdict: record.verdict } : null;
}

// Only our own records: get(null) would also drag every fact-check record -
// tens of KB each - through the service worker on every cached tile. getKeys
// (Chrome 130+) makes the filter free; older Chromes fall back to the full read.
async function readScoreRecords() {
  const area = storageArea();
  if (!area) return Object.fromEntries(memoryStore);
  try {
    if (typeof area.getKeys === "function") {
      const keys = (await area.getKeys()).filter((key) => key.startsWith(SCORE_KEY_PREFIX));
      return keys.length ? ((await area.get(keys)) ?? {}) : {};
    }
    return (await area.get(null)) ?? {};
  } catch {
    return {};
  }
}

export async function getCachedScore(videoId) {
  const key = scoreKey(videoId);
  const area = storageArea();
  if (!area) return toPublic(normalize(videoId, memoryStore.get(key)));
  try {
    const stored = await area.get(key);
    return toPublic(normalize(videoId, stored?.[key]));
  } catch {
    return null;
  }
}

/**
 * Batch lookup: exactly one storage read no matter how many ids are asked
 * for, so scanning a whole tile grid doesn't fan out into N reads.
 */
export async function getCachedScores(videoIds) {
  const ids = Array.from(new Set((videoIds ?? []).filter(Boolean)));
  const result = {};
  if (ids.length === 0) return result;

  const keys = ids.map(scoreKey);
  const area = storageArea();

  let raw = {};
  if (!area) {
    for (const key of keys) {
      if (memoryStore.has(key)) raw[key] = memoryStore.get(key);
    }
  } else {
    try {
      raw = (await area.get(keys)) ?? {};
    } catch {
      raw = {};
    }
  }

  for (const id of ids) {
    result[id] = toPublic(normalize(id, raw[scoreKey(id)]));
  }
  return result;
}

/**
 * Keys to drop so that at most SCORE_MAX_RECORDS survive.
 *
 * Oldest `updatedAt` goes first, and records with a missing or unparseable
 * timestamp go before any valid one. `keepKey` is never evicted - the write
 * that triggered this must survive it. Keys outside our own prefix (filter
 * state, fact-check records) are never touched.
 */
function keysToEvict(allItems, keepKey) {
  const candidates = Object.keys(allItems)
    .filter((key) => key.startsWith(SCORE_KEY_PREFIX) && key !== keepKey)
    .map((key) => {
      const parsed = Date.parse(allItems[key]?.updatedAt ?? "");
      return { key, at: Number.isNaN(parsed) ? -Infinity : parsed };
    })
    .sort((a, b) => a.at - b.at);

  // +1 because keepKey is excluded above but still occupies a slot.
  const surplus = candidates.length + 1 - SCORE_MAX_RECORDS;
  return surplus > 0 ? candidates.slice(0, surplus).map((entry) => entry.key) : [];
}

export async function putCachedScore(videoId, { score, verdict } = {}) {
  const key = scoreKey(videoId);
  const normalizedScore = score === undefined ? null : score;
  const normalizedVerdict = normalizedScore === null ? null : (verdict ?? null);
  const record = makeRecord(videoId, normalizedScore, normalizedVerdict);
  validateRecord(record);

  const area = storageArea();
  if (!area) {
    memoryStore.set(key, record);
    for (const stale of keysToEvict(Object.fromEntries(memoryStore), key)) {
      memoryStore.delete(stale);
    }
    return;
  }

  // Evict BEFORE writing, not after. Eviction exists to keep the write below
  // from hitting the 10MB quota, so running it afterwards makes it useless in
  // exactly the case it was built for: the failing write skips its own
  // eviction, so the next write fails too, and the extension is wedged until
  // someone clears storage by hand.
  try {
    const stale = keysToEvict(await readScoreRecords(), key);
    if (stale.length) await area.remove(stale);
  } catch {
    // Eviction is best-effort; a failure here must not block the write.
  }

  try {
    await area.set({ [key]: record });
  } catch (error) {
    // Don't return as if this succeeded - the caller needs to be able to tell
    // that nothing was persisted.
    throw new Error(`failed to persist score cache for ${videoId}: ${error?.message}`, {
      cause: error,
    });
  }
}

export async function clearScoreCache() {
  const area = storageArea();
  if (!area) {
    for (const key of Array.from(memoryStore.keys())) {
      if (key.startsWith(SCORE_KEY_PREFIX)) memoryStore.delete(key);
    }
    return;
  }
  try {
    const all = await readScoreRecords();
    const keys = Object.keys(all).filter((key) => key.startsWith(SCORE_KEY_PREFIX));
    if (keys.length) await area.remove(keys);
  } catch {
    // Best-effort, same as eviction above.
  }
}

/** Test-only: drop the in-memory fallback between cases. */
export function _resetMemoryStore() {
  memoryStore.clear();
}
