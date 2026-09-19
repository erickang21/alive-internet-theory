import { MESSAGE_TYPES } from "../shared/constants.js";
import {
  removeOverlay,
  renderError,
  renderEvaluation,
  renderLoading,
  renderNotAnalyzed,
} from "./overlay.js";

let currentVideoId = null;

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
