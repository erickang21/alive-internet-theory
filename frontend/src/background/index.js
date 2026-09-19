import { API_BASE_URL, MESSAGE_TYPES } from "../shared/constants.js";

// The service worker owns backend calls: its host_permissions exempt it from
// the CORS and private-network checks a youtube.com content script would hit
// calling 127.0.0.1.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MESSAGE_TYPES.REQUEST_EVALUATION) return false;

  requestEvaluation(message.videoId)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

// Returns the stored evaluation, or starts indexing the video and reports
// {status: "indexing"} / {status: "failed", detail} until it's stored.
async function requestEvaluation(videoId) {
  const response = await fetch(`${API_BASE_URL}/video/evaluation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ video_id: videoId }),
  });
  if (!response.ok && response.status !== 202) {
    throw new Error(`Backend returned ${response.status}`);
  }
  return response.json();
}
