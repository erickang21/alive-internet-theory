import styled from "styled-components";

// The frame every state of the card shares: the verdict, the loading skeleton and the
// error container all sit in the same shell, so a verdict landing swaps the contents
// without the box moving or resizing under the viewer.

export const SEGMENTS = 5;

// One gradient draws all four separators, so the segments need no extra elements.
export const separators = `linear-gradient(
  90deg,
  ${Array.from({ length: SEGMENTS - 1 }, (_, index) => {
    const stop = ((index + 1) * 100) / SEGMENTS;
    return `transparent calc(${stop}% - 2px), var(--ait-surface) calc(${stop}% - 2px) ${stop}%, transparent ${stop}%`;
  }).join(", ")}
)`;

export const Shell = styled.article`
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

export const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--ait-space-3);
  padding: var(--ait-space-4);
`;

export const Headline = styled.div`
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--ait-space-3);
`;

export const Track = styled.div`
  position: relative;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--ait-tonal);

  &::after {
    content: "";
    position: absolute;
    inset: 0;
    background: ${separators};
  }
`;

/* The footer rule the feedback row and its skeleton both hang off, drawn full-bleed
   across the padded body. */
export const Footer = styled.div`
  margin: 0 calc(-1 * var(--ait-space-4));
  padding: var(--ait-space-2) var(--ait-space-4) 0;
  border-top: 1px solid var(--ait-outline);
`;
