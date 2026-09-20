// No jsdom/linkedom: FactCheckCard only touches a small, well-known slice of
// the DOM API, so we hand-roll a fake `document` here that supports exactly
// that slice (createElement, append/appendChild/replaceChildren/remove,
// className/classList, textContent, attributes, hidden, addEventListener +
// a `.click()` to dispatch, and a small querySelector(All) engine). This
// keeps the test free of new dependencies while still exercising the real
// component code, unmodified, against a real (if minimal) tree.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { createFactCheckCard } from "./FactCheckCard.js";

// --- fake DOM ----------------------------------------------------------------

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this._text = "";
    this._className = "";
    this._attrs = new Map();
    this._listeners = new Map();
    this.hidden = false;
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
      contains(name) {
        return names().includes(name);
      },
      toggle(name, force) {
        const has = names().includes(name);
        const shouldHave = force === undefined ? !has : force;
        const set = new Set(names());
        if (shouldHave) set.add(name);
        else set.delete(name);
        write(set);
        return shouldHave;
      },
    };
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this._text = value === undefined || value === null ? "" : String(value);
  }

  setAttribute(name, value) {
    this._attrs.set(name, String(value));
    if (name === "id") this.id = String(value);
  }
  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }
  remove() {
    if (!this.parent) return;
    const siblings = this.parent.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parent = null;
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners.get(type);
    if (!list) return;
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  dispatchEvent(type, event = { type }) {
    for (const handler of this._listeners.get(type) ?? []) handler(event);
  }
  click() {
    this.dispatchEvent("click");
  }

  querySelector(selector) {
    return queryAll(this, selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    return queryAll(this, selector);
  }
}

function descendantsOf(node) {
  const out = [];
  for (const child of node.children) {
    out.push(child);
    out.push(...descendantsOf(child));
  }
  return out;
}

// Supports simple selectors (tag, .class, #id, and tag/.class/#id combined,
// e.g. "li.ait-fc-verdict") plus a plain descendant combinator ("ul li").
// That is everything FactCheckCard's markup needs; it is not a CSS engine.
function matchesSimple(node, token) {
  if (token === "*") return true;
  let rest = token;
  const idMatch = rest.match(/#([\w-]+)/);
  if (idMatch) rest = rest.replace(idMatch[0], "");
  const classNames = [...rest.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  rest = rest.replace(/\.[\w-]+/g, "");
  const tag = rest || null;
  if (tag && node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  if (idMatch && node.getAttribute("id") !== idMatch[1]) return false;
  return classNames.every((name) => node.classList.contains(name));
}

function hasMatchingAncestor(node, token) {
  let cur = node.parent;
  while (cur) {
    if (matchesSimple(cur, token)) return true;
    cur = cur.parent;
  }
  return false;
}

function queryAll(root, selector) {
  const tokens = selector.trim().split(/\s+/);
  let matches = descendantsOf(root).filter((node) =>
    matchesSimple(node, tokens[tokens.length - 1]),
  );
  for (let i = tokens.length - 2; i >= 0; i--) {
    const token = tokens[i];
    matches = matches.filter((node) => hasMatchingAncestor(node, token));
  }
  return matches;
}

beforeEach(() => {
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
});
afterEach(() => {
  delete globalThis.document;
});

// --- helpers -------------------------------------------------------------

function baseRecord(overrides = {}) {
  return {
    videoId: "v1",
    stage: "idle",
    updatedAt: "2026-09-19T00:00:00.000Z",
    schemaVersion: 1,
    pregate: null,
    result: null,
    error: null,
    ...overrides,
  };
}

function mountCard(initialData, options = {}) {
  const container = new FakeElement("div");
  const card = createFactCheckCard(options);
  card.mount(container, initialData);
  return { card, container, root: container.children[0] };
}

const CITATION = {
  title: "Example News",
  domain: "example.com",
  url: "https://example.com/a",
  quote: "The counter-quote text.",
};

function completeRecord(overrides = {}) {
  return baseRecord({
    stage: "complete",
    result: {
      validityScore: 72.5,
      rating: "Mostly Reliable",
      lowConfidence: false,
      claimCount: 2,
      verifiableCount: 2,
      countsByStatus: { verified_true: 1, false: 1 },
      verdicts: [
        {
          claimId: "c1",
          claimText: "A true claim.",
          timestampS: 10,
          status: "verified_true",
          debunk: null,
          citations: [],
        },
        {
          claimId: "c2",
          claimText: "A false claim.",
          timestampS: 95,
          status: "false",
          debunk: "Independent sources contradict this.",
          citations: [CITATION],
        },
      ],
      ...overrides.result,
    },
    ...overrides,
  });
}

// --- idle ------------------------------------------------------------------

test("idle with undefined data renders nothing and hides the root", () => {
  const { root } = mountCard(undefined);
  assert.equal(root.hidden, true);
  assert.equal(root.querySelector(".ait-fc-body").children.length, 0);
});

test("an explicit idle record also renders nothing", () => {
  const { root } = mountCard(baseRecord({ stage: "idle" }));
  assert.equal(root.hidden, true);
});

// --- pending -----------------------------------------------------------------

for (const stage of ["checking_eligibility", "fact_checking"]) {
  test(`${stage} renders the pending state with skeleton bars`, () => {
    const { root } = mountCard(baseRecord({ stage }));
    assert.equal(root.hidden, false);
    assert.ok(root.textContent.includes("Verifying sources…"));
    assert.equal(root.querySelectorAll(".ait-fc-skeleton-bar").length, 3);
  });
}

// --- complete ----------------------------------------------------------------

test("complete renders the score as a percentage and the rating label", () => {
  const { root } = mountCard(completeRecord());
  assert.equal(root.querySelector(".ait-fc-score").textContent, "72.5%");
  assert.equal(root.querySelector(".ait-fc-rating").textContent, "Mostly Reliable");
});

test("complete with a null validityScore shows only the rating, never 'null%'", () => {
  const record = completeRecord({
    result: {
      validityScore: null,
      rating: "Insufficient Verifiable Data",
      claimCount: 0,
      verifiableCount: 0,
      verdicts: [],
    },
  });
  const { root } = mountCard(record);
  assert.equal(root.querySelector(".ait-fc-score"), null);
  assert.ok(!root.textContent.toLowerCase().includes("null"));
  assert.ok(root.textContent.includes("Insufficient Verifiable Data"));
});

test("lowConfidence renders the low-confidence note", () => {
  const { root } = mountCard(completeRecord({ result: { lowConfidence: true } }));
  assert.ok(root.textContent.includes("Based on only a few verifiable claims."));
});

test("the claims list is collapsed by default and the toggle expands it", () => {
  const { root } = mountCard(completeRecord());
  assert.equal(root.querySelectorAll(".ait-fc-verdicts").length, 0);
  const toggle = root.querySelector(".ait-fc-toggle");
  assert.ok(toggle, "expected a toggle button");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  toggle.click();

  assert.equal(root.querySelectorAll(".ait-fc-verdicts").length, 1);
  const items = root.querySelectorAll("li.ait-fc-verdict");
  assert.equal(items.length, 2);
  assert.equal(root.querySelector(".ait-fc-claim").textContent, "A false claim.");
  assert.equal(
    root.querySelector(".ait-fc-debunk").textContent,
    "Independent sources contradict this.",
  );
  const quote = root.querySelector("blockquote.ait-fc-quote");
  assert.ok(quote, "expected a blockquoted counter-quote");
  assert.equal(quote.textContent, "The counter-quote text.");
  const link = root.querySelector("a.ait-fc-source");
  assert.ok(link, "expected a citation link");
  assert.equal(link.href, "https://example.com/a");
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
});

test("disputed claims (false/misleading) sort before others when expanded", () => {
  const record = completeRecord({
    result: {
      claimCount: 3,
      verifiableCount: 3,
      verdicts: [
        {
          claimId: "c1",
          claimText: "True one.",
          timestampS: null,
          status: "verified_true",
          debunk: null,
          citations: [],
        },
        {
          claimId: "c2",
          claimText: "Misleading one.",
          timestampS: null,
          status: "misleading",
          debunk: "Missing context.",
          citations: [],
        },
        {
          claimId: "c3",
          claimText: "False one.",
          timestampS: null,
          status: "false",
          debunk: "Wrong.",
          citations: [],
        },
      ],
    },
  });
  const { root } = mountCard(record);
  root.querySelector(".ait-fc-toggle").click();
  const items = root.querySelectorAll("li.ait-fc-verdict");
  assert.equal(items.length, 3);
  assert.ok(items[0].classList.contains("ait-fc-verdict-misleading"));
  assert.ok(items[1].classList.contains("ait-fc-verdict-false"));
  assert.ok(items[2].classList.contains("ait-fc-verdict-verified_true"));
});

// --- skipped_fiction -----------------------------------------------------------

test("skipped_fiction renders pregate.reason verbatim", () => {
  const record = baseRecord({
    stage: "skipped_fiction",
    pregate: {
      isEligible: false,
      category: "Gaming",
      reason: "This video is gameplay commentary.",
      source: "category",
    },
  });
  const { root } = mountCard(record);
  assert.ok(root.textContent.includes("This video is gameplay commentary."));
});

test("skipped_fiction with a fallback pregate is worded as 'couldn't classify', not fiction", () => {
  const record = baseRecord({
    stage: "skipped_fiction",
    pregate: {
      isEligible: false,
      category: "unknown",
      reason: "We couldn't confidently classify this video's content.",
      source: "fallback",
    },
  });
  const { root } = mountCard(record);
  const text = root.textContent.toLowerCase();
  assert.ok(text.includes("classif"), "expected wording about classification");
  assert.ok(
    !text.includes("fiction"),
    "must not call it fiction when we only failed to classify it",
  );
});

// --- failed --------------------------------------------------------------------

test("failed renders error.message; retryable shows a working retry button", () => {
  let retriedVideoId = null;
  const { root } = mountCard(
    baseRecord({
      stage: "failed",
      videoId: "v42",
      error: { message: "Backend unavailable.", retryable: true },
    }),
    { onRetry: (videoId) => (retriedVideoId = videoId) },
  );
  assert.ok(root.textContent.includes("Backend unavailable."));
  const button = root.querySelector(".ait-fc-retry");
  assert.ok(button, "expected a retry button");
  button.click();
  assert.equal(retriedVideoId, "v42");
});

test("a non-retryable failure renders no retry button", () => {
  const { root } = mountCard(
    baseRecord({
      stage: "failed",
      error: { message: "No transcript available.", retryable: false },
    }),
  );
  assert.ok(root.textContent.includes("No transcript available."));
  assert.equal(root.querySelector(".ait-fc-retry"), null);
});

// --- mount/unmount lifecycle -----------------------------------------------------

test("mount() twice does not duplicate DOM", () => {
  const container = new FakeElement("div");
  const card = createFactCheckCard({});
  card.mount(container, baseRecord({ stage: "fact_checking" }));
  card.mount(container, baseRecord({ stage: "fact_checking" }));
  assert.equal(container.children.length, 1);
});

test("unmount() twice does not throw, and unmount() before mount() does not throw", () => {
  const card = createFactCheckCard({});
  assert.doesNotThrow(() => card.unmount());
  const container = new FakeElement("div");
  card.mount(container, baseRecord({ stage: "fact_checking" }));
  card.unmount();
  assert.doesNotThrow(() => card.unmount());
  assert.equal(container.children.length, 0);
});

// --- state transitions leak no nodes ------------------------------------------

const STAGE_RECORDS = {
  idle: baseRecord({ stage: "idle" }),
  checking_eligibility: baseRecord({ stage: "checking_eligibility" }),
  fact_checking: baseRecord({ stage: "fact_checking" }),
  complete: completeRecord(),
  skipped_fiction: baseRecord({
    stage: "skipped_fiction",
    pregate: {
      isEligible: false,
      category: "Gaming",
      reason: "Gameplay video.",
      source: "category",
    },
  }),
  failed: baseRecord({ stage: "failed", error: { message: "Boom.", retryable: true } }),
};

// Markers unique enough to each state that finding one after switching away
// means a node leaked from the previous render.
const MARKERS = {
  idle: [],
  checking_eligibility: [".ait-fc-pending"],
  fact_checking: [".ait-fc-pending"],
  complete: [".ait-fc-score", ".ait-fc-rating", ".ait-fc-toggle"],
  skipped_fiction: [".ait-fc-skipped"],
  failed: [".ait-fc-failed"],
};

const stages = Object.keys(STAGE_RECORDS);
for (const from of stages) {
  for (const to of stages) {
    if (from === to) continue;
    test(`update() ${from} -> ${to} leaves no nodes from the previous state`, () => {
      const { root, card } = mountCard(STAGE_RECORDS[from]);
      card.update(STAGE_RECORDS[to]);
      for (const marker of MARKERS[from]) {
        if (MARKERS[to].includes(marker)) continue;
        assert.equal(
          root.querySelectorAll(marker).length,
          0,
          `${marker} leaked from ${from} into ${to}`,
        );
      }
      const body = root.querySelector(".ait-fc-body");
      assert.ok(body.children.length <= 1, "body should hold at most one top-level render");
    });
  }
}

test("complete -> skipped_fiction leaves no score badge", () => {
  const { root, card } = mountCard(completeRecord());
  card.update(STAGE_RECORDS.skipped_fiction);
  assert.equal(root.querySelectorAll(".ait-fc-score").length, 0);
});

test("update() to a different videoId resets the expanded state", () => {
  const { root, card } = mountCard(completeRecord({ videoId: "v1" }));
  root.querySelector(".ait-fc-toggle").click();
  assert.ok(root.querySelector(".ait-fc-verdicts"));

  card.update(completeRecord({ videoId: "v2" }));
  assert.equal(root.querySelector(".ait-fc-verdicts"), null);
});

// --- no innerHTML ----------------------------------------------------------------

test("the component never uses innerHTML", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./FactCheckCard.js", import.meta.url)),
    "utf8",
  );
  // Matches real usage (`.innerHTML =`, `.innerHTML)`, etc.), not the doc
  // comment at the top of the file that explains *why* it avoids innerHTML.
  assert.ok(
    !/\.innerHTML\b/.test(source),
    "FactCheckCard renders model/scraped text and must avoid innerHTML",
  );
});
