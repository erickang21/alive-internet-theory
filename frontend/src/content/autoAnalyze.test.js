import { after, test } from "node:test";
import assert from "node:assert/strict";

import { holdFeed, initAutoAnalyze, releaseFeed } from "./autoAnalyze.js";
import { AUTO_ANALYZE_STORAGE_KEY, MESSAGE_TYPES } from "../shared/constants.js";

// autoAnalyze.js is content-script glue, so the browser it talks to is stubbed here:
// storage to switch the mode on, an IntersectionObserver whose callback the test fires by
// hand, and a sendMessage whose replies the test resolves when it wants to.

const sent = [];
let pending = [];
let intersect = null;
let storageListener = null;

function fakeTile(videoId) {
  return {
    querySelectorAll: () => [{ getAttribute: () => `/watch?v=${videoId}` }],
  };
}

/** Fires the IntersectionObserver for these ids, as if they scrolled into view. */
function scrollIntoView(...videoIds) {
  intersect(videoIds.map((id) => ({ isIntersecting: true, target: fakeTile(id) })));
}

/** Lets queued sendMessage calls settle, so `sent` reflects everything dispatched. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function install() {
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  // No body, so observeVideoTiles wires nothing up; tiles arrive via scrollIntoView.
  globalThis.document = { body: null, querySelectorAll: () => [] };
  globalThis.IntersectionObserver = class {
    constructor(callback) {
      intersect = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.chrome = {
    storage: {
      local: { get: () => Promise.resolve({ [AUTO_ANALYZE_STORAGE_KEY]: true }) },
      onChanged: {
        addListener: (fn) => (storageListener = fn),
        removeListener: () => {},
      },
    },
    runtime: {
      sendMessage(message) {
        sent.push(message);
        return new Promise((resolve) => pending.push(resolve));
      },
    },
  };
}

/** Answers the oldest unanswered send, so the next queued id can go out. */
function reply(result = { status: "indexing" }) {
  pending.shift()?.({ ok: true, result });
}

function setMode(on) {
  storageListener({ [AUTO_ANALYZE_STORAGE_KEY]: { newValue: on } }, "local");
}

/** Clears the module's queues. Turning the mode off drops what it had collected but does
 * not unwind its in-flight count — in a browser those sends always settle and decrement
 * it themselves, so the outstanding ones are answered here first. */
async function reset() {
  // Answering a send lets the next queued id out, so drain until nothing new appears;
  // otherwise the module starts the next test with slots still taken.
  for (let round = 0; round < 10 && pending.length; round++) {
    while (pending.length) reply();
    await settle();
  }
  setMode(false);
  setMode(true);
  sent.length = 0;
  pending = [];
}

install();
initAutoAnalyze(() => {});
await settle();

// The module keeps a rescheduling 15s retry timer while the mode is on, which node counts
// as a live handle and would wait on forever. Turning the mode off clears it.
after(() => setMode(false));

test("the feed waits for the watched video, then drains what it collected", async () => {
  await reset();
  holdFeed();

  scrollIntoView("aaa", "bbb");
  await settle();
  assert.deepEqual(sent, [], "nothing may go out while the watched video has no verdict");

  releaseFeed();
  await settle();
  assert.deepEqual(
    sent.map((message) => message.videoId),
    ["aaa", "bbb"],
    "the backlog collected while held goes out on release",
  );
  assert.equal(sent[0].type, MESSAGE_TYPES.QUEUE_ANALYSIS);
});

test("releasing twice is harmless, and later tiles go straight out", async () => {
  await reset();
  releaseFeed();
  releaseFeed();

  scrollIntoView("ccc");
  await settle();
  assert.deepEqual(
    sent.map((message) => message.videoId),
    ["ccc"],
  );
});

test("no more than three are in flight at once", async () => {
  await reset();
  scrollIntoView("v1", "v2", "v3", "v4", "v5");
  await settle();
  assert.deepEqual(
    sent.map((message) => message.videoId),
    ["v1", "v2", "v3"],
    "the fourth waits for a slot",
  );

  reply();
  await settle();
  assert.deepEqual(
    sent.map((message) => message.videoId),
    ["v1", "v2", "v3", "v4"],
    "answering one frees exactly one slot",
  );
});

test("a tile already queued is not sent twice", async () => {
  await reset();
  scrollIntoView("dup");
  await settle();
  scrollIntoView("dup");
  await settle();
  assert.deepEqual(
    sent.map((message) => message.videoId),
    ["dup"],
  );
});

test("moving to a new video drops the old page's backlog", async () => {
  await reset();
  // Four collected on the page being left: three go out, the fourth is still waiting.
  scrollIntoView("old1", "old2", "old3", "old4");
  await settle();
  assert.equal(sent.length, 3);
  sent.length = 0;

  // Navigating away. The leftover "old4" must never be sent, and the three in flight
  // answering must not pull it through behind the hold.
  holdFeed();
  while (pending.length) reply();
  await settle();
  assert.deepEqual(sent, [], "the backlog from the page just left is dropped, not resumed");

  // The new page's tiles collect, and wait for the new video like any others.
  scrollIntoView("new1");
  await settle();
  assert.deepEqual(sent, []);

  releaseFeed();
  await settle();
  assert.deepEqual(
    sent.map((message) => message.videoId),
    ["new1"],
  );
});
