import { test } from "node:test";
import assert from "node:assert/strict";

import { getAutoAnalyze, setAutoAnalyze, subscribeAutoAnalyze } from "./autoAnalyze.js";
import { AUTO_ANALYZE_STORAGE_KEY } from "./constants.js";

function installFakeChrome(initialStore = {}) {
  const store = { ...initialStore };
  const listeners = [];

  globalThis.chrome = {
    storage: {
      local: {
        get(key) {
          return Promise.resolve({ [key]: store[key] });
        },
        set(entries) {
          for (const [key, value] of Object.entries(entries)) {
            const changes = { [key]: { oldValue: store[key], newValue: value } };
            store[key] = value;
            for (const listener of [...listeners]) listener(changes, "local");
          }
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const index = listeners.indexOf(fn);
          if (index !== -1) listeners.splice(index, 1);
        },
      },
    },
  };
  return {
    store,
    emit: (changes, area = "local") => listeners.forEach((fn) => fn(changes, area)),
    listenerCount: () => listeners.length,
  };
}

test("defaults to off when chrome is unavailable", async () => {
  delete globalThis.chrome;
  assert.equal(await getAutoAnalyze(), false);
});

test("round-trips through chrome.storage.local", async () => {
  const fake = installFakeChrome();
  await setAutoAnalyze(true);
  assert.equal(fake.store[AUTO_ANALYZE_STORAGE_KEY], true);
  assert.equal(await getAutoAnalyze(), true);
  await setAutoAnalyze(false);
  assert.equal(await getAutoAnalyze(), false);
});

test("a stored non-boolean still reads as a boolean", async () => {
  installFakeChrome({ [AUTO_ANALYZE_STORAGE_KEY]: "yes" });
  assert.equal(await getAutoAnalyze(), true);
  installFakeChrome({ [AUTO_ANALYZE_STORAGE_KEY]: undefined });
  assert.equal(await getAutoAnalyze(), false);
});

test("a rejecting storage read falls back instead of throwing", async () => {
  installFakeChrome();
  await setAutoAnalyze(true);
  globalThis.chrome.storage.local.get = () => Promise.reject(new Error("context invalidated"));
  assert.equal(await getAutoAnalyze(), true);
});

test("subscribers fire only for this key in the local area", async () => {
  const fake = installFakeChrome();
  const seen = [];
  const unsubscribe = subscribeAutoAnalyze((on) => seen.push(on));

  fake.emit({ [AUTO_ANALYZE_STORAGE_KEY]: { newValue: true } });
  fake.emit({ somethingElse: { newValue: true } });
  fake.emit({ [AUTO_ANALYZE_STORAGE_KEY]: { newValue: true } }, "sync");
  assert.deepEqual(seen, [true]);

  unsubscribe();
  unsubscribe();
  assert.equal(fake.listenerCount(), 0);
  fake.emit({ [AUTO_ANALYZE_STORAGE_KEY]: { newValue: false } });
  assert.deepEqual(seen, [true]);
});
