import { MESSAGE_TYPES } from "../shared/constants.js";
import { getFilterState, subscribeFilterState } from "../shared/filterState.js";
import { getCachedScores } from "../shared/scoreCache.js";
import { mountFactCheckFor, unmountFactCheck } from "./factCheckMount.js";
import { applyFilter, clearFilter } from "./filterRenderer.js";
import { extractVideoId, findVideoTiles, observeVideoTiles } from "./videoScanner.js";
import {
  removeOverlay,
  renderError,
  renderEvaluation,
  renderLoading,
  renderNotAnalyzed,
} from "./overlay.js";

// Indexing a video takes a minute or two in the backend, so keep asking while it
// runs instead of making the viewer reopen the video. The jitter keeps a handful
// of open tabs from hitting the backend on the same tick.
const POLL_INTERVAL_MS = 30_000;
const POLL_JITTER_MS = 2_000;

let currentVideoId = null;
let pollTimer = null;

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

// Reads the persistent score cache directly (no background round trip - content
// scripts already read chrome.storage.local directly for filter state, for the same
// reason: the side panel that could message this tab is closed almost all the time).
// This is what makes a revisited video flag instantly instead of after a fetch: the
// cache survives service-worker restarts even though the in-memory Map in background
// doesn't.
async function cachedScoresForVideoIds(videoIds) {
  if (videoIds.length === 0) return {};
  try {
    const records = await getCachedScores(videoIds);
    const scores = {};
    for (const [id, record] of Object.entries(records)) scores[id] = record?.score ?? null;
    return scores;
  } catch (error) {
    console.warn("[alive-internet-theory]", error);
    return {};
  }
}

function applyScoresToTiles(state, idByTile, scores) {
  const tilesWithScores = Array.from(idByTile.entries()).map(([tile, videoId]) => ({
    tile,
    videoId,
    score: scores[videoId] ?? null,
  }));
  applyFilter(state, tilesWithScores);
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
  const state = await getFilterState();

  // Instant pass, BEFORE asking the background for anything: a video seen (and
  // cached) in a previous session flags on first paint instead of after a round
  // trip through GET_EVALUATIONS. applyFilter is idempotent per tile (see
  // filterRenderer's module header), so re-running it below once fresh scores
  // arrive is always safe, never a flicker for a tile whose state didn't change.
  const cachedScores = await cachedScoresForVideoIds(uniqueIds);
  applyScoresToTiles(state, idByTile, cachedScores);

  // Then refresh: the background may know about a video newly analyzed since it
  // was last cached, or a real score that supersedes a cached "not analyzed" miss.
  // Merged over the cached pass, because scoresForVideoIds returns {} when the
  // worker is unreachable - exactly the case the persistent cache exists for -
  // and applying that bare would strip every flag the first pass just drew.
  const freshScores = await scoresForVideoIds(uniqueIds);
  const mergedScores = { ...cachedScores, ...freshScores };

  lastFilterStats = {
    total: uniqueIds.length,
    analyzed: uniqueIds.filter((id) => mergedScores[id] !== null && mergedScores[id] !== undefined)
      .length,
  };

  applyScoresToTiles(state, idByTile, mergedScores);
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
    stopPolling();
    currentVideoId = null;
    unmountFactCheck();
    removeOverlay();
    return;
  }
  if (videoId === currentVideoId) return;
  stopPolling();
  currentVideoId = videoId;

  renderLoading();
  // Independent of the AI-score poll below: that poll stops the moment a
  // score renders (see poll()/showEvaluation() and factCheckBridge.js's
  // module comment for why), but the fact-check for the same video can still
  // be minutes away. mountFactCheckFor tears down any previous video's card,
  // subscription and poll timer before starting this one's, so a fast
  // navigation never leaves a stale bridge writing records for the old video.
  mountFactCheckFor(videoId);
  await poll(videoId);
}

function stopPolling() {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
}

async function poll(videoId) {
  pollTimer = null;
  if (await showEvaluation(videoId)) return;
  const delay = POLL_INTERVAL_MS + (Math.random() * 2 - 1) * POLL_JITTER_MS;
  pollTimer = setTimeout(() => poll(videoId), delay);
}

/** Renders the video's state, and returns whether it's settled: a score on screen
 * (or a video we've navigated away from) is nothing left to poll for. */
async function showEvaluation(videoId) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.REQUEST_EVALUATION,
      videoId,
    });

    if (videoId !== currentVideoId) return true;
    if (!response?.ok) {
      throw new Error(response?.error ?? "no response from service worker");
    }
    // An unanalyzed video comes back as a status, not an evaluation. The request
    // itself has queued it for indexing in the background; the viewer only sees
    // that it isn't analyzed yet, and the next poll picks up the verdict.
    if (response.result.status) {
      renderNotAnalyzed();
      return false;
    }
    renderEvaluation(response.result);
    return true;
  } catch (error) {
    if (videoId !== currentVideoId) return true;
    console.warn("[alive-internet-theory]", error);
    renderError("Couldn't reach the backend. Is it running?");
    return false;
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
