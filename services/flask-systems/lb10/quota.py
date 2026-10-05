"""The visitor's daily run: one a day, counted atomically in Postgres, with one run going at a time.

The limit is the datasheet's promise, kept here by the service in one SQL statement: a run is admitted by an
upsert that raises the visitor's counter only while it is below the limit and no run of theirs is going, so
two requests that arrive together can't both take the one place. The gateway's own per-session quota (40
calls) is a second line behind this one.

A run the service itself fails to finish (the models were down for every call, the worker died) is given
back, so it does not cost the visitor their one run; such a failure can be caused on purpose only with
difficulty here (the visitor's prompt is the only input, and a bad reply is a graded failure, not a service
failure), but the refunds are capped all the same. No history of a visitor is kept: the first run each day
deletes the counters of days that are over (`manage.py sweep_lb10` does the same by hand).

This is LB-05's ledger (lb05/quota.py) on LB-10's own table and limits; the two systems share no code.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal, Protocol

from sqlalchemy import Engine, Select, and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import SQLAlchemyError

from core.errors import describe_failure
from lb10.limits import BUSY_SECONDS, KEEP_DAYS, MAX_REFUNDS_PER_DAY, RUNS_PER_DAY
from lb10.models import QuotaUsage

logger = logging.getLogger(__name__)

type Reason = Literal["ok", "daily_limit", "busy"]


@dataclass(frozen=True)
class Admission:
    """The ledger's answer to a run arriving: let it in or not, and where the visitor's count stands."""

    allowed: bool
    reason: Reason
    session_key: str
    day: date
    used: int
    limit: int

    @property
    def remaining(self) -> int:
        """Return how many runs the visitor has left today."""
        return max(self.limit - self.used, 0)


@dataclass(frozen=True)
class Usage:
    """How many runs a visitor has started today, and when the count starts again."""

    used: int
    limit: int
    resets_at: datetime

    @property
    def remaining(self) -> int:
        """Return how many runs the visitor has left today."""
        return max(self.limit - self.used, 0)


class Ledger(Protocol):
    """What the API needs of the quota: admit a run, end it, and read a visitor's count."""

    def admit(self, session_key: str) -> Admission:
        """Admit a run from a visitor if they have one left today and none going."""
        ...

    def finish(self, admission: Admission, refund: bool) -> bool:
        """End an admitted run. Return whether the visitor got their place back."""
        ...

    def usage(self, session_key: str) -> Usage:
        """Return a visitor's count for today."""
        ...


def midnight_after(day: date) -> datetime:
    """Return midnight UTC at the start of the day after `day`: when a visitor's count starts again."""
    return datetime.combine(day + timedelta(days=1), time.min, tzinfo=UTC)


class PostgresLedger:
    """The ledger on LB-10's Postgres schema: every step is one statement, so it is atomic without a lock."""

    def __init__(
        self,
        engine: Engine,
        clock: Callable[[], datetime],
        limit: int = RUNS_PER_DAY,
        busy_seconds: int = BUSY_SECONDS,
        max_refunds: int = MAX_REFUNDS_PER_DAY,
    ) -> None:
        """Count on the schema `engine` is bound to, dating each day by `clock` (aware, in UTC)."""
        self._engine = engine
        self._clock = clock
        self._limit = limit
        self._busy_seconds = busy_seconds
        self._max_refunds = max_refunds
        self._swept_day: date | None = None

    def today(self) -> date:
        """Return today's date in UTC, the day a visitor's count belongs to."""
        return self._clock().astimezone(UTC).date()

    def admit(self, session_key: str) -> Admission:
        """Admit a run in one upsert that raises the count only while it is below the limit and nothing is going."""
        now = self._clock()
        day = now.astimezone(UTC).date()
        self.sweep_once_a_day(day)
        until = now + timedelta(seconds=self._busy_seconds)
        free_to_run = and_(
            QuotaUsage.used < self._limit, or_(QuotaUsage.busy_until.is_(None), QuotaUsage.busy_until <= now)
        )
        statement = (
            insert(QuotaUsage)
            .values(session_key=session_key, day=day, used=1, busy_until=until)
            .on_conflict_do_update(
                index_elements=[QuotaUsage.session_key, QuotaUsage.day],
                set_={"used": QuotaUsage.used + 1, "busy_until": until},
                where=free_to_run,
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

    def finish(self, admission: Admission, refund: bool) -> bool:
        """End an admitted run: clear the busy flag, and give the place back if a refund is asked for and allowed."""
        if not admission.allowed:
            return False
        this_visitor_today = (QuotaUsage.session_key == admission.session_key, QuotaUsage.day == admission.day)
        with self._engine.begin() as connection:
            if refund:
                given_back = connection.execute(
                    update(QuotaUsage)
                    .where(*this_visitor_today, QuotaUsage.refunds < self._max_refunds)
                    .values(used=func.greatest(QuotaUsage.used - 1, 0), refunds=QuotaUsage.refunds + 1, busy_until=None)
                ).rowcount
                if given_back:
                    return True
            connection.execute(update(QuotaUsage).where(*this_visitor_today).values(busy_until=None))
        return False

    def usage(self, session_key: str) -> Usage:
        """Return how many runs a visitor has started today."""
        day = self.today()
        with self._engine.connect() as connection:
            used = connection.execute(self.count_of(session_key, day)).scalar_one_or_none() or 0
        return Usage(used=used, limit=self._limit, resets_at=midnight_after(day))

    def sweep_once_a_day(self, day: date) -> None:
        """Delete the old counters the first time a run arrives on a new day. A failure is logged, never raised."""
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
