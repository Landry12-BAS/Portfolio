"""Fixtures shared by lb-common's tests: a service key, in memory and as a JWK file."""

import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat

from lb_common.tokens import encode_base64url, public_key_of


@pytest.fixture
def service_key() -> Ed25519PrivateKey:
    """Make a fresh Ed25519 key for the test service, so no test depends on a key in the repository."""
    return Ed25519PrivateKey.generate()


@pytest.fixture
def service_jwk(service_key: Ed25519PrivateKey) -> dict[str, str]:
    """Return the test key in the JWK form `just gateway-token keygen` writes."""
    private_part = service_key.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    return {
        "kty": "OKP",
        "crv": "Ed25519",
        "d": encode_base64url(private_part),
        "x": public_key_of(service_key),
        "kid": "django-systems",
    }


@pytest.fixture
def key_file(tmp_path: Path, service_jwk: dict[str, str]) -> Path:
    """Write the test key to a JWK file only its owner can read."""
    path = tmp_path / "django-systems.jwk.json"
    path.write_text(json.dumps(service_jwk), encoding="utf-8")
    path.chmod(0o600)
    return path
