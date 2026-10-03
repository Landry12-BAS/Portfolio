"""The visitor's daily documents: ten a day, two at a time, counted atomically in Postgres.

The limit is the datasheet's promise, and it is kept here, by the service, in one SQL statement: a document is
admitted by an upsert that raises the visitor's counters only while the day's count is below the limit and fewer
than two of their documents are in the pipeline, so two uploads that arrive together can't both take the last
place. The gateway's own per-session quota is a second line behind this one, sized for the worst case of five
model calls a document.

A document the service itself fails to read (the OCR worker crashed, the models are down, the day's free capacity is
spent) is given back, so it does not cost the visitor one of their ten. Almost any such failure can be caused on
purpose, though, so the refunds are capped at a few a day: the cap is what keeps the work a visitor can cause
bounded.

No history of a visitor is kept: the first upload each day deletes the counters of days that are over, so retention
does not depend on a scheduler (`manage.py sweep_lb03` does the same by hand).
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal

from sqlalchemy import Engine, Select, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import SQLAlchemyError

from core.errors import describe_failure
from lb03 import limits
from lb03.models import QuotaUsage

logger = logging.getLogger(__name__)

# Counters older than this many days are deleted: a visitor's day is over, and no history is kept.
KEEP_DAYS = 2

type Reason = Literal["ok", "daily_limit", "busy"]


@dataclass(frozen=True)
class Admission:
    """The ledger's answer to an upload arriving: let it in or not, and where the visitor's count stands."""

    allowed: bool
    reason: Reason
    session_key: str
    day: date
    used: int
    limit: int

    @property
    def remaining(self) -> int:
        """Return how many documents the visitor has left today."""
        return max(self.limit - self.used, 0)


@dataclass(frozen=True)
class Usage:
    """How many documents a visitor has uploaded today, how many are being read, and when the count starts again."""

    used: int
    active: int
    limit: int
    resets_at: datetime

    @property
    def remaining(self) -> int:
        """Return how many documents the visitor has left today."""
        return max(self.limit - self.used, 0)


def midnight_after(day: date) -> datetime:
    """Return midnight UTC at the start of the day after `day`: when a visitor's count starts again."""
    return datetime.combine(day + timedelta(days=1), time.min, tzinfo=UTC)


class PostgresLedger:
    """The ledger on LB-03's Postgres schema: every step is one statement, so it is atomic without a lock."""

    def __init__(
        self,
        engine: Engine,
        clock: Callable[[], datetime],
        limit: int = limits.DOCUMENTS_PER_DAY,
        max_active: int = limits.MAX_ACTIVE_PER_VISITOR,
        max_refunds: int = limits.MAX_REFUNDS_PER_DAY,
    ) -> None:
        """Count on the schema `engine` is bound to, dating each day by `clock` (aware, in UTC)."""
        self._engine = engine
        self._clock = clock
        self._limit = limit
        self._max_active = max_active
        self._max_refunds = max_refunds
        self._swept_day: date | None = None

    def today(self) -> date:
        """Return today's date in UTC, the day a visitor's count belongs to."""
        return self._clock().astimezone(UTC).date()

    def admit(self, session_key: str) -> Admission:
        """Admit an upload in one upsert that raises the counters only while there is a place and a free worker slot."""
        day = self.today()
        self.sweep_once_a_day(day)
        statement = (
            insert(QuotaUsage)
            .values(session_key=session_key, day=day, used=1, active=1)
            .on_conflict_do_update(
                index_elements=[QuotaUsage.session_key, QuotaUsage.day],
                set_={"used": QuotaUsage.used + 1, "active": QuotaUsage.active + 1},
                where=(QuotaUsage.used < self._limit) & (QuotaUsage.active < self._max_active),
            )
            .returning(QuotaUsage.used)
        )
        with self._engine.begin() as connection:
            admitted = connection.execute(statement).scalar_one_or_none()
            if admitted is not None:
                return Admission(True, "ok", session_key, day, admitted, self._limit)
            used = connection.execute(self.count_of(session_key, day)).scalar_one_or_none() or 0
        reason: Reason = "daily_limit" if used >= self._limit else "busy"
        return Admission(False, reason, session_key, day, used, self._limit)

    def release(self, session_key: str, day: date, refund: bool) -> bool:
        """End an admitted document: free its worker slot, and give the place back if a refund is asked for and allowed.

        The allowance is checked by the statement that gives the place back (its WHERE clause), so it is kept
        exactly even when failures arrive together. Returns whether the visitor got their place back.
        """
        this_visitor_today = (QuotaUsage.session_key == session_key, QuotaUsage.day == day)
        with self._engine.begin() as connection:
            if refund:
                given_back = connection.execute(
                    update(QuotaUsage)
                    .where(*this_visitor_today, QuotaUsage.refunds < self._max_refunds)
                    .values(
                        used=func.greatest(QuotaUsage.used - 1, 0),
                        active=func.greatest(QuotaUsage.active - 1, 0),
                        refunds=QuotaUsage.refunds + 1,
                    )
                ).rowcount
                if given_back:
                    return True
            connection.execute(
                update(QuotaUsage).where(*this_visitor_today).values(active=func.greatest(QuotaUsage.active - 1, 0))
            )
        return False

    def usage(self, session_key: str) -> Usage:
        """Return how many documents a visitor has uploaded today, and how many are being read."""
        day = self.today()
        with self._engine.connect() as connection:
            row = connection.execute(
                select(QuotaUsage.used, QuotaUsage.active).where(
                    QuotaUsage.session_key == session_key, QuotaUsage.day == day
                )
            ).one_or_none()
        used, active = (row.used, row.active) if row is not None else (0, 0)
        return Usage(used=used, active=active, limit=self._limit, resets_at=midnight_after(day))

    def sweep_once_a_day(self, day: date) -> None:
        """Delete the old counters the first time an upload arrives on a new day. A failure is logged, never raised."""
        if self._swept_day == day:
            return
        try:
            self.sweep()
        except SQLAlchemyError as error:
            logger.error("Could not sweep old quota counters: %s", describe_failure(error))
            return
        self._swept_day = day

    def sweep(self) -> int:
        """Delete the counters of days that are over, and return how many rows went."""
        oldest = self.today() - timedelta(days=KEEP_DAYS)
        with self._engine.begin() as connection:
            return connection.execute(delete(QuotaUsage).where(QuotaUsage.day < oldest)).rowcount

    @staticmethod
    def count_of(session_key: str, day: date) -> Select[int]:
        """Build the query for one visitor's count on one day."""
        return select(QuotaUsage.used).where(QuotaUsage.session_key == session_key, QuotaUsage.day == day)
