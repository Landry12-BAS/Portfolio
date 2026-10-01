"""The visitor's daily questions: 25 a day, counted atomically in Postgres.

The limit is the datasheet's promise, and it is kept here, by the service, in one SQL statement: a
question is admitted by an upsert that raises the visitor's counter only while it is below the limit,
so two questions that arrive together can't both take the last place. The gateway's own per-session
quota is a second line behind this one, sized for the worst case of five model calls a question.

A visitor also has one question running at a time. A question sets a short-lived busy flag when it is
admitted and clears it when it ends, so one visitor can't hold every worker with parallel questions.
If a process dies mid-question the flag expires on its own.

A question the service itself fails to answer (the models are down, the warehouse is busy) is
refunded: it is not the visitor's fault, and it should not cost them one of their 25.
"""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal, Protocol

from sqlalchemy import Engine, Select, and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert

from lb05.models import QuotaUsage
from lb05.safety import QUESTION_DEADLINE_SECONDS, QUESTIONS_PER_DAY

# A running question holds its visitor's place a little longer than its own deadline, so a slow one is not cut off.
BUSY_SECONDS = int(QUESTION_DEADLINE_SECONDS) + 30
# Counters older than this many days are deleted: a visitor's day is over, and no history is kept.
KEEP_DAYS = 2

type Reason = Literal["ok", "daily_limit", "busy"]


@dataclass(frozen=True)
class Admission:
    """The ledger's answer to a question arriving: let it in or not, and where the visitor's count stands."""

    allowed: bool
    reason: Reason
    session_key: str
    day: date
    used: int
    limit: int

    @property
    def remaining(self) -> int:
        """Return how many questions the visitor has left today."""
        return max(self.limit - self.used, 0)


@dataclass(frozen=True)
class Usage:
    """How many questions a visitor has used today, and when the count starts again."""

    used: int
    limit: int
    resets_at: datetime

    @property
    def remaining(self) -> int:
        """Return how many questions the visitor has left today."""
        return max(self.limit - self.used, 0)


class Ledger(Protocol):
    """What the API needs of the quota: admit a question, end it, and read a visitor's count."""

    def admit(self, session_key: str) -> Admission:
        """Admit a question from a visitor if they have one left today and none running."""
        ...

    def finish(self, admission: Admission, refund: bool) -> None:
        """End an admitted question, giving the visitor their place back when `refund` is true."""
        ...

    def usage(self, session_key: str) -> Usage:
        """Return a visitor's count for today."""
        ...


def midnight_after(day: date) -> datetime:
    """Return midnight UTC at the start of the day after `day`: when a visitor's count starts again."""
    return datetime.combine(day + timedelta(days=1), time.min, tzinfo=UTC)


class PostgresLedger:
    """The ledger on LB-05's Postgres schema: every step is one statement, so it is atomic without a lock."""

    def __init__(
        self,
        engine: Engine,
        clock: Callable[[], datetime],
        limit: int = QUESTIONS_PER_DAY,
        busy_seconds: int = BUSY_SECONDS,
    ) -> None:
        """Count on the schema `engine` is bound to, dating each day by `clock` (aware, in UTC)."""
        self._engine = engine
        self._clock = clock
        self._limit = limit
        self._busy_seconds = busy_seconds

    def today(self) -> date:
        """Return today's date in UTC, the day a visitor's count belongs to."""
        return self._clock().astimezone(UTC).date()

    def admit(self, session_key: str) -> Admission:
        """Admit a question in one upsert that raises the count only while it is below the limit and nothing runs."""
        now = self._clock()
        day = now.astimezone(UTC).date()
        until = now + timedelta(seconds=self._busy_seconds)
        free_to_ask = and_(
            QuotaUsage.used < self._limit, or_(QuotaUsage.busy_until.is_(None), QuotaUsage.busy_until <= now)
        )
        statement = (
            insert(QuotaUsage)
            .values(session_key=session_key, day=day, used=1, busy_until=until)
            .on_conflict_do_update(
                index_elements=[QuotaUsage.session_key, QuotaUsage.day],
                set_={"used": QuotaUsage.used + 1, "busy_until": until},
                where=free_to_ask,
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

    def finish(self, admission: Admission, refund: bool) -> None:
        """End an admitted question: clear the busy flag, and take the count back down by one when it is refunded."""
        if not admission.allowed:
            return
        values: dict[str, object] = {"busy_until": None}
        if refund:
            values["used"] = func.greatest(QuotaUsage.used - 1, 0)
        statement = (
            update(QuotaUsage)
            .where(QuotaUsage.session_key == admission.session_key, QuotaUsage.day == admission.day)
            .values(**values)
        )
        with self._engine.begin() as connection:
            connection.execute(statement)

    def usage(self, session_key: str) -> Usage:
        """Return how many questions a visitor has used today."""
        day = self.today()
        with self._engine.connect() as connection:
            used = connection.execute(self.count_of(session_key, day)).scalar_one_or_none() or 0
        return Usage(used=used, limit=self._limit, resets_at=midnight_after(day))

    def sweep(self) -> int:
        """Delete the counters of days that are over, and return how many rows went."""
        oldest = self.today() - timedelta(days=KEEP_DAYS)
        with self._engine.begin() as connection:
            return connection.execute(delete(QuotaUsage).where(QuotaUsage.day < oldest)).rowcount

    @staticmethod
    def count_of(session_key: str, day: date) -> Select[int]:
        """Build the query for one visitor's count on one day."""
        return select(QuotaUsage.used).where(QuotaUsage.session_key == session_key, QuotaUsage.day == day)
