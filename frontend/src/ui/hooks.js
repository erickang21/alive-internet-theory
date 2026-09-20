import { useCallback, useEffect, useState } from "react";

import { DEBUG_STORAGE_KEY, MESSAGE_TYPES, VERDICTS } from "../shared/constants.js";
import { getFilterState, setFilterState, subscribeFilterState } from "../shared/filterState.js";

/** The vote for one video, shared by every feedback row on screen. */
export function useVote(evaluation) {
  const { agreeVote } = VERDICTS[evaluation.verdict] ?? VERDICTS.likely_ai;
  const videoId = evaluation.video_id;
  const [tally, setTally] = useState(evaluation.community_votes ?? {});
  const [selected, setSelected] = useState(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    storedVote(videoId)
      .then((vote) => {
        if (live && vote) setSelected(vote === agreeVote ? "up" : "down");
      })
      .catch(warn);
    return () => {
      live = false;
    };
  }, [videoId, agreeVote]);

  const submit = useCallback(
    async (name) => {
      if (pending || name === selected) return false;
      const previous = selected;
      const vote = name === "up" ? agreeVote : opposite(agreeVote);
      setSelected(name);
      setPending(true);
      setFailed(false);
      try {
        const response = await chrome.runtime.sendMessage({
          type: MESSAGE_TYPES.SUBMIT_VOTE,
          videoId,
          voterId: await voterId(),
          vote,
        });
        if (!response?.ok) throw new Error(response?.error ?? "no response from service worker");
        await chrome.storage.local.set({ [voteKey(videoId)]: vote });
        setTally(response.result.community_votes ?? {});
        return true;
      } catch (error) {
        warn(error);
        setSelected(previous);
        setFailed(true);
        return false;
      } finally {
        setPending(false);
      }
    },
    [agreeVote, pending, selected, videoId],
  );

  return { agreeVote, tally, selected, pending, failed, submit };
}

/** The tri-state feed filter, which lives in storage so it applies with no UI open. */
export function useFilterState() {
  const [state, setState] = useState("off");
  useEffect(() => {
    getFilterState().then(setState).catch(warn);
    return subscribeFilterState(setState);
  }, []);
  return [state, setFilterState];
}

export function useDebugMode() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    chrome.storage.local
      .get(DEBUG_STORAGE_KEY)
      .then((stored) => setOn(!!stored[DEBUG_STORAGE_KEY]))
      .catch(warn);
    const onChanged = (changes, area) => {
      if (area === "local" && DEBUG_STORAGE_KEY in changes) {
        setOn(!!changes[DEBUG_STORAGE_KEY].newValue);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  const toggle = useCallback(() => {
    setOn((previous) => {
      void chrome.storage.local.set({ [DEBUG_STORAGE_KEY]: !previous });
      return !previous;
    });
  }, []);
  return [on, toggle];
}

/** Closes on Escape and on a click anywhere outside `ref`. */
export function useDismiss(ref, onDismiss) {
  useEffect(() => {
    const onKeydown = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onDismiss();
    };
    const onPointerDown = (event) => {
      if (!ref.current?.contains(event.target)) onDismiss();
    };
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [ref, onDismiss]);
}

export function opposite(vote) {
  return vote === "ai" ? "human" : "ai";
}

function warn(error) {
  console.warn("[alive-internet-theory]", error);
}

let pendingVoterId = null;

// Memoized so two votes in flight at once can't mint two ids for one viewer.
function voterId() {
  pendingVoterId ??= loadVoterId().catch((error) => {
    pendingVoterId = null;
    throw error;
  });
  return pendingVoterId;
}

async function loadVoterId() {
  const stored = await chrome.storage.local.get("voterId");
  if (stored.voterId) return stored.voterId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ voterId: id });
  return id;
}

async function storedVote(videoId) {
  const key = voteKey(videoId);
  const stored = await chrome.storage.local.get(key);
  return stored[key] ?? null;
}

function voteKey(videoId) {
  return `vote:${videoId}`;
}
