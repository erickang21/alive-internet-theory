const SIZE = 32;
const INSET = 2;
const RADIUS = 8;
const FRAME_MS = 60;
const TURN = Math.PI * 2;
const PULSE_MS = 1_400;
// A tab that navigates away or closes stops refreshing this, so the pulse can't run on.
const STALE_MS = 30_000;

const IDLE = "#8b8b8b";
const WORKING = "#ffb300";
const DONE = "#1ea54c";
const FAILED = "#d93025";

const COLOURS = { idle: IDLE, working: WORKING, done: DONE, failed: FAILED };
const TITLES = {
  idle: "Alive Internet Theory",
  working: "Analyzing this video\u2026",
  done: "This video has been analyzed",
  failed: "Couldn't analyze this video \u2014 see the backend logs",
};

const working = new Map();
let timer = null;
let started = 0;

/** The icon is per tab, so it always describes the video the viewer is looking at:
 * grey with nothing to show, a pulsing amber square while it's analyzed, green once
 * it has a verdict. */
export function setIndicator(tabId, state) {
  if (!Number.isInteger(tabId)) return;
  chrome.action.setTitle({ tabId, title: TITLES[state] }).catch(() => {});
  if (state === "working") {
    working.set(tabId, Date.now() + STALE_MS);
    if (timer === null) {
      started = Date.now();
      timer = setInterval(tick, FRAME_MS);
    }
    return;
  }
  working.delete(tabId);
  if (!working.size) stop();
  draw(tabId, COLOURS[state]);
}

function tick() {
  const now = Date.now();
  for (const [tabId, expiry] of working) {
    if (expiry <= now) {
      working.delete(tabId);
      draw(tabId, IDLE);
    }
  }
  if (!working.size) return stop();
  // A slow sine, so the ring breathes rather than blinks.
  const alpha = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(((now - started) / PULSE_MS) * TURN));
  for (const tabId of working.keys()) draw(tabId, WORKING, alpha);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

function draw(tabId, color, alpha = 1) {
  const context = new OffscreenCanvas(SIZE, SIZE).getContext("2d");
  context.globalAlpha = alpha;
  context.fillStyle = color;
  context.beginPath();
  context.roundRect(INSET, INSET, SIZE - 2 * INSET, SIZE - 2 * INSET, RADIUS);
  context.fill();
  const imageData = { [SIZE]: context.getImageData(0, 0, SIZE, SIZE) };
  // The tab can close between frames, which rejects rather than throwing.
  chrome.action.setIcon(tabId === null ? { imageData } : { tabId, imageData }).catch(() => {});
}

// A worker that died mid-pulse can leave amber behind as the default for new tabs.
draw(null, IDLE);
