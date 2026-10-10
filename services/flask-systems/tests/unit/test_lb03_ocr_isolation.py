"""What the OCR worker can reach: the modules it loads are a short list with no part of the service in it.

A decoder bug is the likeliest way into the worker, so what the worker holds matters if it is taken over. It
must not import the web framework, the database, the gateway client, the store, or any of the service's own
code beyond the few modules it needs, and it must not be handed a secret. These tests start the worker's module
in a fresh interpreter and read back what it loaded.
"""

import json
import subprocess
import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[2]
# The service's own top-level packages. The worker may use `lb03.ocr.*` and three small `lb03` modules only.
SERVICE_PACKAGES = ("core", "config", "lb05", "lb_common", "tests")
ALLOWED_LB03 = {"lb03", "lb03.ocr", "lb03.sniff", "lb03.states", "lb03.limits"}
# Third-party packages that would mean the worker could talk to the network, a database, or the web service.
FORBIDDEN_PACKAGES = (
    "flask",
    "flask_openapi3",
    "werkzeug",
    "gunicorn",
    "asgiref",
    "sqlalchemy",
    "alembic",
    "psycopg",
    "redis",
    "openai",
    "httpx",
    "aiohttp",
    "boto3",
    "botocore",
    "jwt",
    "cryptography",
    "duckdb",
    "celery",
)
# What RapidOCR loads that could speak HTTP, for its model downloader, which the worker never calls: it gives the
# models by path. They are named here so that a new one shows up as a failure. They are harmless because the cage
# refuses to open a socket (test_lb03_ocr_sandbox.py), and the worker has no network to use them on.
LOADED_BY_RAPIDOCR = {"requests", "urllib3"}


def loaded_modules() -> list[str]:
    """Import the worker's module in a fresh interpreter, and list every module that was loaded."""
    script = "import json, sys; import lb03.ocr.worker; print(json.dumps(sorted(sys.modules)))"
    done = subprocess.run(  # noqa: S603 - this interpreter, a fixed script
        [sys.executable, "-P", "-c", script],
        env={"PYTHONPATH": str(SERVICE_ROOT), "PYTHONDONTWRITEBYTECODE": "1"},
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    )
    return list(json.loads(done.stdout))


def test_the_worker_loads_no_part_of_the_service() -> None:
    """Of the service's own code, only the OCR package and three small modules are loaded."""
    modules = loaded_modules()
    own = [name for name in modules if name.split(".")[0] in {"lb03", *SERVICE_PACKAGES}]
    outside = [name for name in own if not name.startswith("lb03.ocr.") and name not in ALLOWED_LB03]
    assert outside == []


def test_the_worker_loads_nothing_that_could_reach_the_network_a_database_or_the_web_framework() -> None:
    """No web framework, database driver, cloud SDK or token library is imported, and the only HTTP client is named."""
    top_level = {name.split(".")[0] for name in loaded_modules()}
    assert top_level & set(FORBIDDEN_PACKAGES) == set()
    assert top_level & {"requests", "urllib3", "httpx", "aiohttp", "http.client"} <= LOADED_BY_RAPIDOCR


def test_the_worker_modules_only_import_what_they_are_allowed_to() -> None:
    """The source of the OCR package names no forbidden package, so a later edit cannot add one unnoticed."""
    for path in [*sorted((SERVICE_ROOT / "lb03" / "ocr").glob("*.py")), SERVICE_ROOT / "lb03" / "sniff.py"]:
        source = path.read_text(encoding="utf-8")
        for package in (*FORBIDDEN_PACKAGES, *SERVICE_PACKAGES):
            assert f"import {package}" not in source, (path.name, package)
            assert f"from {package}" not in source, (path.name, package)
        for line in source.splitlines():
            if line.startswith("from lb03"):
                module = line.split()[1]
                assert module.startswith("lb03.ocr") or module in ALLOWED_LB03, (path.name, module)
