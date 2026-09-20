import { VERDICTS } from "../shared/constants.js";

const OVERLAY_ID = "ait-overlay";
// A stable child of the overlay that the fact-check card mounts into. Every
// render* function below replaces the overlay's innerHTML wholesale on each
// poll tick (loading -> not-analyzed -> evaluation), which would otherwise
// rip the card straight out of the DOM without content/index.js ever being
// told - it never calls render* itself. setOverlayContent() below carries the
// slot across that reset instead, so the card only needs to be mounted once
// per video and can be left alone for the rest of that video's polling.
const FACT_CHECK_SLOT_ID = "ait-factcheck-slot";

// Replaces the overlay's body while preserving the fact-check slot (if one has
// been created via getFactCheckSlot()), then re-appends the slot at the end so
// it always renders below the score/notice markup.
function setOverlayContent(overlay, html) {
  const slot = document.getElementById(FACT_CHECK_SLOT_ID);
  overlay.innerHTML = html;
  if (slot) overlay.appendChild(slot);
}

export function renderLoading() {
  const overlay = ensureOverlay();
  overlay.className = "ait-overlay";
  setOverlayContent(
    overlay,
    `
    <div class="ait-header">
      <span class="ait-title">Alive Internet Theory</span>
      <span class="ait-badge ait-verdict-loading">Loading…</span>
    </div>
  `,
  );
}

export function renderError(message) {
  renderNotice("Unavailable", message);
}

export function renderNotAnalyzed() {
  renderNotice("Not analyzed", "This video hasn't been analyzed yet. Check back later.");
}

function renderNotice(badgeText, message) {
  const overlay = ensureOverlay();
  overlay.className = "ait-overlay";
  setOverlayContent(
    overlay,
    `
    <div class="ait-header">
      <span class="ait-title">Alive Internet Theory</span>
      <span class="ait-badge ait-verdict-error"></span>
    </div>
    <div class="ait-detail-line"></div>
  `,
  );
  overlay.querySelector(".ait-badge").textContent = badgeText;
  overlay.querySelector(".ait-detail-line").textContent = message;
}

// A negative deduction is a bonus (a natural filler rate, a channel with a human
// track record), so show the sign the criterion actually had on the score.
function formatDeduction(deduction) {
  if (deduction > 0) return `−${deduction}`;
  if (deduction < 0) return `+${-deduction}`;
  return "0";
}

export function renderEvaluation(evaluation) {
  const overlay = ensureOverlay();
  const verdict = VERDICTS[evaluation.verdict] ?? VERDICTS.likely_ai;

  overlay.className = "ait-overlay";
  setOverlayContent(
    overlay,
    `
    <div class="ait-header">
      <span class="ait-title">Alive Internet Theory</span>
      <span class="ait-badge"></span>
    </div>
    <div class="ait-score"></div>
    <button class="ait-toggle" type="button">Show breakdown</button>
    <ul class="ait-breakdown" hidden></ul>
  `,
  );

  const badge = overlay.querySelector(".ait-badge");
  badge.textContent = verdict.label;
  badge.classList.add(verdict.className);

  overlay.querySelector(".ait-score").textContent = `Score: ${evaluation.score} / 100`;

  const list = overlay.querySelector(".ait-breakdown");
  for (const item of evaluation.breakdown ?? []) {
    const entry = document.createElement("li");
    entry.className = item.applied ? "ait-criterion" : "ait-criterion ait-criterion-skipped";

    const deduction = document.createElement("span");
    deduction.className = "ait-deduction";
    deduction.textContent = item.applied ? formatDeduction(item.deduction) : "n/a";

    const detail = document.createElement("span");
    detail.textContent = item.detail;

    entry.append(deduction, detail);
    list.appendChild(entry);
  }

  const toggle = overlay.querySelector(".ait-toggle");
  toggle.addEventListener("click", () => {
    list.hidden = !list.hidden;
    toggle.textContent = list.hidden ? "Show breakdown" : "Hide breakdown";
  });
}

export function removeOverlay() {
  // The slot is a child of the overlay, so removing the overlay tears the
  // fact-check card's mount point down with it - callers (factCheckMount.js)
  // are still responsible for unmounting/unsubscribing the card itself before
  // this runs, this just guarantees no detached slot survives past it.
  document.getElementById(OVERLAY_ID)?.remove();
}

function ensureOverlay() {
  let overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    document.body.appendChild(overlay);
  }
  return overlay;
}

/**
 * A stable child element of the overlay for the fact-check card to mount
 * into, created lazily and reused across every render* call above (see the
 * comment on FACT_CHECK_SLOT_ID). Safe to call before the overlay has any
 * other content yet (e.g. right after renderLoading()).
 */
export function getFactCheckSlot() {
  const overlay = ensureOverlay();
  let slot = document.getElementById(FACT_CHECK_SLOT_ID);
  if (!slot) {
    slot = document.createElement("div");
    slot.id = FACT_CHECK_SLOT_ID;
    overlay.appendChild(slot);
  } else if (slot.parentNode !== overlay) {
    // Defensive: should never happen since setOverlayContent always
    // re-appends it to the same overlay, but a stray detached slot must
    // never be reused as-is.
    overlay.appendChild(slot);
  }
  return slot;
}
