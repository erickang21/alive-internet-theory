import { MESSAGE_TYPES } from "../shared/constants.js";
import { getFilterState, subscribeFilterState } from "../shared/filterState.js";
import { applyFilter, clearFilter } from "./filterRenderer.js";
import { extractVideoId, findVideoTiles, observeVideoTiles } from "./videoScanner.js";

const RESCAN_DELAY_MS = 250;

// chrome.storage.local is the source of truth: the filter applies on load, on
// navigation and on every storage change, without the settings UI being open.
export function initFilter() {
  // Let the settings switch finish sliding before the rescan takes the main thread.
  subscribeFilterState(() => setTimeout(rescan, RESCAN_DELAY_MS));
  observeVideoTiles((tiles) => rescan(tiles));
  document.addEventListener("yt-navigate-finish", () => rescan());
  rescan();
}

async function rescan(tiles) {
  if ((await getFilterState()) === "off") {
    clearFilter();
    return;
  }

  const idByTile = new Map();
  for (const tile of tiles ?? findVideoTiles()) {
    const videoId = extractVideoId(tile);
    if (videoId) idByTile.set(tile, videoId);
  }

  const scores = await scoresFor([...new Set(idByTile.values())]);
  const scored = [...idByTile].map(([tile, videoId]) => ({
    tile,
    videoId,
    score: scores[videoId] ?? null,
  }));
  applyFilter(await getFilterState(), scored);
}

async function scoresFor(videoIds) {
  if (!videoIds.length) return {};
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.GET_EVALUATIONS,
      videoIds,
    });
    return response?.ok ? response.result : {};
  } catch (error) {
    console.warn("[alive-internet-theory]", error);
    return {};
  }
}
