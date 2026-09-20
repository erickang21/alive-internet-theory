import { createRoot } from "react-dom/client";

// YouTube re-renders the watch page constantly, so the mount point is re-anchored
// from a coalesced observer rather than inserted once.
let container = null;
let root = null;
let observer = null;
let scheduled = false;

export function showCard(element) {
  if (!container) {
    container = document.createElement("div");
    container.setAttribute("data-ait-mount", "");
    container.setAttribute("data-ait-root", "");
    root = createRoot(container);
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  attach();
  root.render(element);
}

export function hideCard() {
  observer?.disconnect();
  observer = null;
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
}

function schedule() {
  if (scheduled || !container) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (container) attach();
  });
}

function attach() {
  if (location.pathname.startsWith("/shorts/")) {
    if (container.parentElement !== document.body) document.body.append(container);
    return;
  }
  // The fundraiser shelf and the related list move from the secondary column
  // into #below when YouTube drops to a single column, so we follow them.
  const anchor = document.querySelector("#donation-shelf, #related");
  if (!anchor || container.nextElementSibling === anchor) return;
  anchor.parentElement.insertBefore(container, anchor);
}
