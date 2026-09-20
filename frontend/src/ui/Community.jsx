import styled from "styled-components";

import { opposite } from "./hooks.js";
import { bodyText } from "./primitives.jsx";

const EMPTY = "No community votes yet";

// Symmetric around an even split, a step every 15 points. No neutral bucket: a tie
// doesn't contradict the verdict, so it lands on the agreeing side.
const LEVELS = [
  [0.8, "strongly agrees", "human", 1],
  [0.65, "somewhat agrees", "human", 0.65],
  [0.5, "slightly agrees", "human", 0.4],
  [0.35, "slightly disagrees", "slop", 0.4],
  [0.2, "somewhat disagrees", "slop", 0.65],
  [0, "strongly disagrees", "slop", 1],
];

const Sentence = styled.p`
  margin: 0;
  ${bodyText}
  color: ${(props) => (props.$empty ? "var(--ait-text-secondary)" : "inherit")};
`;

const Mark = styled.span`
  padding: 0 var(--ait-space-1);
  border-radius: var(--ait-radius-chip);
  background: color-mix(
    in srgb,
    color-mix(
        in srgb,
        var(--ait-${(props) => props.$tone}) ${(props) => props.$mix * 100}%,
        #ffd600
      )
      28%,
    transparent
  );
  font-weight: 500;
`;

export function Community({ vote }) {
  const agree = vote.tally[vote.agreeVote] ?? 0;
  const total = agree + (vote.tally[opposite(vote.agreeVote)] ?? 0);
  if (!total) return <Sentence $empty>{EMPTY}</Sentence>;

  const [, phrase, tone, mix] = LEVELS.find(([min]) => agree / total >= min);
  return (
    <Sentence>
      The community{" "}
      <Mark $tone={tone} $mix={mix}>
        {phrase}
      </Mark>{" "}
      ({total} {total === 1 ? "vote" : "votes"})
    </Sentence>
  );
}
