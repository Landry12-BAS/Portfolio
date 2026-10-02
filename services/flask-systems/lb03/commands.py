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
