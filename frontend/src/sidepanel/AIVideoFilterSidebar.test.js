import { test } from "node:test";
import assert from "node:assert/strict";

// --- Minimal hand-rolled DOM, just enough to drive the component --------
// No jsdom/linkedom dependency: createElement/appendChild/classList/
// addEventListener/querySelector/textContent/setAttribute/remove, plus a
// trivial ".class" selector engine.

class FakeClassList {
  constructor() {
    this._set = new Set();
  }
  add(...names) {
    for (const n of names) this._set.add(n);
  }
  remove(...names) {
    for (const n of names) this._set.delete(n);
  }
  toggle(name, force) {
    const has = this._set.has(name);
    const want = force === undefined ? !has : !!force;
    if (want) this._set.add(name);
    else this._set.delete(name);
    return want;
  }
  contains(name) {
    return this._set.has(name);
  }
  toString() {
    return [...this._set].join(" ");
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._attrs = new Map();
    this.classList = new FakeClassList();
    this._listeners = new Map();
    this._text = "";
    this.hidden = false;
  }

  set className(value) {
    this.classList = new FakeClassList();
    this.classList.add(...String(value).split(/\s+/).filter(Boolean));
  }
  get className() {
    return this.classList.toString();
  }

  set textContent(value) {
    this._text = String(value);
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }

  setAttribute(name, value) {
    this._attrs.set(name, String(value));
  }
  getAttribute(name) {
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }
  removeAttribute(name) {
    this._attrs.delete(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const idx = siblings.indexOf(this);
    if (idx !== -1) siblings.splice(idx, 1);
    this.parentNode = null;
  }

  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this._listeners.get(type)?.delete(handler);
  }
  listenerCount(type) {
    return this._listeners.get(type)?.size ?? 0;
  }
  dispatch(type, eventProps = {}) {
    const event = { type, defaultPrevented: false, preventDefault() {}, ...eventProps };
    for (const handler of this._listeners.get(type) ?? []) handler(event);
    return event;
  }
  click() {
    this.dispatch("click");
  }
  focus() {
    this.focused = true;
  }

  querySelectorAll(selector) {
    const wantClass = selector.startsWith(".") ? selector.slice(1) : null;
    const out = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (wantClass && child.classList.contains(wantClass)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
};

// The component's module-level default collaborators (getFilterState etc.)
// are never reached in these tests because every test injects its own
// getState/setState/subscribe - so no chrome shim is needed here at all.
const { createAIVideoFilterSidebar } = await import("./AIVideoFilterSidebar.js");

function makeRoot() {
  return new FakeElement("div");
}

function makeOptions({ initialState = "off" } = {}) {
  const stateChanges = [];
  const persisted = [];
  let subscribeCallback = null;

  const options = {
    getState: async () => initialState,
    setState: async (s) => {
      persisted.push(s);
    },
    subscribe: (cb) => {
      subscribeCallback = cb;
      return () => {
        subscribeCallback = null;
      };
    },
    onStateChange: (s) => stateChanges.push(s),
  };

  return {
    options,
    stateChanges,
    persisted,
    fireExternalChange: (s) => subscribeCallback?.(s),
    isSubscribed: () => subscribeCallback !== null,
  };
}

async function flush() {
  // Let the getState() promise chain (and any microtasks it schedules)
  // settle before assertions run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function segment(root, state) {
  return root
    .querySelectorAll(".ait-filter-segment")
    .find((btn) => btn.classList.contains(`ait-filter-segment-${state}`));
}

function toggle(root) {
  return root.querySelector(".ait-filter-toggle");
}

function label(root) {
  return root.querySelector(".ait-filter-label").textContent;
}

function filterRoot(root) {
  return (
    root.querySelectorAll(".ait-filter")[0] ??
    root.children.find((c) => c.classList.contains("ait-filter"))
  );
}

test("initial render reflects the loaded state", async () => {
  const root = makeRoot();
  const { options } = makeOptions({ initialState: "flag" });
  const widget = createAIVideoFilterSidebar(options);

  widget.mount(root);
  await flush();

  assert.equal(widget.getState(), "flag");
  assert.equal(label(root), "AI Filter: Flagging");
  const fr = filterRoot(root);
  assert.ok(fr.classList.contains("ait-filter-flag"));
});

test("clicking the toggle cycles off -> flag -> block -> off", async () => {
  const root = makeRoot();
  const { options } = makeOptions({ initialState: "off" });
  const widget = createAIVideoFilterSidebar(options);
  widget.mount(root);
  await flush();

  assert.equal(widget.getState(), "off");

  toggle(root).click();
  assert.equal(widget.getState(), "flag");

  toggle(root).click();
  assert.equal(widget.getState(), "block");

  toggle(root).click();
  assert.equal(widget.getState(), "off");
});

test("root class and label change per state", async () => {
  const root = makeRoot();
  const { options } = makeOptions({ initialState: "off" });
  const widget = createAIVideoFilterSidebar(options);
  widget.mount(root);
  await flush();

  const fr = filterRoot(root);

  toggle(root).click(); // -> flag
  assert.ok(fr.classList.contains("ait-filter-flag"));
  assert.ok(!fr.classList.contains("ait-filter-off"));
  assert.equal(label(root), "AI Filter: Flagging");

  toggle(root).click(); // -> block
  assert.ok(fr.classList.contains("ait-filter-block"));
  assert.ok(!fr.classList.contains("ait-filter-flag"));
  assert.equal(label(root), "AI Filter: Blocking");
});

test("clicking a specific segment jumps straight to it", async () => {
  const root = makeRoot();
  const { options } = makeOptions({ initialState: "off" });
  const widget = createAIVideoFilterSidebar(options);
  widget.mount(root);
  await flush();

  segment(root, "block").click();
  assert.equal(widget.getState(), "block");
  assert.equal(segment(root, "block").getAttribute("aria-pressed"), "true");
  assert.equal(segment(root, "off").getAttribute("aria-pressed"), "false");
});

test("setStats renders the count and hides entirely at total 0", async () => {
  const root = makeRoot();
  const { options } = makeOptions();
  const widget = createAIVideoFilterSidebar(options);
  widget.mount(root);
  await flush();

  widget.setStats({ analyzed: 3, total: 12 });
  const statsEl = root.querySelector(".ait-filter-stats");
  assert.equal(statsEl.hidden, false);
  assert.equal(statsEl.textContent, "3 of 12 analyzed");

  widget.setStats({ analyzed: 0, total: 0 });
  assert.equal(statsEl.hidden, true);
});

test("destroy() twice does not throw", async () => {
  const root = makeRoot();
  const { options } = makeOptions();
  const widget = createAIVideoFilterSidebar(options);
  widget.mount(root);
  await flush();

  assert.doesNotThrow(() => {
    widget.destroy();
    widget.destroy();
  });
  assert.equal(root.children.length, 0);
});

test("mount() twice does not duplicate DOM", async () => {
  const root = makeRoot();
  const { options } = makeOptions();
  const widget = createAIVideoFilterSidebar(options);

  widget.mount(root);
  await flush();
  const countAfterFirst = root.children.length;

  widget.mount(root);
  await flush();

  assert.equal(root.children.length, countAfterFirst);
});

test("an external subscribe callback updates the rendered UI", async () => {
  const root = makeRoot();
  const { options, fireExternalChange } = makeOptions({ initialState: "off" });
  const widget = createAIVideoFilterSidebar(options);
  widget.mount(root);
  await flush();

  fireExternalChange("block");

  assert.equal(widget.getState(), "block");
  assert.equal(label(root), "AI Filter: Blocking");
});

test("onStateChange fires on a user click but not on an external update", async () => {
  const root = makeRoot();
  const { options, stateChanges, fireExternalChange } = makeOptions({ initialState: "off" });
  const widget = createAIVideoFilterSidebar(options);
  widget.mount(root);
  await flush();

  toggle(root).click();
  assert.deepEqual(stateChanges, ["flag"]);

  fireExternalChange("block");
  assert.deepEqual(stateChanges, ["flag"]);
  assert.equal(widget.getState(), "block");
});

test("ArrowRight/ArrowLeft move focus between segments and update state", async () => {
  const root = makeRoot();
  const { options } = makeOptions({ initialState: "off" });
  const widget = createAIVideoFilterSidebar(options);
  widget.mount(root);
  await flush();

  segment(root, "off").dispatch("keydown", { key: "ArrowRight" });
  assert.equal(widget.getState(), "flag");
  assert.ok(segment(root, "flag").focused);

  segment(root, "flag").dispatch("keydown", { key: "ArrowLeft" });
  assert.equal(widget.getState(), "off");
});

test("public setState() syncs display without persisting or firing onStateChange", async () => {
  const root = makeRoot();
  const { options, stateChanges, persisted } = makeOptions({ initialState: "off" });
  const widget = createAIVideoFilterSidebar(options);
  widget.mount(root);
  await flush();

  widget.setState("block");

  assert.equal(widget.getState(), "block");
  assert.equal(label(root), "AI Filter: Blocking");
  assert.deepEqual(stateChanges, []);
  assert.deepEqual(persisted, []);
});
