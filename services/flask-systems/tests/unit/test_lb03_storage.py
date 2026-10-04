"""File storage: the same behaviour from the disk store and from the S3 store (against moto's fake S3).

The S3 store has not been run against Cloudflare R2: that needs a bucket and keys. moto implements the same calls
(`PutObject`, `GetObject`, `ListObjectsV2`, `DeleteObjects`) in process, which is what runs here.
"""

import stat
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from lb03.limits import FILE_LIFETIME_SECONDS, MAX_UPLOAD_BYTES
from lb03.storage import (
    FileStore,
    LocalFileStore,
    S3FileStore,
    StorageError,
    check_key,
    check_prefix,
    s3_client,
    sweep_files,
)

DOCUMENT = "AbCdEfGhIjKlMnOpQrStUv"
OTHER = "ZyXwVuTsRqPoNmLkJiHgFe"
BUCKET = "lb03-test-files"


def key(name: str = "original.pdf", document: str = DOCUMENT) -> str:
    """Make a key in the one shape files are stored under."""
    return f"docs/{document}/{name}"


@pytest.fixture(params=["disk", "s3"])
def store(request: pytest.FixtureRequest, tmp_path: Path) -> Iterator[FileStore]:
    """Provide each kind of store in turn: a folder on disk, and a bucket in moto's fake S3."""
    if request.param == "disk":
        yield LocalFileStore(tmp_path / "files")
        return
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="y")
        client.create_bucket(Bucket=BUCKET)
        yield S3FileStore(client, BUCKET)


def test_a_file_comes_back_as_it_went_in(store: FileStore) -> None:
    """What is put is what is got, byte for byte, and a second put replaces the first."""
    store.put(key(), b"%PDF-1.7 first", "application/pdf")
    assert store.get(key()) == b"%PDF-1.7 first"
    store.put(key(), b"%PDF-1.7 second", "application/pdf")
    assert store.get(key()) == b"%PDF-1.7 second"


def test_every_kind_of_file_a_document_has_can_be_stored(store: FileStore) -> None:
    """The original in each format, and the five page pictures, all have valid keys."""
    for name in (
        "original.pdf",
        "original.png",
        "original.jpg",
        "original.webp",
        *(f"page-{n}.jpg" for n in range(1, 6)),
    ):
        store.put(key(name), name.encode(), "application/octet-stream")
        assert store.get(key(name)) == name.encode()


def test_a_missing_file_is_a_storage_error_that_names_nothing(store: FileStore) -> None:
    """Asking for a file that is not there fails with a fixed sentence, with no key and no path in it."""
    with pytest.raises(StorageError) as caught:
        store.get(key("page-1.jpg"))
    assert DOCUMENT not in str(caught.value)


def test_deleting_a_document_deletes_all_its_files_and_only_its_files(store: FileStore) -> None:
    """The folder of one document goes, with its original and its pages; another document's files stay."""
    for name in ("original.pdf", "page-1.jpg", "page-2.jpg"):
        store.put(key(name), b"x", "application/octet-stream")
    store.put(key("original.pdf", OTHER), b"y", "application/pdf")
    assert store.delete_prefix(f"docs/{DOCUMENT}/") == 3
    with pytest.raises(StorageError):
        store.get(key())
    assert store.get(key("original.pdf", OTHER)) == b"y"
    assert store.delete_prefix(f"docs/{DOCUMENT}/") == 0


def test_the_store_lists_what_it_holds_with_the_time_it_was_written(store: FileStore) -> None:
    """Every file is listed under its key with a modification time that is about now."""
    store.put(key(), b"x", "application/pdf")
    store.put(key("page-1.jpg"), b"y", "image/jpeg")
    listed = {stored.key: stored.modified for stored in store.objects()}
    assert set(listed) == {key(), key("page-1.jpg")}
    for modified in listed.values():
        assert abs((datetime.now(UTC) - modified).total_seconds()) < 120


@pytest.mark.parametrize(
    "bad",
    [
        "docs/../etc/passwd",
        f"docs/{DOCUMENT}/../{OTHER}/original.pdf",
        f"/docs/{DOCUMENT}/original.pdf",
        f"docs/{DOCUMENT}/original.exe",
        f"docs/{DOCUMENT}/page-9.jpg",
        f"docs/{DOCUMENT}/original.pdf/extra",
        f"docs/{DOCUMENT[:-1]}/original.pdf",
        f"docs/{DOCUMENT}/.part-abc",
        "original.pdf",
        "",
    ],
)
def test_a_key_that_is_not_the_one_shape_is_refused_before_it_touches_anything(store: FileStore, bad: str) -> None:
    """Traversal, a wrong name, a wrong id length and a missing folder are all refused, on every operation."""
    with pytest.raises(StorageError):
        store.put(bad, b"x", "application/pdf")
    with pytest.raises(StorageError):
        store.get(bad)
    with pytest.raises(StorageError):
        check_key(bad)


@pytest.mark.parametrize("bad", ["docs/", "docs/short/", f"docs/{DOCUMENT}", f"docs/{DOCUMENT}/x/", "../docs/"])
def test_a_folder_prefix_must_be_one_documents_folder(store: FileStore, bad: str) -> None:
    """Deleting by prefix cannot be pointed at the whole store, or at a parent."""
    with pytest.raises(StorageError):
        store.delete_prefix(bad)
    with pytest.raises(StorageError):
        check_prefix(bad)


def test_the_disk_store_keeps_files_private_to_its_user(tmp_path: Path) -> None:
    """The folders are 0700 and the files 0600, so no other user of the machine can read a visitor's file."""
    disk = LocalFileStore(tmp_path / "files")
    disk.put(key(), b"secret", "application/pdf")
    assert stat.S_IMODE((tmp_path / "files").stat().st_mode) == 0o700
    assert stat.S_IMODE((tmp_path / "files" / "docs" / DOCUMENT).stat().st_mode) == 0o700
    assert stat.S_IMODE((tmp_path / "files" / "docs" / DOCUMENT / "original.pdf").stat().st_mode) == 0o600


def test_the_disk_store_leaves_no_half_written_file_to_be_read(tmp_path: Path) -> None:
    """A put is a temporary file moved into place, so nothing but the finished file is ever listed or read."""
    disk = LocalFileStore(tmp_path / "files")
    disk.put(key(), b"complete", "application/pdf")
    names = sorted(entry.name for entry in (tmp_path / "files" / "docs" / DOCUMENT).iterdir())
    assert names == ["original.pdf"]
    (tmp_path / "files" / "docs" / DOCUMENT / ".part-leftover").write_bytes(b"half")
    assert [stored.key for stored in disk.objects()] == [key()]


def test_the_disk_store_does_not_follow_a_link_where_a_file_should_be(tmp_path: Path) -> None:
    """A symlink planted in the folder is never read through, so it cannot reveal another file."""
    disk = LocalFileStore(tmp_path / "files")
    disk.put(key("page-1.jpg"), b"x", "image/jpeg")
    secret = tmp_path / "secret.txt"
    secret.write_text("not for visitors", encoding="utf-8")
    link = tmp_path / "files" / "docs" / DOCUMENT / "page-2.jpg"
    link.symlink_to(secret)
    with pytest.raises(StorageError):
        disk.get(key("page-2.jpg"))
    assert key("page-2.jpg") not in {stored.key for stored in disk.objects()}


def test_the_disk_store_refuses_to_read_a_file_larger_than_a_stored_file_can_be(tmp_path: Path) -> None:
    """A file over the upload limit is not something the service stored, so it is not read into memory."""
    disk = LocalFileStore(tmp_path / "files")
    disk.put(key(), b"x" * (MAX_UPLOAD_BYTES + 1), "application/pdf")
    with pytest.raises(StorageError):
        disk.get(key())


def test_the_bucket_gives_nothing_public(store: FileStore) -> None:
    """Putting a file sets no ACL: in the fake bucket, the only grant is the owner's, and none is for everyone."""
    if not isinstance(store, S3FileStore):
        pytest.skip("only a bucket has ACLs")
    store.put(key(), b"x", "application/pdf")
    grants = store.client.get_object_acl(Bucket=BUCKET, Key=key())["Grants"]
    assert all(grant["Grantee"].get("URI") is None for grant in grants)
    assert [grant["Permission"] for grant in grants] == ["FULL_CONTROL"]


def test_the_bucket_store_sets_the_content_type_and_nothing_else_about_access(store: FileStore) -> None:
    """The object carries the type it was given, which is all the store says about it."""
    if not isinstance(store, S3FileStore):
        pytest.skip("only a bucket has content types")
    store.put(key("page-1.jpg"), b"x", "image/jpeg")
    head = store.client.head_object(Bucket=BUCKET, Key=key("page-1.jpg"))
    assert head["ContentType"] == "image/jpeg"


def test_a_missing_bucket_is_a_storage_error_with_nothing_in_it_to_leak() -> None:
    """A bucket that does not exist fails every call with a fixed sentence."""
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1", aws_access_key_id="x", aws_secret_access_key="y")
        broken = S3FileStore(client, "no-such-bucket")
        with pytest.raises(StorageError) as caught:
            broken.put(key(), b"x", "application/pdf")
        assert "no-such-bucket" not in str(caught.value)
        with pytest.raises(StorageError):
            broken.get(key())
        with pytest.raises(StorageError):
            list(broken.objects())


def test_a_deletion_of_more_than_a_thousand_objects_goes_in_batches(store: FileStore) -> None:
    """DeleteObjects takes at most a thousand keys; a folder holds at most six files, so one batch always does."""
    assert FILE_LIFETIME_SECONDS == 3_600
    store.put(key(), b"x", "application/pdf")
    assert store.delete_prefix(f"docs/{DOCUMENT}/") == 1


def test_the_s3_client_is_made_with_short_timeouts_and_a_few_retries() -> None:
    """The client for R2 has a five-second connect timeout, a twenty-second read timeout and three attempts."""
    client = s3_client("https://example.invalid", "auto", "key-id", "secret")
    config = client.meta.config
    assert config.connect_timeout == 5
    assert config.read_timeout == 20
    assert config.retries["total_max_attempts"] == 3
    assert client.meta.endpoint_url == "https://example.invalid"


def test_the_sweep_deletes_a_document_whose_newest_file_is_older_than_the_lifetime(store: FileStore) -> None:
    """A folder with nothing written within the hour goes; one with a fresh file stays; the count is documents."""
    store.put(key(), b"x", "application/pdf")
    store.put(key("page-1.jpg"), b"y", "image/jpeg")
    store.put(key("original.pdf", OTHER), b"z", "application/pdf")
    lifetime = timedelta(seconds=FILE_LIFETIME_SECONDS)
    assert sweep_files(store, datetime.now(UTC), lifetime) == 0
    assert sweep_files(store, datetime.now(UTC) + lifetime + timedelta(minutes=1), lifetime) == 2
    assert list(store.objects()) == []


def test_the_sweep_keeps_a_document_while_any_of_its_files_is_young(store: FileStore) -> None:
    """The age of a document is that of its newest file, so a folder still being written is never swept half-way."""
    store.put(key(), b"x", "application/pdf")
    lifetime = timedelta(seconds=FILE_LIFETIME_SECONDS)
    later = datetime.now(UTC) + lifetime - timedelta(seconds=30)
    assert sweep_files(store, later, lifetime) == 0
    assert {stored.key for stored in store.objects()} == {key()}
