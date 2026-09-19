// Applies the tri-state AI filter's visual decoration to YouTube video tiles.
//
// LOWER score = MORE AI (scoring starts at 100, deductions subtract). A tile is only
// ever eligible for "flag"/"block" decoration when its score is a number below
// AI_FILTER_THRESHOLD. `score === null` (not analyzed yet) always renders normally —
// on a fresh machine that's nearly every tile, so getting this backwards would hide
// or flag the entire feed instead of the rare AI one.
//
// Idempotency contract: each tile we touch is marked with
// `data-ait-filter-applied="<off|flag|block>"` holding the DECORATION actually applied
// to that tile (not necessarily the raw global filter state passed in — a tile with a
// null/high score is marked "off" even while the global state is "block", because it
// was never decorated). Re-running applyFilter with unchanged inputs is then a no-op
// per tile, and a transition (e.g. flag -> block) always strips the previous
// decoration before applying the new one so nothing is left behind.
import { AI_FILTER_THRESHOLD } from "../shared/constants.js";
import { getThumbnailElement, getTitleElement } from "./videoScanner.js";

const APPLIED_ATTR = "data-ait-filter-applied";
const THUMB_POSITIONED_CLASS = "ait-thumb-positioned";
const HIDDEN_CLASS = "ait-filtered-hidden";
const BADGE_CLASS = "ait-flag-badge";
const INLINE_CLASS = "ait-flag-inline";
const STYLE_ID = "ait-filter-style";

// build.js does not copy filter.css into dist (see the note at the top of that file),
// and this agent is scoped out of editing build.js/manifest.json to register it there.
// As a stopgap this is an inline copy of filter.css, injected once as a <style> tag so
// the feature works without a build change. Keep this string in sync with filter.css.
const FILTER_CSS = `
.ait-filtered-hidden {
  display: none !important;
}
.ait-thumb-positioned {
  position: relative;
}
.ait-flag-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 9999;
  padding: 2px 8px;
  border-radius: 999px;
  background: #4c1a1a;
  color: #ff7b72;
  font-family: "Roboto", "Segoe UI", sans-serif;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}
.ait-flag-inline {
  display: inline-block;
  margin-left: 6px;
  color: #ff7b72;
  font-size: 12px;
  vertical-align: middle;
}
`;

function ensureStyleInjected() {
  if (typeof document === "undefined" || typeof document.getElementById !== "function") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = FILTER_CSS;
  const target = document.head || document.documentElement || document.body;
  target?.appendChild(style);
}

function isFilterable(score) {
  return typeof score === "number" && !Number.isNaN(score) && score < AI_FILTER_THRESHOLD;
}

// Removes every visual trace of our decoration from a single tile, but leaves the
// data-ait-filter-applied marker alone — callers that go on to re-decorate the tile
// overwrite the marker themselves; callers that are clearing for good remove it too.
function stripDecoration(tile) {
  const thumb = getThumbnailElement(tile);
  thumb?.classList?.remove(THUMB_POSITIONED_CLASS);

  const injected = tile.querySelectorAll?.(`.${BADGE_CLASS}, .${INLINE_CLASS}`) ?? [];
  for (const node of injected) node.remove();

  tile.classList?.remove(HIDDEN_CLASS);
}

function decorateFlag(tile) {
  const thumb = getThumbnailElement(tile);
  if (thumb) {
    thumb.classList?.add(THUMB_POSITIONED_CLASS);
    const badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    badge.textContent = "AI?";
    thumb.appendChild(badge);
  }

  const title = getTitleElement(tile);
  if (title) {
    const icon = document.createElement("span");
    icon.className = INLINE_CLASS;
    icon.textContent = "⚑"; // flag glyph, set via textContent only (see module header)
    (title.parentNode ?? tile).appendChild(icon);
  }
}

function decorateBlock(tile) {
  tile.classList?.add(HIDDEN_CLASS);
}

// tilesWithScores: [{ tile, videoId, score }] — score is a number or null.
export function applyFilter(state, tilesWithScores) {
  ensureStyleInjected();

  for (const entry of tilesWithScores ?? []) {
    const tile = entry?.tile;
    if (!tile) continue;

    const filterable = isFilterable(entry.score);
    const desired = filterable && (state === "flag" || state === "block") ? state : "off";
    const current = tile.getAttribute?.(APPLIED_ATTR) ?? null;
    if (current === desired) continue; // already in the right visual state

    stripDecoration(tile);
    if (desired === "flag") decorateFlag(tile);
    else if (desired === "block") decorateBlock(tile);

    tile.setAttribute?.(APPLIED_ATTR, desired);
  }
}

// Restores root's subtree exactly to its pre-filter state: every injected ait- node,
// the positioning helper class, the hidden class, the marker attribute, and the
// injected <style> tag are all removed.
export function clearFilter(root = document) {
  const marked = Array.from(root.querySelectorAll?.(`[${APPLIED_ATTR}]`) ?? []);
  for (const tile of marked) {
    stripDecoration(tile);
    tile.removeAttribute?.(APPLIED_ATTR);
  }

  // Defensive sweep: catches any injected node/class left behind by a tile that lost
  // its marker attribute out-of-band (e.g. YouTube replaced the element in place).
  for (const node of root.querySelectorAll?.(`.${BADGE_CLASS}, .${INLINE_CLASS}`) ?? []) {
    node.remove();
  }
  for (const el of root.querySelectorAll?.(`.${THUMB_POSITIONED_CLASS}`) ?? []) {
    el.classList?.remove(THUMB_POSITIONED_CLASS);
  }
  for (const el of root.querySelectorAll?.(`.${HIDDEN_CLASS}`) ?? []) {
    el.classList?.remove(HIDDEN_CLASS);
  }
  for (const el of root.querySelectorAll?.(`[${APPLIED_ATTR}]`) ?? []) {
    el.removeAttribute?.(APPLIED_ATTR);
  }

  if (typeof document !== "undefined") {
    document.getElementById?.(STYLE_ID)?.remove();
  }
}
