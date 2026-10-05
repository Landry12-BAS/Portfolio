"""LB-09's API, which the site calls on a visitor's behalf: start a meeting, follow it, read it, export it.

Every route needs a visitor token for lb-09 (core/visitors.py), and a visitor sees only the meetings of their
own session: anyone else's is simply not found. Starting a meeting stores the recording, queues it for the
worker and answers at once; the page follows the worker over the WebSocket (lb09/consumers.py) or by reading
the meeting again. A visitor may start 5 meetings a day, and their meetings are deleted 24 hours after they
were made (the LB-09 datasheet). The recording arrives as base64 in the JSON body, because the site's server
relays JSON only; its first bytes must be one of the containers a browser's recorder writes.
"""

import base64
import binascii
from datetime import datetime, timedelta
from typing import Annotated, Literal, Self

from django.db.models import QuerySet
from django.http import HttpRequest
from django.utils import timezone
from ninja import Query, Router, Schema, Status
from ninja.errors import AuthenticationError
from pydantic import StringConstraints, model_validator

from core.data_files import Key
from core.visitors import Visitor, VisitorBearer
from lb09.audio import AudioRefusedError, check_upload
from lb09.export import LABELS_NOTE, as_csv, as_json, as_text
from lb09.limits import (
    MAX_RECORDING_SECONDS,
    MAX_UPLOAD_BASE64_CHARS,
    MAX_UPLOAD_BYTES,
    RECORDINGS_PER_VISITOR_PER_DAY,
)
from lb09.meetings import MeetingLimitError, midnight_before, own_meeting, start_meeting, started_today
from lb09.models import Item, Meeting, Segment
from lb09.samples import sample_audio, samples
from lb09.storage import AudioStore
from lb09.tasks import queue_meeting

# How many of a visitor's meetings the list shows, newest first.
LIST_LENGTH = 20

router = Router(auth=VisitorBearer("lb-09"), tags=["LB-09 Meeting Recorder"])

# A recording as the browser sends it: standard base64, bounded to what the byte cap allows.
AudioBase64 = Annotated[
    str, StringConstraints(pattern=r"^[A-Za-z0-9+/=\s]+$", min_length=4, max_length=MAX_UPLOAD_BASE64_CHARS)
]
# A language the visitor asked for, as a two-letter code; English and Czech are what the site speaks.
Language = Literal["en", "cs"]
ExportFormat = Literal["json", "csv", "text"]


def audio_store() -> AudioStore:
    """Return the store recordings wait in; a test replaces this with a folder of its own."""
    return AudioStore()


class ErrorDetail(Schema):
    """What went wrong, as a stable code and a sentence for people."""

    code: str
    message: str


class ErrorOut(Schema):
    """The error shape the whole platform answers with."""

    error: ErrorDetail


class SampleOut(Schema):
    """A curated sample meeting the demo opens on, and the committed audio file the page plays."""

    key: str
    title: str
    about: str
    file: str
    seconds: float
    speakers: int


class LimitsOut(Schema):
    """What is left of the visitor's day, and the datasheet's limits the service enforces."""

    recordings_per_day: int
    used_today: int
    left_today: int
    resets_at: datetime
    max_recording_seconds: float
    max_upload_bytes: int


class MeetingIn(Schema):
    """A meeting to start: a visitor's own recording, or a curated sample, in fast or private mode."""

    source: Literal["upload", "sample"]
    mode: Literal["fast", "private"]
    audio: AudioBase64 | None = None
    sample: Key | None = None
    language: Language | None = None

    @model_validator(mode="after")
    def _check_source(self) -> Self:
        """Require the audio for an upload and the sample's key for a sample, and nothing else."""
        if self.source == "upload" and (self.audio is None or self.sample is not None):
            raise ValueError("an upload carries audio and names no sample")
        if self.source == "sample" and (self.sample is None or self.audio is not None):
            raise ValueError("a sample names the sample and carries no audio")
        return self


class MeetingOut(Schema):
    """A meeting: where it stands, what was measured, which model ran, and the counters the page shows."""

    id: str
    sample: str | None
    mode: str
    status: str
    stage: str
    failure: str | None
    run_id: str
    language: str | None
    heard_language: str
    transcriber: str
    duration_seconds: float
    source_bytes: int
    model_calls: int
    dropped_items: int
    # Always true: the labels are inferred from the words, never matched to voices.
    labels_inferred_from_text: bool
    created_at: datetime
    updated_at: datetime
    expires_at: datetime


class SegmentOut(Schema):
    """One stretch of speech, with the speaker the words suggest."""

    position: int
    start: float
    end: float
    text: str
    speaker: int
    label: str


class TranscriptOut(Schema):
    """A finished meeting's transcript, segment by segment, and the note about its labels."""

    meeting: str
    labels_note: str
    segments: list[SegmentOut]


class ItemOut(Schema):
    """A decision or an action item, with its verbatim evidence and the seconds it was said in."""

    position: int
    kind: str
    text: str
    owner: str | None
    deadline: str | None
    evidence: str
    start: float
    end: float
    first_segment: int
    last_segment: int


class ItemsOut(Schema):
    """A finished meeting's items, and how many the checks dropped."""

    meeting: str
    dropped: int
    items: list[ItemOut]


class ExportOut(Schema):
    """An export: its format, a file name to save it as, and its content."""

    format: str
    filename: str
    content_type: str
    content: str


def error(code: str, message: str) -> ErrorOut:
    """Build an error answer in the platform's shape."""
    return ErrorOut(error=ErrorDetail(code=code, message=message))


def visitor_of(request: HttpRequest) -> Visitor:
    """Return the visitor the request's token vouched for."""
    visitor = getattr(request, "auth", None)
    if not isinstance(visitor, Visitor):
        raise AuthenticationError
    return visitor


def own_meetings(visitor: Visitor) -> QuerySet[Meeting]:
    """Return the visitor's own unexpired meetings, newest first; no other meeting is ever reachable."""
    return Meeting.objects.filter(session_key=visitor.session_key, expires_at__gt=timezone.now())


@router.get("/samples", response=list[SampleOut])
def list_samples(request: HttpRequest) -> list[SampleOut]:
    """List the curated sample meetings, with the audio file the page plays for each."""
    visitor_of(request)
    return [SampleOut(**vars(sample)) for sample in samples().values()]


@router.get("/limits", response=LimitsOut)
def limits(request: HttpRequest) -> LimitsOut:
    """Say how many meetings the visitor may still start today, and the limits every recording is held to."""
    visitor = visitor_of(request)
    now = timezone.now()
    used = started_today(visitor.session_key, now)
    return LimitsOut(
        recordings_per_day=RECORDINGS_PER_VISITOR_PER_DAY,
        used_today=used,
        left_today=max(0, RECORDINGS_PER_VISITOR_PER_DAY - used),
        resets_at=midnight_before(now) + timedelta(days=1),
        max_recording_seconds=MAX_RECORDING_SECONDS,
        max_upload_bytes=MAX_UPLOAD_BYTES,
    )


@router.post("/meetings", response={202: MeetingOut, 404: ErrorOut, 413: ErrorOut, 415: ErrorOut, 429: ErrorOut})
def start(request: HttpRequest, payload: MeetingIn) -> Status[MeetingOut] | Status[ErrorOut]:
    """Start a meeting from the visitor's recording or a sample, and queue it for the worker."""
    visitor = visitor_of(request)
    if payload.source == "sample":
        if payload.sample not in samples():
            return Status(404, error("unknown_sample", "There is no sample with that key."))
        audio = sample_audio(str(payload.sample))
    else:
        try:
            audio = base64.b64decode(payload.audio or "", validate=False)
        except (binascii.Error, ValueError):
            return Status(415, error("unsupported_audio", "The recording isn't valid base64."))
    try:
        check_upload(audio)
    except AudioRefusedError as refused:
        if refused.reason == "too_big":
            return Status(413, error("audio_too_big", f"A recording may be at most {MAX_UPLOAD_BYTES} bytes."))
        return Status(415, error("unsupported_audio", "The recording isn't in a container the recorder takes."))
    try:
        meeting = start_meeting(
            visitor.session_key,
            audio,
            payload.mode,
            payload.language or "",
            audio_store(),
            sample_key=str(payload.sample or ""),
            queue=queue_meeting,
        )
    except MeetingLimitError:
        return Status(
            429, error("daily_limit", f"A visitor may record {RECORDINGS_PER_VISITOR_PER_DAY} meetings a day.")
        )
    return Status(202, meeting_out(meeting))


@router.get("/meetings", response=list[MeetingOut])
def list_meetings(request: HttpRequest) -> list[MeetingOut]:
    """List the visitor's own meetings, newest first."""
    return [meeting_out(meeting) for meeting in own_meetings(visitor_of(request))[:LIST_LENGTH]]


@router.get("/meetings/{meeting_id}", response={200: MeetingOut, 404: ErrorOut})
def get_meeting(request: HttpRequest, meeting_id: str) -> Status[MeetingOut] | Status[ErrorOut]:
    """Show where one of the visitor's meetings stands: the polling fallback for the WebSocket."""
    meeting = own_meeting(visitor_of(request).session_key, meeting_id)
    if meeting is None:
        return Status(404, error("not_found", "There is no such meeting."))
    return Status(200, meeting_out(meeting))


@router.get("/meetings/{meeting_id}/transcript", response={200: TranscriptOut, 404: ErrorOut, 409: ErrorOut})
def get_transcript(request: HttpRequest, meeting_id: str) -> Status[TranscriptOut] | Status[ErrorOut]:
    """Show a finished meeting's transcript with its inferred speaker labels."""
    meeting = own_meeting(visitor_of(request).session_key, meeting_id)
    if meeting is None:
        return Status(404, error("not_found", "There is no such meeting."))
    if meeting.status != Meeting.Status.DONE:
        return Status(409, error("not_done", "The transcript is ready once the meeting is done."))
    segments = [segment_out(segment) for segment in Segment.objects.filter(meeting=meeting)]
    return Status(200, TranscriptOut(meeting=meeting.public_id, labels_note=LABELS_NOTE, segments=segments))


@router.get("/meetings/{meeting_id}/items", response={200: ItemsOut, 404: ErrorOut, 409: ErrorOut})
def get_items(request: HttpRequest, meeting_id: str) -> Status[ItemsOut] | Status[ErrorOut]:
    """Show a finished meeting's decisions and action items, each with its evidence and its seconds."""
    meeting = own_meeting(visitor_of(request).session_key, meeting_id)
    if meeting is None:
        return Status(404, error("not_found", "There is no such meeting."))
    if meeting.status != Meeting.Status.DONE:
        return Status(409, error("not_done", "The items are ready once the meeting is done."))
    items = [item_out(item) for item in Item.objects.filter(meeting=meeting)]
    return Status(200, ItemsOut(meeting=meeting.public_id, dropped=meeting.dropped_items, items=items))


@router.get("/meetings/{meeting_id}/export", response={200: ExportOut, 404: ErrorOut, 409: ErrorOut})
def export(
    request: HttpRequest, meeting_id: str, export_format: Annotated[ExportFormat, Query(alias="format")]
) -> Status[ExportOut] | Status[ErrorOut]:
    """Export a finished meeting as JSON, CSV, or the plain-English follow-up for Automation Studio (LB-08)."""
    meeting = own_meeting(visitor_of(request).session_key, meeting_id)
    if meeting is None:
        return Status(404, error("not_found", "There is no such meeting."))
    if meeting.status != Meeting.Status.DONE:
        return Status(409, error("not_done", "An export is ready once the meeting is done."))
    items = list(Item.objects.filter(meeting=meeting))
    if export_format == "json":
        content = as_json(meeting, list(Segment.objects.filter(meeting=meeting)), items)
        return Status(
            200,
            ExportOut(
                format=export_format,
                filename=f"meeting-{meeting.public_id}.json",
                content_type="application/json",
                content=content,
            ),
        )
    if export_format == "csv":
        return Status(
            200,
            ExportOut(
                format=export_format,
                filename=f"meeting-{meeting.public_id}.csv",
                content_type="text/csv",
                content=as_csv(items),
            ),
        )
    return Status(
        200,
        ExportOut(
            format=export_format,
            filename=f"meeting-{meeting.public_id}.txt",
            content_type="text/plain",
            content=as_text(items),
        ),
    )


def meeting_out(meeting: Meeting) -> MeetingOut:
    """Describe a meeting."""
    return MeetingOut(
        id=meeting.public_id,
        sample=meeting.sample_key or None,
        mode=meeting.mode,
        status=meeting.status,
        stage=meeting.stage,
        failure=meeting.failure or None,
        run_id=meeting.run_id,
        language=meeting.language or None,
        heard_language=meeting.heard_language,
        transcriber=meeting.transcriber,
        duration_seconds=meeting.duration_seconds,
        source_bytes=meeting.source_bytes,
        model_calls=meeting.model_calls,
        dropped_items=meeting.dropped_items,
        labels_inferred_from_text=True,
        created_at=meeting.created_at,
        updated_at=meeting.updated_at,
        expires_at=meeting.expires_at,
    )


def segment_out(segment: Segment) -> SegmentOut:
    """Describe a segment."""
    return SegmentOut(
        position=segment.position,
        start=segment.start,
        end=segment.end,
        text=segment.text,
        speaker=segment.speaker,
        label=segment.label,
    )


def item_out(item: Item) -> ItemOut:
    """Describe an item."""
    return ItemOut(
        position=item.position,
        kind=item.kind,
        text=item.text,
        owner=item.owner or None,
        deadline=item.deadline or None,
        evidence=item.evidence,
        start=item.start,
        end=item.end,
        first_segment=item.first_segment,
        last_segment=item.last_segment,
    )
