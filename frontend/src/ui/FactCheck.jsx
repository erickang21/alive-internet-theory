import { useEffect, useState } from "react";
import styled from "styled-components";

import {
  getFactCheckState,
  idleRecord,
  subscribeFactCheckState,
} from "../shared/factCheckState.js";
import { count } from "./format.js";
import { Bone } from "./bones.jsx";
import { bodyText, smallText } from "./primitives.jsx";

// The panel's Fact check tab, between Breakdown and Settings. The Validity Score
// is deliberately independent of the AI-slop score (being wrong and being
// AI-generated are different questions), so it gets its own tab rather than a
// breakdown row -- and because the backend now runs the check AFTER storing the
// evaluation (backend/factchecks.py), this tab is routinely still loading while
// the verdict beside it is final. It owns no polling: factCheckBridge.js writes
// records into chrome.storage.local and this component re-renders from them,
// which is what lets a result written minutes after the verdict appear without
// a reload.
//
// Everything shown here is model output or text scraped off a third-party page,
// so nothing is interpolated into markup: it all renders through JSX text nodes,
// and citation hrefs pass the allow-list below first.

const STATUS_LABELS = {
  verified_true: "Verified true",
  mostly_true: "Mostly true",
  misleading: "Misleading",
  false: "False",
  unverifiable: "Unverifiable",
};

const STATUS_TONES = {
  verified_true: "human",
  mostly_true: "human",
  misleading: "slop",
  false: "slop",
  unverifiable: "text-secondary",
};

// Only these are worth surfacing at the top level; the rest live behind the toggle.
const DAMAGING_STATUSES = new Set(["false", "misleading"]);

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * A citation url, or null when it isn't safe to make clickable.
 *
 * Citation urls are third-party data. A `javascript:` href here would run in
 * YouTube's page with whatever the click grants it, so allow-list the two
 * schemes a source can legitimately use instead of trying to spot bad ones.
 * Parsed with no base on purpose: a citation url is always absolute, and a
 * base would quietly turn "" or "not a url" into a link to the base host.
 */
function safeHref(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return SAFE_URL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function scoreTone(score) {
  if (score >= 65) return "human";
  if (score >= 40) return "possibly";
  return "slop";
}

function timestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  return `${mm}:${String(total % 60).padStart(2, "0")}`;
}

/** The stored record for this video, kept live off chrome.storage. */
function useFactCheckRecord(videoId) {
  const [record, setRecord] = useState(() => idleRecord(videoId));

  useEffect(() => {
    let alive = true;
    setRecord(idleRecord(videoId));
    const unsubscribe = subscribeFactCheckState(videoId, (next) => {
      if (alive) setRecord(next);
    });
    // The subscription only fires on a FUTURE storage change, so without this
    // read the section stays blank when a record from an earlier visit exists.
    getFactCheckState(videoId).then((existing) => {
      if (alive) setRecord(existing);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [videoId]);

  return record;
}

const Section = styled.section`
  display: flex;
  flex-direction: column;
  gap: var(--ait-space-2);
`;

const Row = styled.div`
  display: flex;
  align-items: baseline;
  gap: var(--ait-space-2);
`;

const Score = styled.span`
  padding: 0 var(--ait-space-2);
  border-radius: var(--ait-radius-chip);
  background: var(--ait-tonal);
  color: var(--ait-${(props) => props.$tone});
  font-size: 1.6rem;
  line-height: 2.4rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
`;

const Rating = styled.span`
  ${bodyText}
  font-weight: 500;
`;

const Note = styled.p`
  margin: 0;
  ${smallText}
  color: var(--ait-text-secondary);
`;

// What the finished report looks like, with every value still missing: a score
// chip and rating, the "N of M verifiable" note, then a claim per row. Same
// wave as the verdict card's skeleton (ui/bones.jsx), so a panel that is half
// settled and half loading reads as one surface.
const Scaffold = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--ait-space-2);
`;

const ScaffoldRow = styled.div`
  display: flex;
  align-items: center;
  gap: var(--ait-space-2);
`;

const Toggle = styled.button`
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  color: var(--ait-cta);
  font-family: inherit;
  ${smallText}
  font-weight: 500;
  text-decoration: underline;
  cursor: pointer;

  &:hover {
    text-decoration-thickness: 2px;
  }

  &:focus-visible {
    outline: 2px solid var(--ait-text);
    outline-offset: 2px;
    border-radius: 2px;
  }
`;

const Retry = styled(Toggle)`
  color: var(--ait-cta);
`;

const Claims = styled.ul`
  display: flex;
  flex-direction: column;
  gap: var(--ait-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
`;

const Claim = styled.li`
  display: flex;
  flex-direction: column;
  gap: var(--ait-space-1);
  padding-left: var(--ait-space-3);
  border-left: 2px solid var(--ait-${(props) => props.$tone});
`;

const StatusLabel = styled.span`
  ${smallText}
  font-weight: 500;
  color: var(--ait-${(props) => props.$tone});
`;

const Time = styled.button`
  padding: 0;
  border: none;
  background: none;
  color: var(--ait-cta);
  font: inherit;
  ${smallText}
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }

  &:focus-visible {
    outline: 2px solid var(--ait-text);
    outline-offset: 2px;
    border-radius: 2px;
  }
`;

const ClaimText = styled.p`
  margin: 0;
  ${bodyText}
`;

const Debunk = styled.p`
  margin: 0;
  ${smallText}
  color: var(--ait-text-secondary);
`;

const Quote = styled.blockquote`
  margin: 0;
  padding-left: var(--ait-space-2);
  border-left: 2px solid var(--ait-outline);
  ${smallText}
  color: var(--ait-text-secondary);
  font-style: italic;
`;

const SourceLink = styled.a`
  ${smallText}
  color: var(--ait-cta);
  text-decoration: underline;
  overflow-wrap: anywhere;

  &:hover {
    text-decoration-thickness: 2px;
  }

  &:focus-visible {
    outline: 2px solid var(--ait-text);
    outline-offset: 2px;
    border-radius: 2px;
  }
`;

const SourceText = styled.span`
  ${smallText}
  color: var(--ait-text-secondary);
  overflow-wrap: anywhere;
`;

function Citation({ citation }) {
  const label = citation.title || citation.domain || citation.url || "Source";
  const href = safeHref(citation.url);
  return (
    <>
      {citation.quote && <Quote>{citation.quote}</Quote>}
      {href ? (
        <SourceLink href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </SourceLink>
      ) : (
        // Inert text rather than dropping the citation entirely: the quote is
        // still evidence, it just isn't clickable.
        <SourceText>{label}</SourceText>
      )}
    </>
  );
}

function Verdict({ verdict }) {
  const tone = STATUS_TONES[verdict.status] ?? "text-secondary";
  const stamp = timestamp(verdict.timestampS);
  const seek = () => {
    const video = document.querySelector("video");
    if (video) video.currentTime = verdict.timestampS;
  };
  return (
    <Claim $tone={tone}>
      <Row>
        <StatusLabel $tone={tone}>{STATUS_LABELS[verdict.status] ?? verdict.status}</StatusLabel>
        {stamp && (
          <Time type="button" aria-label={`Jump to ${stamp}`} onClick={seek}>
            {stamp}
          </Time>
        )}
      </Row>
      <ClaimText>{verdict.claimText}</ClaimText>
      {verdict.debunk && <Debunk>{verdict.debunk}</Debunk>}
      {(verdict.citations ?? []).map((citation, index) => (
        <Citation key={citation.url ?? index} citation={citation} />
      ))}
    </Claim>
  );
}

function Complete({ result }) {
  const [expanded, setExpanded] = useState(false);
  const verdicts = result.verdicts ?? [];
  const damaging = verdicts.filter((verdict) => DAMAGING_STATUSES.has(verdict.status));
  // Disputed claims first: they're the reason someone opened this.
  const ordered = [...damaging, ...verdicts.filter((v) => !DAMAGING_STATUSES.has(v.status))];
  const hasScore = typeof result.validityScore === "number";

  return (
    <>
      <Row>
        {hasScore && (
          <Score $tone={scoreTone(result.validityScore)}>{Math.round(result.validityScore)}%</Score>
        )}
        {/* With no verifiable claims the rating IS the message ("Insufficient
            Verifiable Data"), so it shows alone rather than beside "null%". */}
        <Rating>{result.rating ?? "No rating"}</Rating>
      </Row>
      {result.lowConfidence && <Note>Based on only a few verifiable claims.</Note>}
      <Note>
        {count(result.verifiableCount ?? 0, "claim")} of {result.claimCount ?? 0} verifiable
      </Note>
      {verdicts.length > 0 && (
        <Toggle type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded
            ? "Hide claims"
            : damaging.length
              ? `Show ${count(damaging.length, "disputed claim")}`
              : `Show ${count(verdicts.length, "claim")}`}
        </Toggle>
      )}
      {expanded && (
        <Claims>
          {ordered.map((verdict) => (
            <Verdict key={verdict.claimId ?? verdict.claimText} verdict={verdict} />
          ))}
        </Claims>
      )}
    </>
  );
}

/** The shape of the report that's coming, with a line saying what's happening. */
function Loading({ note }) {
  return (
    <Scaffold aria-busy="true">
      <ScaffoldRow>
        <Bone $row={0} $width="52px" $height="24px" />
        <Bone $row={0} $width="140px" $height="20px" />
      </ScaffoldRow>
      <Bone $row={1} $width="128px" $height="18px" />
      <Bone $row={2} $width="100%" $height="16px" />
      <Bone $row={3} $width="86%" $height="16px" />
      <Bone $row={4} $width="92%" $height="16px" />
      <Note>{note}</Note>
    </Scaffold>
  );
}

function Body({ record, onRetry }) {
  switch (record?.stage) {
    case "checking_eligibility":
      return <Loading note="Checking whether this video makes claims worth verifying…" />;
    case "fact_checking":
      return <Loading note="Currently referencing citations…" />;
    case "complete":
      return <Complete result={record.result ?? {}} />;
    case "skipped_fiction":
      return (
        <Note>
          {record.pregate?.reason ?? "This video isn't factual content, so it wasn't checked."}
        </Note>
      );
    case "failed":
      return (
        <>
          <Note>{record.error?.message ?? "The fact check couldn't run."}</Note>
          {record.error?.retryable && onRetry && (
            <Retry type="button" onClick={onRetry}>
              Try again
            </Retry>
          )}
        </>
      );
    default:
      return null; // idle: no record for this video yet
  }
}

export function FactCheck({ videoId, onRetry }) {
  const record = useFactCheckRecord(videoId);

  // "idle" means no record for this video yet. In the card this rendered
  // nothing; a tab can't be blank, and idle here is itself a wait -- the
  // bridge writes its first record on its next tick.
  const stage = record?.stage ?? "idle";

  return (
    <Section aria-live="polite">
      {stage === "idle" ? (
        <Loading note="Waiting for the backend to start the fact check…" />
      ) : (
        <Body record={record} onRetry={onRetry} />
      )}
    </Section>
  );
}
