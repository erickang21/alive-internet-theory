import styled from "styled-components";

import { Tokens } from "./tokens.js";
import { ALERT } from "./icons.js";
import { Body, Shell } from "./frame.jsx";
import { Icon, bodyText, focusRing, smallText } from "./primitives.jsx";

// Two ways the card can have nothing to show: the analysis ran and gave up, or nothing
// answered at all. Neither is a verdict, so neither may look like one.
const MESSAGES = {
  failed: {
    title: "Analysis failed",
    body: "The backend couldn't finish analyzing this video.",
    action: "Analyze again",
  },
  offline: {
    title: "Analyzer unavailable",
    body: "Nothing is analyzing this video right now. Check that the backend is running, then try again.",
    action: "Try again",
  },
};

const Title = styled.h3`
  display: flex;
  align-items: center;
  gap: var(--ait-space-2);
  margin: 0;
  color: var(--ait-error);
  font-size: 1.6rem;
  line-height: 2.2rem;
  font-weight: 500;
  font-stretch: 25%;
`;

const Message = styled.p`
  margin: 0;
  ${bodyText}
`;

const Detail = styled.p`
  margin: 0;
  color: var(--ait-text-secondary);
  overflow-wrap: anywhere;
  ${smallText}
`;

const Retry = styled.button`
  align-self: flex-end;
  height: 32px;
  padding: 0 var(--ait-space-3);
  border: 1px solid var(--ait-outline);
  border-radius: var(--ait-radius-chip);
  background: transparent;
  color: var(--ait-text);
  font-family: inherit;
  ${bodyText}
  font-weight: 500;
  font-stretch: 25%;
  cursor: pointer;
  transition: background var(--ait-duration-fast) var(--ait-ease-exit);

  &:hover {
    background: var(--ait-tonal-hover);
  }

  &:active {
    background: var(--ait-tonal-pressed);
  }

  &:focus-visible {
    ${focusRing}
  }
`;

/** The skeleton's dead end: the same shell, saying why no score is coming. */
export function ErrorCard({ kind, detail, floating, onRetry }) {
  const message = MESSAGES[kind] ?? MESSAGES.offline;

  return (
    <>
      <Tokens />
      <Shell $floating={floating} role="alert">
        <Body>
          <Title>
            <Icon d={ALERT} />
            {message.title}
          </Title>
          <Message>{message.body}</Message>
          {detail && <Detail>{detail}</Detail>}
          {onRetry && (
            <Retry type="button" onClick={onRetry}>
              {message.action}
            </Retry>
          )}
        </Body>
      </Shell>
    </>
  );
}
