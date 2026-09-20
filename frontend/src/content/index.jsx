import { MESSAGE_TYPES, RERUN_EVENT } from "../shared/constants.js";
import { Card } from "../ui/Card.jsx";
import { ErrorCard } from "../ui/ErrorCard.jsx";
import { FactCheck } from "../ui/FactCheck.jsx";
import { Skeleton } from "../ui/Skeleton.jsx";
import { createFactCheckBridge } from "./factCheckBridge.js";
import { initFilter } from "./filter.js";
import { hideCard, showCard } from "./mount.js";

// Indexing runs in the backend, so keep asking while it does instead of making the
// viewer reopen the video. The jitter keeps a handful of open tabs from hitting the
// backend on the same tick.
const POLL_INTERVAL_MS = 5_000;
const POLL_JITTER_MS = 2_000;
// A service worker torn down mid-message can leave sendMessage pending for good, and a
// poll that never settles never schedules the next one.
const REPLY_TIMEOUT_MS = 25_000;
// A request that hasn't answered by now is treated as nothing running, and the error
// container replaces the skeleton. This is a display deadline, not a timeout: the
// request is left alone, so a backend that was only slow puts the skeleton (or the
// verdict) straight back. Without it the skeleton would shimmer for up to
// REQUEST_TIMEOUT_MS against a backend that accepts the connection and then hangs.
const SILENCE_MS = 2_000;

// The fact-check gets its own poll loop (30s cadence: a check takes minutes) and
// NEVER shares the score poll below, whose whole design is to stop the moment a
// verdict settles - minutes before the fact-check has anything to say. The bridge
// writes chrome.storage records; the card's FactCheck section renders from them.
const factCheckBridge = createFactCheckBridge();

let currentVideoId = null;
let pollTimer = null;
// Bumped every time polling stops. A request still in flight from the previous chain
// can't render its answer or schedule another tick once a restart has taken over,
// which the error container's retry makes reachable with one click.
let pollToken = 0;

function stale(videoId, token) {
  return videoId !== currentVideoId || token !== pollToken;
}

function getVideoIdFromUrl() {
  const url = new URL(location.href);
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const shortsMatch = url.pathname.match(/^\/shorts\/([\w-]+)/);
  return shortsMatch ? shortsMatch[1] : null;
}

function isFloating() {
  return location.pathname.startsWith("/shorts/");
}

function showSkeleton() {
  showCard(<Skeleton floating={isFloating()} />);
}

/** `failed` is the backend having given up on this video, so its retry has to force a
 * fresh analysis; an unreachable backend only needs the same request again. */
function showError(kind, detail) {
  showCard(
    <ErrorCard
      kind={kind}
      detail={detail}
      floating={isFloating()}
      onRetry={() => restart(kind === "failed")}
    />,
  );
}

async function showCurrentVideo() {
  const videoId = getVideoIdFromUrl();
  if (videoId === currentVideoId) return;
  stopPolling();
  const token = pollToken;
  currentVideoId = videoId;
  // Reset the toolbar so each video runs its own idle -> working -> done cycle, rather
  // than inheriting the last one's colour until its first answer comes back.
  send({ type: MESSAGE_TYPES.CLEAR_INDICATOR });
  if (!videoId) {
    factCheckBridge.stop();
    hideCard();
    return;
  }
  // start() tears down the previous video's loop first, so a navigation can
  // never leave two bridges writing records.
  factCheckBridge.start(videoId);
  // The request goes out with the page, so the skeleton goes up with it: the card is
  // never missing while an answer is on its way.
  showSkeleton();
  await poll(videoId, token, true);
}

/** Re-asks for the current video from the skeleton up: the error container's retry, and
 * debug mode's re-analyze, which forces the stored evaluation to be thrown away. */
async function restart(force) {
  const videoId = currentVideoId;
  if (!videoId) return;
  stopPolling();
  const token = pollToken;
  showSkeleton();
  if (force) {
    try {
      await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.RERUN_EVALUATION, videoId });
    } catch (error) {
      console.warn("[alive-internet-theory]", error);
    }
  }
  if (!stale(videoId, token)) await poll(videoId, token);
}

function ask(message) {
  return Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error("the service worker never answered")), REPLY_TIMEOUT_MS),
    ),
  ]);
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
  pollToken += 1;
}

async function poll(videoId, token, first = false) {
  pollTimer = null;
  if (await showEvaluation(videoId, token, first)) return;
  if (stale(videoId, token)) return;
  pollTimer = setTimeout(
    () => poll(videoId, token),
    POLL_INTERVAL_MS + Math.random() * POLL_JITTER_MS,
  );
}

/** Puts this poll's answer in the card and returns whether it's settled: a score on
 * screen, a failed analysis (which the backend remembers until it restarts), or a video
 * we've navigated away from is nothing left to poll for. A verdict that lands while the
 * viewer is watching replaces the skeleton with the rainbow ring. */
async function showEvaluation(videoId, token, first) {
  let result;
  const silent = setTimeout(() => {
    if (!stale(videoId, token)) showError("offline", "No answer from the backend.");
  }, SILENCE_MS);
  try {
    const response = await ask({ type: MESSAGE_TYPES.REQUEST_EVALUATION, videoId });
    if (stale(videoId, token)) return true;
    if (!response?.ok) {
      throw new Error(response?.error ?? "no response from service worker");
    }
    result = response.result;
  } catch (error) {
    if (stale(videoId, token)) return true;
    console.warn("[alive-internet-theory]", error);
    // Nothing is analyzing this video, so the skeleton would be a lie. Polling carries
    // on regardless, and a backend that comes back puts the skeleton up again.
    showError("offline", String(error?.message ?? error));
    return false;
  } finally {
    clearTimeout(silent);
  }

  // An unanalyzed video comes back as a status, not an evaluation. The request itself
  // has queued it for indexing, so the skeleton stays up until the verdict lands.
  if (result.status === "indexing") {
    showSkeleton();
    return false;
  }
  if (result.status) {
    showError("failed", result.detail);
    return true;
  }
  showCard(
    <Card
      evaluation={result}
      celebrate={!first}
      floating={isFloating()}
      factCheck={<FactCheck videoId={videoId} onRetry={() => factCheckBridge.retry(videoId)} />}
    />,
  );
  return true;
}

// YouTube is an SPA: yt-navigate-finish fires on every in-app navigation,
// including the initial load in most cases; the direct call covers the rest.
// yt-navigate-finish covers in-app navigation; yt-page-data-updated lands later and
// catches the times it fires before location has caught up.
document.addEventListener("yt-navigate-finish", showCurrentVideo);
document.addEventListener("yt-page-data-updated", showCurrentVideo);
document.addEventListener(RERUN_EVENT, () => restart(true));
showCurrentVideo();
initFilter();
