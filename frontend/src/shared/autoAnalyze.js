// Whether the content script queues the feed's videos for analysis as they scroll past.
// Like the filter, this lives in chrome.storage.local rather than in the settings UI,
// because the popup is closed almost all of the time and the content script is not.
//
// `chrome` (or `chrome.storage`) is undefined in the demo harness and in these tests, so
// every entry point below falls back to a module-level in-memory value instead of throwing.

import { AUTO_ANALYZE_STORAGE_KEY } from "./constants.js";

function hasChromeStorage() {
  return typeof chrome !== "undefined" && !!chrome?.storage?.local;
}

// Fallback store used whenever chrome.storage isn't available.
let memoryState = false;

export async function getAutoAnalyze() {
  if (!hasChromeStorage()) return memoryState;

  try {
    const result = await chrome.storage.local.get(AUTO_ANALYZE_STORAGE_KEY);
    return !!result?.[AUTO_ANALYZE_STORAGE_KEY];
  } catch {
    // chrome.storage rejects once the extension context is invalidated; never let that
    // surface as a rejected promise to callers.
    return memoryState;
  }
}

export async function setAutoAnalyze(on) {
  memoryState = !!on;

  if (!hasChromeStorage()) return;

  try {
    await chrome.storage.local.set({ [AUTO_ANALYZE_STORAGE_KEY]: memoryState });
  } catch {
    // The write failed (context invalidated, etc). The in-memory value is already
    // updated, so this tab stays consistent with itself.
  }
}

export function subscribeAutoAnalyze(callback) {
  const canSubscribe =
    typeof chrome !== "undefined" &&
    typeof chrome?.storage?.onChanged?.addListener === "function" &&
    typeof chrome?.storage?.onChanged?.removeListener === "function";

  if (!canSubscribe) return () => {};

  const listener = (changes, areaName) => {
    if (areaName !== "local") return;
    if (!Object.prototype.hasOwnProperty.call(changes, AUTO_ANALYZE_STORAGE_KEY)) return;
    callback(!!changes[AUTO_ANALYZE_STORAGE_KEY].newValue);
  };

  chrome.storage.onChanged.addListener(listener);

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    chrome.storage.onChanged.removeListener(listener);
  };
}
