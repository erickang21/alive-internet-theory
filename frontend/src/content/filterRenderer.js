// Applies the tri-state AI filter's visual decoration to YouTube video tiles.
//
// LOWER score = MORE AI (scoring starts at 100, deductions subtract). With the filter
// on, every analyzed tile gets a preview label for its score band; only a score below
// AI_FILTER_THRESHOLD is ever hidden by "block". `score === null` (not analyzed yet)
// always renders normally — on a fresh machine that's nearly every tile, so getting
// this backwards would label or hide the entire feed.
//
// Idempotency contract: each tile we touch is marked with
// `data-ait-filter-applied="<off|flag:<tone>|block>"` holding the DECORATION actually applied
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
const MARK_CLASS = "ait-mark";
const NOTE_CLASS = "ait-flag-note";
const SVG_NS = "http://www.w3.org/2000/svg";

// Left of the label: a warning triangle for the AI band, a question mark for the
// band we are less sure about.
const ICONS = {
  ai: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
  "likely-ai":
    "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z",
};

// The backend's own verdict thresholds, so a preview always agrees with its card.
// Only the AI side is marked: labelling the videos you do want doubles the noise for
// nothing, so a clean tile means human or simply not analyzed.
const BANDS = [
  { min: 75, label: "Likely Human", tone: null },
  { min: AI_FILTER_THRESHOLD, label: "Likely AI", tone: "likely-ai" },
  { min: -Infinity, label: "Heavy AI Use", tone: "ai" },
];

function bandFor(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return null;
  const band = BANDS.find((entry) => score >= entry.min);
  return band.tone ? band : null;
}

// Removes every visual trace of our decoration from a single tile, but leaves the
// data-ait-filter-applied marker alone — callers that go on to re-decorate the tile
// overwrite the marker themselves; callers that are clearing for good remove it too.
function stripDecoration(tile) {
  const thumb = getThumbnailElement(tile);
  thumb?.classList?.remove(THUMB_POSITIONED_CLASS);

  const injected = tile.querySelectorAll?.(`.${MARK_CLASS}, .${NOTE_CLASS}`) ?? [];
  for (const node of injected) node.remove();

  tile.classList?.remove(HIDDEN_CLASS);
}

function icon(tone) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `${MARK_CLASS}__icon`);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[tone]);
  svg.appendChild(path);
  return svg;
}

function decorateFlag(tile, band) {
  const thumb = getThumbnailElement(tile);
  if (thumb) {
    thumb.classList?.add(THUMB_POSITIONED_CLASS);
    // The mark covers the thumbnail so a style can darken or tint it; the pill inside
    // carries the icon and label, and every style just places it differently.
    const mark = document.createElement("span");
    mark.className = `${MARK_CLASS} ${MARK_CLASS}--${band.tone}`;
    const pill = document.createElement("span");
    pill.className = `${MARK_CLASS}__pill`;
    const label = document.createElement("span");
    label.className = `${MARK_CLASS}__label`;
    label.textContent = band.label;
    pill.appendChild(icon(band.tone));
    pill.appendChild(label);
    mark.appendChild(pill);
    thumb.appendChild(mark);
  }

  // Screen readers get the verdict without depending on colour or the mark's shape.
  const title = getTitleElement(tile);
  if (title) {
    const note = document.createElement("span");
    note.className = NOTE_CLASS;
    note.textContent = `(${band.label})`;
    (title.parentNode ?? tile).appendChild(note);
  }
}

function decorateBlock(tile) {
  tile.classList?.add(HIDDEN_CLASS);
}

// tilesWithScores: [{ tile, videoId, score }] — score is a number or null.
export function applyFilter(state, tilesWithScores) {
  for (const entry of tilesWithScores ?? []) {
    const tile = entry?.tile;
    if (!tile) continue;

    const band = state === "flag" || state === "block" ? bandFor(entry.score) : null;
    const blocked = state === "block" && band?.tone === "ai";
    const desired = !band ? "off" : blocked ? "block" : `flag:${band.tone}`;
    const current = tile.getAttribute?.(APPLIED_ATTR) ?? null;
    if (current === desired) continue; // already in the right visual state

    stripDecoration(tile);
    if (blocked) decorateBlock(tile);
    else if (band) decorateFlag(tile, band);

    tile.setAttribute?.(APPLIED_ATTR, desired);
  }
}

// Restores root's subtree exactly to its pre-filter state: every injected ait- node,
// the positioning helper class, the hidden class, and the
// marker attribute are all removed.
export function clearFilter(root = document) {
  const marked = Array.from(root.querySelectorAll?.(`[${APPLIED_ATTR}]`) ?? []);
  for (const tile of marked) {
    stripDecoration(tile);
    tile.removeAttribute?.(APPLIED_ATTR);
  }

  // Defensive sweep: catches any injected node/class left behind by a tile that lost
  // its marker attribute out-of-band (e.g. YouTube replaced the element in place).
  for (const node of root.querySelectorAll?.(`.${MARK_CLASS}, .${NOTE_CLASS}`) ?? []) {
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
}
