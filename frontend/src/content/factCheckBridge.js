// The fact-check bridge: polls the backend (through the background worker,
// same reasoning as REQUEST_EVALUATION/GET_EVALUATIONS - a content script on
// youtube.com has no host permission for 127.0.0.1) and writes what it learns
// into chrome.storage.local via setFactCheckState. Nothing else populates
// aitFactCheck: records, so without this module FactCheckCard sits at "idle"
// forever, however correctly everything downstream of storage is wired.
//
// This is a SEPARATE poll loop from content/index.jsx's AI-score poll, on
// purpose. That loop's poll() stops rescheduling the moment showEvaluation()
// settles (a verdict or a remembered failure on screen), because a stored
// evaluation is durable and never needs re-checking. The fact-check for that
// same video can still be minutes away at that point, so hanging this off the
// same loop would strand the card at "fact_checking" forever right when the
// AI score appears - the exact bug this module exists to prevent, just moved
// one stage later. The two loops share nothing but their terminal discipline:
// each has its own timer and its own cadence constants below.

import { MESSAGE_TYPES } from "../shared/constants.js";
import { setFactCheckState } from "../shared/factCheckState.js";

// Same cadence as content/index.js's AI-score poll (see the module comment
// there): a video takes minutes to fact-check, so this doesn't need to be
// fast, and the jitter keeps several open tabs from hammering the backend on
// the same tick.
export const POLL_INTERVAL_MS = 30_000;
export const POLL_JITTER_MS = 2_000;

// A single fetch failure is treated as transient (extension reloading,
// backend restarting mid-request) and just retried on the next tick. Only a
// run of these in a row is reported as "failed", so a blip doesn't flash an
// error at the viewer for a few seconds before recovering.
export const MAX_CONSECUTIVE_FAILURES = 3;

// "failed" stops the AUTOMATIC loop same as the two success terminals do -
// only onRetry (FactCheckCard's retry button, wired to bridge.retry()) starts
// it again. Spinning on a backend that just told us it's down would just
// spam the same request every interval forever.
const TERMINAL_STAGES = new Set(["complete", "skipped_fiction", "failed"]);

function jitteredDelay(intervalMs, jitterMs) {
  return intervalMs + (Math.random() * 2 - 1) * jitterMs;
}

/**
 * Maps a ValidityReport (backend/factcheck/models.py, snake_case
 * dataclasses.asdict output) to the camelCase shape FactCheckCard.js and the
 * frozen storage contract expect. Never dumps the raw payload into the
 * record: field names differ (claim.id -> claimId, claim.timestamp_s ->
 * timestampS) and the report carries fields (sources_consulted, reasoning,
 * engine internals) the card has no use for and validateRecord doesn't know
 * about.
 */
export function mapReportToResult(report) {
  const verdicts = Array.isArray(report?.verdicts) ? report.verdicts : [];
  return {
    validityScore: report?.validity_score ?? null,
    rating: report?.rating ?? null,
    lowConfidence: Boolean(report?.low_confidence),
    claimCount: report?.claim_count ?? 0,
    verifiableCount: report?.verifiable_count ?? 0,
    countsByStatus: report?.counts_by_status ?? {},
    verdicts: verdicts.map((verdict) => ({
      claimId: verdict?.claim?.id ?? null,
      claimText: verdict?.claim?.text ?? "",
      timestampS: verdict?.claim?.timestamp_s ?? null,
      status: verdict?.status ?? "unverifiable",
      debunk: verdict?.debunk ?? null,
      citations: Array.isArray(verdict?.citations)
        ? verdict.citations.map((citation) => ({
            title: citation?.title ?? null,
            domain: citation?.domain ?? null,
            url: citation?.url ?? null,
            quote: citation?.quote ?? null,
          }))
        : [],
    })),
  };
}

/**
 * Maps a GET_FACT_CHECK background response ({stage, report?, pregate?}) to a
 * setFactCheckState patch. Every branch sets pregate/result/error explicitly
 * (rather than relying on setFactCheckState's "clear the terminal payload
 * that no longer applies" rule, which only clears result/error) so a stale
 * pregate from an earlier poll can never survive into a later stage -
 * `validateRecord` would only catch that for "skipped_fiction" specifically.
 */
export function stagePatchFromResponse(response) {
  if (response?.stage === "complete") {
    return { stage: "complete", result: mapReportToResult(response.report), pregate: null };
  }
  if (response?.stage === "skipped_fiction") {
    return { stage: "skipped_fiction", pregate: response.pregate ?? null };
  }
  // "failed" here is the backend's {status: "unavailable"}: the check
  // couldn't run (no LLM credentials, classifier down) and the row remembers
  // that until a --force rerun, so polling again cannot change the answer.
  // Terminal like a fetch-failure "failed", but with the backend's own
  // wording - the fact-check couldn't run; the video didn't fail.
  if (response?.stage === "failed") {
    return {
      stage: "failed",
      error: {
        message: response.detail || "The fact check couldn't run for this video.",
        retryable: true,
      },
      pregate: null,
    };
  }
  // "fact_checking" - no evaluation row yet, so the analysis (and with it the
  // fact check) is still on its way.
  return { stage: "fact_checking", pregate: null, result: null };
}

function failurePatch() {
  return {
    stage: "failed",
    error: {
      message: "Couldn't reach the backend to check this video's fact-check status.",
      retryable: true,
    },
    pregate: null,
  };
}

/**
 * One independent poll loop for one video's fact-check status. `start` and
 * `stop` are idempotent; `retry` re-arms polling after a "failed" stage
 * (FactCheckCard's onRetry) without waiting out the rest of the current
 * interval.
 *
 * `intervalMs`/`jitterMs` are constructor options (defaulting to the real
 * cadence above) purely so tests can drive many ticks without waiting real
 * minutes - production code never overrides them.
 */
export function createFactCheckBridge({
  intervalMs = POLL_INTERVAL_MS,
  jitterMs = POLL_JITTER_MS,
  maxConsecutiveFailures = MAX_CONSECUTIVE_FAILURES,
} = {}) {
  let timer = null;
  let videoId = null;
  let failureCount = 0;
  let running = false;

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function stop() {
    running = false;
    videoId = null;
    clearTimer();
  }

  function scheduleNext(forVideoId) {
    clearTimer();
    timer = setTimeout(
      () => {
        timer = null;
        void tick(forVideoId);
      },
      jitteredDelay(intervalMs, jitterMs),
    );
  }

  async function fetchStatus(forVideoId) {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.GET_FACT_CHECK,
      videoId: forVideoId,
    });
    if (!response?.ok) {
      throw new Error(response?.error ?? "no response from service worker");
    }
    // The worker's HANDLERS wrapper answers {ok, result}; the result is the
    // {stage, report?, pregate?, detail?} object the stage mapping reads.
    return response.result;
  }

  async function tick(forVideoId) {
    if (!running || forVideoId !== videoId) return; // superseded by a navigation

    let patch;
    try {
      const response = await fetchStatus(forVideoId);
      failureCount = 0;
      patch = stagePatchFromResponse(response);
    } catch (error) {
      failureCount += 1;
      console.warn("[alive-internet-theory]", error);
      if (failureCount < maxConsecutiveFailures) {
        if (running && forVideoId === videoId) scheduleNext(forVideoId);
        return;
      }
      patch = failurePatch();
    }

    if (!running || forVideoId !== videoId) return; // navigated away mid-request

    try {
      await setFactCheckState(forVideoId, patch);
    } catch (storageError) {
      // Storage is best-effort here too (matches every other write site in
      // this codebase): a quota/context-invalidated failure shouldn't wedge
      // the poll loop, it should just try again next tick.
      console.warn("[alive-internet-theory]", storageError);
    }

    if (!running || forVideoId !== videoId) return;
    if (TERMINAL_STAGES.has(patch.stage)) return; // settled - nothing left to poll for
    scheduleNext(forVideoId);
  }

  function start(newVideoId) {
    stop();
    running = true;
    videoId = newVideoId;
    failureCount = 0;
    void tick(newVideoId);
  }

  function retry(forVideoId) {
    if (!running || forVideoId !== videoId) return; // stale retry from an old card instance
    failureCount = 0;
    clearTimer();
    void tick(forVideoId);
  }

  return { start, stop, retry };
}
