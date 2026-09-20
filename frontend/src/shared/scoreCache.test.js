// No network, no real chrome. A fake chrome.storage is installed per test and
// removed afterwards so nothing leaks between cases.

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { SCORE_MAX_RECORDS, SCORE_MISS_TTL_MS, SCORE_SCHEMA_VERSION } from "./constants.js";
import {
  _resetMemoryStore,
  clearScoreCache,
  getCachedScore,
  getCachedScores,
  putCachedScore,
  scoreKey,
} from "./scoreCache.js";

let store;
let listeners;
let getCallCount;

function installChrome() {
  store = {};
  listeners = [];
  getCallCount = 0;
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => {
          getCallCount += 1;
          if (key === null || key === undefined) return { ...store };
          if (Array.isArray(key)) {
            const result = {};
            for (const k of key) if (k in store) result[k] = store[k];
            return result;
          }
          return key in store ? { [key]: store[key] } : {};
        },
        set: async (items) => {
          const changes = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = v;
          }
          listeners.forEach((l) => l(changes, "local"));
        },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const k of list) {
            changes[k] = { oldValue: store[k], newValue: undefined };
            delete store[k];
          }
          listeners.forEach((l) => l(changes, "local"));
        },
      },
      onChanged: {
        addListener: (l) => listeners.push(l),
        removeListener: (l) => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },
  };
}

beforeEach(() => {
  installChrome();
  _resetMemoryStore();
});

afterEach(() => {
  delete globalThis.chrome;
  _resetMemoryStore();
});

function rawRecord(videoId, overrides) {
  return {
    videoId,
    score: 32.5,
    verdict: "ai_slop",
    updatedAt: new Date().toISOString(),
    schemaVersion: SCORE_SCHEMA_VERSION,
    ...overrides,
  };
}

// --- basics ------------------------------------------------------------------

test("scoreKey prefixes the video id", () => {
  assert.equal(scoreKey("abc123"), "aitScore:abc123");
});

test("a missing key reads back as a miss", async () => {
  assert.equal(await getCachedScore("v1"), null);
});

test("put then get round-trips and stamps updatedAt + schemaVersion", async () => {
  await putCachedScore("v1", { score: 32.5, verdict: "ai_slop" });

  const stored = store[scoreKey("v1")];
  assert.equal(stored.schemaVersion, SCORE_SCHEMA_VERSION);
  assert.ok(Date.parse(stored.updatedAt) > 0);
  assert.equal(stored.videoId, "v1");

  const record = await getCachedScore("v1");
  assert.deepEqual(record, { score: 32.5, verdict: "ai_slop" });
});

test("clearScoreCache removes every aitScore record", async () => {
  await putCachedScore("v1", { score: 10, verdict: "ai_slop" });
  await putCachedScore("v2", { score: null, verdict: null });
  store.aitFilterState = "block";

  await clearScoreCache();

  assert.equal(await getCachedScore("v1"), null);
  assert.equal(await getCachedScore("v2"), null);
  assert.equal(store.aitFilterState, "block");
});

// --- the two TTLs --------------------------------------------------------------

test("a real score does not expire, even long past the miss TTL", async () => {
  const ancient = new Date(Date.now() - SCORE_MISS_TTL_MS * 100).toISOString();
  store[scoreKey("v1")] = rawRecord("v1", {
    score: 91,
    verdict: "likely_human",
    updatedAt: ancient,
  });

  const record = await getCachedScore("v1");
  assert.deepEqual(record, { score: 91, verdict: "likely_human" });
});

test("a null score is a hit while inside the miss TTL", async () => {
  store[scoreKey("v1")] = rawRecord("v1", {
    score: null,
    verdict: null,
    updatedAt: new Date(Date.now() - (SCORE_MISS_TTL_MS - 1000)).toISOString(),
  });

  assert.deepEqual(await getCachedScore("v1"), { score: null, verdict: null });
});

test("a null score expires after SCORE_MISS_TTL_MS and reads back as a miss", async () => {
  store[scoreKey("v1")] = rawRecord("v1", {
    score: null,
    verdict: null,
    updatedAt: new Date(Date.now() - (SCORE_MISS_TTL_MS + 1000)).toISOString(),
  });

  assert.equal(await getCachedScore("v1"), null);
});

// --- write-side invariants -----------------------------------------------------

test("a verdict is forced to null when the score is null", async () => {
  await putCachedScore("v1", { score: null, verdict: "ai_slop" });
  assert.deepEqual(await getCachedScore("v1"), { score: null, verdict: null });
});

test("a real score with no verdict is rejected rather than guessing one", async () => {
  await assert.rejects(() => putCachedScore("v1", { score: 42 }));
});

test("an unknown verdict string is rejected", async () => {
  await assert.rejects(() => putCachedScore("v1", { score: 42, verdict: "banana" }));
});

// --- garbage never reaches a caller ---------------------------------------------

for (const [label, value] of [
  [
    "a garbage shape",
    { score: "not a number", verdict: null, schemaVersion: SCORE_SCHEMA_VERSION },
  ],
  ["a stale schemaVersion", { score: 50, verdict: "likely_human", schemaVersion: 0 }],
  ["a non-object", "just a string"],
  ["an array", [1, 2, 3]],
  ["null", null],
  [
    "an inconsistent score/verdict pairing",
    {
      score: 50,
      verdict: null,
      schemaVersion: SCORE_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
    },
  ],
]) {
  test(`${label} reads back as a miss`, async () => {
    store[scoreKey("v1")] = value;
    assert.equal(await getCachedScore("v1"), null);
  });
}

// --- batch lookup ----------------------------------------------------------------

test("getCachedScores does one storage read for N ids and returns null for absent ones", async () => {
  await putCachedScore("v1", { score: 10, verdict: "ai_slop" });
  await putCachedScore("v2", { score: 90, verdict: "likely_human" });
  getCallCount = 0; // reset after the setup writes' own reads (eviction check)

  const result = await getCachedScores(["v1", "v2", "v3"]);

  assert.equal(getCallCount, 1);
  assert.deepEqual(result, {
    v1: { score: 10, verdict: "ai_slop" },
    v2: { score: 90, verdict: "likely_human" },
    v3: null,
  });
});

test("getCachedScores with an empty list touches storage zero times", async () => {
  const result = await getCachedScores([]);
  assert.deepEqual(result, {});
  assert.equal(getCallCount, 0);
});

// --- LRU eviction ------------------------------------------------------------

test("eviction keeps exactly the cap, dropping the oldest first, and the newest write survives", async () => {
  const overflow = 5;
  for (let i = 0; i < SCORE_MAX_RECORDS + overflow; i++) {
    store[scoreKey(`v${i}`)] = rawRecord(`v${i}`, {
      updatedAt: new Date(1000 + i * 1000).toISOString(),
    });
  }

  await putCachedScore("newest", { score: 5, verdict: "ai_slop" });

  const keys = Object.keys(store);
  assert.equal(keys.length, SCORE_MAX_RECORDS);
  for (let i = 0; i < overflow; i++) {
    assert.ok(!keys.includes(scoreKey(`v${i}`)), `v${i} should have been evicted`);
  }
  assert.ok(keys.includes(scoreKey("newest")));
});

test("eviction ignores keys belonging to other features", async () => {
  store.aitFilterState = "block";
  store["aitFactCheck:x"] = { some: "record" };
  for (let i = 0; i < SCORE_MAX_RECORDS + 3; i++) {
    store[scoreKey(`v${i}`)] = rawRecord(`v${i}`, {
      updatedAt: new Date(1000 + i * 1000).toISOString(),
    });
  }

  await putCachedScore("newest", { score: 5, verdict: "ai_slop" });

  assert.equal(store.aitFilterState, "block");
  assert.deepEqual(store["aitFactCheck:x"], { some: "record" });
});

test("eviction reads only score keys when getKeys exists, never the whole store", async () => {
  const requestedKeys = [];
  globalThis.chrome.storage.local.getKeys = async () => Object.keys(store);
  const realGet = globalThis.chrome.storage.local.get;
  globalThis.chrome.storage.local.get = async (key) => {
    requestedKeys.push(key);
    return realGet(key);
  };
  store["aitFactCheck:fat"] = { some: "record" };
  for (let i = 0; i < SCORE_MAX_RECORDS + 3; i++) {
    store[scoreKey(`v${i}`)] = rawRecord(`v${i}`, {
      updatedAt: new Date(1000 + i * 1000).toISOString(),
    });
  }

  await putCachedScore("newest", { score: 5, verdict: "ai_slop" });

  assert.ok(!requestedKeys.includes(null), "get(null) must not run when getKeys exists");
  for (const key of requestedKeys.filter(Array.isArray).flat()) {
    assert.ok(key.startsWith("aitScore:"), `fetched a foreign key: ${key}`);
  }
  assert.equal(
    Object.keys(store).filter((key) => key.startsWith("aitScore:")).length,
    SCORE_MAX_RECORDS,
  );
  assert.deepEqual(store["aitFactCheck:fat"], { some: "record" });
});

test("eviction runs before the write, so a full store can still be written to", async () => {
  for (let i = 0; i < SCORE_MAX_RECORDS + 3; i++) {
    store[scoreKey(`v${i}`)] = rawRecord(`v${i}`, {
      updatedAt: new Date(1000 + i * 1000).toISOString(),
    });
  }

  const order = [];
  const realRemove = globalThis.chrome.storage.local.remove;
  globalThis.chrome.storage.local.remove = async (keys) => {
    order.push("remove");
    return realRemove(keys);
  };
  const realSet = globalThis.chrome.storage.local.set;
  globalThis.chrome.storage.local.set = async (items) => {
    order.push("set");
    return realSet(items);
  };

  await putCachedScore("newest", { score: 5, verdict: "ai_slop" });

  assert.deepEqual(order, ["remove", "set"], "eviction must precede the write");
  assert.ok(scoreKey("newest") in store);
});

// --- a failed write must not look like a success -----------------------------

test("a rejected set() rejects rather than returning fake success", async () => {
  globalThis.chrome.storage.local.set = async () => {
    throw new Error("QUOTA_BYTES quota exceeded");
  };
  await assert.rejects(
    () => putCachedScore("v1", { score: 10, verdict: "ai_slop" }),
    /failed to persist/,
  );
});

// --- no chrome at all --------------------------------------------------------

test("everything still works with chrome undefined", async () => {
  delete globalThis.chrome;

  assert.equal(await getCachedScore("v1"), null);
  await putCachedScore("v1", { score: 77, verdict: "likely_human" });
  assert.deepEqual(await getCachedScore("v1"), { score: 77, verdict: "likely_human" });
  assert.deepEqual(await getCachedScores(["v1", "v2"]), {
    v1: { score: 77, verdict: "likely_human" },
    v2: null,
  });
  await clearScoreCache();
  assert.equal(await getCachedScore("v1"), null);
});

test("the in-memory fallback also evicts", async () => {
  delete globalThis.chrome;
  for (let i = 0; i < SCORE_MAX_RECORDS + 4; i++) {
    await putCachedScore(`v${i}`, { score: i, verdict: "ai_slop" });
  }
  assert.deepEqual(await getCachedScore(`v${SCORE_MAX_RECORDS + 3}`), {
    score: SCORE_MAX_RECORDS + 3,
    verdict: "ai_slop",
  });
  assert.equal(await getCachedScore("v0"), null);
});
