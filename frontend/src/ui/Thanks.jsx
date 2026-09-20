import styled from "styled-components";

import { bodyText } from "./primitives.jsx";

const Shell = styled.div`
  height: auto;
  overflow: hidden;
  interpolate-size: allow-keywords;
  transition:
    height var(--ait-duration-enter) var(--ait-ease-enter),
    opacity var(--ait-duration-enter) var(--ait-ease-enter);

  @starting-style {
    height: 0;
    opacity: 0;
  }
`;

const Text = styled.p`
  margin: 0;
  padding: var(--ait-space-3) var(--ait-space-4);
  border-top: 1px solid var(--ait-outline);
  ${bodyText}
`;

export function Thanks() {
  return (
    <Shell>
      <Text role="status">Thanks for contributing! 🎉</Text>
    </Shell>
  );
}
