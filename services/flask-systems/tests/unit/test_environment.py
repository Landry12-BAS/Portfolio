"""Tests for config.environment: the service reads its variables once and says plainly what is wrong."""

import pytest

from config.environment import ConfigurationError, read_environment, split_hosts
from tests.support import VALID_ENVIRONMENT, SiteKey


def test_reads_a_complete_environment_with_safe_defaults() -> None:
    """A valid environment loads, with the gateway's Redis prefix and modest DuckDB limits."""
    environment = read_environment({**VALID_ENVIRONMENT, "FLASK_ALLOWED_HOSTS": "api.example.test, localhost"})

    assert environment.allowed_hosts == ("api.example.test", "localhost")
    assert environment.redis_prefix == "lb:"
    assert environment.lb05_database_url is None
    assert environment.web_token_key is None
    assert (environment.duckdb_memory_limit, environment.duckdb_threads) == ("1GB", 2)
    assert environment.gateway_is_configured() is False


def test_lists_every_problem_in_one_error() -> None:
    """One start-up error names every missing or malformed variable, not just the first."""
    with pytest.raises(ConfigurationError) as error:
        read_environment({"LB_DATABASE_URL": "mysql://db/lb"})

    message = str(error.value)
    for variable in ("FLASK_ALLOWED_HOSTS", "LB_DATABASE_URL", "LB_REDIS_URL"):
        assert variable in message


def test_never_repeats_a_value_in_its_error() -> None:
    """Error messages name variables, never their values, so a secret can't reach a log."""
    leaked_password = "password-that-must-not-leak"
    leaked_name = "Name That Must Not Leak"

    with pytest.raises(ConfigurationError) as error:
        read_environment(
            {
                **VALID_ENVIRONMENT,
                "LB_DATABASE_URL": f"mysql://root:{leaked_password}@db/lb",
                "LB_SERVICE_NAME": leaked_name,
            }
        )

    assert leaked_password not in str(error.value)
    assert leaked_name not in str(error.value)


def test_a_blank_variable_counts_as_missing() -> None:
    """A variable set to spaces is missing, not an empty host list."""
    with pytest.raises(ConfigurationError, match="FLASK_ALLOWED_HOSTS"):
        read_environment({**VALID_ENVIRONMENT, "FLASK_ALLOWED_HOSTS": "  ,  "})


@pytest.mark.parametrize(
    ("variable", "value"),
    [
        ("LB05_DATABASE_URL", "sqlite:///lb.db"),
        ("LB_REDIS_URL", "http://cache:6379"),
        ("LB_REDIS_PREFIX", "LB:"),
        ("LB_REDIS_PREFIX", "lb"),
        ("LB_WEB_TOKEN_KEY", "not-a-key"),
        ("LB05_DUCKDB_MEMORY_LIMIT", "lots"),
        ("LB05_DUCKDB_MEMORY_LIMIT", "0GB"),
        ("LB05_DUCKDB_THREADS", "0"),
        ("LB05_DUCKDB_THREADS", "64"),
    ],
)
def test_refuses_a_malformed_address_key_prefix_or_limit(variable: str, value: str) -> None:
    """Database URLs must be Postgres, Redis URLs Redis, the key an Ed25519 key, and limits sane."""
    with pytest.raises(ConfigurationError, match=variable):
        read_environment({**VALID_ENVIRONMENT, variable: value})


def test_accepts_the_sites_public_key() -> None:
    """A real Ed25519 public key in base64url is kept as given."""
    key = SiteKey().public

    assert read_environment({**VALID_ENVIRONMENT, "LB_WEB_TOKEN_KEY": key}).web_token_key == key


def test_the_gateway_settings_come_together_or_not_at_all() -> None:
    """A half-described gateway is a start-up error: it would fail on the first question instead."""
    gateway = {
        "LB_GATEWAY_URL": "http://127.0.0.1:8080",
        "LB_SERVICE_NAME": "flask-systems",
        "LB_SERVICE_KEY_FILE": "/home/lb/flask-systems.jwk.json",
    }

    assert read_environment({**VALID_ENVIRONMENT, **gateway}).gateway_is_configured() is True
    with pytest.raises(ConfigurationError, match="must be set together"):
        read_environment({**VALID_ENVIRONMENT, "LB_GATEWAY_URL": gateway["LB_GATEWAY_URL"]})


def test_the_gateway_url_must_be_safe_for_service_tokens() -> None:
    """Plain HTTP to a public host would expose the service token, so it is refused."""
    with pytest.raises(ConfigurationError, match="LB_GATEWAY_URL"):
        read_environment(
            {
                **VALID_ENVIRONMENT,
                "LB_GATEWAY_URL": "http://gateway.example.com",
                "LB_SERVICE_NAME": "flask-systems",
                "LB_SERVICE_KEY_FILE": "/home/lb/flask-systems.jwk.json",
            }
        )


def test_split_hosts_drops_blanks_and_spaces() -> None:
    """Host lists tolerate spaces and stray commas."""
    assert split_hosts(" a.example.test, ,b.example.test ,") == ("a.example.test", "b.example.test")
