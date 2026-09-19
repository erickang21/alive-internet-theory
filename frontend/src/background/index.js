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

// Returns the stored evaluation. For a video that isn't stored yet, the backend
// quietly starts indexing it and answers {status: "indexing"} or
// {status: "failed", detail}.
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
