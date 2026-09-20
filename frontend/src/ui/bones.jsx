import styled, { keyframes } from "styled-components";

// The loading placeholder, shared by the verdict card's skeleton and the
// fact-check tab's. One wave crossing the whole surface, not N bones blinking
// on their own: every bone runs the same sweep and each row starts further
// behind it, so the sheen rolls down the card. The delays are negative, which
// offsets the phase without stalling the first cycle.
const WAVE_MS = 1600;
const ROW_STEP_MS = 180;
const ROWS = 5;

const wave = keyframes`
  from { transform: translateX(-100%); }
  to { transform: translateX(100%); }
`;

/** A placeholder block: the resting tone plus the sheen that sweeps across it. */
export const Bone = styled.div`
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
    animation-delay: ${(props) => ((props.$row ?? 0) - ROWS) * ROW_STEP_MS}ms;
  }
`;
