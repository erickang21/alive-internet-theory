import { createGlobalStyle } from "styled-components";

// Tokens stay CSS custom properties rather than a styled-components theme object so
// they can alias YouTube's own live values and flip with html[dark] without any JS.
export const Tokens = createGlobalStyle`
  [data-ait-root] {
    --ait-font: "Roboto", "Arial", sans-serif;
    --ait-radius: 12px;
    --ait-radius-chip: 8px;
    --ait-space-1: 4px;
    --ait-space-2: 8px;
    --ait-space-3: 12px;
    --ait-space-4: 16px;
    --ait-control-height: 40px;
    --ait-masthead-height: 56px;
    --ait-surface: var(--yt-sys-color-baseline--base-background, #fff);
    --ait-menu: var(--yt-sys-color-baseline--menu-background, #fff);
    --ait-marker: rgba(255, 214, 0, 0.45);
    --ait-text: var(--yt-sys-color-baseline--text-primary, #0f0f0f);
    --ait-text-secondary: var(--yt-sys-color-baseline--text-secondary, #606060);
    --ait-text-disabled: var(--yt-sys-color-baseline--text-disabled, #909090);
    --ait-outline: var(--yt-sys-color-baseline--outline, rgba(0, 0, 0, 0.1));
    --ait-tonal: var(--yt-sys-color-baseline--additive-background, rgba(0, 0, 0, 0.05));
    --ait-tonal-hover: var(--yt-sys-color-baseline--mono-tonal-hover, rgba(0, 0, 0, 0.1));
    --ait-tonal-pressed: var(--yt-sys-color-baseline--state-mono-standard-pressed, rgba(0, 0, 0, 0.1));
    --ait-cta: var(--yt-sys-color-baseline--call-to-action, #065fd4);
    --ait-error: var(--yt-sys-color-baseline--error-indicator, #c30027);
    --ait-human: var(--yt-sys-color-baseline--themed-green, #107516);
    --ait-possibly: var(--yt-sys-color-baseline--add-on-orange-primary, #bd3d19);
    --ait-slop: var(--yt-sys-color-baseline--error-indicator, #c30027);
    --ait-duration-fast: 0.1s;
    --ait-duration-enter: 0.25s;
    --ait-duration-switch: 0.2s;
    --ait-ease-exit: cubic-bezier(0.4, 0, 1, 1);
    --ait-ease-enter: cubic-bezier(0, 0, 0.2, 1);
    --ait-ease-standard: cubic-bezier(0.4, 0, 0.2, 1);
    --ait-elevation: 0 4px 32px rgba(0, 0, 0, 0.1);
  }

  html[dark] [data-ait-root] {
    --ait-surface: var(--yt-sys-color-baseline--base-background, #0f0f0f);
    --ait-menu: var(--yt-sys-color-baseline--menu-background, #282828);
    --ait-marker: rgba(255, 214, 0, 0.3);
    --ait-text: var(--yt-sys-color-baseline--text-primary, #f1f1f1);
    --ait-text-secondary: var(--yt-sys-color-baseline--text-secondary, #aaa);
    --ait-text-disabled: var(--yt-sys-color-baseline--text-disabled, #717171);
    --ait-outline: var(--yt-sys-color-baseline--outline, rgba(255, 255, 255, 0.2));
    --ait-tonal: var(--yt-sys-color-baseline--additive-background, rgba(255, 255, 255, 0.1));
    --ait-tonal-hover: var(--yt-sys-color-baseline--mono-tonal-hover, rgba(255, 255, 255, 0.2));
    --ait-tonal-pressed: var(--yt-sys-color-baseline--state-mono-standard-pressed, rgba(255, 255, 255, 0.1));
    --ait-cta: var(--yt-sys-color-baseline--call-to-action, #3ea6ff);
    --ait-error: var(--yt-sys-color-baseline--error-indicator, #f57);
    --ait-human: var(--yt-sys-color-baseline--themed-green, #2ba640);
    --ait-possibly: var(--yt-sys-color-baseline--add-on-orange-primary, #ffb39b);
    --ait-slop: var(--yt-sys-color-baseline--error-indicator, #f57);
    --ait-elevation: 0 4px 32px rgba(0, 0, 0, 0.4);
  }

  [data-ait-root], [data-ait-root] * { box-sizing: border-box; }

  /* The mount point is transparent to layout so the card itself is the flow element. */
  [data-ait-mount] { display: contents; }

  @media (prefers-reduced-motion: reduce) {
    [data-ait-root], [data-ait-root] *, [data-ait-root] *::before, [data-ait-root] *::after {
      animation: none !important;
      transition: none !important;
    }
  }
`;

export const tone = (name) => `var(--ait-${name})`;
