import { createRoot } from "react-dom/client";
import styled, { createGlobalStyle } from "styled-components";

import { Settings } from "../ui/Settings.jsx";
import { Tokens } from "../ui/tokens.js";
import { smallText } from "../ui/primitives.jsx";

// The popup is our own page, so YouTube's theme attribute isn't here to inherit.
if (matchMedia("(prefers-color-scheme: dark)").matches) {
  document.documentElement.setAttribute("dark", "");
}

const PopupStyle = createGlobalStyle`
  html {
    /* YouTube sets a 10px root, which every rem in our components is measured against. */
    font-size: 10px;
    color-scheme: light dark;
    background: Canvas;
  }

  body {
    width: 300px;
    margin: 0;
    padding: var(--ait-space-3) var(--ait-space-4) var(--ait-space-4);
    background: var(--ait-menu);
    color: var(--ait-text);
    font-family: var(--ait-font);
  }
`;

const Title = styled.h1`
  margin: 0 0 var(--ait-space-2);
  font-size: 1.6rem;
  line-height: 2.2rem;
  font-weight: 700;
  font-stretch: 25%;
`;

const Hint = styled.p`
  margin: var(--ait-space-1) 0 0 calc(var(--ait-space-4) + var(--ait-space-4));
  color: var(--ait-text-secondary);
  ${smallText}
`;

createRoot(document.body).render(
  <>
    <Tokens />
    <PopupStyle />
    <Title>Alive Internet Theory</Title>
    <Settings debugExtra={<Hint>Rerun analysis sits on the video&apos;s card.</Hint>} />
  </>,
);
