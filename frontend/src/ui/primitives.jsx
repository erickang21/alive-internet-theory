import styled, { css } from "styled-components";

export const focusRing = css`
  outline: none;
  background: transparent;
  box-shadow: inset 0 0 0 2px var(--ait-text);
`;

export const bodyText = css`
  font-size: 1.4rem;
  line-height: 2rem;
  font-weight: 400;
`;

export const smallText = css`
  font-size: 1.2rem;
  line-height: 1.8rem;
  font-weight: 400;
`;

const Svg = styled.svg`
  width: 24px;
  height: 24px;
  fill: currentColor;
`;

export function Icon({ d }) {
  return (
    <Svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </Svg>
  );
}

export const IconButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--ait-control-height);
  height: var(--ait-control-height);
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--ait-text);
  cursor: pointer;
  transition: background var(--ait-duration-fast) var(--ait-ease-exit);

  &:hover {
    background: var(--ait-tonal-hover);
  }

  &:active {
    background:
      linear-gradient(var(--ait-tonal-pressed), var(--ait-tonal-pressed)), var(--ait-tonal-hover);
  }

  &:focus-visible {
    ${focusRing}
  }

  &:disabled {
    color: var(--ait-text-disabled);
    cursor: default;
  }

  &:disabled:hover {
    background: transparent;
  }
`;

export const Divider = styled.div`
  border-top: 1px solid var(--ait-outline);
`;

export const Status = styled.p`
  margin: 0;
  color: var(--ait-error);
  ${smallText}
`;
