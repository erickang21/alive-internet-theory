import { MAX_INDEXING_RETRIES, VERDICTS } from "../shared/constants.js";

const OVERLAY_ID = "ait-overlay";

export function renderLoading() {
  const overlay = ensureOverlay();
  overlay.className = "ait-overlay";
  overlay.innerHTML = `
    <div class="ait-header">
      <span class="ait-title">Alive Internet Theory</span>
      <span class="ait-badge ait-verdict-loading">Loading…</span>
    </div>
  `;
}

export function renderError(message) {
  renderNotice("Unavailable", message);
}

export function renderIndexing(retryCount = 0) {
  const overlay = ensureOverlay();
  overlay.className = "ait-overlay";
  overlay.innerHTML = `
    <div class="ait-header">
      <span class="ait-title">Alive Internet Theory</span>
      <span class="ait-badge ait-verdict-loading">Indexing…</span>
    </div>
    <div class="ait-detail-line">Please wait, indexing video...</div>
    <div class="ait-subtext"></div>
  `;
  overlay.querySelector(".ait-subtext").textContent =
    retryCount > 0
      ? `Continuing to index, taking longer than usual (${retryCount}/${MAX_INDEXING_RETRIES})...`
      : "This may take a while. Check back later!";
}

export function renderIndexingFailed(detail) {
  renderNotice("Indexing failed", detail || "Analysis failed. See the backend logs.");
}

export function renderEvaluationFailed() {
  const overlay = ensureOverlay();
  overlay.className = "ait-overlay";
  overlay.innerHTML = `
    <div class="ait-header">
      <span class="ait-title">Alive Internet Theory</span>
      <span class="ait-badge ait-verdict-error">Evaluation failed</span>
    </div>
    <div class="ait-subtext">Try again later.</div>
  `;
}

function renderNotice(badgeText, message) {
  const overlay = ensureOverlay();
  overlay.className = "ait-overlay";
  overlay.innerHTML = `
    <div class="ait-header">
      <span class="ait-title">Alive Internet Theory</span>
      <span class="ait-badge ait-verdict-error"></span>
    </div>
    <div class="ait-detail-line"></div>
  `;
  overlay.querySelector(".ait-badge").textContent = badgeText;
  overlay.querySelector(".ait-detail-line").textContent = message;
}

export function renderEvaluation(evaluation) {
  const overlay = ensureOverlay();
  const verdict = VERDICTS[evaluation.verdict] ?? VERDICTS.possibly_ai;

  overlay.className = "ait-overlay";
  overlay.innerHTML = `
    <div class="ait-header">
      <span class="ait-title">Alive Internet Theory</span>
      <span class="ait-badge"></span>
    </div>
    <div class="ait-score"></div>
    <button class="ait-toggle" type="button">Show breakdown</button>
    <ul class="ait-breakdown" hidden></ul>
  `;

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
    deduction.textContent = item.applied ? `−${item.deduction}` : "n/a";

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
