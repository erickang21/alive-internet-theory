import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import styled from "styled-components";

import { VERDICTS } from "../shared/constants.js";
import { Community } from "./Community.jsx";
import { Feedback } from "./Feedback.jsx";
import { Panel } from "./Panel.jsx";
import { Ring } from "./Ring.jsx";
import { Thanks } from "./Thanks.jsx";
import { Tokens } from "./tokens.js";
import { useVote } from "./hooks.js";
import { bodyText } from "./primitives.jsx";

const SEGMENTS = 5;

const Shell = styled.article`
  position: relative;
  margin-bottom: var(--ait-space-4);
  border: 1px solid var(--ait-outline);
  border-radius: var(--ait-radius);
  background: var(--ait-surface);
  color: var(--ait-text);
  font-family: var(--ait-font);

  ${(props) =>
    props.$floating &&
    `
    position: fixed;
    top: 72px;
    right: var(--ait-space-4);
    z-index: 2000;
    width: 360px;
    max-width: calc(100vw - 2 * var(--ait-space-4));
    margin-bottom: 0;
    box-shadow: var(--ait-elevation);
  `}

  /* Single-column layout: YouTube moves the anchors under the player, which has no gap below it. */
  :not(#secondary-inner) > [data-ait-mount] > & {
    margin-top: var(--ait-space-3);
  }
`;

const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--ait-space-3);
  padding: var(--ait-space-4);
`;

const Headline = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--ait-space-3);
`;

const Verdict = styled.h3`
  flex: 1 1 auto;
  margin: 0;
  overflow: hidden;
  font-size: 1.6rem;
  line-height: 2.2rem;
  font-weight: 500;
  font-stretch: 25%;
  white-space: nowrap;
  text-overflow: ellipsis;
`;

const Percent = styled.span`
  flex: 0 0 auto;
  font-size: 1.6rem;
  line-height: 2.2rem;
  font-weight: 700;
  font-stretch: 25%;
`;

const Track = styled.div`
  position: relative;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--ait-tonal);

  /* One gradient draws all four separators, so the segments need no extra elements. */
  &::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      ${Array.from({ length: SEGMENTS - 1 }, (_, index) => {
        const stop = ((index + 1) * 100) / SEGMENTS;
        return `transparent calc(${stop}% - 2px), var(--ait-surface) calc(${stop}% - 2px) ${stop}%, transparent ${stop}%`;
      }).join(", ")}
    );
  }
`;

const Fill = styled.div`
  height: 100%;
  border-radius: inherit;
  width: ${(props) => props.$score}%;
  background: var(--ait-${(props) => props.$tone});
`;

const BreakdownLink = styled.button`
  align-self: flex-end;
  padding: 0;
  border: none;
  background: none;
  color: var(--ait-cta);
  font-family: inherit;
  ${bodyText}
  font-weight: 500;
  font-stretch: 25%;
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

export function Card({ evaluation, celebrate, floating }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [thanked, setThanked] = useState(false);
  const vote = useVote(evaluation);
  const link = useRef(null);

  const verdict = VERDICTS[evaluation.verdict] ?? VERDICTS.likely_ai;
  const score = Number.isFinite(evaluation.score)
    ? Math.min(100, Math.max(0, Math.round(evaluation.score)))
    : 0;

  const closePanel = () => {
    setPanelOpen(false);
    link.current?.focus();
  };

  return (
    <>
      <Tokens />
      <Shell $floating={floating}>
        <Body>
          <Headline>
            <Verdict>{verdict.label}</Verdict>
            <Percent>{score}%</Percent>
          </Headline>
          <Track aria-hidden="true">
            <Fill $score={score} $tone={verdict.tone} />
          </Track>
          <Community vote={vote} />
          <Feedback vote={vote} onVoted={() => setThanked(true)} />
          <BreakdownLink ref={link} type="button" onClick={() => setPanelOpen(true)}>
            View breakdown
          </BreakdownLink>
        </Body>
        {thanked && <Thanks />}
        {celebrate && <Ring />}
      </Shell>
      {panelOpen &&
        createPortal(
          <Panel evaluation={evaluation} vote={vote} onClose={closePanel} />,
          document.body,
        )}
    </>
  );
}
