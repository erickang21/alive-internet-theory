import { MESSAGE_TYPES } from "../shared/constants.js";
import { extractVideoMetadata, getPagePlayerResponse } from "./playerResponse.js";
import { getTranscript } from "./transcript.js";
import { removeOverlay, renderError, renderEvaluation, renderLoading } from "./overlay.js";

let currentVideoId = null;

function getVideoIdFromUrl() {
  const url = new URL(location.href);
  if (url.pathname === "/watch") return url.searchParams.get("v");
  const shortsMatch = url.pathname.match(/^\/shorts\/([\w-]+)/);
  return shortsMatch ? shortsMatch[1] : null;
}

async function evaluateCurrentVideo() {
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
    const playerResponse = getPagePlayerResponse();
    const metadata = extractVideoMetadata(playerResponse);

    const transcript = await getTranscript(videoId, playerResponse);
    if (!transcript?.text) {
      renderError("No captions available for this video, so it can't be analyzed.");
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.EVALUATE_VIDEO,
      payload: { video_id: videoId, transcript, metadata },
    });

    if (videoId !== currentVideoId) return;
    if (!response?.ok) {
      throw new Error(response?.error ?? "no response from service worker");
    }
    renderEvaluation(response.evaluation);
  } catch (error) {
    if (videoId !== currentVideoId) return;
    console.warn("[alive-internet-theory]", error);
    renderError("Analysis failed. Is the backend running?");
  }
}

// YouTube is an SPA: yt-navigate-finish fires on every in-app navigation,
// including the initial load in most cases; the direct call covers the rest.
document.addEventListener("yt-navigate-finish", evaluateCurrentVideo);
evaluateCurrentVideo();
