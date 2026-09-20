// No network, no real chrome. A fake chrome.storage is installed per test and
// removed afterwards so nothing leaks between cases.

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { FACT_CHECK_MAX_RECORDS, FACT_CHECK_SCHEMA_VERSION } from "./constants.js";
import {
  _resetMemoryStore,
  clearFactCheckState,
  factCheckKey,
  getFactCheckState,
  idleRecord,
  setFactCheckState,
  subscribeAllFactChecks,
  subscribeFactCheckState,
  validateRecord,
} from "./factCheckState.js";

let store;
let listeners;

function installChrome() {
  store = {};
  listeners = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => {
          if (key === null || key === undefined) return { ...store };
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

const RESULT = {
  validityScore: 72.5,
  rating: "Mostly Reliable",
  lowConfidence: false,
  claimCount: 12,
  verifiableCount: 9,
  countsByStatus: {},
  verdicts: [],
};
const PREGATE_SKIP = {
  isEligible: false,
  category: "gaming",
  reason: "Gameplay.",
  source: "category",
};

// --- basics ------------------------------------------------------------------

test("a missing key reads back as a valid idle record", async () => {
  const record = await getFactCheckState("v1");
  assert.equal(record.stage, "idle");
  assert.equal(record.videoId, "v1");
  assert.equal(record.result, null);
  assert.equal(record.error, null);
});

test("set then get round-trips and stamps updatedAt + schemaVersion", async () => {
  await setFactCheckState("v1", { stage: "fact_checking" });
  const record = await getFactCheckState("v1");
  assert.equal(record.stage, "fact_checking");
  assert.equal(record.schemaVersion, FACT_CHECK_SCHEMA_VERSION);
  assert.ok(Date.parse(record.updatedAt) > 0);
});

test("a partial patch merges, so pregate survives a stage transition", async () => {
  const pregate = { isEligible: true, category: "educational", reason: "r", source: "llm" };
  await setFactCheckState("v1", { stage: "checking_eligibility", pregate });
  await setFactCheckState("v1", { stage: "fact_checking" });
  const record = await getFactCheckState("v1");
  assert.deepEqual(record.pregate, pregate);
  assert.equal(record.stage, "fact_checking");
});

test("moving off complete clears result, and off failed clears error", async () => {
  await setFactCheckState("v1", { stage: "complete", result: RESULT });
  await setFactCheckState("v1", { stage: "fact_checking" });
  assert.equal((await getFactCheckState("v1")).result, null);

  await setFactCheckState("v2", { stage: "failed", error: { message: "x", retryable: true } });
  await setFactCheckState("v2", { stage: "checking_eligibility" });
  assert.equal((await getFactCheckState("v2")).error, null);
});

test("clearFactCheckState removes the record", async () => {
  await setFactCheckState("v1", { stage: "fact_checking" });
  await clearFactCheckState("v1");
  assert.equal((await getFactCheckState("v1")).stage, "idle");
});

// --- invariants --------------------------------------------------------------

test("complete without a result is rejected", () => {
  assert.throws(() => validateRecord({ ...idleRecord("v"), stage: "complete" }), /result/);
});

test("failed without an error is rejected", () => {
  assert.throws(() => validateRecord({ ...idleRecord("v"), stage: "failed" }), /error/);
});

test("a result on a non-complete stage is rejected", () => {
  assert.throws(
    () => validateRecord({ ...idleRecord("v"), stage: "fact_checking", result: RESULT }),
    /result/,
  );
});

test("skipped_fiction requires a pregate that actually says ineligible", () => {
  assert.throws(
    () => validateRecord({ ...idleRecord("v"), stage: "skipped_fiction" }),
    /skipped_fiction/,
  );
  assert.throws(
    () =>
      validateRecord({
        ...idleRecord("v"),
        stage: "skipped_fiction",
        pregate: { isEligible: true },
      }),
    /skipped_fiction/,
  );
  validateRecord({ ...idleRecord("v"), stage: "skipped_fiction", pregate: PREGATE_SKIP });
});

test("an unknown stage is rejected", () => {
  assert.throws(() => validateRecord({ ...idleRecord("v"), stage: "banana" }), /stage/);
});

// --- garbage never reaches the UI -------------------------------------------

for (const [label, value] of [
  ["a garbage stage", { stage: "banana", schemaVersion: FACT_CHECK_SCHEMA_VERSION }],
  ["a stale schemaVersion", { stage: "complete", schemaVersion: 0, result: RESULT }],
  ["a non-object", "just a string"],
  ["an array", [1, 2, 3]],
  ["null", null],
]) {
  test(`${label} reads back as idle`, async () => {
    store[factCheckKey("v1")] = value;
    assert.equal((await getFactCheckState("v1")).stage, "idle");
  });
}

// --- LRU eviction ------------------------------------------------------------

test("eviction keeps exactly the cap, dropping the oldest first", async () => {
  const overflow = 5;
  for (let i = 0; i < FACT_CHECK_MAX_RECORDS + overflow; i++) {
    // Write timestamps directly so ordering is deterministic rather than
    // depending on how fast the loop runs.
    store[factCheckKey(`v${i}`)] = {
      ...idleRecord(`v${i}`),
      stage: "fact_checking",
      updatedAt: new Date(1000 + i * 1000).toISOString(),
    };
  }
  await setFactCheckState("newest", { stage: "fact_checking" });

  const keys = Object.keys(store);
  assert.equal(keys.length, FACT_CHECK_MAX_RECORDS);
  // The `overflow` oldest are gone...
  for (let i = 0; i < overflow; i++) {
    assert.ok(!keys.includes(factCheckKey(`v${i}`)), `v${i} should have been evicted`);
  }
  // ...and the write that triggered eviction survived it.
  assert.ok(keys.includes(factCheckKey("newest")));
});

test("records with a missing updatedAt are evicted before valid ones", async () => {
  store[factCheckKey("broken")] = { ...idleRecord("broken"), stage: "fact_checking" };
  for (let i = 0; i < FACT_CHECK_MAX_RECORDS - 1; i++) {
    store[factCheckKey(`v${i}`)] = {
      ...idleRecord(`v${i}`),
      stage: "fact_checking",
      updatedAt: new Date(1000 + i * 1000).toISOString(),
    };
  }
  await setFactCheckState("newest", { stage: "fact_checking" });

  assert.ok(!(factCheckKey("broken") in store), "the timestamp-less record should go first");
  assert.ok(factCheckKey("newest") in store);
});

test("eviction ignores keys belonging to other features", async () => {
  store.aitFilterState = "block";
  for (let i = 0; i < FACT_CHECK_MAX_RECORDS + 3; i++) {
    store[factCheckKey(`v${i}`)] = {
      ...idleRecord(`v${i}`),
      stage: "fact_checking",
      updatedAt: new Date(1000 + i * 1000).toISOString(),
    };
  }
  await setFactCheckState("newest", { stage: "fact_checking" });
  assert.equal(store.aitFilterState, "block");
});

// --- subscriptions -----------------------------------------------------------

test("subscribeFactCheckState fires only for its own video", async () => {
  const seen = [];
  const unsub = subscribeFactCheckState("v1", (r) => seen.push(r.stage));
  await setFactCheckState("v1", { stage: "fact_checking" });
  await setFactCheckState("v2", { stage: "fact_checking" });
  assert.deepEqual(seen, ["fact_checking"]);
  unsub();
});

test("subscriptions ignore unrelated keys and non-local areas", async () => {
  const seen = [];
  const unsub = subscribeAllFactChecks((id) => seen.push(id));
  await globalThis.chrome.storage.local.set({ aitFilterState: "flag" });
  listeners.forEach((l) => l({ [factCheckKey("v1")]: { newValue: {} } }, "sync"));
  assert.deepEqual(seen, []);
  unsub();
});

test("subscribeAllFactChecks reports the videoId and record", async () => {
  const seen = [];
  const unsub = subscribeAllFactChecks((id, record) => seen.push([id, record.stage]));
  await setFactCheckState("v9", { stage: "checking_eligibility" });
  assert.deepEqual(seen, [["v9", "checking_eligibility"]]);
  unsub();
});

test("unsubscribe stops delivery and is safe to call twice", async () => {
  const seen = [];
  const unsub = subscribeFactCheckState("v1", (r) => seen.push(r.stage));
  unsub();
  unsub();
  await setFactCheckState("v1", { stage: "fact_checking" });
  assert.deepEqual(seen, []);
});

// --- no chrome at all --------------------------------------------------------

test("everything still works with chrome undefined", async () => {
  delete globalThis.chrome;
  assert.equal((await getFactCheckState("v1")).stage, "idle");
  await setFactCheckState("v1", { stage: "complete", result: RESULT });
  assert.equal((await getFactCheckState("v1")).stage, "complete");
  const unsub = subscribeFactCheckState("v1", () => {});
  assert.equal(typeof unsub, "function");
  unsub();
  await clearFactCheckState("v1");
  assert.equal((await getFactCheckState("v1")).stage, "idle");
});

test("the in-memory fallback also evicts", async () => {
  delete globalThis.chrome;
  for (let i = 0; i < FACT_CHECK_MAX_RECORDS + 4; i++) {
    await setFactCheckState(`v${i}`, { stage: "fact_checking" });
  }
  assert.equal((await getFactCheckState(`v${FACT_CHECK_MAX_RECORDS + 3}`)).stage, "fact_checking");
  assert.equal((await getFactCheckState("v0")).stage, "idle");
});

// --- a failed write must not look like a success -----------------------------
// Eviction exists to stop the write below hitting the 10MB quota. Running it
// AFTER the write made it useless in exactly that case: the failing write
// skipped its own eviction, so every later write failed too and the extension
// was wedged until storage was cleared by hand.

test("a rejected set() surfaces instead of returning a fake-success record", async () => {
  globalThis.chrome.storage.local.set = async () => {
    throw new Error("QUOTA_BYTES quota exceeded");
  };
  await assert.rejects(
    () => setFactCheckState("v1", { stage: "fact_checking" }),
    /failed to persist/,
  );
});

test("eviction runs before the write, so a full store can still be written to", async () => {
  for (let i = 0; i < FACT_CHECK_MAX_RECORDS + 3; i++) {
    store[factCheckKey(`v${i}`)] = {
      ...idleRecord(`v${i}`),
      stage: "fact_checking",
      updatedAt: new Date(1000 + i * 1000).toISOString(),
    };
  }
  const removed = [];
  const realRemove = globalThis.chrome.storage.local.remove;
  const order = [];
  globalThis.chrome.storage.local.remove = async (keys) => {
    order.push("remove");
    removed.push(...(Array.isArray(keys) ? keys : [keys]));
    return realRemove(keys);
  };
  const realSet = globalThis.chrome.storage.local.set;
  globalThis.chrome.storage.local.set = async (items) => {
    order.push("set");
    return realSet(items);
  };

  await setFactCheckState("newest", { stage: "fact_checking" });
  assert.deepEqual(order, ["remove", "set"], "eviction must precede the write");
  assert.ok(removed.length > 0);
  assert.ok(factCheckKey("newest") in store);
});

// --- shape, not just presence ------------------------------------------------

for (const [label, record] of [
  ["a string result", { stage: "complete", result: "oops a string" }],
  ["an array result", { stage: "complete", result: [1, 2] }],
  ["non-array verdicts", { stage: "complete", result: { verdicts: "nope" } }],
  ["a string error", { stage: "failed", error: "just a string" }],
  ["an error with no message", { stage: "failed", error: { retryable: true } }],
  ["an array pregate", { stage: "fact_checking", pregate: [1, 2, 3] }],
  ["a pregate without isEligible", { stage: "fact_checking", pregate: { category: "news" } }],
]) {
  test(`validateRecord rejects ${label}`, () => {
    assert.throws(() => validateRecord({ ...idleRecord("v"), ...record }));
  });
}

test("a shape-invalid record cannot be persisted", async () => {
  await assert.rejects(() => setFactCheckState("v1", { stage: "complete", result: "garbage" }));
  assert.equal((await getFactCheckState("v1")).stage, "idle");
});
