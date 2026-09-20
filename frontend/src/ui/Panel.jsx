import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import styled from "styled-components";

import { RERUN_EVENT } from "../shared/constants.js";
import { Breakdown } from "./Breakdown.jsx";
import { FactCheck } from "./FactCheck.jsx";
import { Feedback } from "./Feedback.jsx";
import { Settings } from "./Settings.jsx";
import { Thanks } from "./Thanks.jsx";
import { BREAKDOWN, CLOSE, FACT_CHECK, SETTINGS } from "./icons.js";
import { useDismiss } from "./hooks.js";
import { Icon, IconButton, bodyText, focusRing } from "./primitives.jsx";

const EXIT_MS = 200;
const FOCUSABLE = 'a[href], button:not(:disabled):not([tabindex="-1"])';
// Fact check sits between them on purpose: it reads as the second half of the
// analysis, and it is the one tab that can still be loading while the rest of
// the panel is final (backend/factchecks.py runs it after the evaluation).
const TABS = [
  { id: "breakdown", label: "Breakdown", icon: BREAKDOWN },
  { id: "fact-check", label: "Fact check", icon: FACT_CHECK },
  { id: "settings", label: "Settings", icon: SETTINGS },
];

const Root = styled.div`
  position: fixed;
  inset: 0;
  z-index: 2100;
  font-family: var(--ait-font);
  pointer-events: ${(props) => (props.$closing ? "none" : "auto")};
`;

const Dialog = styled.div`
  position: absolute;
  top: calc(var(--ait-masthead-height) + var(--ait-space-1));
  right: var(--ait-space-4);
  display: flex;
  flex-direction: column;
  width: 400px;
  max-width: calc(100vw - 2 * var(--ait-space-4));
  max-height: calc(100vh - var(--ait-masthead-height) - 2 * var(--ait-space-4));
  border-radius: var(--ait-radius);
  overflow: hidden;
  background: var(--ait-menu);
  color: var(--ait-text);
  box-shadow: var(--ait-elevation);
  transform-origin: top right;
  opacity: ${(props) => (props.$closing ? 0 : 1)};
  transform: ${(props) =>
    props.$closing ? "translateY(calc(-1 * var(--ait-space-2))) scale(0.96)" : "none"};
  transition:
    opacity var(--ait-duration-${(props) => (props.$closing ? "fast" : "enter")})
      var(--ait-ease-${(props) => (props.$closing ? "exit" : "enter")}),
    transform var(--ait-duration-${(props) => (props.$closing ? "fast" : "enter")})
      var(--ait-ease-${(props) => (props.$closing ? "exit" : "enter")});

  @starting-style {
    opacity: 0;
    transform: translateY(calc(-1 * var(--ait-space-2))) scale(0.96);
  }
`;

const Header = styled.header`
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: var(--ait-space-2);
  padding: var(--ait-space-2) var(--ait-space-2) 0 var(--ait-space-4);
`;

const Title = styled.h2`
  margin: 0;
  font-size: 2rem;
  line-height: 2.8rem;
  font-weight: 700;
  font-stretch: 25%;
`;

const TabList = styled.div`
  display: flex;
  flex: 0 0 auto;
  margin: var(--ait-space-2) var(--ait-space-4) var(--ait-space-1);
  border: 1px solid var(--ait-outline);
  border-radius: var(--ait-radius-chip);
  overflow: hidden;
`;

const Tab = styled.button`
  display: flex;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  gap: var(--ait-space-2);
  height: var(--ait-control-height);
  /* Three tabs share 400px now, and "Fact check" wrapped to two lines at the old
     12px. The icon gives up its space before the label does. */
  padding: 0 var(--ait-space-2);
  white-space: nowrap;
  border: none;
  background: ${(props) => (props.$selected ? "var(--ait-tonal-hover)" : "transparent")};
  color: var(--ait-${(props) => (props.$selected ? "text" : "text-secondary")});
  font-family: inherit;
  ${bodyText}
  font-weight: 500;
  font-stretch: 25%;
  cursor: pointer;
  transition: background var(--ait-duration-fast) var(--ait-ease-exit);

  & + & {
    border-left: 1px solid var(--ait-outline);
  }

  &:hover {
    background: var(--ait-tonal);
  }

  &:focus-visible {
    ${focusRing}
  }
`;

const Body = styled.div`
  flex: 1 1 auto;
  min-height: min(264px, 40vh);
  padding: var(--ait-space-2) var(--ait-space-4) var(--ait-space-3);
  overflow-y: auto;
  overscroll-behavior: contain;
`;

const Footer = styled.footer`
  flex: 0 0 auto;
  padding: 0 var(--ait-space-4) var(--ait-space-2);
`;

const Rerun = styled.button`
  align-self: flex-start;
  height: 36px;
  margin: var(--ait-space-1) 0 0 var(--ait-space-4);
  padding: 0 var(--ait-space-4);
  border: none;
  border-radius: 18px;
  background: var(--ait-tonal);
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

  &:focus-visible {
    ${focusRing}
  }
`;

export function Panel({ evaluation, vote, onClose, onFactCheckRetry }) {
  const [tab, setTab] = useState("breakdown");
  const [thanked, setThanked] = useState(false);
  const [closing, setClosing] = useState(false);
  const dialog = useRef(null);
  const close = useRef(null);

  const dismiss = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, EXIT_MS);
  }, [onClose]);

  useDismiss(dialog, dismiss);
  useLayoutEffect(() => close.current?.focus(), []);

  useEffect(() => {
    const onKeydown = (event) => {
      if (event.key !== "Tab" || !dialog.current) return;
      const targets = [...dialog.current.querySelectorAll(FOCUSABLE)].filter((node) =>
        node.checkVisibility(),
      );
      const edge = event.shiftKey ? targets[0] : targets[targets.length - 1];
      if (document.activeElement !== edge && dialog.current.contains(document.activeElement))
        return;
      event.preventDefault();
      (event.shiftKey ? targets[targets.length - 1] : targets[0]).focus();
    };
    document.addEventListener("keydown", onKeydown, true);
    return () => document.removeEventListener("keydown", onKeydown, true);
  }, []);

  return (
    <Root data-ait-root $closing={closing}>
      <Dialog
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Alive Internet Theory"
        $closing={closing}
      >
        <Header>
          <Title>Alive Internet Theory</Title>
          <IconButton ref={close} type="button" aria-label="Close" onClick={dismiss}>
            <Icon d={CLOSE} />
          </IconButton>
        </Header>
        <TabList role="tablist" onKeyDown={(event) => moveTab(event, tab, setTab)}>
          {TABS.map(({ id, label, icon }) => (
            <Tab
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              tabIndex={tab === id ? 0 : -1}
              $selected={tab === id}
              onClick={() => setTab(id)}
            >
              <Icon d={icon} />
              <span>{label}</span>
            </Tab>
          ))}
        </TabList>
        <Body role="tabpanel">
          {tab === "breakdown" && <Breakdown evaluation={evaluation} />}
          {tab === "fact-check" && (
            <FactCheck videoId={evaluation.video_id} onRetry={onFactCheckRetry} />
          )}
          {tab === "settings" && <Settings debugExtra={<RerunButton />} />}
        </Body>
        <Footer>
          <Feedback vote={vote} onVoted={() => setThanked(true)} />
        </Footer>
        {thanked && <Thanks />}
      </Dialog>
    </Root>
  );
}

function RerunButton() {
  return (
    <Rerun type="button" onClick={() => document.dispatchEvent(new CustomEvent(RERUN_EVENT))}>
      Rerun analysis
    </Rerun>
  );
}

function moveTab(event, tab, setTab) {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  if (!step) return;
  const index = TABS.findIndex(({ id }) => id === tab);
  const next = TABS[(index + step + TABS.length) % TABS.length];
  setTab(next.id);
  event.currentTarget.children[TABS.indexOf(next)].focus();
}
