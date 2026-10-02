"""How many WebSocket connections each visitor has open in this process.

A visitor token is cheap to come by (the site hands one to anyone who passes its check), and a
connection costs a socket, a task and a blocked read on Redis, so one visitor may not hold
more than a few. The count is kept in the process, because the connections are: with several
server processes each one allows the limit, which is still a bound.
"""


class ConnectionCounts:
    """Counts each visitor's open connections and refuses one more past a limit."""

    def __init__(self, limit: int) -> None:
        """Allow each visitor `limit` connections at a time."""
        self.limit = limit
        self.counts: dict[str, int] = {}

    def enter(self, visitor: str) -> bool:
        """Count one more connection for the visitor unless they have as many as they may; say if it was counted."""
        open_now = self.counts.get(visitor, 0)
        if open_now >= self.limit:
            return False
        self.counts[visitor] = open_now + 1
        return True

    def leave(self, visitor: str) -> None:
        """Count one connection fewer for the visitor, and forget a visitor who has none left."""
        open_now = self.counts.get(visitor, 0)
        if open_now <= 1:
            self.counts.pop(visitor, None)
        else:
            self.counts[visitor] = open_now - 1

    def open_for(self, visitor: str) -> int:
        """Return how many connections the visitor has open."""
        return self.counts.get(visitor, 0)

    def total(self) -> int:
        """Return how many connections every visitor has open together."""
        return sum(self.counts.values())
