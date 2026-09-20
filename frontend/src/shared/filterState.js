// The side panel is closed almost all the time, so chrome.storage.local is
// the source of truth for the AI video filter, not the panel's in-memory
// state. The content script re-reads storage on init and subscribes to
// onChanged so the filter keeps applying with no UI alive; chrome.storage
// is a promise-first API in MV3, so get/set are awaited directly.
//
// `chrome` (or `chrome.storage`) is undefined in the demo harness and in
// these tests, so every entry point below falls back to a module-level
// in-memory value instead of throwing.

import { DEFAULT_FILTER_STATE, FILTER_STATES, FILTER_STORAGE_KEY } from "./constants.js";

function isValidState(value) {
  return FILTER_STATES.includes(value);
}

function hasChromeStorage() {
  return typeof chrome !== "undefined" && !!chrome?.storage?.local;
}

// Fallback store used whenever chrome.storage isn't available.
let memoryState = DEFAULT_FILTER_STATE;

export async function getFilterState() {
  if (!hasChromeStorage()) return memoryState;

  try {
    const result = await chrome.storage.local.get(FILTER_STORAGE_KEY);
    const stored = result?.[FILTER_STORAGE_KEY];
    // A corrupt or unrecognized stored value must never leak past this
    // module - callers can always trust the return value is a real state.
    return isValidState(stored) ? stored : DEFAULT_FILTER_STATE;
  } catch {
    // chrome.storage can reject (e.g. extension context invalidated);
    // never let that surface as a rejected promise to callers.
    return memoryState;
  }
}

export async function setFilterState(state) {
  if (!isValidState(state)) {
    throw new Error(`Invalid filter state: ${String(state)}`);
  }

  memoryState = state;

  if (!hasChromeStorage()) return;

  try {
    await chrome.storage.local.set({ [FILTER_STORAGE_KEY]: state });
  } catch {
    // Storage write failed (context invalidated, etc). The in-memory value
    // is already updated above so this tab stays consistent with itself;
    // there's nothing more useful to do without a UI to surface an error.
  }
}

export function subscribeFilterState(callback) {
  const canSubscribe =
    typeof chrome !== "undefined" &&
    typeof chrome?.storage?.onChanged?.addListener === "function" &&
    typeof chrome?.storage?.onChanged?.removeListener === "function";

  if (!canSubscribe) {
    // No storage to watch (demo harness / tests) - nothing to unsubscribe.
    return () => {};
  }

  const listener = (changes, areaName) => {
    if (areaName !== "local") return;
    if (!Object.prototype.hasOwnProperty.call(changes, FILTER_STORAGE_KEY)) return;

    const newValue = changes[FILTER_STORAGE_KEY].newValue;
    callback(isValidState(newValue) ? newValue : DEFAULT_FILTER_STATE);
  };

  chrome.storage.onChanged.addListener(listener);

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    chrome.storage.onChanged.removeListener(listener);
  };
}
