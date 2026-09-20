import styled from "styled-components";

const COLORS = ["#ff3d3d", "#ff9f1a", "#ffe21a", "#3ddc5a", "#1ab2ff", "#8a5bff", "#ff3dcb"];

const Svg = styled.svg`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
  opacity: 0.55;
  animation: ait-ring-fade 0.6s var(--ait-ease-exit) 2.4s forwards;

  rect {
    fill: none;
    stroke: url("#ait-ring-gradient");
    stroke-width: 2;
    stroke-linecap: round;
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    animation: ait-ring-draw 1.8s var(--ait-ease-standard) forwards;
  }

  rect:first-of-type {
    stroke-width: 6;
    stroke-opacity: 0.6;
    filter: blur(8px);
  }

  @keyframes ait-ring-draw {
    to {
      stroke-dashoffset: 0;
    }
  }

  @keyframes ait-ring-fade {
    to {
      opacity: 0;
    }
  }
`;

/** Draws clockwise from the top-left corner until it closes, then fades out. */
export function Ring() {
  return (
    <Svg aria-hidden="true">
      <defs>
        <linearGradient id="ait-ring-gradient" x2="1" y2="1">
          {COLORS.map((color, index) => (
            <stop key={color} offset={index / (COLORS.length - 1)} stopColor={color} />
          ))}
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" rx="12" pathLength="1" />
      <rect width="100%" height="100%" rx="12" pathLength="1" />
    </Svg>
  );
}
