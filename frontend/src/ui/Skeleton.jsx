import styled, { keyframes } from "styled-components";

import { Tokens } from "./tokens.js";
import { Body, Footer, Headline, Shell, separators } from "./frame.jsx";

const LABEL = "Evaluating video...";

// One wave crossing the card, not five bones blinking on their own: every bone runs the
// same sweep and each row starts further behind it, so the sheen rolls down the card.
// The delays are negative, which offsets the phase without stalling the first cycle.
const WAVE_MS = 1600;
const ROW_STEP_MS = 180;
const ROWS = 5;

const wave = keyframes`
  from { transform: translateX(-100%); }
  to { transform: translateX(100%); }
`;

/** A placeholder block: the resting tone plus the sheen that sweeps across it. */
const Bone = styled.div`
  position: relative;
  flex: 0 0 auto;
  overflow: hidden;
  border-radius: var(--ait-radius-chip);
  background: var(--ait-skeleton);
  width: ${(props) => props.$width};
  height: ${(props) => props.$height};

  &::after {
    content: "";
    position: absolute;
    inset: 0;
    /* Parked off the left edge, so reduced motion leaves the bones plain rather than
       freezing the sheen across the middle of each one. */
    transform: translateX(-100%);
    background: linear-gradient(90deg, transparent, var(--ait-skeleton-sheen), transparent);
    animation: ${wave} ${WAVE_MS}ms var(--ait-ease-standard) infinite;
    animation-delay: ${(props) => (props.$row - ROWS) * ROW_STEP_MS}ms;
  }
`;

// The meter keeps its segments while it waits, so the one element that carries the
// score doesn't change shape when the verdict lands.
const Meter = styled(Bone)`
  border-radius: 4px;

  &::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: 1;
    background: ${separators};
  }
`;

// The headline aligns on the baseline, and a block's baseline is its bottom edge, so a
// bone beside real text would sit a line's ascent too low and make the row taller than
// the verdict's. Centring keeps the row exactly 22px, as it is on the settled card.
const Score = styled(Bone)`
  align-self: center;
`;

const Heading = styled.h3`
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

// The thumbs are left out rather than drawn as two circles, so the footer carries their
// height instead: without it the card would grow by the button row when it settles.
const Row = styled.div`
  display: flex;
  align-items: center;
  min-height: var(--ait-control-height);
`;

const Link = styled(Bone)`
  align-self: flex-end;
`;

/** The verdict card's own frame with every value still missing: same shell, same rows,
 * same heights, so the card doesn't move when the real one replaces it. The heading is
 * the one thing that says what the wait is for, and `role="status"` announces it. */
export function Skeleton({ floating }) {
  return (
    <>
      <Tokens />
      <Shell $floating={floating} role="status" aria-busy="true">
        <Body>
          <Headline>
            <Heading>{LABEL}</Heading>
            <Score $row={0} $width="44px" $height="22px" />
          </Headline>
          <Meter $row={1} $width="100%" $height="8px" />
          <Bone $row={2} $width="82%" $height="20px" />
          <Footer>
            <Row>
              <Bone $row={3} $width="152px" $height="20px" />
            </Row>
          </Footer>
          <Link $row={4} $width="104px" $height="20px" />
        </Body>
      </Shell>
    </>
  );
}
