const SIZE = 32;
const FRAME_MS = 70;
const TURN = Math.PI * 2;
const STEP = TURN / 28;
const SWEEP = TURN * 0.3;
// A tab closed mid-analysis stops refreshing this, so the spinner can't run forever.
const STALE_MS = 75_000;
const DONE_MS = 4_000;

const IDLE = "#8b8b8b";
const WORKING = "#ffb300";
const DONE = "#1ea54c";

const active = new Map();
let timer = null;
let settle = null;
let angle = 0;

/** Idle is grey, a spinning amber ring means a video is being analyzed, and green
 * marks one that just finished. */
export function setIndexing(videoId, indexing) {
  clearTimeout(settle);
  settle = null;
  if (indexing) {
    active.set(videoId, Date.now() + STALE_MS);
    if (timer === null) timer = setInterval(tick, FRAME_MS);
    return;
  }
  // Only a video we were watching can have just finished; anything else was already idle.
  const finished = active.delete(videoId);
  if (active.size) return;
  stop();
  if (!finished) return;
  draw(DONE);
  settle = setTimeout(() => draw(IDLE), DONE_MS);
}

function tick() {
  for (const [id, expiry] of active) {
    if (expiry <= Date.now()) active.delete(id);
  }
  if (!active.size) {
    stop();
    return draw(IDLE);
  }
  angle = (angle + STEP) % TURN;
  draw(WORKING, angle);
}

function stop() {
  clearInterval(timer);
  timer = null;
  angle = 0;
}

function draw(color, rotation = null) {
  const context = new OffscreenCanvas(SIZE, SIZE).getContext("2d");
  const center = SIZE / 2;
  const radius = center - 3.5;
  context.lineWidth = 4;
  context.lineCap = "round";
  context.globalAlpha = rotation === null ? 1 : 0.25;
  context.strokeStyle = color;
  context.beginPath();
  context.arc(center, center, radius, 0, TURN);
  context.stroke();
  if (rotation !== null) {
    context.globalAlpha = 1;
    context.beginPath();
    context.arc(center, center, radius, rotation, rotation + SWEEP);
    context.stroke();
  }
  void chrome.action.setIcon({ imageData: { [SIZE]: context.getImageData(0, 0, SIZE, SIZE) } });
}

// A worker that dies mid-spin leaves the last frame on the toolbar until we reset it.
draw(IDLE);
