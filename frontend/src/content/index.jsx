import { MESSAGE_TYPES, RERUN_EVENT } from "../shared/constants.js";
import { Card } from "../ui/Card.jsx";
import { initFilter } from "./filter.js";
import { hideCard, showCard } from "./mount.js";

// Indexing runs in the backend, so keep asking while it does instead of making the
// viewer reopen the video. The jitter keeps a handful of open tabs from hitting the
// backend on the same tick.
const POLL_INTERVAL_MS = 5_000;
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
  if (videoId === currentVideoId) return;
  stopPolling();
  currentVideoId = videoId;
  hideCard();
  // Reset the toolbar so each video runs its own idle -> working -> done cycle, rather
  // than inheriting the last one's colour until its first answer comes back.
  send({ type: MESSAGE_TYPES.CLEAR_INDICATOR });
  if (videoId) await poll(videoId, true);
}

// Debug mode: drop the card, re-analyze, and let the fresh verdict arrive like any
// other one that lands while the viewer is watching.
async function rerunCurrentVideo() {
  const videoId = currentVideoId;
  if (!videoId) return;
  stopPolling();
  hideCard();
  try {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RERUN_EVALUATION, videoId });
  } catch (error) {
    console.warn("[alive-internet-theory]", error);
  }
  if (videoId === currentVideoId) await poll(videoId);
}

// sendMessage throws synchronously once the extension is reloaded under an open tab,
// which would otherwise take the rest of the navigation down with it.
function send(message) {
  try {
    void chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // The page needs a reload to talk to the new worker; nothing to do here.
  }
}

function stopPolling() {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = null;
}

async function poll(videoId, first = false) {
  pollTimer = null;
  if (await showEvaluation(videoId, first)) return;
  pollTimer = setTimeout(() => poll(videoId), POLL_INTERVAL_MS + Math.random() * POLL_JITTER_MS);
}

/** Shows the card once the video has a verdict, and returns whether it's settled:
 * a score on screen (or a video we've navigated away from) is nothing left to poll
 * for. Until then the page stays untouched; a verdict that lands while the viewer
 * is watching arrives with the rainbow ring. */
async function showEvaluation(videoId, first) {
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
    // itself has queued it for indexing; the next poll picks up the verdict. A failed
    // analysis is remembered until the backend restarts, so there is nothing to wait
    // for and the toolbar carries it instead.
    if (response.result.status) return response.result.status !== "indexing";
    showCard(
      <Card
        evaluation={response.result}
        celebrate={!first}
        floating={location.pathname.startsWith("/shorts/")}
      />,
    );
    return true;
  } catch (error) {
    if (videoId !== currentVideoId) return true;
    console.warn("[alive-internet-theory]", error);
    return false;
  }
}

// YouTube is an SPA: yt-navigate-finish fires on every in-app navigation,
// including the initial load in most cases; the direct call covers the rest.
document.addEventListener("yt-navigate-finish", showCurrentVideo);
document.addEventListener(RERUN_EVENT, rerunCurrentVideo);
showCurrentVideo();
initFilter();
