import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyFilter, clearFilter } from "./filterRenderer.js";

// --- Minimal hand-rolled fake DOM -------------------------------------------------
// Just enough of the Element/Document surface for filterRenderer.js: createElement,
// classList add/remove/contains, setAttribute/getAttribute/removeAttribute,
// querySelector/querySelectorAll (tag, #id, .class, [attr] presence, comma lists),
// appendChild/remove, and textContent. No jsdom/linkedom — none is installed and the
// spec asks us not to add dependencies.

class FakeElement {
  constructor(tagName, opts = {}) {
    this.tagName = tagName;
    this._attrs = {};
    this._classes = new Set();
    this.children = [];
    this.parentNode = null;
    this._text = "";
    if (opts.id) this.id = opts.id;
    if (opts.className) this.className = opts.className;

    this.classList = {
      add: (...names) => names.forEach((n) => this._classes.add(n)),
      remove: (...names) => names.forEach((n) => this._classes.delete(n)),
      contains: (n) => this._classes.has(n),
    };
  }

  get id() {
    return this._attrs.id ?? "";
  }
  set id(value) {
    this._attrs.id = value;
  }

  get className() {
    return Array.from(this._classes).join(" ");
  }
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get textContent() {
    return this._text;
  }
  set textContent(value) {
    this._text = String(value);
  }

  setAttribute(name, value) {
    if (name === "class") {
      this.className = value;
      return;
    }
    this._attrs[name] = String(value);
  }

  getAttribute(name) {
    if (name === "class") return this.className || null;
    return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
  }

  removeAttribute(name) {
    delete this._attrs[name];
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx !== -1) this.parentNode.children.splice(idx, 1);
    this.parentNode = null;
  }

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
  if (parsed.classes.some((c) => !el.classList.contains(c))) return false;
  if (parsed.attrs.some((a) => el.getAttribute(a) === null)) return false;
  return true;
}

function makeFakeDocument() {
  const head = new FakeElement("head");
  const body = new FakeElement("body");
  return {
    head,
    body,
    documentElement: new FakeElement("html"),
    createElement: (tag) => new FakeElement(tag),
    getElementById(id) {
      return head.querySelector(`#${id}`) ?? body.querySelector(`#${id}`) ?? null;
    },
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => body.querySelector(sel),
  };
}

// Runs fn with a fresh fake `document` installed as a global (filterRenderer.js reads
// the bare `document` identifier for style injection and node creation), then restores
// whatever was there before.
function withFakeDom(fn) {
  const real = globalThis.document;
  const doc = makeFakeDocument();
  globalThis.document = doc;
  try {
    return fn(doc);
  } finally {
    if (real === undefined) delete globalThis.document;
    else globalThis.document = real;
  }
}

// A tile shaped like what videoScanner.findVideoTiles()/extractVideoId() would hand
// back: a thumbnail wrapper matching `a#thumbnail` and a title matching `#video-title`,
// wrapped in its own parent so "next to the title" has somewhere to land.
function makeTile(doc) {
  const tile = new FakeElement("ytd-rich-item-renderer");

  const thumb = new FakeElement("a", { id: "thumbnail" });
  thumb.appendChild(new FakeElement("img"));
  tile.appendChild(thumb);

  const titleWrap = new FakeElement("div");
  const title = new FakeElement("span", { id: "video-title" });
  titleWrap.appendChild(title);
  tile.appendChild(titleWrap);

  doc.body.appendChild(tile);
  return { tile, thumb, title, titleWrap };
}

// --- threshold direction -------------------------------------------------------------

describe("threshold direction", () => {
  test("score below AI_FILTER_THRESHOLD (10) IS filtered under block", () => {
    withFakeDom((doc) => {
      const { tile } = makeTile(doc);
      applyFilter("block", [{ tile, videoId: "low", score: 10 }]);
      assert.ok(tile.classList.contains("ait-filtered-hidden"));
    });
  });

  test("score above AI_FILTER_THRESHOLD (90) is NOT filtered under block", () => {
    withFakeDom((doc) => {
      const { tile } = makeTile(doc);
      applyFilter("block", [{ tile, videoId: "high", score: 90 }]);
      assert.equal(tile.classList.contains("ait-filtered-hidden"), false);
    });
  });

  test("score below threshold IS flagged with a badge and inline icon", () => {
    withFakeDom((doc) => {
      const { tile, thumb, title } = makeTile(doc);
      applyFilter("flag", [{ tile, videoId: "low", score: 10 }]);
      assert.equal(thumb.querySelectorAll(".ait-flag-badge").length, 1);
      assert.equal(title.parentNode.querySelectorAll(".ait-flag-inline").length, 1);
    });
  });

  test("score above threshold is NOT flagged", () => {
    withFakeDom((doc) => {
      const { tile } = makeTile(doc);
      applyFilter("flag", [{ tile, videoId: "high", score: 90 }]);
      assert.equal(tile.querySelectorAll(".ait-flag-badge, .ait-flag-inline").length, 0);
    });
  });
});

// --- score === null (not analyzed) ----------------------------------------------------

describe("score === null (not analyzed yet)", () => {
  test("is never flagged", () => {
    withFakeDom((doc) => {
      const { tile } = makeTile(doc);
      applyFilter("flag", [{ tile, videoId: "unknown", score: null }]);
      assert.equal(tile.querySelectorAll(".ait-flag-badge, .ait-flag-inline").length, 0);
    });
  });

  test("is never hidden", () => {
    withFakeDom((doc) => {
      const { tile } = makeTile(doc);
      applyFilter("block", [{ tile, videoId: "unknown", score: null }]);
      assert.equal(tile.classList.contains("ait-filtered-hidden"), false);
    });
  });
});

// --- idempotency -----------------------------------------------------------------------

describe("idempotency", () => {
  test("applyFilter x3 (flag) produces the same DOM as x1", () => {
    withFakeDom((doc) => {
      const { tile } = makeTile(doc);
      const entries = [{ tile, videoId: "low", score: 10 }];

      applyFilter("flag", entries);
      const afterOne = tile.querySelectorAll(".ait-flag-badge, .ait-flag-inline").length;

      applyFilter("flag", entries);
      applyFilter("flag", entries);
      const afterThree = tile.querySelectorAll(".ait-flag-badge, .ait-flag-inline").length;

      assert.equal(afterOne, 2); // one badge + one inline icon
      assert.equal(afterThree, afterOne);
      assert.equal(tile.getAttribute("data-ait-filter-applied"), "flag");
    });
  });

  test("applyFilter x3 (block) produces the same DOM as x1", () => {
    withFakeDom((doc) => {
      const { tile } = makeTile(doc);
      const entries = [{ tile, videoId: "low", score: 10 }];

      applyFilter("block", entries);
      applyFilter("block", entries);
      applyFilter("block", entries);

      assert.ok(tile.classList.contains("ait-filtered-hidden"));
      assert.equal(tile.getAttribute("data-ait-filter-applied"), "block");
    });
  });
});

// --- state transitions -------------------------------------------------------------

describe("flag -> block transition", () => {
  test("leaves no leftover badge or inline icon", () => {
    withFakeDom((doc) => {
      const { tile } = makeTile(doc);
      const entries = [{ tile, videoId: "low", score: 10 }];

      applyFilter("flag", entries);
      assert.equal(tile.querySelectorAll(".ait-flag-badge, .ait-flag-inline").length, 2);

      applyFilter("block", entries);
      assert.equal(tile.querySelectorAll(".ait-flag-badge, .ait-flag-inline").length, 0);
      assert.ok(tile.classList.contains("ait-filtered-hidden"));
      assert.equal(tile.getAttribute("data-ait-filter-applied"), "block");
    });
  });
});

describe("block adds the hidden class to the TILE, not the thumbnail", () => {
  test("thumbnail element is untouched by the hidden class", () => {
    withFakeDom((doc) => {
      const { tile, thumb } = makeTile(doc);
      applyFilter("block", [{ tile, videoId: "low", score: 10 }]);
      assert.ok(tile.classList.contains("ait-filtered-hidden"));
      assert.equal(thumb.classList.contains("ait-filtered-hidden"), false);
    });
  });
});

// --- clearFilter full restore ---------------------------------------------------------

describe("clearFilter", () => {
  test("restores the DOM exactly: no ait- nodes, classes, or marker attributes", () => {
    withFakeDom((doc) => {
      const flagged = makeTile(doc);
      const blocked = makeTile(doc);

      applyFilter("flag", [{ tile: flagged.tile, videoId: "a", score: 10 }]);
      applyFilter("block", [{ tile: blocked.tile, videoId: "b", score: 5 }]);

      // Sanity: decoration is actually present before clearing.
      assert.ok(doc.body.querySelectorAll(".ait-flag-badge, .ait-flag-inline").length > 0);
      assert.ok(doc.body.querySelectorAll(".ait-filtered-hidden").length > 0);
      assert.ok(doc.getElementById("ait-filter-style"));

      clearFilter();

      assert.equal(doc.body.querySelectorAll(".ait-flag-badge, .ait-flag-inline").length, 0);
      assert.equal(doc.body.querySelectorAll(".ait-filtered-hidden").length, 0);
      assert.equal(doc.body.querySelectorAll(".ait-thumb-positioned").length, 0);
      assert.equal(doc.body.querySelectorAll("[data-ait-filter-applied]").length, 0);
      assert.equal(doc.getElementById("ait-filter-style"), null);
    });
  });

  test("clearFilter accepts an explicit root", () => {
    withFakeDom((doc) => {
      const { tile } = makeTile(doc);
      applyFilter("block", [{ tile, videoId: "a", score: 5 }]);
      assert.ok(tile.classList.contains("ait-filtered-hidden"));

      clearFilter(doc.body);

      assert.equal(tile.classList.contains("ait-filtered-hidden"), false);
      assert.equal(tile.getAttribute("data-ait-filter-applied"), null);
    });
  });

  test("off state clears a previously flagged tile via applyFilter itself", () => {
    withFakeDom((doc) => {
      const { tile } = makeTile(doc);
      applyFilter("flag", [{ tile, videoId: "a", score: 10 }]);
      assert.equal(tile.querySelectorAll(".ait-flag-badge, .ait-flag-inline").length, 2);

      applyFilter("off", [{ tile, videoId: "a", score: 10 }]);
      assert.equal(tile.querySelectorAll(".ait-flag-badge, .ait-flag-inline").length, 0);
      assert.equal(tile.getAttribute("data-ait-filter-applied"), "off");
    });
  });
});

// --- no innerHTML ------------------------------------------------------------------

test("filterRenderer.js never uses innerHTML (these nodes go into a page we don't control)", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./filterRenderer.js", import.meta.url)),
    "utf8",
  );
  assert.equal(source.includes("innerHTML"), false);
});
