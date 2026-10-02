"""Tests for LB-03's settings: where its files are kept, how many OCR processes run, and its own database login."""

import pytest

from config.environment import ConfigurationError, read_environment
from core.databases import connection_options, system_engines
from tests.support import VALID_ENVIRONMENT

S3 = {
    "LB03_STORAGE": "s3",
    "LB03_S3_BUCKET": "lb03-invoices",
    "LB03_S3_ENDPOINT": "https://0123456789abcdef.r2.cloudflarestorage.com",
    "LB03_S3_ACCESS_KEY_ID": "AKIA-TEST-ONLY",
    "LB03_S3_SECRET_ACCESS_KEY": "secret-that-must-not-print",
}


def test_the_defaults_keep_files_on_local_disk_with_one_ocr_worker() -> None:
    """Without any LB03_ variable the system runs on its own: local files, one OCR process, the shared database."""
    environment = read_environment(VALID_ENVIRONMENT)

    assert environment.lb03_storage == "local"
    assert environment.lb03_files_dir is None
    assert environment.lb03_ocr_workers == 1
    assert environment.lb03_scratch_dir is None
    assert environment.lb03_database_url is None
    assert environment.database_url_for("lb03") == environment.database_url


def test_an_s3_store_needs_its_bucket_and_both_halves_of_its_key() -> None:
    """A store that would fail on the first upload is a start-up error that names what is missing."""
    complete = read_environment({**VALID_ENVIRONMENT, **S3})
    assert complete.lb03_storage == "s3"
    assert complete.lb03_s3_region == "auto"

    for variable in ("LB03_S3_BUCKET", "LB03_S3_ACCESS_KEY_ID", "LB03_S3_SECRET_ACCESS_KEY"):
        incomplete = {name: value for name, value in {**VALID_ENVIRONMENT, **S3}.items() if name != variable}
        with pytest.raises(ConfigurationError, match=variable):
            read_environment(incomplete)


def test_the_secret_key_is_never_printed() -> None:
    """The secret is held as a secret: neither the settings' text nor a start-up error carries it."""
    environment = read_environment({**VALID_ENVIRONMENT, **S3})

    assert "secret-that-must-not-print" not in repr(environment)
    assert "secret-that-must-not-print" not in str(environment)
    assert environment.lb03_s3_secret_access_key is not None
    assert environment.lb03_s3_secret_access_key.get_secret_value() == "secret-that-must-not-print"
    with pytest.raises(ConfigurationError) as error:
        read_environment({**VALID_ENVIRONMENT, **S3, "LB03_S3_BUCKET": "Not A Bucket"})
    assert "secret-that-must-not-print" not in str(error.value)


@pytest.mark.parametrize(
    ("variable", "value"),
    [
        ("LB03_STORAGE", "ftp"),
        ("LB03_DATABASE_URL", "sqlite:///lb.db"),
        ("LB03_OCR_WORKERS", "0"),
        ("LB03_OCR_WORKERS", "9"),
        ("LB03_S3_BUCKET", "UPPER"),
        ("LB03_S3_BUCKET", "ab"),
        ("LB03_S3_ENDPOINT", "http://storage.example.com"),
        ("LB03_S3_ENDPOINT", "https://storage.example.com/path"),
        ("LB03_S3_ENDPOINT", "file:///etc/passwd"),
        ("LB03_S3_REGION", "Europe Central"),
    ],
)
def test_refuses_a_malformed_storage_database_or_worker_setting(variable: str, value: str) -> None:
    """The storage kind, the database URL, the worker count and the S3 details are checked at start-up."""
    with pytest.raises(ConfigurationError, match=variable):
        read_environment({**VALID_ENVIRONMENT, **S3, variable: value})


def test_a_local_s3_server_may_use_plain_http() -> None:
    """MinIO on this machine is allowed without TLS; the same address on another host is not."""
    local = {**VALID_ENVIRONMENT, **S3, "LB03_S3_ENDPOINT": "http://127.0.0.1:9000"}

    assert read_environment(local).lb03_s3_endpoint == "http://127.0.0.1:9000"


def test_lb_03_logs_in_as_its_own_role_when_it_has_one() -> None:
    """LB03_DATABASE_URL is the login of the lb03 role; LB-05's login is not used for it."""
    own = "postgres://lb03@127.0.0.1/lb"
    environment = read_environment(
        {**VALID_ENVIRONMENT, "LB03_DATABASE_URL": own, "LB05_DATABASE_URL": "postgres://lb05@127.0.0.1/lb"}
    )

    assert environment.database_url_for("lb03") == own
    assert environment.database_url_for("lb05") == "postgres://lb05@127.0.0.1/lb"
    assert environment.database_url_for("anything-else") == environment.database_url


def test_lb_03_has_an_engine_on_its_own_schema() -> None:
    """The schema is registered, so its connections have a search_path of lb03 only."""
    engines = system_engines("postgres://shared@127.0.0.1/lb", {"lb03": "postgres://lb03@127.0.0.1/lb"})

    assert engines["lb03"].url.username == "lb03"
    assert "-c search_path=lb03 " in connection_options("lb03")
    for engine in engines.values():
        engine.dispose()
