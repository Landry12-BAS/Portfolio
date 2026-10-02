"""LB-03's `manage.py` commands: draw the seed documents, measure the OCR, grade the golden set, sweep expired files.

Each is a plain function taking its arguments and the platform and returning the exit status, so a test
calls it directly (core/registry.py). `just seed-lb03`, `just eval-lb03`, `just ocr-lb03` and
`just sweep-lb03` run them.
"""

import sys
from collections.abc import Sequence

from core.platform import Platform


def write_line(text: str, *, error: bool = False) -> None:
    """Write one line to a command's standard output, or to standard error."""
    stream = sys.stderr if error else sys.stdout
    stream.write(text + "\n")


def seed_lb03(arguments: Sequence[str], platform: Platform) -> int:  # noqa: ARG001 - the Command signature
    """Draw LB-03's synthetic documents, the manifest and the golden set; with `--check`, only say what is out of date.

    The documents are drawn from lb03/synthetic/content.py. `--check` draws them in memory and compares them with
    what is committed (PDFs byte for byte, photographs by what they show), and exits 1 listing every difference.
    """
    # Imported here: the generator needs ReportLab, OpenCV and Pillow, which the running service never loads.
    from lb03.synthetic.build import build_seed, check_seed

    if list(arguments) not in ([], ["--check"]):
        write_line("seed_lb03 takes no arguments, or --check.", error=True)
        return 2
    if arguments:
        problems = check_seed()
        for problem in problems:
            write_line(problem, error=True)
        write_line(
            "The seed documents are up to date."
            if not problems
            else f"{len(problems)} things are out of date: run `just seed-lb03`."
        )
        return 1 if problems else 0
    manifest = build_seed()
    total = sum(entry.bytes for entry in manifest.files)
    write_line(
        f"Drew {len(manifest.files)} documents ({total / 1_000_000:.1f} MB): data/seed/lb03, evals/lb03/golden.yaml."
    )
    return 0


def ocr_lb03(arguments: Sequence[str], platform: Platform) -> int:  # noqa: ARG001 - the Command signature
    """Measure the OCR on the synthetic documents with the real worker, and print the table.

    Options: `--case ID` for one document, `--workers N` for how many to read at once (default 2),
    `--page-side PIXELS` to render pages at another size than the service does, `--json FILE`
    to save every document's figures, `--write-baseline` to record the run as evals/lb03/ocr-baseline.json, and
    `--check` to fail (exit 1) when a figure falls more than the margin below that baseline. It reads about
    forty documents at a few seconds each and spends no model call.
    """
    # Imported here: the measurement needs the generator, which the running service never loads.
    import asyncio
    import time
    from pathlib import Path

    from lb03 import measure

    options = parse_options(
        arguments,
        {
            "--case": True,
            "--workers": True,
            "--page-side": True,
            "--json": True,
            "--write-baseline": False,
            "--check": False,
        },
    )
    if options is None:
        write_line(
            "ocr_lb03 takes --case ID, --workers N, --page-side PIXELS, --json FILE, --write-baseline, --check.",
            error=True,
        )
        return 2
    started = time.monotonic()
    page_side = int(options["--page-side"]) if "--page-side" in options else None
    results = asyncio.run(measure.measure_all(options.get("--case"), int(options.get("--workers", "2")), page_side))
    seconds = time.monotonic() - started
    write_line(measure.render_table(results))
    write_line(f"{len(results)} documents in {seconds:.0f} s.")
    if "--json" in options:
        measure.write_report(Path(options["--json"]), results, seconds)
    if "--write-baseline" in options:
        measure.write_baseline(results)
        write_line(f"Wrote {measure.BASELINE_FILE}.")
    if "--check" in options:
        problems = measure.regressions(results)
        for problem in problems:
            write_line(problem, error=True)
        return 1 if problems else 0
    return 0


def parse_options(arguments: Sequence[str], allowed: dict[str, bool]) -> dict[str, str] | None:
    """Read `--name value` and `--flag` arguments against a list of allowed names; None when anything else is given."""
    found: dict[str, str] = {}
    pending = list(arguments)
    while pending:
        name = pending.pop(0)
        if name not in allowed:
            return None
        if allowed[name]:
            if not pending:
                return None
            found[name] = pending.pop(0)
        else:
            found[name] = ""
    return found
