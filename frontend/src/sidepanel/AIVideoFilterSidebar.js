// Host-agnostic tri-state AI video filter control.
//
// Renders a segmented control (Off / Flag / Block) so the current position
// is always visible, plus a "main button" that shows the active label and
// advances one step per click - satisfying the product ask for "a single
// button that cycles" while the segments let a user jump straight to a
// state. No chrome.* calls happen in this file: persistence and live
// updates are injected via `options`, defaulting to `shared/filterState.js`
// so the component stays mountable (and testable) with nothing but a DOM.
import { DEFAULT_FILTER_STATE, FILTER_STATES, nextFilterState } from "../shared/constants.js";
import { getFilterState, setFilterState, subscribeFilterState } from "../shared/filterState.js";

const STATE_LABELS = {
  off: "AI Filter: Off",
  flag: "AI Filter: Flagging",
  block: "AI Filter: Blocking",
};

const SEGMENT_LABELS = {
  off: "Off",
  flag: "Flag",
  block: "Block",
};

const SEGMENT_ARIA_LABELS = {
  off: "Set AI filter to off",
  flag: "Set AI filter to flag",
  block: "Set AI filter to block",
};

function isKnownState(value) {
  return FILTER_STATES.includes(value);
}

export function createAIVideoFilterSidebar(options = {}) {
  const {
    getState = getFilterState,
    setState: persistState = setFilterState,
    subscribe = subscribeFilterState,
    onStateChange,
  } = options;

  let state = DEFAULT_FILTER_STATE;
  let mounted = false;
  let rootEl = null;
  let toggleBtn = null;
  let labelEl = null;
  let statsEl = null;
  let unsubscribe = null;
  // segment button + its own listeners, keyed by state, so destroy() can
  // remove exactly what it added.
  const segments = {};

  function applyStateToDom() {
    if (!rootEl) return;

    for (const s of FILTER_STATES) {
      rootEl.classList.toggle(`ait-filter-${s}`, s === state);
    }
    labelEl.textContent = STATE_LABELS[state];
    toggleBtn.setAttribute(
      "aria-label",
      `${STATE_LABELS[state]}. Activate to cycle to the next filter state.`,
    );

    for (const s of FILTER_STATES) {
      const isActive = s === state;
      segments[s].button.setAttribute("aria-pressed", String(isActive));
      segments[s].button.classList.toggle("ait-filter-segment-active", isActive);
    }
  }

  // `fromUser` gates onStateChange: it only fires for changes the person
  // driving this control caused (click / keyboard), never for state that
  // arrived from the subscription (another tab, another panel) or from a
  // host calling the public setState() to sync display.
  function applyNewState(next, { fromUser }) {
    if (state === next) return;
    state = next;
    applyStateToDom();
    if (fromUser && typeof onStateChange === "function") onStateChange(state);
  }

  function persist(next) {
    Promise.resolve()
      .then(() => persistState(next))
      .catch((error) => {
        console.warn("[alive-internet-theory] failed to persist filter state", error);
      });
  }

  function handleToggleClick() {
    const next = nextFilterState(state);
    applyNewState(next, { fromUser: true });
    persist(next);
  }

  function handleSegmentActivate(s) {
    if (s === state) return;
    applyNewState(s, { fromUser: true });
    persist(s);
  }

  function handleSegmentKeydown(event, s) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();

    const idx = FILTER_STATES.indexOf(s);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const nextState = FILTER_STATES[(idx + delta + FILTER_STATES.length) % FILTER_STATES.length];

    segments[nextState].button.focus();
    handleSegmentActivate(nextState);
  }

  function buildDom() {
    rootEl = document.createElement("div");
    rootEl.className = "ait-filter";
    rootEl.setAttribute("role", "group");
    rootEl.setAttribute("aria-label", "AI video filter");

    toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "ait-filter-toggle";
    toggleBtn.addEventListener("click", handleToggleClick);

    labelEl = document.createElement("span");
    labelEl.className = "ait-filter-label";
    toggleBtn.appendChild(labelEl);

    const segmentsEl = document.createElement("div");
    segmentsEl.className = "ait-filter-segments";

    for (const s of FILTER_STATES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ait-filter-segment ait-filter-segment-${s}`;
      button.textContent = SEGMENT_LABELS[s];
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", SEGMENT_ARIA_LABELS[s]);

      const onClick = () => handleSegmentActivate(s);
      const onKeydown = (event) => handleSegmentKeydown(event, s);
      button.addEventListener("click", onClick);
      button.addEventListener("keydown", onKeydown);

      segments[s] = { button, onClick, onKeydown };
      segmentsEl.appendChild(button);
    }

    statsEl = document.createElement("div");
    statsEl.className = "ait-filter-stats";
    statsEl.hidden = true;

    rootEl.append(toggleBtn, segmentsEl, statsEl);
  }

  function mount(root) {
    if (mounted) return;

    buildDom();
    root.appendChild(rootEl);
    mounted = true;
    applyStateToDom();

    // `Promise.resolve(getState())` would evaluate getState() first, so a collaborator
    // that throws synchronously escapes mount() entirely. Every collaborator here is
    // injectable, so a misbehaving one is a foreseeable case, not a contrived one.
    Promise.resolve()
      .then(() => getState())
      .then((loaded) => {
        if (!mounted) return;
        applyNewState(isKnownState(loaded) ? loaded : DEFAULT_FILTER_STATE, { fromUser: false });
      })
      .catch(() => {
        // Loading the initial state failed (e.g. storage error) - keep
        // showing the default rather than leaving the control in limbo.
      });

    // Same reasoning as above: an injected subscribe that throws must not take mount()
    // down with it - the control still works, it just won't see external changes.
    try {
      const unsub = subscribe((newState) => {
        if (!mounted) return;
        applyNewState(isKnownState(newState) ? newState : DEFAULT_FILTER_STATE, {
          fromUser: false,
        });
      });
      unsubscribe = typeof unsub === "function" ? unsub : null;
    } catch (error) {
      console.warn("[alive-internet-theory] filter state subscription failed", error);
      unsubscribe = null;
    }
  }

  function destroy() {
    if (!mounted) return;

    toggleBtn.removeEventListener("click", handleToggleClick);
    for (const s of FILTER_STATES) {
      const { button, onClick, onKeydown } = segments[s];
      button.removeEventListener("click", onClick);
      button.removeEventListener("keydown", onKeydown);
      delete segments[s];
    }

    unsubscribe?.();
    unsubscribe = null;

    rootEl.remove();
    rootEl = null;
    toggleBtn = null;
    labelEl = null;
    statsEl = null;
    mounted = false;
  }

  function getComponentState() {
    return state;
  }

  // Programmatic display sync (e.g. a host that already knows the state).
  // Deliberately does not persist or fire onStateChange - only a user
  // action (click/keyboard) or the storage subscription should do that.
  function setComponentState(next) {
    applyNewState(isKnownState(next) ? next : DEFAULT_FILTER_STATE, { fromUser: false });
  }

  function setStats(stats) {
    if (!statsEl) return;
    const analyzed = stats?.analyzed ?? 0;
    const total = stats?.total ?? 0;

    if (!total) {
      statsEl.hidden = true;
      statsEl.textContent = "";
      return;
    }

    statsEl.hidden = false;
    statsEl.textContent = `${analyzed} of ${total} analyzed`;
  }

  return {
    mount,
    destroy,
    getState: getComponentState,
    setState: setComponentState,
    setStats,
  };
}
