// YouTube ships several tile layouts simultaneously (home grid, search results,
// up-next sidebar, channel grids, shorts shelf, and the newer unified lockup), so we
// match all of them. Pure DOM reads only — no chrome.* APIs, no network, no mutation.
// That is what makes this module unit-testable without a real browser.
const TILE_SELECTORS = [
  "ytd-rich-item-renderer",
  "ytd-video-renderer",
  "ytd-compact-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-reel-item-renderer",
  "ytm-shorts-lockup-view-model",
  "yt-lockup-view-model",
];
const TILE_SELECTOR = TILE_SELECTORS.join(", ");

const TITLE_SELECTORS = [
  "#video-title",
  "a#video-title-link",
  "yt-formatted-string#video-title",
  ".yt-lockup-metadata-view-model__title",
];

const THUMBNAIL_SELECTORS = ["a#thumbnail", "ytd-thumbnail", "yt-thumbnail-view-model", "img"];

// A tile's link can point at /watch?v=ID or /shorts/ID, relative or absolute.
const WATCH_ID_PATTERN = /^\/watch\/?$/;
const SHORTS_ID_PATTERN = /^\/shorts\/([\w-]+)/;

// YouTube mutates the DOM constantly while scrolling, so callback-on-every-mutation
// would fire hundreds of times a second. Debounce to one call per burst.
const OBSERVE_DEBOUNCE_MS = 150;

export function findVideoTiles(root = document) {
  return Array.from(root.querySelectorAll(TILE_SELECTOR));
}

export function extractVideoId(tile) {
  const anchors = tile.querySelectorAll("a[href]");
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    if (!href) continue;

    // new URL(relative) throws without a base, so always give it one.
    let url;
    try {
      url = new URL(href, "https://www.youtube.com");
    } catch {
      continue;
    }

    if (WATCH_ID_PATTERN.test(url.pathname)) {
      const id = url.searchParams.get("v");
      if (id) return id;
      continue;
    }

    const shortsMatch = url.pathname.match(SHORTS_ID_PATTERN);
    if (shortsMatch) return shortsMatch[1];
  }
  // A tile frequently renders before its anchor does — this is normal, not an error.
  return null;
}

export function getTitleElement(tile) {
  for (const selector of TITLE_SELECTORS) {
    const el = tile.querySelector(selector);
    if (el) return el;
  }
  return null;
}

export function getThumbnailElement(tile) {
  for (const selector of THUMBNAIL_SELECTORS) {
    const el = tile.querySelector(selector);
    if (el) return el;
  }
  return null;
}

export function observeVideoTiles(callback) {
  let debounceTimer = null;
  let disconnected = false;

  const observer = new MutationObserver(() => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (disconnected) return;
      callback(findVideoTiles());
    }, OBSERVE_DEBOUNCE_MS);
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  }

  return () => {
    disconnected = true;
    observer.disconnect();
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };
}
