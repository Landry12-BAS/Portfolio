"""Unit tests for `Gateway.transcribe`, against a scripted transport: what is sent, and what is accepted back."""

import email
import email.policy
from collections.abc import Callable, Iterator
from pathlib import Path

import httpx2
import openai
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from lb_common.audio import BYTES_PER_SECOND, wav_from_pcm
from lb_common.gateway import (
    Gateway,
    GatewayCode,
    GatewayResponseError,
    GatewaySettings,
    OutsideRunError,
    Transcription,
)
from lb_common.run import Run, run_scope
from lb_common.tokens import ServiceTokens

RUN = Run(system="lb-09", run_id="run-audio-0001", session="session-0123456789abcdef")
SAMPLE = Run(system="lb-09", run_id="sample-audio-0001", data_class="synthetic")
WAV = wav_from_pcm(bytes(BYTES_PER_SECOND * 5))

SPEECH = {
    "task": "transcribe",
    "language": "English",
    "duration": 5.0,
    "text": "Good morning, everyone. Marta will re-profile the Colombian by Wednesday.",
    "segments": [
        {"id": 0, "start": 0.0, "end": 2.4, "text": "Good morning, everyone.", "no_speech_prob": 0.01},
        {
            "id": 1,
            "start": 2.4,
            "end": 5.0,
            "text": "Marta will re-profile the Colombian by Wednesday.",
            "avg_logprob": -0.2,
        },
    ],
}


class RecordingTransport:
    """A fake gateway that records the requests it gets and answers each with one scripted response."""

    def __init__(self, response: httpx2.Response) -> None:
        """Answer every request with `response`."""
        self.response = response
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        """Record the request and answer it."""
        self.requests.append(request)
        return self.response


def answering(body: object, status: int = 200) -> RecordingTransport:
    """Make a fake gateway that answers with a JSON body."""
    return RecordingTransport(httpx2.Response(status, json=body))


@pytest.fixture
def connect(service_key: Ed25519PrivateKey, key_file: Path) -> Iterator[Callable[[RecordingTransport], Gateway]]:
    """Return a function that connects a client to a fake gateway, and closes every client when the test ends."""
    opened: list[Gateway] = []

    def connect_to(fake: RecordingTransport) -> Gateway:
        """Connect a client to the fake gateway, signing as django-systems."""
        settings = GatewaySettings(url="http://gateway:8080", service="django-systems", key_file=key_file)
        gateway = Gateway(settings, ServiceTokens("django-systems", service_key), transport=httpx2.MockTransport(fake))
        opened.append(gateway)
        return gateway

    yield connect_to
    for gateway in opened:
        gateway.close()


def parts_of(request: httpx2.Request) -> dict[str, tuple[str | None, bytes]]:
    """Read a multipart request into its parts: each name, with the file's name (if it is a file) and its bytes."""
    head = b"Content-Type: " + request.headers["content-type"].encode() + b"\r\n\r\n"
    message = email.message_from_bytes(head + request.content, policy=email.policy.HTTP)
    found: dict[str, tuple[str | None, bytes]] = {}
    for part in message.iter_parts():
        payload = part.get_payload(decode=True)
        assert isinstance(payload, bytes)
        found[str(part.get_param("name", header="content-disposition"))] = (part.get_filename(), payload)
    return found


def test_a_recording_is_sent_as_the_openai_form_with_the_runs_headers(
    connect: Callable[[RecordingTransport], Gateway],
) -> None:
    """The model and the format are form fields, the recording is the one file, and the call belongs to its run."""
    fake = answering(SPEECH)

    with run_scope(RUN):
        connect(fake).transcribe(WAV, language="en")

    request = fake.requests[0]
    assert request.method == "POST"
    assert request.url == "http://gateway:8080/v1/audio/transcriptions"
    assert request.headers["content-type"].startswith("multipart/form-data; boundary=")
    assert request.headers["authorization"].startswith("Bearer ")
    assert request.headers["x-lb-system"] == "lb-09"
    assert request.headers["x-lb-run-id"] == "run-audio-0001"
    assert request.headers["x-lb-data-class"] == "visitor"
    assert request.headers["x-lb-session"] == "session-0123456789abcdef"
    assert parts_of(request) == {
        "model": (None, b"lb-stt"),
        "response_format": (None, b"verbose_json"),
        "language": (None, b"en"),
        "file": ("recording.wav", WAV),
    }


def test_the_language_is_left_out_unless_it_is_given(connect: Callable[[RecordingTransport], Gateway]) -> None:
    """Without a language the model detects it; a synthetic run carries no session."""
    fake = answering(SPEECH)

    with run_scope(SAMPLE):
        connect(fake).transcribe(WAV)

    assert "language" not in parts_of(fake.requests[0])
    assert fake.requests[0].headers["x-lb-data-class"] == "synthetic"
    assert "x-lb-session" not in fake.requests[0].headers


def test_the_transcription_comes_back_typed(connect: Callable[[RecordingTransport], Gateway]) -> None:
    """The words, the language and each segment's times, with Whisper's doubts when the provider gave them."""
    with run_scope(RUN):
        transcript = connect(answering(SPEECH)).transcribe(WAV)

    assert isinstance(transcript, Transcription)
    assert transcript.language == "English"
    assert transcript.duration == 5.0
    assert [(segment.start, segment.end, segment.text) for segment in transcript.segments] == [
        (0.0, 2.4, "Good morning, everyone."),
        (2.4, 5.0, "Marta will re-profile the Colombian by Wednesday."),
    ]
    assert transcript.segments[0].no_speech_prob == 0.01
    assert transcript.segments[1].avg_logprob == -0.2


def test_a_call_outside_a_run_never_leaves(connect: Callable[[RecordingTransport], Gateway]) -> None:
    """A recording belongs to a run, so no quota is spent and no trace is lost; it is stopped before it leaves."""
    fake = answering(SPEECH)

    with pytest.raises(OutsideRunError, match="run_scope"):
        connect(fake).transcribe(WAV)

    assert fake.requests == []


@pytest.mark.parametrize(
    "answer",
    [
        {**SPEECH, "segments": [{"id": 0, "start": 3.0, "end": 1.0, "text": "Backwards."}]},
        {**SPEECH, "segments": [{"id": 1, "start": 0.0, "end": 1.0, "text": "Numbered wrongly."}]},
        {
            **SPEECH,
            "segments": [
                {"id": 0, "start": 2.0, "end": 3.0, "text": "Second."},
                {"id": 1, "start": 0.0, "end": 1.0, "text": "First."},
            ],
        },
        {**SPEECH, "segments": [{"id": 0, "start": 0.0, "end": 9.0, "text": "Runs past the end."}]},
        {**SPEECH, "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": ""}]},
        {**SPEECH, "segments": [{"id": 0, "start": 0.0, "end": 1.0, "text": "Doubtful.", "no_speech_prob": 7}]},
        {**SPEECH, "segments": [{"id": index, "start": 0.0, "end": 1.0, "text": "Many."} for index in range(601)]},
        {"language": "English", "duration": 5.0},
    ],
)
def test_a_transcription_that_makes_no_sense_is_refused(
    connect: Callable[[RecordingTransport], Gateway], answer: dict[str, object]
) -> None:
    """Out of order, past the recording, unnumbered, empty, too many or unfinished: never passed on."""
    with run_scope(RUN), pytest.raises(GatewayResponseError, match="/audio/transcriptions"):
        connect(answering(answer)).transcribe(WAV)


def test_the_gateways_refusals_keep_their_code(connect: Callable[[RecordingTransport], Gateway]) -> None:
    """A recording that is too long, or a quota that is spent, is the gateway's error with its stable code."""
    error = {"error": {"message": "too long", "type": "invalid_request_error", "code": "input_too_large"}}

    with run_scope(RUN), pytest.raises(openai.APIStatusError) as caught:
        connect(answering(error, status=413)).transcribe(WAV)

    assert caught.value.status_code == 413
    assert caught.value.code == GatewayCode.INPUT_TOO_LARGE
