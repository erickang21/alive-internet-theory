import styled from "styled-components";

import { useDebugMode, useFilterState } from "./hooks.js";
import { bodyText, focusRing } from "./primitives.jsx";

const Shell = styled.div`
  display: flex;
  flex-direction: column;
`;

const Row = styled.button`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ait-space-4);
  width: calc(100% + 2 * var(--ait-space-2));
  min-height: var(--ait-control-height);
  margin: 0 calc(-1 * var(--ait-space-2));
  padding: var(--ait-space-2);
  padding-left: ${(props) =>
    props.$nested ? "calc(var(--ait-space-4) + var(--ait-space-4))" : "var(--ait-space-2)"};
  border: none;
  border-radius: var(--ait-radius-chip);
  background: transparent;
  color: inherit;
  font-family: inherit;
  ${bodyText}
  text-align: left;
  cursor: pointer;
  transition: background var(--ait-duration-fast) var(--ait-ease-exit);

  &:hover {
    background: var(--ait-tonal);
  }

  &:focus-visible {
    ${focusRing}
  }

  &:disabled {
    color: var(--ait-text-disabled);
    background: transparent;
    cursor: default;
  }
`;

const Track = styled.span`
  position: relative;
  flex: 0 0 auto;
  width: 44px;
  height: 24px;
  border-radius: 12px;
  background-color: ${(props) => (props.$on ? "var(--ait-text)" : "var(--ait-tonal-hover)")};
  opacity: ${(props) => (props.$disabled ? 0.4 : 1)};
  transition:
    background-color var(--ait-duration-switch) var(--ait-ease-standard),
    opacity var(--ait-duration-switch) var(--ait-ease-standard);

  &::after {
    content: "";
    position: absolute;
    top: 3px;
    left: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background-color: ${(props) => (props.$on ? "var(--ait-menu)" : "var(--ait-text-secondary)")};
    transform: translateX(${(props) => (props.$on ? "20px" : "0")});
    will-change: transform;
    transition:
      transform var(--ait-duration-switch) var(--ait-ease-standard),
      background-color var(--ait-duration-switch) var(--ait-ease-standard);
  }
`;

function Switch({ label, on, disabled, nested, onToggle }) {
  return (
    <Row
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      $nested={nested}
      onClick={onToggle}
    >
      <span>{label}</span>
      <Track $on={on} $disabled={disabled} />
    </Row>
  );
}

/** `debugExtra` is revealed while debug mode is on: the panel's rerun button, or a hint. */
export function Settings({ debugExtra }) {
  const [filter, setFilter] = useFilterState();
  const [debug, toggleDebug] = useDebugMode();

  return (
    <Shell>
      <Switch
        label="AI flags on video previews"
        on={filter !== "off"}
        onToggle={() => setFilter(filter === "off" ? "flag" : "off")}
      />
      <Switch
        label="Remove AI-flagged videos"
        nested
        on={filter === "block"}
        disabled={filter === "off"}
        onToggle={() => setFilter(filter === "block" ? "flag" : "block")}
      />
      <Switch label="Debug mode" on={debug} onToggle={toggleDebug} />
      {debug && debugExtra}
    </Shell>
  );
}
