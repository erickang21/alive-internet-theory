import { MESSAGE_TYPES } from "../shared/constants.js";
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
    removeOverlay();
    return;
  }
  if (videoId === currentVideoId) return;
  stopPolling();
  currentVideoId = videoId;

  renderLoading();
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
