"""Check that every Python module, class and function in the repository has a docstring.

Ruff's pydocstyle rules cover public names only. The owner's rule (CLAUDE.md, Code
conventions) covers everything, private helpers and nested functions included, so this
walks the Python sources and lists whatever lacks a docstring. `just lint` runs it.

    uv run python scripts/check_docstrings.py
"""

import ast
import sys
from collections.abc import Iterator
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Where the repository's Python lives.
SOURCE_DIRECTORIES = ("python", "services", "scripts")
# Folders that hold no hand-written Python: environments, caches, dependencies, and
# Django's generated migrations.
SKIPPED_FOLDERS = {".venv", "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", "migrations"}

type Documented = ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef


def python_files() -> Iterator[Path]:
    """Yield every hand-written Python file under the source folders, in a stable order."""
    for directory in SOURCE_DIRECTORIES:
        for path in sorted((ROOT / directory).rglob("*.py")):
            if not SKIPPED_FOLDERS.intersection(path.relative_to(ROOT).parts):
                yield path


def undocumented(tree: ast.Module) -> Iterator[Documented]:
    """Yield the module itself, and every class and function in it, that has no docstring."""
    if ast.get_docstring(tree) is None:
        yield tree
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef) and ast.get_docstring(node) is None:
            yield node


def describe(path: Path, node: Documented) -> str:
    """Describe one missing docstring as `file:line what`."""
    relative = path.relative_to(ROOT)
    if isinstance(node, ast.Module):
        return f"{relative}:1 the module has no docstring"
    return f"{relative}:{node.lineno} {node.name} has no docstring"


def main() -> int:
    """Check every file, report each missing docstring, and return the exit status."""
    problems: list[str] = []
    for path in python_files():
        tree = ast.parse(path.read_bytes(), str(path))
        problems.extend(describe(path, node) for node in undocumented(tree))
    for problem in problems:
        sys.stderr.write(f"{problem}\n")
    if problems:
        sys.stderr.write(f"{len(problems)} missing docstrings. Every module, class and function needs one.\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
