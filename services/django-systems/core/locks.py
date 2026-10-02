"""Locks that make a visitor's daily limit hold when their requests arrive at the same moment.

A limit that counts a visitor's rows and then saves a new one is a check followed by an action.
Two requests of the same visitor can both count before either saves, and both pass, so a visitor
who sends many at once gets as many as they sent instead of the limit. Taking this lock first
makes them take turns: the second request counts only after the first has saved and committed.
"""

from django.db import connections


def lock_visitor(using: str, scope: str, session_key: str) -> None:
    """Wait for this visitor's turn at `scope`, and keep it until the current transaction ends.

    Call it first thing inside `transaction.atomic(using=using)`, before counting what the
    visitor has already made. Other visitors, and the same visitor's other scopes, never wait.
    The lock is a Postgres advisory lock named by the scope and the visitor's session hash, so
    it works across every process of the service and is released by the commit or rollback.
    """
    with connections[using].cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", [f"{scope}:{session_key}"])
