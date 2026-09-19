import { fetchPlayerResponseViaInjection } from "./playerResponse.js";

export async function getTranscript(videoId, pagePlayerResponse) {
  const fromPage = await fetchFromTracks(extractCaptionTracks(pagePlayerResponse));
  if (fromPage) return fromPage;

  // Page-level tracks can be PoToken-gated (empty 200s) or expired; the
  // ANDROID-client player response is signed differently and needs no PoToken.
  const androidPlayerResponse = await fetchPlayerResponseViaInjection(videoId);
  return fetchFromTracks(extractCaptionTracks(androidPlayerResponse));
}

function extractCaptionTracks(playerResponse) {
  return playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
}

function pickTrack(tracks) {
  if (tracks.length === 0) return null;
  const asr = tracks.find((t) => t.kind === "asr");
  return asr ?? tracks[0];
}

async function fetchFromTracks(tracks) {
  const track = pickTrack(tracks);
  if (!track?.baseUrl) return null;

  try {
    const response = await fetch(`${track.baseUrl}&fmt=json3`);
    const body = await response.text();
    // PoToken-gated tracks return an empty 200 body; treat as a miss so the
    // caller can fall through to the ANDROID-client path.
    if (!body) return null;

    const text = parseJson3(JSON.parse(body));
    if (!text) return null;

    return {
      text,
      kind: track.kind ?? "standard",
      language: track.languageCode ?? null,
    };
  } catch {
    return null;
  }
}

function parseJson3(data) {
  return (data.events ?? [])
    .flatMap((event) => event.segs ?? [])
    .map((seg) => seg.utf8)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}
