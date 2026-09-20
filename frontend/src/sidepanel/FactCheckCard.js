// Host-agnostic fact-check card.
//
// Mounts under the AI-likelihood section and re-renders from a state record
// (see shared/factCheckState.js). It makes no chrome.* calls and owns no
// polling: a host hands it records, which is what lets it be reviewed
// standalone in factcheck-demo.html and unit-tested with a fake DOM.
//
// Everything it renders is either model output or text scraped off a third-party
// page, so it is built with createElement + textContent throughout. No innerHTML.

const ROOT_CLASS = "ait-fc";

const RATING_CLASS = [
  { min: 85, className: "ait-fc-score-high" },
  { min: 65, className: "ait-fc-score-good" },
  { min: 40, className: "ait-fc-score-risk" },
  { min: -Infinity, className: "ait-fc-score-low" },
];

const STATUS_LABELS = {
  verified_true: "Verified true",
  mostly_true: "Mostly true",
  misleading: "Misleading",
  false: "False",
  unverifiable: "Unverifiable",
};

// Only these are worth surfacing at the top level; the rest live behind the toggle.
const DAMAGING_STATUSES = new Set(["false", "misleading"]);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatTimestamp(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function scoreClassName(score) {
  return RATING_CLASS.find((band) => score >= band.min).className;
}

export function createFactCheckCard(options = {}) {
  const { onRetry } = options;

  let rootEl = null;
  let bodyEl = null;
  let mounted = false;
  let data = null;
  let expanded = false;

  function renderPending() {
    const wrap = el("div", "ait-fc-pending");
    wrap.append(
      el("span", "ait-fc-spinner"),
      el("span", "ait-fc-pending-text", "Verifying sources…"),
    );
    // Three skeleton bars, so the card has the rough shape of its final state
    // instead of jumping when the result lands.
    const skeleton = el("div", "ait-fc-skeleton");
    for (let i = 0; i < 3; i++) skeleton.appendChild(el("div", "ait-fc-skeleton-bar"));
    wrap.appendChild(skeleton);
    return wrap;
  }

  function renderSkipped(record) {
    const pregate = record.pregate ?? {};
    // A fallback pre-gate means we couldn't classify the video, which is not
    // the same claim as "this is fiction" - say so.
    const couldNotClassify = pregate.source === "fallback";
    const wrap = el("div", "ait-fc-skipped");
    wrap.appendChild(
      el(
        "div",
        "ait-fc-skipped-title",
        couldNotClassify ? "Fact-check not run" : "Fact-checking skipped",
      ),
    );
    wrap.appendChild(
      el(
        "div",
        "ait-fc-skipped-reason",
        pregate.reason ||
          (couldNotClassify
            ? "This video couldn't be classified."
            : "This video isn't factual content."),
      ),
    );
    return wrap;
  }

  function renderFailed(record) {
    const wrap = el("div", "ait-fc-failed");
    wrap.appendChild(el("div", "ait-fc-failed-title", "Fact-check failed"));
    wrap.appendChild(el("div", "ait-fc-failed-message", record.error?.message ?? "Unknown error."));
    if (record.error?.retryable && typeof onRetry === "function") {
      const button = el("button", "ait-fc-retry", "Try again");
      button.type = "button";
      button.addEventListener("click", () => onRetry(record.videoId));
      wrap.appendChild(button);
    }
    return wrap;
  }

  function renderCitation(citation) {
    const wrap = el("div", "ait-fc-citation");
    if (citation.quote) {
      wrap.appendChild(el("blockquote", "ait-fc-quote", citation.quote));
    }
    const link = el("a", "ait-fc-source", citation.title || citation.domain || citation.url);
    link.href = citation.url ?? "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    wrap.appendChild(link);
    if (citation.domain) wrap.appendChild(el("span", "ait-fc-domain", citation.domain));
    return wrap;
  }

  function renderVerdict(verdict) {
    const item = el("li", `ait-fc-verdict ait-fc-verdict-${verdict.status}`);

    const header = el("div", "ait-fc-verdict-header");
    header.appendChild(
      el("span", "ait-fc-status", STATUS_LABELS[verdict.status] ?? verdict.status),
    );
    const stamp = formatTimestamp(verdict.timestampS);
    if (stamp) header.appendChild(el("span", "ait-fc-timestamp", `[${stamp}]`));
    item.appendChild(header);

    item.appendChild(el("div", "ait-fc-claim", verdict.claimText ?? ""));
    if (verdict.debunk) item.appendChild(el("div", "ait-fc-debunk", verdict.debunk));
    for (const citation of verdict.citations ?? []) {
      item.appendChild(renderCitation(citation));
    }
    return item;
  }

  function renderComplete(record) {
    const result = record.result ?? {};
    const wrap = el("div", "ait-fc-complete");

    const header = el("div", "ait-fc-header");
    const hasScore = typeof result.validityScore === "number";
    if (hasScore) {
      const badge = el(
        "span",
        `ait-fc-score ${scoreClassName(result.validityScore)}`,
        `${result.validityScore}%`,
      );
      header.appendChild(badge);
    }
    // With no verifiable claims the rating IS the message ("Insufficient
    // Verifiable Data"), so show it alone rather than rendering "null%".
    header.appendChild(el("span", "ait-fc-rating", result.rating ?? "No rating"));
    wrap.appendChild(header);

    if (result.lowConfidence) {
      wrap.appendChild(
        el("div", "ait-fc-low-confidence", "Based on only a few verifiable claims."),
      );
    }

    const counts = el(
      "div",
      "ait-fc-counts",
      `${result.verifiableCount ?? 0} of ${result.claimCount ?? 0} claims verifiable`,
    );
    wrap.appendChild(counts);

    const verdicts = result.verdicts ?? [];
    const damaging = verdicts.filter((v) => DAMAGING_STATUSES.has(v.status));
    if (verdicts.length) {
      const toggle = el(
        "button",
        "ait-fc-toggle",
        expanded
          ? "Hide claims"
          : damaging.length
            ? `Show ${damaging.length} disputed claim${damaging.length === 1 ? "" : "s"}`
            : `Show ${verdicts.length} claim${verdicts.length === 1 ? "" : "s"}`,
      );
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.addEventListener("click", () => {
        expanded = !expanded;
        render();
      });
      wrap.appendChild(toggle);

      if (expanded) {
        const list = el("ul", "ait-fc-verdicts");
        // Disputed claims first: they're the reason someone opened this.
        const ordered = [...damaging, ...verdicts.filter((v) => !DAMAGING_STATUSES.has(v.status))];
        for (const verdict of ordered) list.appendChild(renderVerdict(verdict));
        wrap.appendChild(list);
      }
    }
    return wrap;
  }

  function renderBody(record) {
    switch (record?.stage) {
      case "checking_eligibility":
      case "fact_checking":
        return renderPending();
      case "complete":
        return renderComplete(record);
      case "skipped_fiction":
        return renderSkipped(record);
      case "failed":
        return renderFailed(record);
      default:
        return null; // idle renders nothing
    }
  }

  function render() {
    if (!rootEl) return;
    rootEl.className = `${ROOT_CLASS} ${ROOT_CLASS}-${data?.stage ?? "idle"}`;
    bodyEl.replaceChildren();
    const body = renderBody(data);
    // Hide the whole card while idle rather than leaving an empty bordered box
    // above the AI-likelihood section.
    rootEl.hidden = body === null;
    if (body) bodyEl.appendChild(body);
  }

  function mount(container, factCheckData) {
    if (mounted) return;
    rootEl = el("section", ROOT_CLASS);
    rootEl.setAttribute("aria-live", "polite");
    rootEl.appendChild(el("h3", "ait-fc-title", "Fact check"));
    bodyEl = el("div", "ait-fc-body");
    rootEl.appendChild(bodyEl);
    container.appendChild(rootEl);
    mounted = true;
    if (factCheckData !== undefined) data = factCheckData;
    render();
  }

  function update(factCheckData) {
    // A new video (or a stage change away from complete) should not inherit the
    // previous card's expanded state.
    if (factCheckData?.videoId !== data?.videoId || factCheckData?.stage !== "complete") {
      expanded = false;
    }
    data = factCheckData;
    render();
  }

  function unmount() {
    if (!mounted) return;
    rootEl.remove();
    rootEl = null;
    bodyEl = null;
    mounted = false;
    expanded = false;
  }

  return { mount, unmount, update, getData: () => data };
}
