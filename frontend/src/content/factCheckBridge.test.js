// No network, no real chrome. `chrome.runtime.sendMessage` is a hand-rolled
// stub whose response depends on a call counter, and node:test's built-in
// timer mocking (mock.timers) drives the poll loop without real waits.

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";

import { FACT_CHECK_SCHEMA_VERSION } from "../shared/constants.js";
import { _resetMemoryStore, getFactCheckState, validateRecord } from "../shared/factCheckState.js";
import {
  MAX_CONSECUTIVE_FAILURES,
  createFactCheckBridge,
  mapReportToResult,
  stagePatchFromResponse,
} from "./factCheckBridge.js";

let store;
let listeners;
let sendMessageImpl;

function installChrome() {
  store = {};
  listeners = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => {
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
    runtime: {
      sendMessage: async (message) => sendMessageImpl(message),
    },
  };
}

beforeEach(() => {
  installChrome();
  _resetMemoryStore();
  sendMessageImpl = async () => ({ ok: true, stage: "fact_checking" });
});

afterEach(() => {
  delete globalThis.chrome;
  _resetMemoryStore();
  mock.timers.reset();
  mock.reset();
});

// Drains every pending microtask. The bridge's tick() is a deep async chain
// (sendMessage -> setFactCheckState -> getFactCheckState -> chrome.storage
// get/set), all real Promises even under mock.timers (which only fakes the
// clock, not the microtask queue), so a bare `await Promise.resolve()` a
// fixed number of times is fragile against how deep that chain happens to be.
// setImmediate's callback is only invoked once Node's microtask queue is
// completely empty, so one round-trip through it is sufficient regardless of
// chain depth - two, for safety against a tick that itself schedules another
// microtask-only continuation right at the boundary.
async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function advance(ms) {
  mock.timers.tick(ms);
  await flushMicrotasks();
}

const FAST = { intervalMs: 1000, jitterMs: 0 };

// --- mapReportToResult -------------------------------------------------------------

test("mapReportToResult maps snake_case ValidityReport fields to the camelCase card contract", () => {
  const report = {
    validity_score: 72.5,
    rating: "Mostly Reliable",
    low_confidence: false,
    claim_count: 2,
    verifiable_count: 2,
    counts_by_status: { verified_true: 1, false: 1 },
    verdicts: [
      {
        claim: { id: "c1", text: "A true claim.", timestamp_s: 10 },
        status: "verified_true",
        debunk: null,
        citations: [],
      },
      {
        claim: { id: "c2", text: "A false claim.", timestamp_s: 95 },
        status: "false",
        debunk: "Independent sources contradict this.",
        citations: [
          { title: "Example", domain: "example.com", url: "https://example.com/a", quote: "q" },
        ],
      },
    ],
  };

  const result = mapReportToResult(report);
  assert.equal(result.validityScore, 72.5);
  assert.equal(result.rating, "Mostly Reliable");
  assert.equal(result.lowConfidence, false);
  assert.equal(result.claimCount, 2);
  assert.equal(result.verifiableCount, 2);
  assert.deepEqual(result.countsByStatus, { verified_true: 1, false: 1 });
  assert.equal(result.verdicts.length, 2);
  assert.deepEqual(result.verdicts[1], {
    claimId: "c2",
    claimText: "A false claim.",
    timestampS: 95,
    status: "false",
    debunk: "Independent sources contradict this.",
    citations: [
      { title: "Example", domain: "example.com", url: "https://example.com/a", quote: "q" },
    ],
  });
});

test("mapReportToResult tolerates a missing/malformed report rather than throwing", () => {
  assert.doesNotThrow(() => mapReportToResult(null));
  assert.doesNotThrow(() => mapReportToResult({}));
  const result = mapReportToResult({});
  assert.equal(result.validityScore, null);
  assert.deepEqual(result.verdicts, []);
});

// --- stagePatchFromResponse (the stage mapping table) -------------------------------

test("a report present maps to complete with the mapped result", () => {
  const patch = stagePatchFromResponse({
    ok: true,
    stage: "complete",
    report: { validity_score: 50, rating: "Mixed", verdicts: [] },
  });
  assert.equal(patch.stage, "complete");
  assert.equal(patch.result.validityScore, 50);
  assert.equal(patch.pregate, null);
});

test("a pregate-ineligible evaluation maps to skipped_fiction with that pregate", () => {
  const pregate = {
    isEligible: false,
    category: "gaming",
    reason: "This video is gameplay commentary.",
    source: "category",
  };
  const patch = stagePatchFromResponse({ ok: true, stage: "skipped_fiction", pregate });
  assert.equal(patch.stage, "skipped_fiction");
  assert.deepEqual(patch.pregate, pregate);
});

test("no stored report and no pregate skip maps to fact_checking", () => {
  const patch = stagePatchFromResponse({ ok: true, stage: "fact_checking" });
  assert.equal(patch.stage, "fact_checking");
  assert.equal(patch.pregate, null);
  assert.equal(patch.result, null);
});

test("an unavailable check maps to failed with the backend's own wording", () => {
  const patch = stagePatchFromResponse({
    ok: true,
    stage: "failed",
    detail: "Skipped: no usable fact-check LLM credentials.",
  });
  assert.equal(patch.stage, "failed");
  assert.equal(patch.error.message, "Skipped: no usable fact-check LLM credentials.");
  assert.equal(patch.error.retryable, true);
  assert.equal(patch.pregate, null);
});

test("an unavailable check with no detail still gets an honest message", () => {
  const patch = stagePatchFromResponse({ ok: true, stage: "failed", detail: null });
  assert.equal(patch.stage, "failed");
  assert.ok(patch.error.message.length > 0);
});

// --- the bridge: end-to-end polling behaviour ---------------------------------------

test("still-checking keeps polling on the interval and writes fact_checking each time", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  sendMessageImpl = async () => {
    calls += 1;
    return { ok: true, stage: "fact_checking" };
  };

  const bridge = createFactCheckBridge(FAST);
  bridge.start("v1");
  await flushMicrotasks();
  assert.equal(calls, 1);

  const record1 = await getFactCheckState("v1");
  assert.equal(record1.stage, "fact_checking");
  validateRecord(record1);

  await advance(1000);
  assert.equal(calls, 2);

  await advance(1000);
  assert.equal(calls, 3);

  bridge.stop();
});

test("a report arriving stops polling at complete", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  sendMessageImpl = async () => {
    calls += 1;
    if (calls === 1) return { ok: true, stage: "fact_checking" };
    return {
      ok: true,
      stage: "complete",
      report: { validity_score: 80, rating: "OK", verdicts: [] },
    };
  };

  const bridge = createFactCheckBridge(FAST);
  bridge.start("v1");
  await flushMicrotasks();
  assert.equal((await getFactCheckState("v1")).stage, "fact_checking");

  await advance(1000);
  assert.equal(calls, 2);
  const record = await getFactCheckState("v1");
  assert.equal(record.stage, "complete");
  assert.equal(record.result.validityScore, 80);
  validateRecord(record);

  // Terminal - no further ticks scheduled, however long we wait.
  await advance(1000);
  await advance(1000);
  assert.equal(calls, 2, "polling must stop once complete is reached");
});

test("a pregate skip stops polling at skipped_fiction", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const pregate = {
    isEligible: false,
    category: "gaming",
    reason: "Not factual.",
    source: "category",
  };
  sendMessageImpl = async () => {
    calls += 1;
    return { ok: true, stage: "skipped_fiction", pregate };
  };

  const bridge = createFactCheckBridge(FAST);
  bridge.start("v1");
  await flushMicrotasks();

  const record = await getFactCheckState("v1");
  assert.equal(record.stage, "skipped_fiction");
  assert.deepEqual(record.pregate, pregate);
  validateRecord(record);

  await advance(1000);
  await advance(1000);
  assert.equal(calls, 1, "polling must stop once skipped_fiction is reached");
});

test("an unavailable check stops polling at failed instead of spinning forever", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  sendMessageImpl = async () => {
    calls += 1;
    return { ok: true, stage: "failed", detail: "Skipped: no usable fact-check LLM credentials." };
  };

  const bridge = createFactCheckBridge(FAST);
  bridge.start("v1");
  await flushMicrotasks();

  const record = await getFactCheckState("v1");
  assert.equal(record.stage, "failed");
  assert.equal(record.error.message, "Skipped: no usable fact-check LLM credentials.");
  validateRecord(record);

  await advance(1000);
  await advance(1000);
  assert.equal(calls, 1, "polling must stop once the backend says the check cannot run");
});

test("a run of backend errors writes failed/retryable and stops polling", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  sendMessageImpl = async () => {
    calls += 1;
    throw new Error("network down");
  };

  const bridge = createFactCheckBridge(FAST);
  bridge.start("v1"); // call #1 fails, failureCount=1
  await flushMicrotasks();

  // Every failure short of the threshold is retried quietly: no record is
  // written yet, so the card stays exactly where it was (idle here).
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 2; i++) {
    await advance(1000);
  }
  assert.equal(calls, MAX_CONSECUTIVE_FAILURES - 1);
  const beforeFinal = await getFactCheckState("v1");
  assert.equal(beforeFinal.stage, "idle", "a failure below the threshold writes nothing yet");

  // The Nth consecutive failure (N = MAX_CONSECUTIVE_FAILURES) is the one
  // that finally gets reported.
  await advance(1000);
  assert.equal(calls, MAX_CONSECUTIVE_FAILURES);
  const record = await getFactCheckState("v1");
  assert.equal(record.stage, "failed");
  assert.equal(record.error.retryable, true);
  assert.equal(typeof record.error.message, "string");
  validateRecord(record);

  // Terminal (failed stops the automatic loop; only onRetry restarts it).
  await advance(1000);
  await advance(1000);
  assert.equal(calls, MAX_CONSECUTIVE_FAILURES, "must not keep auto-retrying past failed");
});

test("a single transient failure does not mark failed, and recovers on the next tick", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  sendMessageImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error("blip");
    return { ok: true, stage: "fact_checking" };
  };

  const bridge = createFactCheckBridge(FAST);
  bridge.start("v1");
  await flushMicrotasks();
  assert.equal((await getFactCheckState("v1")).stage, "idle");

  await advance(1000);
  assert.equal(calls, 2);
  assert.equal((await getFactCheckState("v1")).stage, "fact_checking");
  bridge.stop();
});

test("retry() re-arms polling after failed without waiting out the interval", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let failing = true;
  sendMessageImpl = async () => {
    calls += 1;
    if (failing) throw new Error("down");
    return {
      ok: true,
      stage: "complete",
      report: { validity_score: 90, rating: "Good", verdicts: [] },
    };
  };

  const bridge = createFactCheckBridge(FAST);
  bridge.start("v1"); // call #1
  await flushMicrotasks();
  for (let i = 0; i < MAX_CONSECUTIVE_FAILURES - 1; i++) await advance(1000);
  assert.equal((await getFactCheckState("v1")).stage, "failed");
  const callsAtFailure = calls;

  failing = false;
  bridge.retry("v1");
  await flushMicrotasks();

  assert.equal(calls, callsAtFailure + 1);
  assert.equal((await getFactCheckState("v1")).stage, "complete");
  bridge.stop();
});

test("retry() for a stale/different videoId is ignored", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  sendMessageImpl = async () => {
    calls += 1;
    return { ok: true, stage: "fact_checking" };
  };
  const bridge = createFactCheckBridge(FAST);
  bridge.start("v1");
  await flushMicrotasks();
  const callsBefore = calls;

  bridge.retry("some-other-video");
  await flushMicrotasks();

  assert.equal(calls, callsBefore, "a retry for a video that isn't current must be a no-op");
  bridge.stop();
});

test("stop() cancels the pending timer so no further fetch ever happens", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  sendMessageImpl = async () => {
    calls += 1;
    return { ok: true, stage: "fact_checking" };
  };
  const bridge = createFactCheckBridge(FAST);
  bridge.start("v1");
  await flushMicrotasks();
  assert.equal(calls, 1);

  bridge.stop();
  await advance(1000);
  await advance(1000);
  assert.equal(calls, 1, "no more fetches after stop()");
});

test("starting a new video stops the previous one's polling (no cross-video writes)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const callsByVideo = { v1: 0, v2: 0 };
  sendMessageImpl = async (message) => {
    callsByVideo[message.videoId] = (callsByVideo[message.videoId] ?? 0) + 1;
    return { ok: true, stage: "fact_checking" };
  };

  const bridge = createFactCheckBridge(FAST);
  bridge.start("v1");
  await flushMicrotasks();
  assert.equal(callsByVideo.v1, 1);

  bridge.start("v2"); // simulates factCheckMount always creating a fresh bridge,
  // but also exercises the same instance switching videos defensively.
  await flushMicrotasks();
  assert.equal(callsByVideo.v2, 1);

  await advance(1000);
  await advance(1000);
  assert.equal(callsByVideo.v1, 1, "v1 must not be polled again after start(v2)");
  assert.ok(callsByVideo.v2 >= 2, "v2 keeps polling");
  bridge.stop();
});

test("the record written on every branch satisfies validateRecord (schemaVersion, invariants)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  for (const response of [
    { ok: true, stage: "fact_checking" },
    {
      ok: true,
      stage: "complete",
      report: { validity_score: 10, rating: "Bad", verdicts: [] },
    },
    {
      ok: true,
      stage: "skipped_fiction",
      pregate: { isEligible: false, category: "music", reason: "Not factual.", source: "category" },
    },
  ]) {
    _resetMemoryStore();
    installChrome();
    sendMessageImpl = async () => response;
    const bridge = createFactCheckBridge(FAST);
    bridge.start("v1");
    await flushMicrotasks();
    const record = await getFactCheckState("v1");
    assert.equal(record.schemaVersion, FACT_CHECK_SCHEMA_VERSION);
    validateRecord(record);
    bridge.stop();
  }
});
