// Mounts/unmounts the FactCheckCard for the current watch/shorts video and
// drives its data with the fact-check bridge (factCheckBridge.js). Kept
// separate from content/index.js so this lifecycle - and specifically "no
// leaked subscription/poll across a navigation" - can be unit-tested without
// dragging in index.js's own top-level side effects (tile scanning, the
// filter subscription, the AI-score poll).
//
// One video mounted at a time: mountFactCheckFor() tears down whatever was
// there before (unmount, unsubscribe, stop polling) before setting up the
// new one, so a rapid double-navigation can never leave two subscriptions or
// two timers alive.

import { createFactCheckCard } from "../sidepanel/FactCheckCard.js";
import { getFactCheckState, subscribeFactCheckState } from "../shared/factCheckState.js";
import { getFactCheckSlot } from "./overlay.js";
import { createFactCheckBridge } from "./factCheckBridge.js";

let card = null;
let unsubscribe = null;
let bridge = null;
let mountedVideoId = null;

/** Mounts (or, if already mounted for this exact video, no-ops) the card and
 * starts polling for it. `createBridge` is an injection seam for tests only -
 * production code always uses the real factCheckBridge. */
export function mountFactCheckFor(videoId, { createBridge = createFactCheckBridge } = {}) {
  if (!videoId || videoId === mountedVideoId) return;
  unmountFactCheck();

  mountedVideoId = videoId;
  bridge = createBridge();
  card = createFactCheckCard({ onRetry: (id) => bridge?.retry(id) });
  card.mount(getFactCheckSlot());

  unsubscribe = subscribeFactCheckState(videoId, (record) => card?.update(record));
  // subscribeFactCheckState only fires on a FUTURE storage change, so the
  // card would otherwise stay blank until the bridge's first write even when
  // a record from an earlier session already exists.
  getFactCheckState(videoId).then((record) => {
    if (videoId === mountedVideoId) card?.update(record);
  });

  bridge.start(videoId);
}

/** Tears down whatever is currently mounted: stops the poll loop, drops the
 * storage subscription, and removes the card from the DOM. Safe to call when
 * nothing is mounted. */
export function unmountFactCheck() {
  if (bridge) {
    bridge.stop();
    bridge = null;
  }
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (card) {
    card.unmount();
    card = null;
  }
  mountedVideoId = null;
}

/** Test-only: which video (if any) currently owns the mounted card. */
export function _currentlyMountedVideoId() {
  return mountedVideoId;
}
