"""The AI gateway (LB-00), as a Python service calls it.

Chat completions and embeddings go through the official `openai` client pointed at the
gateway, which speaks the same API. Speech to text uses the same client's transcription
endpoint, with the recording in the one format the gateway measures (lb_common.audio).
Reranking and the prompt-injection guard are the gateway's own endpoints, called through
the same client. Every request carries a fresh
service token and the current run's x-lb-* headers, and every failure raises an `openai`
error: when the gateway answered, `error.code` is one of `GatewayCode`.

    gateway = Gateway.from_env()
    with run_scope(Run(system="lb-01", run_id=new_run_id(), session=session_key)):
        reply = gateway.openai.chat.completions.create(model="lb-fast", messages=messages)
"""

import os
from collections.abc import Mapping, Sequence
from enum import StrEnum
from pathlib import Path
from typing import Self
from urllib.parse import urlsplit

import httpx2
from openai import OpenAI, OpenAIError
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from lb_common.run import Run, current_run, current_span_id
from lb_common.tokens import ServiceTokens, check_service_name, load_service_key

# How long to wait for a connection to the gateway. Answers get the settings' longer
# timeout, which outlasts the gateway's own deadlines, so the gateway answers 504 first.
CONNECT_TIMEOUT_SECONDS = 5.0
# Hosts reachable only from this machine.
LOOPBACK_HOSTS = ("localhost", "127.0.0.1", "::1")


class GatewayCode(StrEnum):
    """The gateway's stable error codes (services/gateway/src/errors.ts); its README says what each means."""

    INVALID_REQUEST = "invalid_request"
    UNSUPPORTED_REQUEST = "unsupported_request"
    # An error code, not a credential.
    INVALID_SERVICE_TOKEN = "invalid_service_token"  # noqa: S105
    SYSTEM_NOT_ALLOWED = "system_not_allowed"
    ALIAS_NOT_ALLOWED = "alias_not_allowed"
    MODEL_NOT_FOUND = "model_not_found"
    INPUT_TOO_LARGE = "input_too_large"
    QUOTA_EXCEEDED = "quota_exceeded"
    BUDGET_EXHAUSTED = "budget_exhausted"
    UPSTREAM_REJECTED = "upstream_rejected"
    UPSTREAM_FAILED = "upstream_failed"
    UPSTREAM_TIMEOUT = "upstream_timeout"
    GATEWAY_UNAVAILABLE = "gateway_unavailable"
    NOT_FOUND = "not_found"
    INTERNAL_ERROR = "internal_error"


class OutsideRunError(RuntimeError):
    """A model call was made outside any run, so no quota could count it and no trace could show it."""


class GatewayResponseError(OpenAIError):
    """The gateway answered, but not in the shape its API promises."""


def check_gateway_url(url: str) -> str:
    """Return the gateway's base URL, without a trailing slash, if service tokens may be sent to it.

    HTTPS anywhere. Plain HTTP only to this machine, or to a single-label host such as
    `gateway`, the gateway's name on the internal Docker network. The URL is a scheme, a
    host and a port: no credentials, path, query or fragment.
    """
    parts = urlsplit(url)
    host = parts.hostname or ""
    if parts.scheme not in ("http", "https") or not host:
        raise ValueError("The gateway URL must be an http:// or https:// URL with a host.")
    if parts.username or parts.password or parts.query or parts.fragment or parts.path not in ("", "/"):
        raise ValueError("The gateway URL is only a scheme, a host and a port.")
    internal = host in LOOPBACK_HOSTS or "." not in host
    if parts.scheme == "http" and not internal:
        raise ValueError("Use https:// for a gateway outside the internal network.")
    return url.rstrip("/")


class GatewaySettings(BaseModel):
    """Where the gateway is, which service is calling, and where that service's private key is."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    url: str
    service: str
    key_file: Path
    # Longer than any alias's deadline in routing.yaml (lb-long allows 180 seconds).
    timeout_seconds: float = Field(default=200.0, gt=0, le=600)

    @field_validator("url")
    @classmethod
    def _check_url(cls, url: str) -> str:
        """Refuse a URL that could expose the service token (see `check_gateway_url`)."""
        return check_gateway_url(url)

    @field_validator("service")
    @classmethod
    def _check_service(cls, service: str) -> str:
        """Refuse a malformed service name."""
        return check_service_name(service)

    @classmethod
    def from_env(cls, environ: Mapping[str, str] = os.environ) -> Self:
        """Read the settings from LB_GATEWAY_URL, LB_SERVICE_NAME and LB_SERVICE_KEY_FILE."""
        names = ("LB_GATEWAY_URL", "LB_SERVICE_NAME", "LB_SERVICE_KEY_FILE")
        missing = [name for name in names if not environ.get(name)]
        if missing:
            raise ValueError(f"Set {', '.join(missing)} to call the gateway.")
        return cls(
            url=environ["LB_GATEWAY_URL"],
            service=environ["LB_SERVICE_NAME"],
            key_file=Path(environ["LB_SERVICE_KEY_FILE"]),
        )


def run_headers(run: Run, parent_span_id: str | None) -> dict[str, str]:
    """Return the x-lb-* headers that tell the gateway which run a call belongs to."""
    headers = {
        "x-lb-system": run.system,
        "x-lb-run-id": run.run_id,
        "x-lb-data-class": run.data_class,
    }
    if run.session is not None:
        headers["x-lb-session"] = run.session
    if parent_span_id is not None:
        headers["x-lb-parent-span"] = parent_span_id
    return headers


def label_with_current_run(request: httpx2.Request) -> None:
    """Add the current run's x-lb-* headers to a request on its way to the gateway.

    It runs as an httpx event hook, so every request is labelled, whichever API sent it.
    A request made outside any run is stopped here, before it leaves.
    """
    run = current_run()
    if run is None:
        raise OutsideRunError("Model calls belong to a run: make them inside run_scope().")
    request.headers.update(run_headers(run, current_span_id()))


class RankedDocument(BaseModel):
    """One document's place in a ranking: its position in the request, and its relevance from 0 to 1."""

    model_config = ConfigDict(frozen=True)

    index: int = Field(ge=0)
    relevance_score: float = Field(ge=0.0, le=1.0, allow_inf_nan=False)


class RerankAnswer(BaseModel):
    """The gateway's answer to a rerank request: the documents, best first."""

    results: list[RankedDocument]


class GuardVerdict(BaseModel):
    """The gateway's verdict on whether a text looks like an attempt to hijack a model.

    `score` is the classifier's highest injection probability across the text, from 0 to
    1, and `flagged` is true when it reaches `threshold`. Long texts are checked in
    `segments`, so an injection can't hide past the classifier's input limit.
    """

    model_config = ConfigDict(frozen=True)

    flagged: bool
    score: float = Field(ge=0.0, le=1.0, allow_inf_nan=False)
    threshold: float = Field(gt=0.0, le=1.0)
    segments: int = Field(ge=1)


# The most segments one recording can hold, and the longest text of one: the gateway's own caps.
MAX_SEGMENTS = 600
MAX_SEGMENT_TEXT = 2_000
# A segment may end this far past the recording's end before the answer counts as wrong.
SEGMENT_END_SLACK_SECONDS = 0.01


class TranscriptSegment(BaseModel):
    """One stretch of speech: the words, and the seconds from the start of the recording it begins and ends at.

    `no_speech_prob` and `avg_logprob` are Whisper's own doubts about the segment, when the provider
    reports them; a caller can use them to drop text invented over silence.
    """

    model_config = ConfigDict(frozen=True)

    id: int = Field(ge=0)
    start: float = Field(ge=0.0, allow_inf_nan=False)
    end: float = Field(ge=0.0, allow_inf_nan=False)
    text: str = Field(min_length=1, max_length=MAX_SEGMENT_TEXT)
    avg_logprob: float | None = Field(default=None, allow_inf_nan=False)
    no_speech_prob: float | None = Field(default=None, ge=0.0, le=1.0, allow_inf_nan=False)

    @model_validator(mode="after")
    def _ends_after_it_starts(self) -> Self:
        """Refuse a segment that ends before it starts."""
        if self.end < self.start:
            raise ValueError("A segment can't end before it starts.")
        return self


class Transcription(BaseModel):
    """The gateway's transcription of a recording, in the same shape whichever provider served it.

    `duration` is what the gateway measured from the recording's bytes, not the provider's claim. The
    segments are in order of their start, numbered from 0, and none runs past the recording.
    """

    model_config = ConfigDict(frozen=True)

    language: str = Field(max_length=40)
    duration: float = Field(ge=0.0, allow_inf_nan=False)
    text: str
    segments: list[TranscriptSegment] = Field(max_length=MAX_SEGMENTS)

    @model_validator(mode="after")
    def _segments_fit_the_recording(self) -> Self:
        """Refuse segments that are out of order, numbered wrongly, or run past the end of the recording."""
        if [segment.id for segment in self.segments] != list(range(len(self.segments))):
            raise ValueError("The segments aren't numbered from 0 in order.")
        starts = [segment.start for segment in self.segments]
        if starts != sorted(starts):
            raise ValueError("The segments aren't in order of their start.")
        if any(segment.end > self.duration + SEGMENT_END_SLACK_SECONDS for segment in self.segments):
            raise ValueError("A segment runs past the end of the recording.")
        return self


class Gateway:
    """One service's connection to the AI gateway, shared by the whole process."""

    def __init__(
        self, settings: GatewaySettings, tokens: ServiceTokens, transport: httpx2.BaseTransport | None = None
    ) -> None:
        """Connect to the gateway at `settings.url` as `tokens.service`. Pass `transport` only in tests."""
        timeout = httpx2.Timeout(settings.timeout_seconds, connect=CONNECT_TIMEOUT_SECONDS)
        self._tokens = tokens
        self._http = httpx2.Client(
            transport=transport,
            timeout=timeout,
            # A redirect must never carry the service token to another address, and proxy
            # variables in the environment must never route it through a proxy.
            follow_redirects=False,
            trust_env=False,
            event_hooks={"request": [label_with_current_run]},
        )
        self.openai = OpenAI(
            base_url=f"{settings.url}/v1",
            # Called before every request, so each call carries a token with time left.
            api_key=tokens.current,
            # The gateway already falls back across providers; a retry here would only
            # spend the run's quota twice.
            max_retries=0,
            timeout=timeout,
            http_client=self._http,
        )

    @classmethod
    def from_env(cls, environ: Mapping[str, str] = os.environ) -> Self:
        """Connect with the settings in the environment (see `GatewaySettings.from_env`)."""
        settings = GatewaySettings.from_env(environ)
        return cls(settings, ServiceTokens(settings.service, load_service_key(settings.key_file)))

    def embed(self, texts: Sequence[str], model: str = "lb-embed") -> list[list[float]]:
        """Return one embedding vector per text, in the order of the texts."""
        answer = self.openai.embeddings.create(model=model, input=list(texts), encoding_format="float")
        items = sorted(answer.data, key=lambda item: item.index)
        if [item.index for item in items] != list(range(len(texts))):
            raise GatewayResponseError("The gateway didn't return exactly one vector per text.")
        return [item.embedding for item in items]

    def rerank(
        self, query: str, documents: Sequence[str], top_n: int | None = None, model: str = "lb-rerank"
    ) -> list[RankedDocument]:
        """Score how well each document answers the query, and return them best first."""
        body: dict[str, object] = {"model": model, "query": query, "documents": list(documents)}
        if top_n is not None:
            body["top_n"] = top_n
        ranking = self._post("/rerank", body, RerankAnswer).results
        indexes = [document.index for document in ranking]
        if len(set(indexes)) != len(indexes) or any(index >= len(documents) for index in indexes):
            raise GatewayResponseError("The gateway's ranking doesn't match the documents sent.")
        scores = [document.relevance_score for document in ranking]
        if scores != sorted(scores, reverse=True):
            raise GatewayResponseError("The gateway's ranking isn't in order.")
        return ranking

    def transcribe(self, wav: bytes, language: str | None = None, model: str = "lb-stt") -> Transcription:
        """Turn a recording into words with the second each stretch of speech starts and ends.

        `wav` must be the format the gateway measures: 16-bit PCM, mono, 16 kHz (`lb_common.audio.wav_from_pcm`
        writes it). `language` is a code such as `en`; left out, the model detects it. A visitor's recording
        is only ever sent to a provider that does not train on inputs: the run's data class decides.
        """
        fields = {"model": model, "response_format": "verbose_json"}
        if language is not None:
            fields["language"] = language
        response = self.openai.post(
            "/audio/transcriptions",
            cast_to=httpx2.Response,
            body=fields,
            files=[("file", ("recording.wav", wav, "audio/wav"))],
            options={
                "headers": {"Authorization": f"Bearer {self._tokens.current()}", "Content-Type": "multipart/form-data"}
            },
        )
        try:
            return Transcription.model_validate_json(response.content)
        except ValidationError as error:
            # The error names the fields that were wrong, never the words of the transcript.
            raise GatewayResponseError("The gateway's answer to /audio/transcriptions is malformed.") from error

    def guard(self, text: str, model: str = "lb-guard") -> GuardVerdict:
        """Ask whether a text looks like a prompt injection, before it reaches a model that can call tools."""
        return self._post("/guard", {"model": model, "input": text}, GuardVerdict)

    def close(self) -> None:
        """Close the connections to the gateway."""
        self.openai.close()

    def _post[Answer: BaseModel](self, path: str, body: dict[str, object], answer_type: type[Answer]) -> Answer:
        """Send one of the gateway's own requests, and validate its answer against `answer_type`."""
        response = self.openai.post(
            path,
            cast_to=httpx2.Response,
            body=body,
            options={"headers": {"Authorization": f"Bearer {self._tokens.current()}"}},
        )
        try:
            return answer_type.model_validate_json(response.content)
        except ValidationError as error:
            raise GatewayResponseError(f"The gateway's answer to {path} is malformed.") from error
