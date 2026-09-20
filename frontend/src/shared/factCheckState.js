// Per-video fact-check state, backed by chrome.storage.local.
//
// The fact-check itself runs in the backend and takes minutes. The extension
// panel is closed for most of that, so nothing can rely on being messaged:
// storage is the ground truth, and the UI re-renders purely from storage
// changes. A record is NOT an archive - the full report is always re-fetchable
// from GET /video/fact-check, which is what makes the eviction below safe.

import {
  FACT_CHECK_KEY_PREFIX,
  FACT_CHECK_MAX_RECORDS,
  FACT_CHECK_SCHEMA_VERSION,
  FACT_CHECK_STAGES,
} from "./constants.js";

const DEFAULT_STAGE = "idle";

// Used when chrome.storage is unavailable: the demo harness, unit tests, and
// any page that loads the component outside an extension.
const memoryStore = new Map();

function storageArea() {
  try {
    return globalThis.chrome?.storage?.local ?? null;
  } catch {
    // Accessing chrome can throw in some sandboxed contexts.
    return null;
  }
}

export function factCheckKey(videoId) {
  return `${FACT_CHECK_KEY_PREFIX}${videoId}`;
}

export function videoIdFromKey(key) {
  return key.startsWith(FACT_CHECK_KEY_PREFIX) ? key.slice(FACT_CHECK_KEY_PREFIX.length) : null;
}

export function idleRecord(videoId) {
  return {
    videoId,
    stage: DEFAULT_STAGE,
    updatedAt: null,
    schemaVersion: FACT_CHECK_SCHEMA_VERSION,
    pregate: null,
    result: null,
    error: null,
  };
}

/** Throws if a record breaks an invariant, so an inconsistent one can't be stored. */
export function validateRecord(record) {
  if (!record || typeof record !== "object") {
    throw new Error("fact-check record must be an object");
  }
  if (!FACT_CHECK_STAGES.includes(record.stage)) {
    throw new Error(`unknown fact-check stage: ${record.stage}`);
  }
  const hasResult = record.result !== null && record.result !== undefined;
  const hasError = record.error !== null && record.error !== undefined;

  if (hasResult !== (record.stage === "complete")) {
    throw new Error("`result` must be set exactly when stage is 'complete'");
  }
  if (hasError !== (record.stage === "failed")) {
    throw new Error("`error` must be set exactly when stage is 'failed'");
  }
  if (record.stage === "skipped_fiction" && record.pregate?.isEligible !== false) {
    throw new Error("'skipped_fiction' requires a pregate with isEligible false");
  }
}

/**
 * Coerce whatever came out of storage into a record the UI can render.
 *
 * Anything unrecognizable - a stale schemaVersion, a stage we've never heard
 * of, a non-object - reads back as a fresh idle record rather than reaching
 * the UI as garbage.
 */
function normalize(videoId, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return idleRecord(videoId);
  if (raw.schemaVersion !== FACT_CHECK_SCHEMA_VERSION) return idleRecord(videoId);
  if (!FACT_CHECK_STAGES.includes(raw.stage)) return idleRecord(videoId);

  const record = {
    ...idleRecord(videoId),
    ...raw,
    videoId,
    schemaVersion: FACT_CHECK_SCHEMA_VERSION,
  };
  try {
    validateRecord(record);
  } catch {
    return idleRecord(videoId);
  }
  return record;
}

async function readAll() {
  const area = storageArea();
  if (!area) return Object.fromEntries(memoryStore);
  try {
    return (await area.get(null)) ?? {};
  } catch {
    return {};
  }
}

export async function getFactCheckState(videoId) {
  const key = factCheckKey(videoId);
  const area = storageArea();
  if (!area) return normalize(videoId, memoryStore.get(key));
  try {
    const stored = await area.get(key);
    return normalize(videoId, stored?.[key]);
  } catch {
    return idleRecord(videoId);
  }
}

/**
 * Keys to drop so that at most FACT_CHECK_MAX_RECORDS survive.
 *
 * Oldest `updatedAt` goes first, and records with a missing or unparseable
 * timestamp go before any valid one. `keepKey` is never evicted - the write
 * that triggered this must survive it.
 */
function keysToEvict(allItems, keepKey) {
  const candidates = Object.keys(allItems)
    .filter((key) => key.startsWith(FACT_CHECK_KEY_PREFIX) && key !== keepKey)
    .map((key) => {
      const parsed = Date.parse(allItems[key]?.updatedAt ?? "");
      return { key, at: Number.isNaN(parsed) ? -Infinity : parsed };
    })
    .sort((a, b) => a.at - b.at);

  // +1 because keepKey is excluded above but still occupies a slot.
  const surplus = candidates.length + 1 - FACT_CHECK_MAX_RECORDS;
  return surplus > 0 ? candidates.slice(0, surplus).map((entry) => entry.key) : [];
}

export async function setFactCheckState(videoId, patch) {
  const key = factCheckKey(videoId);
  const current = await getFactCheckState(videoId);
  const next = {
    ...current,
    ...patch,
    videoId,
    schemaVersion: FACT_CHECK_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
  };

  // A stage change invalidates whichever terminal payload no longer applies,
  // so a caller doesn't have to remember to null it out by hand.
  if (next.stage !== "complete") next.result = null;
  if (next.stage !== "failed") next.error = null;

  validateRecord(next);

  const area = storageArea();
  if (!area) {
    memoryStore.set(key, next);
    for (const stale of keysToEvict(Object.fromEntries(memoryStore), key)) {
      memoryStore.delete(stale);
    }
    return next;
  }

  try {
    await area.set({ [key]: next });
    const stale = keysToEvict(await readAll(), key);
    if (stale.length) await area.remove(stale);
  } catch {
    // A failed write must not take the caller down; the UI will just keep
    // showing the previous stage until the next update lands.
  }
  return next;
}

export async function clearFactCheckState(videoId) {
  const key = factCheckKey(videoId);
  const area = storageArea();
  if (!area) {
    memoryStore.delete(key);
    return;
  }
  try {
    await area.remove(key);
  } catch {
    // nothing to do
  }
}

function addChangeListener(handler) {
  const onChanged = globalThis.chrome?.storage?.onChanged;
  if (!onChanged?.addListener) return () => {};

  onChanged.addListener(handler);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    onChanged.removeListener?.(handler);
  };
}

export function subscribeAllFactChecks(callback) {
  return addChangeListener((changes, areaName) => {
    if (areaName !== "local") return;
    for (const [key, change] of Object.entries(changes ?? {})) {
      const videoId = videoIdFromKey(key);
      if (videoId === null) continue;
      callback(videoId, normalize(videoId, change?.newValue));
    }
  });
}

export function subscribeFactCheckState(videoId, callback) {
  const key = factCheckKey(videoId);
  return addChangeListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes || !(key in changes)) return;
    callback(normalize(videoId, changes[key]?.newValue));
  });
}

/** Test-only: drop the in-memory fallback between cases. */
export function _resetMemoryStore() {
  memoryStore.clear();
}
