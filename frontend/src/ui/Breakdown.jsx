import { useState } from "react";
import styled from "styled-components";

import { bodyText, focusRing, smallText } from "./primitives.jsx";

const MAX_PHRASES = 3;
const WIDE_VALUE_CHARS = 40;
const GPTZERO_CLASSES = { ai: "AI", human: "Human", mixed: "Mixed" };

const CRITERIA = {
  gptzero_transcript: {
    name: "Transcript analysis",
    rows: (evidence) => [
      ["Verdict", GPTZERO_CLASSES[evidence.predicted_class] ?? evidence.predicted_class],
      ["Confidence", percent(evidence.confidence_score)],
      ["AI probability", percent(evidence.class_probabilities?.ai)],
      ["Flagged sentences", percent(evidence.flagged_sentence_ratio)],
    ],
  },
  filler_words: {
    name: "Filler words",
    rows: (evidence) => [
      ["Fillers found", number(evidence.filler_count)],
      ["Filler rate", number(evidence.rate_per_100_words, " per 100 words")],
    ],
  },
  upload_pattern: {
    name: "Upload history",
    rows: (evidence) => [
      ["Median gap between uploads", gap(evidence.median_gap_hours)],
      ["Uploads sampled", number(evidence.uploads_sampled)],
    ],
  },
  account_age: {
    name: "Channel creation date",
    rows: (evidence) => [["Oldest upload", age(evidence.oldest_upload_age_days)]],
  },
  channel_history: {
    name: "Similar videos",
    rows: (evidence) => [
      ["Videos sampled", number(evidence.videos_sampled)],
      ["Average score", number(evidence.average_score, " / 100")],
    ],
  },
  tts_likelihood: { name: "Text-to-speech likelihood" },
};

// The fact check isn't scored, so the breakdown leaves it out. The backend has no
// voice analysis yet: until it sends tts_likelihood, this placeholder holds its row.
const HIDDEN = new Set(["fact_check"]);
const TTS_PLACEHOLDER = {
  criterion: "tts_likelihood",
  applied: false,
  deduction: 0,
  detail: "Voice analysis is coming soon.",
};

const List = styled.ol`
  margin: 0;
  padding: 0;
  list-style: none;
`;

const Toggle = styled.button`
  display: flex;
  align-items: center;
  gap: var(--ait-space-3);
  width: calc(100% + 2 * var(--ait-space-2));
  min-height: var(--ait-control-height);
  margin: 0 calc(-1 * var(--ait-space-2));
  padding: var(--ait-space-2);
  border: none;
  border-radius: var(--ait-radius-chip);
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: 1.4rem;
  line-height: 2rem;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background var(--ait-duration-fast) var(--ait-ease-exit);

  &:hover {
    background: var(--ait-tonal);
  }

  &:active {
    background: var(--ait-tonal-hover);
  }

  &:focus-visible {
    ${focusRing}
  }
`;

const Index = styled.span`
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--ait-text);
  border-radius: 50%;
  ${smallText}
`;

const Points = styled.span`
  margin-left: auto;
  color: var(--ait-${(props) => props.$tone});
  font-weight: ${(props) => (props.$tone === "text-secondary" ? 400 : 500)};
  font-variant-numeric: tabular-nums;
`;

const Details = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--ait-space-2);
  margin: var(--ait-space-1) 0 var(--ait-space-2) 11px;
  padding-left: calc(var(--ait-space-4) + var(--ait-space-2));
  border-left: 2px solid var(--ait-text);
`;

const Detail = styled.p`
  margin: 0;
  ${bodyText}
  color: var(--ait-text-secondary);
`;

const Label = styled.dt`
  margin: 0;
  ${bodyText}
  color: var(--ait-text-secondary);
`;

const Value = styled.dd`
  margin: 0;
  ${bodyText}
  text-align: ${(props) => (props.$wide ? "left" : "right")};
  overflow-wrap: anywhere;
`;

const Rows = styled.dl`
  display: flex;
  flex-direction: column;
  gap: var(--ait-space-1);
  margin: 0;
`;

const Pair = styled.div`
  display: flex;
  flex-direction: ${(props) => (props.$wide ? "column" : "row")};
  justify-content: space-between;
  gap: ${(props) => (props.$wide ? "0" : "var(--ait-space-4)")};
`;

const PhraseList = styled.ul`
  display: flex;
  flex-direction: column;
  gap: var(--ait-space-2);
  margin: var(--ait-space-1) 0 0;
  padding: 0;
  list-style: none;
`;

const Phrase = styled.li`
  display: flex;
  align-items: baseline;
  gap: var(--ait-space-2);
  font-size: 1.4rem;
  line-height: 2.2rem;
`;

const Time = styled.button`
  flex: 0 0 auto;
  padding: 0;
  border: none;
  background: none;
  color: var(--ait-cta);
  font: inherit;
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

const Quote = styled.span`
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 8;
  line-clamp: 8;
`;

const Marked = styled.mark`
  padding: 2px var(--ait-space-1);
  border-radius: var(--ait-space-1);
  background: var(--ait-marker);
  color: inherit;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
`;

const PhraseLabel = styled.p`
  margin: 0;
  ${bodyText}
  font-weight: 500;
`;

export function Breakdown({ evaluation }) {
  const [open, setOpen] = useState(null);
  const items = (evaluation.breakdown ?? []).filter((item) => !HIDDEN.has(item.criterion));
  if (!items.some((item) => item.criterion === TTS_PLACEHOLDER.criterion)) {
    items.push(TTS_PLACEHOLDER);
  }

  return (
    <List>
      {items.map((item, index) => {
        const config = CRITERIA[item.criterion] ?? {};
        const evidence = item.evidence ?? {};
        const [text, tone] = points(item);
        const expanded = open === index;
        return (
          <li key={item.criterion}>
            <Toggle
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : index)}
            >
              <Index>{index + 1}</Index>
              <span>{config.name ?? humanize(item.criterion)}</span>
              <Points $tone={tone}>{text}</Points>
            </Toggle>
            {expanded && (
              <Details>
                {item.detail && <Detail>{item.detail}</Detail>}
                <Phrases sentences={evidence.flagged_sentences} />
                <RowList entries={config.rows?.(evidence) ?? []} />
              </Details>
            )}
          </li>
        );
      })}
    </List>
  );
}

function Phrases({ sentences }) {
  const phrases = (Array.isArray(sentences) ? sentences : [])
    .filter((entry) => entry?.text)
    .slice(0, MAX_PHRASES);
  if (!phrases.length) return null;

  const seek = (start) => {
    const video = document.querySelector("video");
    if (video) video.currentTime = start;
  };

  return (
    <div>
      <PhraseLabel>Likely AI phrases:</PhraseLabel>
      <PhraseList>
        {phrases.map(({ text, start_seconds: start }) => (
          <Phrase key={text}>
            {Number.isFinite(start) && (
              <Time
                type="button"
                aria-label={`Jump to ${timestamp(start)}`}
                onClick={() => seek(start)}
              >
                {timestamp(start)}
              </Time>
            )}
            <Quote>
              <Marked>{text}</Marked>
            </Quote>
          </Phrase>
        ))}
      </PhraseList>
    </div>
  );
}

function RowList({ entries }) {
  const rows = entries.filter(([, value]) => value != null && value !== "");
  if (!rows.length) return null;
  return (
    <Rows>
      {rows.map(([label, value]) => {
        const wide = String(value).length > WIDE_VALUE_CHARS;
        return (
          <Pair key={label} $wide={wide}>
            <Label>{label}</Label>
            <Value $wide={wide}>{value}</Value>
          </Pair>
        );
      })}
    </Rows>
  );
}

function points({ applied, deduction }) {
  if (!applied) return ["n/a", "text-secondary"];
  if (deduction > 0) return [`−${number(deduction)}`, "slop"];
  if (deduction < 0) return [`+${number(-deduction)}`, "human"];
  return ["0", "text-secondary"];
}

function number(value, suffix = "") {
  return Number.isFinite(value) ? `${Math.round(value * 10) / 10}${suffix}` : null;
}

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : null;
}

function gap(hours) {
  return hours > 48 ? number(hours / 24, " days") : number(hours, " h");
}

function age(days) {
  if (!Number.isFinite(days)) return null;
  return days < 365 ? `${days} days ago` : number(days / 365, " years ago");
}

function timestamp(seconds) {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function humanize(name) {
  const text = String(name).replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
