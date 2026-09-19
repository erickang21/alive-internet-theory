import { API_BASE_URL, MESSAGE_TYPES } from "../shared/constants.js";

// The service worker owns backend calls: its host_permissions exempt it from
// the CORS and private-network checks a youtube.com content script would hit
// calling 127.0.0.1.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MESSAGE_TYPES.GET_EVALUATION) return false;

  getEvaluation(message.videoId)
    .then((evaluation) => sendResponse({ ok: true, evaluation }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

async function getEvaluation(videoId) {
  const response = await fetch(
    `${API_BASE_URL}/video/evaluation?video_id=${encodeURIComponent(videoId)}`,
  );
  // Videos are analyzed offline by the backend's analyze script; a 404 just
  // means this one hasn't been yet.
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}`);
  }
  return response.json();
}
