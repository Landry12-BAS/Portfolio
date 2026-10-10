"""Tests for config.environment: the service reads its variables once and says plainly what is wrong."""

import pytest
from django.core.exceptions import ImproperlyConfigured

from config.environment import read_environment, split_hosts

# A complete, valid environment; each test changes what it is about.
VALID = {
    "DJANGO_SECRET_KEY": "k" * 50,
    "DJANGO_ALLOWED_HOSTS": "api.example.test, localhost",
    "LB_DATABASE_URL": "postgres://lb:lb@db:5432/lb",
    "LB_REDIS_URL": "redis://cache:6379/0",
}


def test_reads_a_complete_environment_with_safe_defaults() -> None:
    """A valid environment loads, with debugging off and the gateway's Redis prefix."""
    environment = read_environment(VALID)

    assert environment.allowed_hosts == ("api.example.test", "localhost")
    assert environment.debug is False
    assert environment.redis_prefix == "lb:"
    assert environment.lb01_database_url is None
    assert environment.seed_dir is None


def test_debugging_is_on_only_when_asked_for() -> None:
    """DJANGO_DEBUG turns debugging on; nothing else does."""
    assert read_environment({**VALID, "DJANGO_DEBUG": "true"}).debug is True
    assert read_environment({**VALID, "DJANGO_DEBUG": "false"}).debug is False


def test_lists_every_problem_in_one_error() -> None:
    """One start-up error names every missing or malformed variable, not just the first."""
    with pytest.raises(ImproperlyConfigured) as error:
        read_environment({"LB_DATABASE_URL": "mysql://db/lb"})

    message = str(error.value)
    for variable in ("DJANGO_SECRET_KEY", "DJANGO_ALLOWED_HOSTS", "LB_DATABASE_URL", "LB_REDIS_URL"):
        assert variable in message


def test_never_repeats_a_value_in_its_error() -> None:
    """Error messages name variables, never their values, so a secret can't reach a log."""
    leaked_password = "password-that-must-not-leak"
    leaked_key = "key-that-must-not-leak"

    with pytest.raises(ImproperlyConfigured) as error:
        read_environment(
            {**VALID, "DJANGO_SECRET_KEY": leaked_key, "LB_DATABASE_URL": f"mysql://root:{leaked_password}@db/lb"}
        )

    assert leaked_password not in str(error.value)
    assert leaked_key not in str(error.value)


def test_a_blank_variable_counts_as_missing() -> None:
    """A variable set to spaces is missing, not an empty host list."""
    with pytest.raises(ImproperlyConfigured, match="DJANGO_ALLOWED_HOSTS"):
        read_environment({**VALID, "DJANGO_ALLOWED_HOSTS": "  ,  "})


@pytest.mark.parametrize(
    ("variable", "value"),
    [
        ("LB01_DATABASE_URL", "sqlite:///lb.db"),
        ("LB_REDIS_URL", "http://cache:6379"),
        ("LB_REDIS_PREFIX", "LB:"),
        ("LB_REDIS_PREFIX", "lb"),
    ],
)
def test_refuses_a_malformed_address_or_prefix(variable: str, value: str) -> None:
    """Database URLs must be Postgres, Redis URLs Redis, and the prefix in the gateway's format."""
    with pytest.raises(ImproperlyConfigured, match=variable):
        read_environment({**VALID, variable: value})


def test_split_hosts_drops_blanks_and_spaces() -> None:
    """Host lists tolerate spaces and stray commas."""
    assert split_hosts(" a.example.test, ,b.example.test ,") == ("a.example.test", "b.example.test")
