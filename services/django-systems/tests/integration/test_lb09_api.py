"""Integration tests for LB-09's HTTP API: who may ask, starting a meeting, the daily limit, and reading a meeting."""

import base64
import threading
from collections.abc import Callable
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from django.test import Client
from django.utils import timezone
from lb09 import api
from lb09.limits import MAX_UPLOAD_BYTES, RECORDINGS_PER_VISITOR_PER_DAY
from lb09.meetings import MeetingLimitError, start_meeting
from lb09.models import Item, Meeting, Segment
from lb09.samples import samples
from lb09.storage import AudioStore

from lb_common.audio import wav_from_pcm
from tests.lb02_support import mint_token, race

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb09"])]

JANA = "session-of-jana-visitor-01"
DAN = "session-of-dan-visitor-002"
# A second of silence as a WAV, which passes the container check.
WAV = wav_from_pcm(bytes(32_000))


@pytest.fixture(autouse=True)
def store(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> AudioStore:
    """Keep the recordings in a folder of the test's own, and queue nothing for a worker that isn't there."""
    built = AudioStore(tmp_path / "audio")
    monkeypatch.setattr(api, "audio_store", lambda: built)
    return built


@pytest.fixture
def queued(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Record which meetings the API queued for the worker, instead of sending them to Celery."""
    seen: list[int] = []
    monkeypatch.setattr(api, "queue_meeting", seen.append)
    return seen


type CaptureCommits = Callable[..., AbstractContextManager[list[Callable[[], None]]]]
type Start = Callable[[Client, dict[str, object]], tuple[int, Any]]


@pytest.fixture
def start(django_capture_on_commit_callbacks: CaptureCommits) -> Start:
    """Return a way to start a meeting that runs what the API queues on commit, as a committed request would."""

    def start_meeting_as(client: Client, body: dict[str, object]) -> tuple[int, Any]:
        """POST the body and run the on-commit callbacks."""
        with django_capture_on_commit_callbacks(using="lb09", execute=True):
            return post(client, "/api/lb09/meetings", body)

    return start_meeting_as


def visitor(key: Ed25519PrivateKey, session: str = JANA, system: str = "lb-09") -> Client:
    """Return a test client that calls as a visitor, with a token the site minted for `system`."""
    return Client(headers={"Authorization": f"Bearer {mint_token(key, session, system)}"})


def get(client: Client, path: str) -> tuple[int, Any]:
    """GET a path and return the status and the JSON body."""
    response = client.get(path)
    return response.status_code, response.json()


def post(client: Client, path: str, body: dict[str, object]) -> tuple[int, Any]:
    """POST JSON to a path and return the status and the JSON body."""
    response = client.post(path, data=body, content_type="application/json")
    return response.status_code, response.json()


def upload(audio: bytes = WAV, mode: str = "fast") -> dict[str, object]:
    """Make the body that uploads a recording."""
    return {"source": "upload", "mode": mode, "audio": base64.b64encode(audio).decode("ascii")}


def done_meeting(session: str = JANA) -> Meeting:
    """Make a finished meeting with one segment and one item, as the worker leaves it."""
    meeting = Meeting.objects.create(
        session_key=session,
        mode="fast",
        run_id="run-" + "a" * 12,
        status="done",
        stage="done",
        duration_seconds=12.5,
        transcriber="lb-stt",
    )
    Segment.objects.create(
        meeting=meeting,
        position=0,
        start=0.3,
        end=4.3,
        text="Then we roast the Colombian first on Monday.",
        speaker=0,
        label="Hannah",
    )
    Item.objects.create(
        meeting=meeting,
        position=0,
        kind="decision",
        text="Roast the Colombian first on Monday",
        evidence="Then we roast the Colombian first on Monday.",
        start=0.3,
        end=4.3,
        first_segment=0,
        last_segment=0,
    )
    return meeting


# Who may ask


@pytest.mark.parametrize(
    "path", ["/api/lb09/samples", "/api/lb09/limits", "/api/lb09/meetings", "/api/lb09/meetings/AAAAAAAAAAAAAAAA"]
)
def test_every_route_needs_a_visitor_token_for_lb_09(web_signing_key: Ed25519PrivateKey, path: str) -> None:
    """No token, or a token minted for another system, is a 401 in the platform's error shape."""
    for client in (Client(), visitor(web_signing_key, system="lb-02")):
        status, body = get(client, path)
        assert status == 401
        assert body["error"]["code"] == "unauthorized"


# Samples and limits


def test_the_samples_are_the_golden_sets_with_their_audio(web_signing_key: Ed25519PrivateKey) -> None:
    """Each curated sample comes with its title, its audio file and its length from the manifest."""
    status, body = get(visitor(web_signing_key), "/api/lb09/samples")
    assert status == 200
    assert {sample["key"] for sample in body} == set(samples())
    monday = next(sample for sample in body if sample["key"] == "monday-roasting-plan")
    assert monday["file"] == "monday-roasting-plan.mp3"
    assert 40 < monday["seconds"] < 42
    assert monday["speakers"] == 4


@pytest.mark.usefixtures("queued")
def test_the_limits_count_down_through_the_day(web_signing_key: Ed25519PrivateKey, start: Start) -> None:
    """Five a day, one used after a start, and the reset at the next midnight UTC."""
    client = visitor(web_signing_key)
    status, before = get(client, "/api/lb09/limits")
    assert status == 200
    assert (before["recordings_per_day"], before["used_today"], before["left_today"]) == (
        RECORDINGS_PER_VISITOR_PER_DAY,
        0,
        5,
    )
    assert before["max_recording_seconds"] == 60.0
    assert before["max_upload_bytes"] == MAX_UPLOAD_BYTES
    start(client, {"source": "sample", "mode": "fast", "sample": "weekend-staffing"})
    _, after = get(client, "/api/lb09/limits")
    assert (after["used_today"], after["left_today"]) == (1, 4)
    assert after["resets_at"].endswith("T00:00:00Z")


# Starting a meeting


def test_a_sample_is_started_from_its_committed_audio_and_queued(
    web_signing_key: Ed25519PrivateKey, queued: list[int], store: AudioStore, start: Start
) -> None:
    """The meeting answers 202 with its run ID, the sample's audio waits in the store, and the worker is told."""
    status, body = start(
        visitor(web_signing_key), {"source": "sample", "mode": "private", "sample": "monday-roasting-plan"}
    )
    assert status == 202
    assert (body["sample"], body["mode"], body["status"], body["stage"]) == (
        "monday-roasting-plan",
        "private",
        "received",
        "received",
    )
    assert body["labels_inferred_from_text"] is True
    assert len(body["run_id"]) >= 8
    meeting = Meeting.objects.get(public_id=body["id"])
    assert queued == [meeting.pk]
    assert store.path_of(meeting.audio_name).stat().st_size == body["source_bytes"] > 50_000


def test_a_visitors_recording_is_stored_as_sent_and_queued(
    web_signing_key: Ed25519PrivateKey, queued: list[int], store: AudioStore, start: Start
) -> None:
    """The base64 is decoded, the bytes are kept as they were, and the language asked for is recorded."""
    status, body = start(visitor(web_signing_key), {**upload(), "language": "cs"})
    assert status == 202
    meeting = Meeting.objects.get(public_id=body["id"])
    assert store.path_of(meeting.audio_name).read_bytes() == WAV
    assert (body["language"], body["source_bytes"], body["sample"]) == ("cs", len(WAV), None)
    assert queued == [meeting.pk]


def test_an_unknown_sample_is_404(web_signing_key: Ed25519PrivateKey, queued: list[int]) -> None:
    """A sample key that isn't one of the golden set's is not found, and nothing is queued."""
    status, body = post(
        visitor(web_signing_key),
        "/api/lb09/meetings",
        {"source": "sample", "mode": "fast", "sample": "no-such-meeting"},
    )
    assert (status, body["error"]["code"]) == (404, "unknown_sample")
    assert queued == []


def test_a_recording_in_no_known_container_is_refused_unread(
    web_signing_key: Ed25519PrivateKey, queued: list[int], store: AudioStore
) -> None:
    """Text dressed as audio is 415, nothing is stored, and the day's count is untouched."""
    client = visitor(web_signing_key)
    status, body = post(client, "/api/lb09/meetings", upload(b"<html>not audio</html>"))
    assert (status, body["error"]["code"]) == (415, "unsupported_audio")
    assert queued == []
    assert not store.folder.exists() or list(store.folder.iterdir()) == []
    assert get(client, "/api/lb09/limits")[1]["used_today"] == 0


def test_a_recording_over_the_byte_cap_is_413(web_signing_key: Ed25519PrivateKey) -> None:
    """A body a little past 3 MiB of audio is too big."""
    status, body = post(visitor(web_signing_key), "/api/lb09/meetings", upload(b"OggS" + bytes(MAX_UPLOAD_BYTES)))
    assert (status, body["error"]["code"]) == (413, "audio_too_big")


def test_a_body_that_does_not_fit_the_schema_is_422(web_signing_key: Ed25519PrivateKey) -> None:
    """A sample with audio, an upload without, a third mode, or audio that isn't base64: refused, naming the fields."""
    client = visitor(web_signing_key)
    bodies: list[dict[str, object]] = [
        {"source": "sample", "mode": "fast", "sample": "monday-roasting-plan", "audio": "AAAA"},
        {"source": "upload", "mode": "fast"},
        {"source": "upload", "mode": "turbo", "audio": "AAAA"},
        {"source": "upload", "mode": "fast", "audio": "not base64!"},
    ]
    for body in bodies:
        status, answer = post(client, "/api/lb09/meetings", body)
        assert status == 422
        assert answer["error"]["code"] == "invalid_request"
        assert "AAAA" not in answer["error"].get("fields", "")


@pytest.mark.usefixtures("queued")
def test_the_sixth_meeting_of_the_day_is_refused_and_its_audio_removed(
    web_signing_key: Ed25519PrivateKey, store: AudioStore
) -> None:
    """Five start; the sixth is 429, nothing of it is kept, and another visitor is not affected."""
    client = visitor(web_signing_key)
    for _ in range(RECORDINGS_PER_VISITOR_PER_DAY):
        assert post(client, "/api/lb09/meetings", upload())[0] == 202
    status, body = post(client, "/api/lb09/meetings", upload())
    assert (status, body["error"]["code"]) == (429, "daily_limit")
    assert len(list(store.folder.iterdir())) == RECORDINGS_PER_VISITOR_PER_DAY
    assert post(visitor(web_signing_key, DAN), "/api/lb09/meetings", upload())[0] == 202


@pytest.mark.usefixtures("queued")
def test_a_meeting_the_service_failed_gives_its_place_back_and_one_the_visitor_sent_wrong_does_not(
    web_signing_key: Ed25519PrivateKey,
) -> None:
    """A transcriber, model, worker or crash failure frees the place; a refused recording or no speech keeps it."""
    client = visitor(web_signing_key)
    for _ in range(RECORDINGS_PER_VISITOR_PER_DAY):
        assert post(client, "/api/lb09/meetings", upload())[0] == 202
    assert post(client, "/api/lb09/meetings", upload())[0] == 429
    meetings = list(Meeting.objects.filter(session_key=JANA).order_by("pk"))
    for meeting, failure in zip(meetings, ("model", "too_long", "no_speech"), strict=False):
        Meeting.objects.filter(pk=meeting.pk).update(status="failed", stage="failed", failure=failure)
    _, limits = get(client, "/api/lb09/limits")
    assert (limits["used_today"], limits["left_today"]) == (4, 1)
    assert post(client, "/api/lb09/meetings", upload())[0] == 202
    assert post(client, "/api/lb09/meetings", upload())[0] == 429
    for failure in ("transcriber", "stale", "pipeline_error", "audio_gone"):
        Meeting.objects.filter(pk=meetings[3].pk).update(status="failed", stage="failed", failure=failure)
        assert get(client, "/api/lb09/limits")[1]["left_today"] == 1


@pytest.mark.django_db(databases=["lb09"], transaction=True)
def test_eight_uploads_at_once_still_give_five(store: AudioStore) -> None:
    """The per-visitor lock makes simultaneous starts take turns: exactly five pass, three are refused."""
    outcomes = race([lambda: start_meeting(JANA, WAV, "fast", "", store) for _ in range(8)])
    passed = [outcome for outcome in outcomes if isinstance(outcome, Meeting)]
    refused = [outcome for outcome in outcomes if isinstance(outcome, MeetingLimitError)]
    assert (len(passed), len(refused)) == (5, 3)
    assert Meeting.objects.filter(session_key=JANA).count() == 5
    assert len(list(store.folder.iterdir())) == 5
    assert threading.active_count() < 20


# Reading a meeting


def test_a_visitor_reads_their_own_meeting_and_nobody_elses(web_signing_key: Ed25519PrivateKey) -> None:
    """The list and the single read show Jana's meeting to Jana; to Dan it is not found; an expired one is gone."""
    meeting = done_meeting()
    jana, dan = visitor(web_signing_key), visitor(web_signing_key, DAN)
    assert [item["id"] for item in get(jana, "/api/lb09/meetings")[1]] == [meeting.public_id]
    assert get(dan, "/api/lb09/meetings")[1] == []
    status, body = get(jana, f"/api/lb09/meetings/{meeting.public_id}")
    assert status == 200
    assert (body["status"], body["duration_seconds"], body["transcriber"]) == ("done", 12.5, "lb-stt")
    assert get(dan, f"/api/lb09/meetings/{meeting.public_id}")[0] == 404
    meeting.expires_at = timezone.now()
    meeting.save(update_fields=["expires_at"])
    assert get(jana, f"/api/lb09/meetings/{meeting.public_id}")[0] == 404


def test_the_transcript_items_and_exports_of_a_finished_meeting(web_signing_key: Ed25519PrivateKey) -> None:
    """Segments with labels, items with evidence and seconds, and the three exports, each with its file name."""
    meeting = done_meeting()
    client = visitor(web_signing_key)
    status, transcript = get(client, f"/api/lb09/meetings/{meeting.public_id}/transcript")
    assert status == 200
    assert transcript["segments"][0]["label"] == "Hannah"
    assert "inferred from the words" in transcript["labels_note"]
    status, items = get(client, f"/api/lb09/meetings/{meeting.public_id}/items")
    assert status == 200
    assert items["items"][0]["evidence"] == "Then we roast the Colombian first on Monday."
    assert (items["items"][0]["start"], items["items"][0]["end"], items["dropped"]) == (0.3, 4.3, 0)
    for export_format, suffix in (("json", ".json"), ("csv", ".csv"), ("text", ".txt")):
        status, export = get(client, f"/api/lb09/meetings/{meeting.public_id}/export?format={export_format}")
        assert status == 200, export
        assert export["filename"].endswith(suffix)
        assert "Colombian" in export["content"]
    assert get(client, f"/api/lb09/meetings/{meeting.public_id}/export?format=docx")[0] == 422
    assert get(client, f"/api/lb09/meetings/{meeting.public_id}/export")[0] == 422


def test_the_transcript_items_and_exports_wait_for_the_meeting_to_be_done(web_signing_key: Ed25519PrivateKey) -> None:
    """While the worker is on it, those routes answer 409 and never a half-made transcript."""
    meeting = Meeting.objects.create(
        session_key=JANA, mode="fast", run_id="run-" + "b" * 12, status="processing", stage="transcribing"
    )
    client = visitor(web_signing_key)
    for path in ("transcript", "items", "export?format=json"):
        status, body = get(client, f"/api/lb09/meetings/{meeting.public_id}/{path}")
        assert (status, body["error"]["code"]) == (409, "not_done")
