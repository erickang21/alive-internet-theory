import { MESSAGE_TYPES } from "../shared/constants.js";

// Runs in the page's MAIN world: youtubei/v1/player 403s requests from
// chrome-extension:// origins, so the call has to come from youtube.com itself.
window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const { type, videoId } = event.data ?? {};
  if (type !== MESSAGE_TYPES.FETCH_PLAYER_RESPONSE || !videoId) return;

  const respond = (payload) => {
    window.postMessage({ type: MESSAGE_TYPES.PLAYER_RESPONSE_RESULT, videoId, ...payload }, "*");
  };

  try {
    const response = await fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // ANDROID-client caption URLs are signed without a PoToken requirement,
        // unlike the WEB client's.
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
        videoId,
      }),
    });
    if (!response.ok) {
      throw new Error(`youtubei/v1/player returned ${response.status}`);
    }
    respond({ playerResponse: await response.json() });
  } catch (error) {
    respond({ error: String(error) });
  }
});
