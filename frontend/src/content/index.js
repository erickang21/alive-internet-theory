import { MESSAGE_TYPES } from "../shared/constants.js";
import {
  extractVideoMetadata,
  fetchAndroidPlayerResponse,
  getPagePlayerResponse,
} from "./playerResponse.js";
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

  let metadata;
  let transcript;
  try {
    // The inline ytInitialPlayerResponse still describes the previous video
    // after SPA navigation, so it only counts when its video ID matches.
    const pageResponse = getPagePlayerResponse();
    const pageIsFresh = pageResponse?.videoDetails?.videoId === videoId;
    const playerResponse = pageIsFresh ? pageResponse : await fetchAndroidPlayerResponse(videoId);
    metadata = extractVideoMetadata(playerResponse);
    transcript = await getTranscript(videoId, playerResponse, {
      allowAndroidFallback: pageIsFresh,
    });
  } catch (error) {
    if (videoId !== currentVideoId) return;
    console.warn("[alive-internet-theory]", error);
    renderError("Couldn't fetch this video's data from YouTube.");
    return;
  }

  if (videoId !== currentVideoId) return;
  if (!transcript?.text) {
    renderError("No captions available for this video, so it can't be analyzed.");
    return;
  }

  try {
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
