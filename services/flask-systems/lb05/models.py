"""LB-05's tables in its own Postgres schema, `lb05`.

The analyst's data lives in DuckDB, not here. Postgres holds only what has to be shared by every
worker process and survive a restart: how many questions each visitor has asked today, which is a
quota the service enforces itself. Visitors have no accounts, so a visitor is the hash of their
session (the subject of their token), never a name or an address, and a row is useless after its day.

The tables carry no schema name: every connection of this system has a search_path of `lb05` only
(core/databases.py), so they are created and read there, and the models work unchanged on a role that is
granted nothing else.
"""

from datetime import date, datetime

from sqlalchemy import CheckConstraint, Date, DateTime, Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# The most a counter may hold, which a CHECK constraint keeps even if a bug tried to pass it.
MAX_COUNTER = 1_000


class Base(DeclarativeBase):
    """The base of LB-05's tables; its metadata is what the migrations are checked against."""


class QuotaUsage(Base):
    """How many questions one visitor has asked on one day, and until when one is running.

    `busy_until` is set while a question is being answered and cleared when it ends, so a visitor
    has one question running at a time; if the process dies mid-question, the flag expires.
    `refunds` counts the questions given back today, which the ledger caps (lb05/safety.py).
    """

    __tablename__ = "quota_usage"
    __table_args__ = (
        CheckConstraint(f"used >= 0 AND used <= {MAX_COUNTER}", name="quota_usage_used_range"),
        CheckConstraint(f"refunds >= 0 AND refunds <= {MAX_COUNTER}", name="quota_usage_refunds_range"),
    )

    session_key: Mapped[str] = mapped_column(String(128), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    used: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    busy_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    refunds: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
