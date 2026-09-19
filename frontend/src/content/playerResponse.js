import { MESSAGE_TYPES } from "../shared/constants.js";

// ytInitialPlayerResponse goes stale on SPA navigation, so callers must
// re-fetch on every yt-navigate-finish instead of caching this.
export function getPagePlayerResponse() {
  const script = [...document.querySelectorAll("script")].find((s) =>
    s.textContent?.includes("ytInitialPlayerResponse ="),
  );
  if (!script) return null;

  const match = script.textContent.match(
    /ytInitialPlayerResponse\s*=\s*({.+?});(?:\s*var|\s*<\/)/s,
  );
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

// The youtubei /player endpoint 403s chrome-extension:// origins, so the call
// runs in the MAIN-world content script (main-world.js, registered in the
// manifest at document_start) and the result comes back via postMessage.
export function fetchAndroidPlayerResponse(videoId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("main-world player response timed out"));
    }, 10000);

    const onMessage = (event) => {
      if (event.source !== window) return;
      const { type, videoId: responseVideoId, playerResponse, error } = event.data ?? {};
      if (type !== MESSAGE_TYPES.PLAYER_RESPONSE_RESULT || responseVideoId !== videoId) return;

      clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (error) reject(new Error(error));
      else resolve(playerResponse);
    };

    window.addEventListener("message", onMessage);
    window.postMessage({ type: MESSAGE_TYPES.FETCH_PLAYER_RESPONSE, videoId }, "*");
  });
}

export function extractVideoMetadata(playerResponse) {
  const details = playerResponse?.videoDetails ?? {};
  const microformat = playerResponse?.microformat?.playerMicroformatRenderer ?? {};
  return {
    video_id: details.videoId ?? null,
    channel_id: details.channelId ?? null,
    author: details.author ?? null,
    length_seconds: Number(details.lengthSeconds ?? 0),
    publish_date: microformat.publishDate ?? microformat.uploadDate ?? null,
  };
}
