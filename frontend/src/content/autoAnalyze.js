import { getAutoAnalyze, subscribeAutoAnalyze } from "../shared/autoAnalyze.js";
import { MESSAGE_TYPES } from "../shared/constants.js";
import { extractVideoId, findVideoTiles, observeVideoTiles } from "./videoScanner.js";

// Three at a time. The backend runs its own small pool, so this is only here to keep a
// feed from handing it hundreds of ids at once; it is not the real rate limit.
const MAX_IN_FLIGHT = 3;
// Indexing a video takes tens of seconds, so the ones still running are asked about again
// on this interval. That is what turns a queued tile into a flagged one without a reload.
const RETRY_MS = 15_000;
// Queue a tile slightly before it scrolls into view, so its verdict is more often there
// by the time it is.
const ROOT_MARGIN = "200px";

let enabled = false;
let rescanFeed = () => {};
let observer = null;
let stopWatchingTiles = null;
let retryTimer = null;
// Set while the video the viewer is actually on has no verdict yet. Tiles keep being
// collected, they just aren't sent, so the watched video gets the backend to itself.
let held = false;

// Every id queued since the mode was last turned on, so a tile scrolling past twice is
// only sent once.
const queued = new Set();
const waiting = [];
// Ids the backend says it is still working on, re-asked about every RETRY_MS.
const indexing = new Set();
let inFlight = 0;

/** Watches the feed while the mode is on, queueing each video as it comes into view.
 * `onResolved` runs whenever a verdict lands, to repaint the tiles. */
export function initAutoAnalyze(onResolved) {
  rescanFeed = onResolved;
  subscribeAutoAnalyze((on) => (on ? start() : stop()));
  getAutoAnalyze()
    .then((on) => on && start())
    .catch(() => {});
}

function start() {
  if (enabled) return;
  enabled = true;
  observer = new IntersectionObserver(onIntersect, { rootMargin: ROOT_MARGIN });
  stopWatchingTiles = observeVideoTiles(watch);
  watch();
  scheduleRetry();
}

function stop() {
  enabled = false;
  observer?.disconnect();
  observer = null;
  stopWatchingTiles?.();
  stopWatchingTiles = null;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  // Forget what was queued, so turning the mode back on sweeps the feed again rather
  // than skipping every tile already on the page. A stored video costs one read.
  clearQueue();
}

// In-flight sends are deliberately not counted here: they cannot be recalled, and they
// unwind `inFlight` themselves when they settle.
function clearQueue() {
  queued.clear();
  waiting.length = 0;
  indexing.clear();
}

function watch(tiles) {
  if (!observer) return;
  // observe() on an element already being observed is a no-op, so re-running this over
  // the whole feed on every DOM burst only picks up the new tiles.
  for (const tile of tiles ?? findVideoTiles()) observer.observe(tile);
}

function onIntersect(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    observer?.unobserve(entry.target);
    const videoId = extractVideoId(entry.target);
    if (!videoId || queued.has(videoId)) continue;
    queued.add(videoId);
    waiting.push(videoId);
  }
  pump();
}

/** Called when the viewer moves to a new video. Two things happen, both about not
 * spending the backend on the wrong thing: whatever was queued for the page just left is
 * dropped, since those tiles are gone, and nothing more is sent until the new video has
 * its own verdict. The backend runs two analyses at a time, so without the hold a watch
 * page's up-next tiles take slots from the video the viewer is actually waiting on. */
export function holdFeed() {
  held = true;
  // Start the new page over. Re-asking about a video that turns out to be analyzed
  // already is one read, which is cheaper than finishing a queue nobody can see.
  clearQueue();
}

/** Called once the watched video has a verdict or has definitively failed, and on any
 * page that has no watched video to wait for. The backlog collected meanwhile drains. */
export function releaseFeed() {
  if (!held) return;
  held = false;
  pump();
}

function pump() {
  while (enabled && !held && inFlight < MAX_IN_FLIGHT && waiting.length) {
    void send(waiting.shift());
  }
}

async function send(videoId) {
  inFlight += 1;
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.QUEUE_ANALYSIS,
      videoId,
    });
    if (!response?.ok) {
      throw new Error(response?.error ?? "no response from service worker");
    }
    if (response.result.status === "indexing") {
      indexing.add(videoId);
    } else {
      // A score, or an analysis the backend has given up on: either way there is nothing
      // left to wait for, and a score means the tile can be marked now.
      indexing.delete(videoId);
      rescanFeed();
    }
  } catch (error) {
    console.warn("[alive-internet-theory]", error);
    indexing.delete(videoId);
  } finally {
    inFlight -= 1;
    pump();
  }
}

function scheduleRetry() {
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!enabled) return;
    for (const videoId of indexing) {
      if (!waiting.includes(videoId)) waiting.push(videoId);
    }
    pump();
    scheduleRetry();
  }, RETRY_MS);
}
