import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  findVideoTiles,
  extractVideoId,
  getTitleElement,
  getThumbnailElement,
  observeVideoTiles,
} from "./videoScanner.js";

// --- Minimal hand-rolled fake DOM -------------------------------------------------
// Just enough to drive querySelector/querySelectorAll for the selector grammar this
// module actually uses: tag names, #id, .class, [attr] presence, and comma lists.

class FakeElement {
  constructor(tagName, { id, className, attrs } = {}) {
    this.tagName = tagName;
    this.attributes = { ...attrs };
    if (id) this.attributes.id = id;
    if (className) this.attributes.class = className;
    this.children = [];
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  // Depth-first descendants, not including self — matches real DOM semantics.
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  querySelectorAll(selectorList) {
    const parsed = selectorList.split(",").map((s) => parseSimpleSelector(s.trim()));
    const matches = [];
    for (const el of this.descendants()) {
      if (parsed.some((p) => elementMatches(el, p))) matches.push(el);
    }
    return matches;
  }

  querySelector(selectorList) {
    return this.querySelectorAll(selectorList)[0] ?? null;
  }
}

function parseSimpleSelector(sel) {
  const m = sel.match(/^([a-zA-Z][a-zA-Z0-9-]*)?((?:[.#][\w-]+|\[[a-zA-Z-]+\])*)$/);
  if (!m) throw new Error(`fake DOM: unsupported selector "${sel}"`);
  const tag = m[1] ? m[1].toLowerCase() : null;
  const parts = m[2].match(/[.#][\w-]+|\[[a-zA-Z-]+\]/g) || [];
  return {
    tag,
    id: parts.find((p) => p[0] === "#")?.slice(1) ?? null,
    classes: parts.filter((p) => p[0] === ".").map((p) => p.slice(1)),
    attrs: parts.filter((p) => p[0] === "[").map((p) => p.slice(1, -1)),
  };
}

function elementMatches(el, parsed) {
  if (parsed.tag && el.tagName.toLowerCase() !== parsed.tag) return false;
  if (parsed.id && el.getAttribute("id") !== parsed.id) return false;
  const classList = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
  if (parsed.classes.some((c) => !classList.includes(c))) return false;
  if (parsed.attrs.some((a) => el.getAttribute(a) === null)) return false;
  return true;
}

function anchor(href) {
  return new FakeElement("a", { attrs: href === undefined ? {} : { href } });
}

// --- extractVideoId ----------------------------------------------------------------

describe("extractVideoId", () => {
  test("relative /watch?v=", () => {
    const tile = new FakeElement("div");
    tile.appendChild(anchor("/watch?v=ABC123"));
    assert.equal(extractVideoId(tile), "ABC123");
  });

  test("absolute watch url with extra query params", () => {
    const tile = new FakeElement("div");
    tile.appendChild(anchor("https://www.youtube.com/watch?v=ABC123&t=5s"));
    assert.equal(extractVideoId(tile), "ABC123");
  });

  test("relative /shorts/", () => {
    const tile = new FakeElement("div");
    tile.appendChild(anchor("/shorts/ABC123"));
    assert.equal(extractVideoId(tile), "ABC123");
  });

  test("absolute shorts url", () => {
    const tile = new FakeElement("div");
    tile.appendChild(anchor("https://www.youtube.com/shorts/XYZ789"));
    assert.equal(extractVideoId(tile), "XYZ789");
  });

  test("no matching anchor returns null, not empty string", () => {
    const tile = new FakeElement("div");
    tile.appendChild(new FakeElement("span"));
    assert.equal(extractVideoId(tile), null);
  });

  test("/watch with no v param returns null", () => {
    const tile = new FakeElement("div");
    tile.appendChild(anchor("/watch?list=PL123"));
    assert.equal(extractVideoId(tile), null);
  });

  test("/@handle link returns null", () => {
    const tile = new FakeElement("div");
    tile.appendChild(anchor("/@SomeChannel"));
    assert.equal(extractVideoId(tile), null);
  });

  test("/playlist link returns null", () => {
    const tile = new FakeElement("div");
    tile.appendChild(anchor("/playlist?list=PL123"));
    assert.equal(extractVideoId(tile), null);
  });

  test("neither relative nor absolute form throws", () => {
    const relTile = new FakeElement("div");
    relTile.appendChild(anchor("/watch?v=REL1"));
    const absTile = new FakeElement("div");
    absTile.appendChild(anchor("https://www.youtube.com/watch?v=ABS1"));
    assert.doesNotThrow(() => extractVideoId(relTile));
    assert.doesNotThrow(() => extractVideoId(absTile));
  });
});

// --- findVideoTiles ------------------------------------------------------------------

describe("findVideoTiles", () => {
  test("finds tiles across several renderer tag names", () => {
    const root = new FakeElement("body");
    const rich = new FakeElement("ytd-rich-item-renderer");
    const video = new FakeElement("ytd-video-renderer");
    const compact = new FakeElement("ytd-compact-video-renderer");
    const lockup = new FakeElement("yt-lockup-view-model");
    const noise = new FakeElement("div");
    root.appendChild(rich);
    root.appendChild(video);
    root.appendChild(noise);
    noise.appendChild(compact);
    root.appendChild(lockup);

    const tiles = findVideoTiles(root);
    assert.equal(tiles.length, 4);
    assert.ok(tiles.includes(rich));
    assert.ok(tiles.includes(video));
    assert.ok(tiles.includes(compact));
    assert.ok(tiles.includes(lockup));
  });

  test("returns empty array when nothing matches", () => {
    const root = new FakeElement("body");
    root.appendChild(new FakeElement("div"));
    assert.deepEqual(findVideoTiles(root), []);
  });
});

// --- getTitleElement / getThumbnailElement --------------------------------------------

describe("getTitleElement", () => {
  test("prefers #video-title over later selectors", () => {
    const tile = new FakeElement("div");
    const preferred = new FakeElement("span", { id: "video-title" });
    const fallback = new FakeElement("a", { id: "video-title-link" });
    tile.appendChild(fallback);
    tile.appendChild(preferred);
    assert.equal(getTitleElement(tile), preferred);
  });

  test("falls through to a#video-title-link", () => {
    const tile = new FakeElement("div");
    const el = new FakeElement("a", { id: "video-title-link" });
    tile.appendChild(el);
    assert.equal(getTitleElement(tile), el);
  });

  test("falls through to yt-formatted-string#video-title", () => {
    const tile = new FakeElement("div");
    const el = new FakeElement("yt-formatted-string", { id: "video-title" });
    tile.appendChild(el);
    assert.equal(getTitleElement(tile), el);
  });

  test("falls through to the lockup title class", () => {
    const tile = new FakeElement("div");
    const el = new FakeElement("span", { className: "yt-lockup-metadata-view-model__title" });
    tile.appendChild(el);
    assert.equal(getTitleElement(tile), el);
  });

  test("returns null when nothing matches", () => {
    const tile = new FakeElement("div");
    tile.appendChild(new FakeElement("span"));
    assert.equal(getTitleElement(tile), null);
  });
});

describe("getThumbnailElement", () => {
  test("prefers a#thumbnail over later selectors", () => {
    const tile = new FakeElement("div");
    const fallback = new FakeElement("img");
    const preferred = new FakeElement("a", { id: "thumbnail" });
    tile.appendChild(fallback);
    tile.appendChild(preferred);
    assert.equal(getThumbnailElement(tile), preferred);
  });

  test("falls through to ytd-thumbnail", () => {
    const tile = new FakeElement("div");
    const el = new FakeElement("ytd-thumbnail");
    tile.appendChild(el);
    assert.equal(getThumbnailElement(tile), el);
  });

  test("falls through to yt-thumbnail-view-model", () => {
    const tile = new FakeElement("div");
    const el = new FakeElement("yt-thumbnail-view-model");
    tile.appendChild(el);
    assert.equal(getThumbnailElement(tile), el);
  });

  test("falls through to bare img", () => {
    const tile = new FakeElement("div");
    const el = new FakeElement("img");
    tile.appendChild(el);
    assert.equal(getThumbnailElement(tile), el);
  });

  test("returns null when nothing matches", () => {
    const tile = new FakeElement("div");
    tile.appendChild(new FakeElement("span"));
    assert.equal(getThumbnailElement(tile), null);
  });
});

// --- observeVideoTiles ---------------------------------------------------------------
// Fakes MutationObserver, document.body, and the timer functions so debounce behaviour
// is deterministic instead of depending on real wall-clock time.

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = null;
    this.disconnected = false;
    FakeMutationObserver.instances.push(this);
  }
  observe(target, options) {
    this.observed = { target, options };
  }
  disconnect() {
    this.disconnected = true;
  }
  // Test helper: simulate a batch of mutation records arriving.
  fire() {
    this.callback([]);
  }
}
FakeMutationObserver.instances = [];

function withFakeGlobals(fn) {
  const realMutationObserver = globalThis.MutationObserver;
  const realDocument = globalThis.document;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  const scheduled = new Map(); // id -> fn, mirrors what a real timer table would hold
  let nextId = 1;
  const calls = []; // history of {id, fn}, kept even after "clearing", for race tests

  globalThis.MutationObserver = FakeMutationObserver;
  FakeMutationObserver.instances = [];
  const body = new FakeElement("body");
  globalThis.document = {
    body,
    // findVideoTiles(document) delegates here, same as a real document would.
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => body.querySelector(sel),
  };
  globalThis.setTimeout = (cb) => {
    const id = nextId++;
    scheduled.set(id, cb);
    calls.push({ id, fn: cb });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    scheduled.delete(id);
  };

  const fireScheduled = (id) => {
    const cb = scheduled.get(id);
    if (cb) {
      scheduled.delete(id);
      cb();
    }
  };

  try {
    return fn({ fireScheduled, calls, scheduledSize: () => scheduled.size });
  } finally {
    globalThis.MutationObserver = realMutationObserver;
    globalThis.document = realDocument;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

describe("observeVideoTiles", () => {
  test("debounces multiple rapid mutations into one callback", () => {
    withFakeGlobals(({ fireScheduled, calls }) => {
      let callCount = 0;
      const disconnect = observeVideoTiles(() => {
        callCount += 1;
      });

      const observerInstance = FakeMutationObserver.instances[0];
      assert.ok(observerInstance, "MutationObserver should have been constructed");
      assert.equal(observerInstance.observed.target, globalThis.document.body);
      assert.deepEqual(observerInstance.observed.options, { childList: true, subtree: true });

      // Simulate three mutation bursts arriving back-to-back, well within the debounce
      // window: each should cancel the previous pending timer via clearTimeout.
      observerInstance.fire();
      observerInstance.fire();
      observerInstance.fire();

      assert.equal(calls.length, 3, "setTimeout should be called once per mutation burst");
      assert.equal(callCount, 0, "callback must not fire before the debounce timer elapses");

      // Only the LAST scheduled timer should still be live (the earlier two were cleared).
      fireScheduled(calls[0].id);
      fireScheduled(calls[1].id);
      assert.equal(callCount, 0, "cleared timers must not invoke the callback");

      fireScheduled(calls[2].id);
      assert.equal(callCount, 1, "the surviving debounced timer should fire exactly once");

      disconnect();
    });
  });

  test("disconnect stops future mutations and guards an already-pending callback", () => {
    withFakeGlobals(({ fireScheduled, calls }) => {
      let callCount = 0;
      const disconnect = observeVideoTiles(() => {
        callCount += 1;
      });
      const observerInstance = FakeMutationObserver.instances[0];

      observerInstance.fire();
      assert.equal(calls.length, 1);

      disconnect();
      assert.ok(observerInstance.disconnected, "disconnect() must disconnect the observer");

      // Simulate a timer callback that was already queued in the event loop at the
      // moment disconnect() ran (disconnect's own clearTimeout call raced and lost).
      // The internal "disconnected" guard must still stop the callback from firing.
      fireScheduled(calls[0].id);
      assert.equal(callCount, 0, "a pending debounced callback must not fire after disconnect");
    });
  });

  test("tolerates document.body being null", () => {
    withFakeGlobals(() => {
      globalThis.document = { body: null };
      assert.doesNotThrow(() => {
        const disconnect = observeVideoTiles(() => {});
        disconnect();
      });
    });
  });

  test("calling disconnect twice does not throw", () => {
    withFakeGlobals(() => {
      const disconnect = observeVideoTiles(() => {});
      assert.doesNotThrow(() => {
        disconnect();
        disconnect();
      });
    });
  });
});
