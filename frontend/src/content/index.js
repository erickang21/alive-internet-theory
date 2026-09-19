import { MESSAGE_TYPES } from "../shared/constants.js";
import { getFilterState, subscribeFilterState } from "../shared/filterState.js";
import { applyFilter, clearFilter } from "./filterRenderer.js";
import { extractVideoId, findVideoTiles, observeVideoTiles } from "./videoScanner.js";
import {
  removeOverlay,
  renderError,
  renderEvaluation,
  renderLoading,
  renderNotAnalyzed,
} from "./overlay.js";

let currentVideoId = null;

// --- Tri-state AI video filter (tile grid, separate from the single-video overlay
// above) -----------------------------------------------------------------------------
//
// THE CRITICAL RULE: the side panel that lets someone change the filter state is
// closed almost all the time, and the manifest has no host permission for
// youtube.com (see REVIEW_NOTES), so chrome.tabs.sendMessage from a panel can never
// reach this content script. chrome.storage.local is therefore the source of truth:
// this module reads it on init, re-reads it on every SPA navigation, and subscribes
// to onChanged so the filter keeps applying with zero messages ever received. The
// onMessage listener below is purely an optional instant-update fast path for tabs
// that happen to be open and somehow do receive it (e.g. a future host-permission
// grant) — nothing here may depend on it firing.

// Last {analyzed, total} counts, exposed for a future stats readout (e.g. a panel
// polling this, or a badge). Kept simple: a module-level value plus a getter, no
// event system, since nothing consumes it yet.
let lastFilterStats = { analyzed: 0, total: 0 };

export function getFilterStats() {
  return lastFilterStats;
}

async function scoresForVideoIds(videoIds) {
  if (videoIds.length === 0) return {};
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.GET_EVALUATIONS,
      videoIds,
    });
    if (!response?.ok) return {};
    return response.scores ?? {};
  } catch (error) {
    // Background unreachable (e.g. extension reloading) — treat every id as
    // not-yet-analyzed rather than throwing out of a mutation-observer callback.
    console.warn("[alive-internet-theory]", error);
    return {};
  }
}

async function rescanAndApplyFilter(tiles) {
  // "Off" means leave no trace, not "decorate nothing": clearFilter is what removes the
  // injected <style> tag and any decoration left over from a previous state. Doing this
  // before any network work also keeps the default state from touching the page at all.
  if ((await getFilterState()) === "off") {
    clearFilter();
    lastFilterStats = { analyzed: 0, total: 0 };
    return;
  }

  const candidateTiles = tiles ?? findVideoTiles();

  // A tile whose id can't be extracted yet (renders before its anchor does) is simply
  // skipped here, so it's left with no `score` entry below and applyFilter renders it
  // normally rather than treating it as filterable.
  const idByTile = new Map();
  for (const tile of candidateTiles) {
    const videoId = extractVideoId(tile);
    if (videoId) idByTile.set(tile, videoId);
  }

  const uniqueIds = Array.from(new Set(idByTile.values()));
  const scores = await scoresForVideoIds(uniqueIds);

  lastFilterStats = {
    total: uniqueIds.length,
    analyzed: uniqueIds.filter((id) => scores[id] !== null && scores[id] !== undefined).length,
  };

  const tilesWithScores = Array.from(idByTile.entries()).map(([tile, videoId]) => ({
    tile,
    videoId,
    score: scores[videoId] ?? null,
  }));

  const state = await getFilterState();
  applyFilter(state, tilesWithScores);
}

// Re-apply whenever the stored filter state changes (panel elsewhere, another tab, or
// this tab's own panel if one is ever added) — this is what keeps the filter live
// while no UI is open in this tab at all.
subscribeFilterState(() => {
  rescanAndApplyFilter();
});

// New tiles render constantly while scrolling/navigating; videoScanner's observer is
// already debounced.
observeVideoTiles((tiles) => {
  rescanAndApplyFilter(tiles);
});

// Optional instant-update fast path only — see the block comment above. Returning
// `true` would keep the message channel open for an async sendResponse, but there is
// nothing useful to respond with here, so the listener stays synchronous.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== MESSAGE_TYPES.SET_FILTER_STATE) return false;
  rescanAndApplyFilter();
  return false;
});

// Initial pass: storage is the source of truth, so this must not wait on any message.
rescanAndApplyFilter();

function getVideoIdFromUrl() {
  const url = new URL(location.href);
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const shortsMatch = url.pathname.match(/^\/shorts\/([\w-]+)/);
  return shortsMatch ? shortsMatch[1] : null;
}

async function showCurrentVideo() {
  const videoId = getVideoIdFromUrl();
  if (!videoId) {
    currentVideoId = null;
    removeOverlay();
    return;
  }
  if (videoId === currentVideoId) return;
  currentVideoId = videoId;

  renderLoading();
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.GET_EVALUATION,
      videoId,
    });

    if (videoId !== currentVideoId) return;
    if (!response?.ok) {
      throw new Error(response?.error ?? "no response from service worker");
    }
    if (response.evaluation) renderEvaluation(response.evaluation);
    else renderNotAnalyzed();
  } catch (error) {
    if (videoId !== currentVideoId) return;
    console.warn("[alive-internet-theory]", error);
    renderError("Couldn't reach the backend. Is it running?");
  }
}

// YouTube is an SPA: yt-navigate-finish fires on every in-app navigation,
// including the initial load in most cases; the direct call covers the rest.
document.addEventListener("yt-navigate-finish", showCurrentVideo);
showCurrentVideo();

// Grid filter re-scan: additive to the single-video overlay logic above, same SPA
// event. A fresh set of tiles (new search results / new channel grid) needs the
// filter re-applied after every in-app navigation.
document.addEventListener("yt-navigate-finish", () => rescanAndApplyFilter());
