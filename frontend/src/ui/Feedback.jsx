import styled from "styled-components";

import { THUMBS } from "./icons.js";
import { Icon, IconButton, Status, bodyText } from "./primitives.jsx";

const PROMPT = "Was our analysis correct?";
const FAILURE = "Couldn't send feedback. Try again.";

const Row = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ait-space-3);
`;

const Prompt = styled.span`
  ${bodyText}
`;

const Actions = styled.div`
  display: flex;
  gap: var(--ait-space-1);
  margin-right: calc(-1 * var(--ait-space-2));
`;

const Thumb = styled(IconButton)`
  color: var(--ait-${(props) => (props.$name === "up" ? "human" : "slop")});

  svg {
    transition: transform var(--ait-duration-fast) var(--ait-ease-exit);
  }

  &:active svg {
    transform: scale(0.88);
  }
`;

const Shell = styled.div`
  margin: 0 calc(-1 * var(--ait-space-4));
  padding: var(--ait-space-2) var(--ait-space-4) 0;
  border-top: 1px solid var(--ait-outline);
`;

/** Thumbs share one vote; `onVoted` fires only for a new choice made from this row. */
export function Feedback({ vote, onVoted }) {
  const choose = async (name) => {
    if (await vote.submit(name)) onVoted();
  };

  return (
    <Shell>
      <Row>
        <Prompt>{PROMPT}</Prompt>
        <Actions>
          {Object.entries(THUMBS).map(([name, thumb]) => {
            const on = vote.selected === name;
            return (
              <Thumb
                key={name}
                $name={name}
                type="button"
                aria-label={thumb.label}
                aria-pressed={on}
                disabled={vote.pending}
                onClick={() => choose(name)}
              >
                <Icon d={on ? thumb.filled : thumb.outline} />
              </Thumb>
            );
          })}
        </Actions>
      </Row>
      {vote.failed && <Status role="status">{FAILURE}</Status>}
    </Shell>
  );
}
