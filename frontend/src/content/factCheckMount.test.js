// No real chrome, no real DOM. A minimal fake `document` gives overlay.js and
// FactCheckCard.js (both real, unmodified) enough surface to run; a fake
// `chrome.storage` (same shape every other storage test in this repo uses)
// drives factCheckState.js's subscribe/get/set for real, so what's actually
// being tested is the WIRING in factCheckMount.js: mount targets the
// overlay's slot, subscriptions are per-video and cleaned up, and the bridge
// factory is only ever asked to start/stop the right video.
//
// The bridge itself is never real here (factCheckBridge.js has its own test
// file) - mountFactCheckFor's `createBridge` injection seam swaps in a fake
// that just records calls, which is what makes it possible to assert
// "unmounting stops exactly one bridge" without a live timer.

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { _resetMemoryStore, setFactCheckState } from "../shared/factCheckState.js";
import {
  _currentlyMountedVideoId,
  mountFactCheckFor,
  unmountFactCheck,
} from "./factCheckMount.js";

// --- fake DOM: just enough for overlay.js + FactCheckCard.js ------------------------

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
      add(...toAdd) {
        const set = new Set(names());
        toAdd.forEach((n) => set.add(n));
        write(set);
      },
      remove(...toRemove) {
        const set = new Set(names());
        toRemove.forEach((n) => set.delete(n));
        write(set);
      },
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
    child.parentNode?.children?.splice(child.parentNode.children.indexOf(child), 1);
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

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  dispatchEvent(type) {
    for (const handler of this._listeners.get(type) ?? []) handler({ type });
  }
  click() {
    this.dispatchEvent("click");
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

function matches(node, selector) {
  if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
  if (selector.startsWith("#")) return node.id === selector.slice(1);
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
  globalThis.document = {
    body,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => findById(body, id),
  };
}

// --- fake chrome.storage (same shape as every other storage test here) -------------

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

function overlayEl() {
  return findById(globalThis.document.body, "ait-overlay");
}

// --- fake bridge factory -----------------------------------------------------------

function fakeBridgeFactory() {
  const instances = [];
  const createBridge = () => {
    const instance = {
      startedWith: [],
      stopped: false,
      retriedWith: [],
      start(videoId) {
        instance.startedWith.push(videoId);
      },
      stop() {
        instance.stopped = true;
      },
      retry(videoId) {
        instance.retriedWith.push(videoId);
      },
    };
    instances.push(instance);
    return instance;
  };
  return { createBridge, instances };
}

beforeEach(() => {
  installFakeDom();
  installChrome();
  _resetMemoryStore();
});

afterEach(() => {
  unmountFactCheck();
  delete globalThis.document;
  delete globalThis.chrome;
  _resetMemoryStore();
});

// --- mount/unmount -------------------------------------------------------------------

test("mountFactCheckFor mounts the card under the overlay's fact-check slot", () => {
  const { createBridge } = fakeBridgeFactory();
  mountFactCheckFor("v1", { createBridge });

  const overlay = overlayEl();
  assert.ok(overlay, "expected the overlay container to exist");
  const slot = findById(overlay, "ait-factcheck-slot");
  assert.ok(slot, "expected the fact-check slot inside the overlay");
  assert.equal(slot.querySelectorAll(".ait-fc-title").length, 1, "card should be mounted in the slot");
});

test("mountFactCheckFor starts a bridge for that video", () => {
  const { createBridge, instances } = fakeBridgeFactory();
  mountFactCheckFor("v1", { createBridge });
  assert.equal(instances.length, 1);
  assert.deepEqual(instances[0].startedWith, ["v1"]);
});

test("mounting the same video twice is a no-op (does not restart the bridge)", () => {
  const { createBridge, instances } = fakeBridgeFactory();
  mountFactCheckFor("v1", { createBridge });
  mountFactCheckFor("v1", { createBridge });
  assert.equal(instances.length, 1, "a second mount for the same video must not create another bridge");
});

test("unmountFactCheck stops the bridge and removes the card from the DOM", () => {
  const { createBridge, instances } = fakeBridgeFactory();
  mountFactCheckFor("v1", { createBridge });
  unmountFactCheck();

  assert.equal(instances[0].stopped, true);
  const overlay = overlayEl();
  const slot = overlay ? findById(overlay, "ait-factcheck-slot") : null;
  assert.equal(
    slot?.querySelectorAll(".ait-fc-title").length ?? 0,
    0,
    "card must be removed from the DOM",
  );
  assert.equal(_currentlyMountedVideoId(), null);
});

test("unmountFactCheck twice, or before any mount, does not throw", () => {
  assert.doesNotThrow(() => unmountFactCheck());
  const { createBridge } = fakeBridgeFactory();
  mountFactCheckFor("v1", { createBridge });
  unmountFactCheck();
  assert.doesNotThrow(() => unmountFactCheck());
});

// --- navigation: old subscription/bridge must not survive ---------------------------

test("mounting a new video stops the previous bridge and starts a new one", () => {
  const { createBridge, instances } = fakeBridgeFactory();
  mountFactCheckFor("v1", { createBridge });
  mountFactCheckFor("v2", { createBridge });

  assert.equal(instances.length, 2);
  assert.equal(instances[0].stopped, true, "v1's bridge must be stopped");
  assert.equal(instances[1].stopped, false);
  assert.deepEqual(instances[1].startedWith, ["v2"]);
  assert.equal(_currentlyMountedVideoId(), "v2");
});

test("navigating away unsubscribes the old video: a storage write for it never reaches the card again", async () => {
  const { createBridge } = fakeBridgeFactory();
  mountFactCheckFor("v1", { createBridge });
  mountFactCheckFor("v2", { createBridge });

  // A write for v1 (e.g. a slow, now-abandoned poll response finally landing)
  // must not resurrect anything for the card now showing v2.
  await setFactCheckState("v1", { stage: "complete", result: { verdicts: [] } });

  const overlay = overlayEl();
  const slot = findById(overlay, "ait-factcheck-slot");
  // The card currently mounted is v2's; nothing in its DOM should reflect a
  // v1 "complete" write (a score badge/toggle would only appear for complete).
  assert.equal(slot.querySelectorAll(".ait-fc-toggle").length, 0);
});

test("a storage write for the currently-mounted video updates the card", async () => {
  const { createBridge } = fakeBridgeFactory();
  mountFactCheckFor("v1", { createBridge });

  await setFactCheckState("v1", {
    stage: "skipped_fiction",
    pregate: { isEligible: false, category: "gaming", reason: "Gameplay video.", source: "category" },
  });

  const overlay = overlayEl();
  const slot = findById(overlay, "ait-factcheck-slot");
  assert.ok(slot.textContent.includes("Gameplay video."));
});

test("an existing stored record hydrates the card on mount, not just future changes", async () => {
  await setFactCheckState("v1", {
    stage: "failed",
    error: { message: "Backend unavailable.", retryable: true },
  });

  const { createBridge } = fakeBridgeFactory();
  mountFactCheckFor("v1", { createBridge });
  // getFactCheckState() is async; give its .then() a turn to run.
  await Promise.resolve();
  await Promise.resolve();

  const overlay = overlayEl();
  const slot = findById(overlay, "ait-factcheck-slot");
  assert.ok(slot.textContent.includes("Backend unavailable."));
});

// --- retry wiring --------------------------------------------------------------------

test("the card's retry button calls bridge.retry() for the current video", () => {
  const { createBridge, instances } = fakeBridgeFactory();
  mountFactCheckFor("v42", { createBridge });

  const overlay = overlayEl();
  const slot = findById(overlay, "ait-factcheck-slot");
  // FactCheckCard only renders nothing (idle) until updated - drive it into
  // "failed" via the real record, then click the real retry button.
  return setFactCheckState("v42", {
    stage: "failed",
    error: { message: "Boom.", retryable: true },
  }).then(() => {
    const button = slot.querySelector(".ait-fc-retry");
    assert.ok(button, "expected a retry button for a retryable failure");
    button.click();
    assert.deepEqual(instances[0].retriedWith, ["v42"]);
  });
});
