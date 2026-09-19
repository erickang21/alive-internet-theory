"""clear pre agree/disagree community votes

Revision ID: c20c9a0d8d84
Revises: dc0a2f02a681
Create Date: 2026-09-19 21:30:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c20c9a0d8d84"
down_revision: str | Sequence[str] | None = "dc0a2f02a681"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Votes used to say what the video is ("human"/"ai"); they now say whether
    # the evaluation was right ("agree"/"disagree"), so old rows are meaningless.
    op.execute("DELETE FROM community_votes WHERE vote NOT IN ('agree', 'disagree')")


def downgrade() -> None:
    pass
