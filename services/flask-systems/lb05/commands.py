"""LB-05's `manage.py` commands: seed the data, sweep old quota rows, and run the live eval.

    seed_lb05   (just seed-lb05)   generate the synthetic Basalt & Bean data and write it to disk
    eval_lb05   (just eval-lb05)   put the golden set (or the adversarial set) to the live pipeline and grade it
    sweep_lb05                     delete the quota counters of days that are over
    export_pack_lb05  (just export-pack-lb05)  write the SQL writer's eval pack for Eval Lab, or check it

Each is a plain function of its arguments and the platform that returns the exit status, so a test can
call it. Output goes to standard output; nothing here prints a secret, a key or a visitor's words.
"""

import argparse
import time
from collections.abc import Sequence
from datetime import date
from pathlib import Path

from core.cli import write_line
from core.data_files import DataFileError
from core.platform import Platform
from lb05.generator import SIZES, generate
from lb05.golden import AdversarialSet, GoldenSet, read_adversarial_set, read_golden_set
from lb05.golden_eval import AdversarialReport, EvalReport, evaluate_adversarial, evaluate_golden
from lb05.pack import MADE_BY, PACK_FILE, SOURCE, PackMismatchError, export_pack
from lb05.pipeline import AnalystPipeline
from lb05.quota import PostgresLedger
from lb05.semantic_check import load_semantic_layer
from lb05.service import warehouse_directory
from lb05.sql_policy import SqlPolicy
from lb05.warehouse import Warehouse, WarehouseError
from lb05.warehouse_build import WarehouseMetaError, write_dataset
from lb10.pack_writer import render_pack, write_or_check

# The seed the shared dataset is made with unless another is asked for. Any number gives a different dataset.
DEFAULT_SEED = 5


def parse(parser: argparse.ArgumentParser, arguments: Sequence[str]) -> argparse.Namespace | int:
    """Parse a command's arguments, or return the exit status to stop with.

    When the arguments are wrong, or `--help` is asked for, argparse has said so already: 2 for a mistake, 0 for help.
    """
    try:
        return parser.parse_args(arguments)
    except SystemExit as stop:
        return stop.code if isinstance(stop.code, int) else 2


def seed_lb05(arguments: Sequence[str], platform: Platform) -> int:
    """Generate the synthetic dataset and write it as Parquet and as the DuckDB file the service opens read-only."""
    parser = argparse.ArgumentParser(prog="manage.py seed_lb05", description=seed_lb05.__doc__)
    parser.add_argument(
        "--size", choices=sorted(SIZES), default="full", help="How much data: full is about two million orders."
    )
    parser.add_argument(
        "--today", type=date.fromisoformat, default=None, help="The data's last day, YYYY-MM-DD (default: today, UTC)."
    )
    parser.add_argument(
        "--seed", type=int, default=DEFAULT_SEED, help="Another seed gives another dataset of the same shape."
    )
    parser.add_argument(
        "--data",
        type=Path,
        default=None,
        help="Where to write (default: LB05_WAREHOUSE_DIR, else data/generated/lb05).",
    )
    options = parse(parser, arguments)
    if isinstance(options, int):
        return options
    directory = options.data or warehouse_directory(platform)
    today = options.today or platform.clock().date()
    started = time.perf_counter()
    meta = write_dataset(generate(SIZES[options.size], today, options.seed), directory)
    write_line(
        f"Wrote the {meta.size} dataset for {meta.as_of} (seed {meta.seed}) to {directory} "
        f"in {time.perf_counter() - started:.1f} s."
    )
    for table, count in meta.rows.items():
        write_line(f"  {table:<14}{count:>12,}")
    write_line(f"  digest {meta.digest}")
    return 0


def sweep_lb05(arguments: Sequence[str], platform: Platform) -> int:
    """Delete the quota counters of days that are over: a visitor's day is done, and no history is kept."""
    if arguments:
        write_line("sweep_lb05 takes no arguments.", error=True)
        return 2
    removed = PostgresLedger(platform.engines["lb05"], platform.clock).sweep()
    write_line(f"Removed {removed} quota counters.")
    return 0


def eval_options(arguments: Sequence[str]) -> argparse.Namespace | int:
    """Read the eval command's arguments, or return the exit status to stop with."""
    parser = argparse.ArgumentParser(prog="manage.py eval_lb05", description=eval_lb05.__doc__)
    parser.add_argument("--samples", action="store_true", help="Run only the curated samples of the golden set.")
    parser.add_argument("--case", action="append", default=[], help="Run this case or attempt ID; repeat for more.")
    parser.add_argument("--adversarial", action="store_true", help="Run the adversarial questions, not the golden set.")
    return parse(parser, arguments)


def print_golden_report(report: EvalReport) -> None:
    """Print each golden case's grade and the totals: accuracy, model calls and corrections."""
    for grade in report.grades:
        write_line(f"{'pass' if grade.passed else 'FAIL'}  {grade.case_id}")
        for failure in grade.failures:
            write_line(f"      {failure}")
    matched = sum(grade.passed for grade in report.grades)
    write_line(
        f"{matched} of {len(report.grades)} cases matched the reference ({report.accuracy():.1%} execution accuracy)."
    )
    calls = report.model_calls()
    write_line(
        f"{calls} model calls ({calls / max(len(report.grades), 1):.1f} a case); "
        f"{report.corrected()} cases needed their self-correction."
    )
    for check, count in report.failures_by_check().most_common():
        write_line(f"  {check}: {count} failures")


def print_adversarial_report(report: AdversarialReport) -> None:
    """Print each adversarial attempt's grade and the totals: how many were held, and how each ended."""
    for grade in report.grades:
        mark = "skip" if grade.inconclusive else ("held" if grade.held else "FAIL")
        layers = f"; stopped by {', '.join(grade.stopped_by)}" if grade.stopped_by else ""
        write_line(f"{mark}  {grade.attempt_id} ({grade.outcome.value}{layers})")
        if grade.failure:
            write_line(f"      {grade.failure}")
    graded = report.conclusive()
    held = sum(grade.held for grade in graded)
    write_line(f"{held} of {len(graded)} conclusive attempts were held ({report.held_rate():.1%}).")
    write_line("Outcomes: " + ", ".join(f"{name} {count}" for name, count in sorted(report.outcomes().items())))


def every_attack_held(report: AdversarialReport) -> bool:
    """Tell whether the adversarial run proved something and every attempt it could grade was held.

    This one is a gate, unlike the golden set's accuracy: holding is not a score. A run in which the models
    were unreachable for every attempt proves nothing, so it does not pass.
    """
    graded = report.conclusive()
    return bool(graded) and all(grade.held for grade in graded)


def unknown_ids(chosen: list[str], known: set[str]) -> list[str]:
    """List the chosen IDs that no case or attempt has."""
    return sorted(set(chosen) - known)


def chosen_ids(options: argparse.Namespace, golden: GoldenSet) -> list[str]:
    """List the case IDs the options ask for: those named, and the curated samples with `--samples`."""
    chosen = [str(case_id) for case_id in options.case]
    if options.samples:
        chosen += [case.id for case in golden.samples()]
    return chosen


def open_pipeline(platform: Platform) -> AnalystPipeline | None:
    """Build the pipeline an eval grades: the real layer, checks and warehouse, with the gateway for the models."""
    if platform.chat is None:
        write_line(
            "eval_lb05 needs the gateway: set LB_GATEWAY_URL, LB_SERVICE_NAME and LB_SERVICE_KEY_FILE.", error=True
        )
        return None
    try:
        layer = load_semantic_layer(platform.seed_directory() / "lb05")
        warehouse = Warehouse.open(
            warehouse_directory(platform), platform.environment.duckdb_memory_limit, platform.environment.duckdb_threads
        )
        warehouse.check_matches(layer)
    except (DataFileError, WarehouseError, WarehouseMetaError) as error:
        write_line(f"The data isn't ready: {error}", error=True)
        return None
    return AnalystPipeline(layer, SqlPolicy(layer), warehouse, platform.chat, platform.tracer)


def eval_lb05(arguments: Sequence[str], platform: Platform) -> int:
    """Put the golden set (or, with --adversarial, the adversarial set) to the live pipeline, and grade it by rules.

    Costs two to four gateway calls a case, five at most, so run it when prompts or routes change:
    `--samples` runs only the curated samples, and `--case` picks cases by ID. Needs the gateway
    running with provider keys, and the data written (`just seed-lb05`). The golden run reports its
    accuracy and exits 0; the adversarial run exits 1 unless every attempt it could grade was held.
    """
    options = eval_options(arguments)
    if isinstance(options, int):
        return options
    try:
        golden = read_golden_set()
        adversarial: AdversarialSet = read_adversarial_set()
    except DataFileError as error:
        write_line(str(error), error=True)
        return 1
    chosen = chosen_ids(options, golden)
    known = (
        {attempt.id for attempt in adversarial.attempts} if options.adversarial else {case.id for case in golden.cases}
    )
    unknown = unknown_ids(chosen, known)
    if unknown:
        write_line(f"No case or attempt has the ID {', '.join(unknown)}.", error=True)
        return 2
    pipeline = open_pipeline(platform)
    if pipeline is None:
        return 1
    if options.adversarial:
        attack_report = evaluate_adversarial(adversarial, pipeline, chosen or None)
        print_adversarial_report(attack_report)
        return 0 if every_attack_held(attack_report) else 1
    print_golden_report(evaluate_golden(golden, pipeline, chosen or None))
    return 0


def export_pack_lb05(arguments: Sequence[str], platform: Platform) -> int:
    """Write the SQL writer's eval pack (evals/packs/lb05-sql-writer.yaml) for Eval Lab, or with --check compare it.

    The pack is built from the production prompt and the golden set, and the export refuses to write a
    pack that renders differently from what the pipeline sends. `--check` is what `just check` runs.
    """
    parser = argparse.ArgumentParser(prog="manage.py export_pack_lb05", description=export_pack_lb05.__doc__)
    parser.add_argument("--check", action="store_true", help="Only say whether the committed pack is up to date.")
    options = parse(parser, arguments)
    if isinstance(options, int):
        return options
    try:
        content, _pack = export_pack(platform.seed_directory())
    except (DataFileError, PackMismatchError, ValueError) as error:
        write_line(f"The pack can't be built: {error}", error=True)
        return 1
    return write_or_check(PACK_FILE, render_pack(content, MADE_BY, SOURCE), options.check, MADE_BY)
