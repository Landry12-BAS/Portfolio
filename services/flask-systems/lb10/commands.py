"""LB-10's `manage.py` commands that need no model: the sweep.

    sweep_lb10   delete the quota counters of days that are over and the runs past their week

The commands that put packs to live models (the nightly eval, the judge, the CI gate, the fallback
advisor) are in lb10/evals.py, since they share the pipeline. Each command is a plain function of its
arguments and the platform that returns the exit status, so a test can call it.
"""

from collections.abc import Sequence

from core.cli import write_line
from core.platform import Platform
from lb10.quota import PostgresLedger
from lb10.repository import EvalRepository


def sweep_lb10(arguments: Sequence[str], platform: Platform) -> int:
    """Delete the quota counters of days that are over and the runs older than their week; safe to run twice."""
    if arguments:
        write_line("sweep_lb10 takes no arguments.", error=True)
        return 2
    engine = platform.engines["lb10"]
    counters = PostgresLedger(engine, platform.clock).sweep()
    runs = EvalRepository(engine, platform.clock).delete_old_runs()
    write_line(f"Removed {counters} quota counters and {runs} old runs.")
    return 0
