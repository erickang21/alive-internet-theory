// Regression coverage for a specific trap: content/index.js's AI-score poll
// (poll()/showEvaluation()) stops rescheduling the instant a score renders,
// because a stored evaluation is durable and never needs re-checking. The
// fact-check for that same video is not durable yet at that point - it can
// still be minutes away - so if the fact-check bridge were ever hung off that
// same loop (instead of factCheckBridge.js's own independent timer), it would
// stop polling on tick 1 right alongside the score and the card would be
// stuck at "fact_checking" forever. This file drives the real content script
// end to end (real chrome.runtime.sendMessage is the only thing faked) and
// proves the two loops are actually independent: the score request fires
// once, the fact-check request keeps firing on its own cadence.
//
// No real chrome, no real browser: a small fake `document`/`location`/
// `MutationObserver` gives the content script enough surface to run, and
// node:test's mock.timers fast-forwards the 30s-ish poll intervals.

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { FILTER_STORAGE_KEY, MESSAGE_TYPES } from "../shared/constants.js";
import { _resetMemoryStore } from "../shared/factCheckState.js";
import { putCachedScore } from "../shared/scoreCache.js";
// factCheckMount.js is a singleton module (imported by index.js under a
// stable specifier, unlike index.js itself below, which each test re-imports
// under a cache-busting query string) - its mounted-video/bridge/subscription
// state survives across tests in this same process unless explicitly torn
// down, so every test must unmount before the next one imports a fresh
// index.js expecting a clean slate.
import { unmountFactCheck } from "./factCheckMount.js";

// --- fake DOM (same shape as factCheckMount.test.js's) ------------------------------

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._id = "";
    this._className = "";
    this._attrs = new Map();
    this._listeners = new Map();
    this.hidden = false;
  }
  get id() {
    return this._id;
  }
  set id(value) {
    this._id = value ?? "";
  }
  get className() {
    return this._className;
  }
  set className(value) {
    this._className = value ?? "";
  }
  get classList() {
    const self = this;
    const names = () => self._className.split(/\s+/).filter(Boolean);
    const write = (set) => {
      self._className = [...set].join(" ");
    };
    return {
      add: (...toAdd) => write(new Set([...names(), ...toAdd])),
      remove: (...toRemove) => write(new Set(names().filter((n) => !toRemove.includes(n)))),
      contains: (name) => names().includes(name),
    };
  }
  get textContent() {
    if (this.children.length === 0) return this._text ?? "";
    return this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = value === undefined || value === null ? "" : String(value);
  }
  get innerHTML() {
    return this._html ?? "";
  }
  set innerHTML(value) {
    // overlay.js only ever writes small static markup and re-queries it by
    // class right afterwards (e.g. `.querySelector(".ait-badge").textContent
    // = ...`), so this needs to actually build a tree - a bare string stand-in
    // would make every one of those lookups silently return null.
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._html = value;
    for (const node of parseFragment(value)) this.appendChild(node);
  }
  setAttribute(name, value) {
    this._attrs.set(name, String(value));
    if (name === "id") this._id = String(value);
  }
  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }
  removeAttribute(name) {
    this._attrs.delete(name);
  }
  appendChild(child) {
    if (child.parentNode?.children) {
      const i = child.parentNode.children.indexOf(child);
      if (i >= 0) child.parentNode.children.splice(i, 1);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
  }
  addEventListener() {
    /* not exercised by this test: no click-driven UI here */
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

// Tiny non-nested-attribute HTML fragment "parser" - just enough for
// overlay.js's static templates (plain divs/spans/buttons/uls with a class
// and/or a boolean/type attribute, no nested quotes). Text nodes are
// deliberately ignored: overlay.js always sets text afterwards via
// `.textContent =`, never relies on markup text surviving this parse.
function parseFragment(html) {
  const root = new FakeElement("template-root");
  const stack = [root];
  const tagRe = /<\/?([a-zA-Z0-9-]+)([^>]*)>/g;
  let match;
  while ((match = tagRe.exec(html))) {
    const isClose = match[0].startsWith("</");
    if (isClose) {
      stack.pop();
      continue;
    }
    const attrsStr = match[2] || "";
    const el = new FakeElement(match[1]);
    const classMatch = attrsStr.match(/class="([^"]*)"/);
    if (classMatch) el.className = classMatch[1];
    const idMatch = attrsStr.match(/\bid="([^"]*)"/);
    if (idMatch) el.id = idMatch[1];
    if (/(^|\s)hidden(\s|=|$)/.test(attrsStr)) el.hidden = true;
    const typeMatch = attrsStr.match(/\btype="([^"]*)"/);
    if (typeMatch) el.setAttribute("type", typeMatch[1]);
    stack[stack.length - 1].appendChild(el);
    if (!attrsStr.trim().endsWith("/")) stack.push(el);
  }
  // A copy, not the live array: appendChild() below removes each node from
  // its previous parent's children array (root's, here) as it re-parents it,
  // which would otherwise shift indices out from under a `for...of` over
  // this exact array and silently skip every other sibling.
  return [...root.children];
}

function matches(node, selector) {
  if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
  if (selector.startsWith("#")) return node.id === selector.slice(1);
  const attrSelector = selector.match(/^([a-zA-Z0-9-]+)\[([a-zA-Z-]+)\]$/);
  if (attrSelector) {
    return (
      node.tagName.toLowerCase() === attrSelector[1] && node.getAttribute(attrSelector[2]) !== null
    );
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findById(child, id);
    if (found) return found;
  }
  return null;
}

function installFakeDom() {
  const body = new FakeElement("body");
  const documentListeners = new Map();
  globalThis.document = {
    body,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => findById(body, id),
    querySelectorAll: () => [], // no video tiles on a bare watch page fixture
    addEventListener: (type, handler) => {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(handler);
    },
    _fire: (type) => {
      for (const handler of documentListeners.get(type) ?? []) handler();
    },
  };

  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }
  globalThis.MutationObserver = FakeMutationObserver;
}

function installLocation(href) {
  globalThis.location = { href };
}

// --- fake chrome.storage + chrome.runtime -------------------------------------------

let store;
let storageListeners;

function installChrome({ onSendMessage }) {
  store = {};
  storageListeners = [];
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
          storageListeners.forEach((l) => l(changes, "local"));
        },
        remove: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const k of list) {
            changes[k] = { oldValue: store[k], newValue: undefined };
            delete store[k];
          }
          storageListeners.forEach((l) => l(changes, "local"));
        },
      },
      onChanged: {
        addListener: (l) => storageListeners.push(l),
        removeListener: (l) => {
          const i = storageListeners.indexOf(l);
          if (i >= 0) storageListeners.splice(i, 1);
        },
      },
    },
    runtime: {
      onMessage: { addListener: () => {} },
      sendMessage: async (message) => onSendMessage(message),
    },
  };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function teardownGlobals() {
  // factCheckMount.js keeps module-level singleton state (which video owns the
  // card, its bridge and its subscription). Importing `./index.js?case=...`
  // gives each test a fresh index.js but NOT a fresh factCheckMount.js - the
  // module cache is keyed per specifier, and only index.js's specifier changes.
  // Without this reset a second test using the same video id hits the
  // `videoId === mountedVideoId` early return and never starts its bridge.
  // Runs first, while the fake DOM still exists for the card to unmount into.
  unmountFactCheck();
  delete globalThis.document;
  delete globalThis.location;
  delete globalThis.MutationObserver;
  delete globalThis.chrome;
  _resetMemoryStore();
  mock.timers.reset();
}

test("the fact-check bridge keeps polling after the AI-score poll settles on tick 1", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  installFakeDom();
  installLocation("https://www.youtube.com/watch?v=vid1");

  let evaluationCalls = 0;
  let factCheckCalls = 0;
  installChrome({
    onSendMessage: (message) => {
      if (message.type === MESSAGE_TYPES.REQUEST_EVALUATION) {
        evaluationCalls += 1;
        // A real, durable evaluation - this is what makes poll() in
        // index.js stop rescheduling after this very first response.
        return { ok: true, result: { score: 91, verdict: "likely_human", breakdown: [] } };
      }
      if (message.type === MESSAGE_TYPES.GET_EVALUATIONS) {
        return { ok: true, scores: {} };
      }
      if (message.type === MESSAGE_TYPES.GET_FACT_CHECK) {
        factCheckCalls += 1;
        // Still working, minutes away from a report - this must keep being
        // polled long after the score above has already rendered.
        return { ok: true, stage: "fact_checking" };
      }
      throw new Error(`unexpected message type: ${message.type}`);
    },
  });

  try {
    // Fresh side effects on every test run: index.js executes its top-level
    // showCurrentVideo()/rescanAndApplyFilter() calls at import time, so a
    // cache-busted specifier is required to re-run them under this test's
    // own fakes rather than reusing another test file's module instance.
    await import(`./index.js?case=independent-loops`);
    await flushMicrotasks();

    assert.equal(evaluationCalls, 1, "the AI-score request should have fired once on load");
    assert.equal(factCheckCalls, 1, "the fact-check request should have fired once on load");

    // Advance past one full poll interval (30s + up to 2s jitter) for BOTH
    // loops. If the fact-check bridge were wrongly hung off the score poll,
    // neither would fire again here.
    mock.timers.tick(33_000);
    await flushMicrotasks();

    assert.equal(
      evaluationCalls,
      1,
      "the AI-score poll must NOT re-fire - a stored evaluation is durable",
    );
    assert.equal(
      factCheckCalls,
      2,
      "the fact-check bridge must keep polling on its own independent timer",
    );

    // And once more, to rule out a fluke single extra tick.
    mock.timers.tick(33_000);
    await flushMicrotasks();
    assert.equal(evaluationCalls, 1);
    assert.equal(factCheckCalls, 3);
  } finally {
    teardownGlobals();
  }
});

test("leaving the watch page stops the fact-check bridge too", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  installFakeDom();
  installLocation("https://www.youtube.com/watch?v=vid1");

  let factCheckCalls = 0;
  installChrome({
    onSendMessage: (message) => {
      if (message.type === MESSAGE_TYPES.REQUEST_EVALUATION) {
        return { ok: true, result: { score: 91, verdict: "likely_human", breakdown: [] } };
      }
      if (message.type === MESSAGE_TYPES.GET_EVALUATIONS) {
        return { ok: true, scores: {} };
      }
      if (message.type === MESSAGE_TYPES.GET_FACT_CHECK) {
        factCheckCalls += 1;
        return { ok: true, stage: "fact_checking" };
      }
      throw new Error(`unexpected message type: ${message.type}`);
    },
  });

  try {
    await import(`./index.js?case=leaves-watch-page`);
    await flushMicrotasks();
    assert.equal(factCheckCalls, 1);

    // Navigate to a non-watch page (e.g. the home feed).
    globalThis.location.href = "https://www.youtube.com/";
    document._fire("yt-navigate-finish");
    await flushMicrotasks();

    mock.timers.tick(33_000);
    await flushMicrotasks();
    mock.timers.tick(33_000);
    await flushMicrotasks();

    assert.equal(factCheckCalls, 1, "no more fact-check polling once the video overlay is gone");
  } finally {
    teardownGlobals();
  }
});

test("cached tile flags survive a refresh pass when the worker is unreachable", async () => {
  installFakeDom();
  installLocation("https://www.youtube.com/"); // a feed page: no watch-page overlay traffic

  // One grid tile whose video has a persisted AI-slop score from an earlier
  // session — the exact situation the persistent cache exists for.
  const tile = new FakeElement("ytd-rich-item-renderer");
  const anchor = new FakeElement("a");
  anchor.setAttribute("href", "/watch?v=vidCached");
  const thumb = new FakeElement("img");
  tile.appendChild(anchor);
  tile.appendChild(thumb);
  globalThis.document.querySelectorAll = () => [tile];

  installChrome({
    onSendMessage: (message) => {
      if (message.type === MESSAGE_TYPES.GET_EVALUATIONS) {
        // The worker is unreachable (extension reloading): the fresh pass
        // gets nothing, and must not undo what the cached pass drew.
        return { ok: false, error: "worker restarting" };
      }
      throw new Error(`unexpected message type: ${message.type}`);
    },
  });
  store[FILTER_STORAGE_KEY] = "flag"; // set directly: no listeners exist yet to re-fire
  await putCachedScore("vidCached", { score: 30, verdict: "ai_slop" });

  try {
    await import(`./index.js?case=cached-flags-survive-worker-outage`);
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(
      tile.getAttribute("data-ait-filter-applied"),
      "flag",
      "the fresh (empty) pass must merge over the cached pass, not replace it",
    );
  } finally {
    teardownGlobals();
  }
});
