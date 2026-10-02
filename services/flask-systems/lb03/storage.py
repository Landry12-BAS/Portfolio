"""Where a visitor's file and its page pictures are kept for the hour they live: local disk, or an S3-compatible bucket.

Both are a `FileStore`, so the service never knows which it has. The disk store is for development, tests and a
single box; the S3 store (`S3FileStore`, boto3) is for Cloudflare R2 or any S3-compatible bucket. The tests run the
S3 store against moto's in-process fake of S3. It has not been run against R2 itself: that needs a bucket and keys,
which this repository does not hold. The calls it makes are plain `PutObject`, `GetObject`, `ListObjectsV2` and
`DeleteObjects`, which R2 documents as supported.

Files are never public. Nothing here makes a public URL or sets an ACL: the only way a file leaves is the
service's authenticated route, which streams it to the visitor whose document it is. A bucket must be created
private (docs/DEPLOY.md says how), and nothing in this code could make an object public.

Keys have one shape, `docs/<document id>/<name>`, and every key is checked against it before it touches a path or
a bucket, so a key can never climb out of its folder. Expiry is the service's own job (lb03/expiry.py deletes by the
document's `expires_at`, and `sweep_files` here deletes anything older than the lifetime that has no document); a
bucket's lifecycle rule works in whole days at best, so it is only a backstop.
"""

import contextlib
import os
import re
import shutil
import stat
import tempfile
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Protocol

from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from lb03.limits import MAX_UPLOAD_BYTES

# `docs/<22-character document id>/<the original file, or a page picture>`.
KEY = re.compile(r"^docs/[A-Za-z0-9_-]{22}/(?:original\.(?:pdf|png|jpg|webp)|page-[1-5]\.jpg)$")
PREFIX = re.compile(r"^docs/[A-Za-z0-9_-]{22}/$")
# What a stored object may weigh when it is read back: the biggest upload, which is the biggest thing stored.
MAX_READ_BYTES = MAX_UPLOAD_BYTES
S3_CONNECT_SECONDS = 5
S3_READ_SECONDS = 20
S3_ATTEMPTS = 3


class StorageError(Exception):
    """A file could not be stored, read or deleted; the message names the key's shape, never a path or a secret."""


@dataclass(frozen=True)
class StoredObject:
    """One stored file: its key and when it was last written."""

    key: str
    modified: datetime


class FileStore(Protocol):
    """Where files live: put, get, delete a document's folder, and list what is stored."""

    def put(self, key: str, data: bytes, content_type: str) -> None:
        """Store a file under a key, replacing any there."""
        ...

    def get(self, key: str) -> bytes:
        """Return a file's bytes; raises `StorageError` when it is missing or too large."""
        ...

    def delete_prefix(self, prefix: str) -> int:
        """Delete every file of one document (`docs/<id>/`) and return how many there were."""
        ...

    def objects(self) -> Iterator[StoredObject]:
        """List every stored file with the time it was written."""
        ...


def check_key(key: str) -> str:
    """Return a key if it has the one shape files are stored under; refuse anything else."""
    if not KEY.fullmatch(key):
        raise StorageError("This is not a key a file is stored under.")
    return key


def check_prefix(prefix: str) -> str:
    """Return a document's folder prefix if it has the right shape."""
    if not PREFIX.fullmatch(prefix):
        raise StorageError("This is not a document's folder.")
    return prefix


class LocalFileStore:
    """Files on local disk, in a folder only the service's user can open, written whole or not at all."""

    def __init__(self, root: Path) -> None:
        """Keep files under `root`, which is made (mode 0700) if it does not exist."""
        self.root = root
        root.mkdir(mode=0o700, parents=True, exist_ok=True)

    def path_of(self, key: str) -> Path:
        """Return the path of a key, which has been checked to hold no `..` and no absolute part."""
        return self.root / check_key(key)

    def put(self, key: str, data: bytes, content_type: str) -> None:  # noqa: ARG002 - the FileStore signature
        """Write a file to a temporary name in its folder and move it into place, so a reader never sees half of it."""
        path = self.path_of(key)
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".part-")
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
            Path(temporary).chmod(0o600)
            Path(temporary).replace(path)
        except OSError:
            with contextlib.suppress(OSError):
                Path(temporary).unlink()
            raise StorageError("The file could not be stored.") from None

    def get(self, key: str) -> bytes:
        """Read a file, which must be a regular file (never a link) no larger than a stored file can be."""
        path = self.path_of(key)
        try:
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        except OSError:
            raise StorageError("The file is not there.") from None
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_READ_BYTES:
                raise StorageError("The file is not a file this service stored.")
            with os.fdopen(descriptor, "rb", closefd=False) as handle:
                return handle.read(MAX_READ_BYTES + 1)
        finally:
            os.close(descriptor)

    def delete_prefix(self, prefix: str) -> int:
        """Delete a document's folder and what is in it, and return how many files there were."""
        folder = self.root / check_prefix(prefix)
        if not folder.is_dir() or folder.is_symlink():
            return 0
        count = sum(1 for entry in folder.iterdir() if entry.is_file() or entry.is_symlink())
        shutil.rmtree(folder, ignore_errors=True)
        return count

    def objects(self) -> Iterator[StoredObject]:
        """List every stored file, skipping half-written ones."""
        base = self.root / "docs"
        if not base.is_dir():
            return
        for folder in base.iterdir():
            if not folder.is_dir() or folder.is_symlink():
                continue
            for entry in folder.iterdir():
                key = f"docs/{folder.name}/{entry.name}"
                if entry.is_file() and not entry.is_symlink() and KEY.fullmatch(key):
                    modified = datetime.fromtimestamp(entry.stat().st_mtime, tz=UTC)
                    yield StoredObject(key, modified)


class S3FileStore:
    """Files in an S3-compatible bucket (Cloudflare R2), read and written with boto3.

    Every call is blocking, so the pipeline makes them on a worker thread. A failure of the bucket becomes a
    `StorageError` whose message holds no key, endpoint or credential.
    """

    def __init__(self, client: Any, bucket: str) -> None:
        """Use `client` (a boto3 S3 client) and the bucket named, which must exist and be private."""
        self.client = client
        self.bucket = bucket

    def put(self, key: str, data: bytes, content_type: str) -> None:
        """Store a file. No ACL is set: the object takes the bucket's own privacy."""
        try:
            self.client.put_object(Bucket=self.bucket, Key=check_key(key), Body=data, ContentType=content_type)
        except (ClientError, BotoCoreError):
            raise StorageError("The file could not be stored.") from None

    def get(self, key: str) -> bytes:
        """Read a file, refusing one larger than a stored file can be."""
        try:
            answer = self.client.get_object(Bucket=self.bucket, Key=check_key(key))
            if int(answer.get("ContentLength", 0)) > MAX_READ_BYTES:
                raise StorageError("The file is not a file this service stored.")
            data: bytes = answer["Body"].read(MAX_READ_BYTES + 1)
        except (ClientError, BotoCoreError):
            raise StorageError("The file is not there.") from None
        return data

    def delete_prefix(self, prefix: str) -> int:
        """Delete every object of one document and return how many there were."""
        keys = [stored.key for stored in self.list_under(check_prefix(prefix))]
        try:
            for start in range(0, len(keys), 1000):
                batch = [{"Key": key} for key in keys[start : start + 1000]]
                self.client.delete_objects(Bucket=self.bucket, Delete={"Objects": batch, "Quiet": True})
        except (ClientError, BotoCoreError):
            raise StorageError("The files could not be deleted.") from None
        return len(keys)

    def list_under(self, prefix: str) -> Iterator[StoredObject]:
        """List the objects whose keys begin with a prefix, page by page."""
        try:
            paginator = self.client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
                for item in page.get("Contents", []):
                    if KEY.fullmatch(item["Key"]):
                        yield StoredObject(item["Key"], item["LastModified"].astimezone(UTC))
        except (ClientError, BotoCoreError):
            raise StorageError("The bucket could not be listed.") from None

    def objects(self) -> Iterator[StoredObject]:
        """List every stored file."""
        return self.list_under("docs/")


def s3_client(endpoint: str | None, region: str, access_key_id: str, secret_access_key: str) -> Any:
    """Make a boto3 S3 client with short timeouts and a few retries; `endpoint` is R2's, none for AWS."""
    import boto3

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        config=Config(
            signature_version="s3v4",
            connect_timeout=S3_CONNECT_SECONDS,
            read_timeout=S3_READ_SECONDS,
            retries={"total_max_attempts": S3_ATTEMPTS, "mode": "standard"},
        ),
    )


def sweep_files(store: FileStore, now: datetime, lifetime: timedelta) -> int:
    """Delete every document folder whose newest file is older than the lifetime, and return how many went.

    This is the backstop behind the document rows' own expiry: a file whose row was never written (the process
    died between the two), or whose row is gone, still goes within the hour and a sweep.
    """
    oldest: dict[str, datetime] = {}
    for stored in store.objects():
        folder = stored.key.rsplit("/", 1)[0] + "/"
        oldest[folder] = max(oldest.get(folder, stored.modified), stored.modified)
    expired = [folder for folder, modified in oldest.items() if now - modified > lifetime]
    for folder in expired:
        store.delete_prefix(folder)
    return len(expired)
