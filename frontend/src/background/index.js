import { API_BASE_URL, MESSAGE_TYPES } from "../shared/constants.js";

// The service worker owns backend calls so content scripts stay same-origin
// with youtube.com (which the transcript fetches require).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MESSAGE_TYPES.EVALUATE_VIDEO) return false;

  evaluateVideo(message.payload)
    .then((evaluation) => sendResponse({ ok: true, evaluation }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

async function evaluateVideo(payload) {
  const cached = await fetch(
    `${API_BASE_URL}/video/evaluation?video_id=${encodeURIComponent(payload.video_id)}`,
  );
  if (cached.ok) return cached.json();

  const response = await fetch(`${API_BASE_URL}/video/evaluation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Backend returned ${response.status}`);
  }
  return response.json();
}
