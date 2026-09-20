import { test } from "node:test";
import assert from "node:assert/strict";

import { getFilterState, setFilterState, subscribeFilterState } from "./filterState.js";
import { FILTER_STORAGE_KEY, DEFAULT_FILTER_STATE } from "./constants.js";

// Minimal in-memory chrome.storage.local + onChanged fake. Real chrome.storage
// resolves get()/set() as promises under MV3 (no callback needed), which is
// what filterState.js relies on.
function installFakeChrome(initialStore = {}) {
  const store = { ...initialStore };
  const listeners = [];

  const dispatch = (key, value, areaName) => {
    const changes = { [key]: { oldValue: store[key], newValue: value } };
    if (areaName === "local") store[key] = value;
    for (const listener of [...listeners]) listener(changes, areaName);
  };

  globalThis.chrome = {
    storage: {
      local: {
        get(key) {
          if (typeof key === "string") {
            return Promise.resolve({ [key]: store[key] });
          }
          return Promise.resolve({ ...store });
        },
        set(obj) {
          for (const [k, v] of Object.entries(obj)) dispatch(k, v, "local");
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener(listener) {
          listeners.push(listener);
        },
        removeListener(listener) {
          const index = listeners.indexOf(listener);
          if (index !== -1) listeners.splice(index, 1);
        },
      },
    },
  };

  return {
    store,
    listenerCount: () => listeners.length,
    // Bypasses setFilterState's validation to simulate a corrupt/foreign
    // storage write, firing onChanged listeners the same way real
    // chrome.storage would (areaName defaults to "local").
    writeRaw(key, value, areaName = "local") {
      dispatch(key, value, areaName);
    },
  };
}

function uninstallFakeChrome() {
  delete globalThis.chrome;
}

// This must run before anything else touches filterState's module-level
// in-memory fallback, since setFilterState updates it unconditionally.
test("getFilterState falls back to the default when chrome is undefined", async () => {
  assert.equal("chrome" in globalThis, false);
  const state = await getFilterState();
  assert.equal(state, DEFAULT_FILTER_STATE);
});

test("setFilterState rejects an invalid state", async () => {
  await assert.rejects(() => setFilterState("nonsense"));
  await assert.rejects(() => setFilterState(null));
  await assert.rejects(() => setFilterState(undefined));
});

test("setFilterState + getFilterState round-trip through chrome.storage.local", async () => {
  installFakeChrome();
  try {
    await setFilterState("flag");
    assert.equal(await getFilterState(), "flag");

    await setFilterState("block");
    assert.equal(await getFilterState(), "block");
  } finally {
    uninstallFakeChrome();
  }
});

test("getFilterState returns the default for a corrupt stored value", async () => {
  const fake = installFakeChrome();
  try {
    fake.store[FILTER_STORAGE_KEY] = "not-a-real-state";
    assert.equal(await getFilterState(), DEFAULT_FILTER_STATE);
  } finally {
    uninstallFakeChrome();
  }
});

test("subscribeFilterState fires only for the right key and area", async () => {
  const fake = installFakeChrome();
  try {
    const seen = [];
    const unsubscribe = subscribeFilterState((state) => seen.push(state));

    fake.writeRaw(FILTER_STORAGE_KEY, "flag", "local");
    assert.deepEqual(seen, ["flag"]);

    unsubscribe();
  } finally {
    uninstallFakeChrome();
  }
});

test("subscribeFilterState ignores a different key and a different areaName", async () => {
  const fake = installFakeChrome();
  try {
    const seen = [];
    const unsubscribe = subscribeFilterState((state) => seen.push(state));

    // Wrong key, right area.
    fake.writeRaw("someOtherKey", "flag", "local");
    assert.deepEqual(seen, []);

    // Right key, wrong area (e.g. "sync" or "managed").
    fake.writeRaw(FILTER_STORAGE_KEY, "block", "sync");
    assert.deepEqual(seen, []);

    // Sanity check: the right key/area combination still works.
    fake.writeRaw(FILTER_STORAGE_KEY, "block", "local");
    assert.deepEqual(seen, ["block"]);

    unsubscribe();
  } finally {
    uninstallFakeChrome();
  }
});

test("unsubscribe stops delivery and is safe to call twice", async () => {
  const fake = installFakeChrome();
  try {
    const seen = [];
    const unsubscribe = subscribeFilterState((state) => seen.push(state));

    fake.writeRaw(FILTER_STORAGE_KEY, "flag", "local");
    assert.deepEqual(seen, ["flag"]);
    assert.equal(fake.listenerCount(), 1);

    unsubscribe();
    assert.equal(fake.listenerCount(), 0);

    fake.writeRaw(FILTER_STORAGE_KEY, "block", "local");
    assert.deepEqual(seen, ["flag"], "no further delivery after unsubscribe");

    assert.doesNotThrow(() => unsubscribe());
  } finally {
    uninstallFakeChrome();
  }
});
