"""LB-09's data, all in the lb09 schema: a meeting, its labelled transcript and the items found in it.

A meeting is one recording a visitor made or one curated sample they chose, and one run of LB-09. The
audio itself is never here: it sits in a file the service deletes the moment it has been transcribed
(lb09/storage.py), and the rows hold only what came out of it, the words with their seconds and the
items with their evidence, for 24 hours (`Meeting.expires_at`). Everything a visitor says is theirs
alone: a meeting belongs to the visitor's session, kept as a keyed hash, and anyone else's is not found.
"""

import secrets
from datetime import datetime

from django.core.validators import RegexValidator
from django.db import models
from django.db.models.functions import Length
from django.db.models.lookups import GreaterThanOrEqual, LessThanOrEqual
from django.utils import timezone

from lb09.limits import MAX_RECORDING_SECONDS, VISITOR_DATA_LIFETIME

# The longest an item's text, owner, deadline or evidence may be, in characters.
MAX_ITEM_TEXT = 200
MAX_OWNER = 60
MAX_DEADLINE = 60
MAX_EVIDENCE = 400
# The longest a speaker label may be: a name, or "Speaker 12".
MAX_LABEL = 40
# The longest one segment's words may be.
MAX_SEGMENT_TEXT = 1_000

# Stable names such as `monday-roasting-plan`.
key_validator = RegexValidator(
    r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$", "Use lowercase letters and digits, joined by dots or hyphens."
)


def new_public_id() -> str:
    """Make the random ID a meeting is known by outside the service, so IDs can't be guessed."""
    return secrets.token_urlsafe(12)


def visitor_data_expiry() -> datetime:
    """Return when a meeting made now must be deleted."""
    return timezone.now() + VISITOR_DATA_LIFETIME


class Meeting(models.Model):
    """One recording and what the pipeline made of it, with where the pipeline has got to.

    `stage` is the step the worker is on, which the page shows as progress; `status` is the outcome. A
    meeting from a curated sample carries the sample's key and runs on the committed audio; a visitor's
    own recording carries none. `source_bytes` and `duration_seconds` are measured from the decoded audio,
    never read from a header, and they are all that is kept of the audio itself.
    """

    class Status(models.TextChoices):
        """Where the meeting stands: queued for the worker, being worked on, finished, or given up on."""

        RECEIVED = "received", "Received"
        PROCESSING = "processing", "Processing"
        DONE = "done", "Done"
        FAILED = "failed", "The pipeline couldn't finish"

    class Stage(models.TextChoices):
        """The step the worker is on, in the order the pipeline runs them."""

        RECEIVED = "received", "Received"
        DECODING = "decoding", "Decoding the audio"
        TRANSCRIBING = "transcribing", "Transcribing"
        LABELLING = "labelling", "Labelling the speakers"
        EXTRACTING = "extracting", "Extracting decisions and actions"
        ALIGNING = "aligning", "Aligning the items with the transcript"
        DONE = "done", "Done"
        FAILED = "failed", "Failed"

    class Mode(models.TextChoices):
        """Which transcriber a meeting runs on: the gateway's Whisper, or the one on our own server."""

        FAST = "fast", "Fast: Whisper through the gateway"
        PRIVATE = "private", "Private: faster-whisper on our own server"

    class Failure(models.TextChoices):
        """Why a meeting failed, in a code the page can explain. Never the words of an error."""

        UNDECODABLE = "undecodable", "The audio could not be decoded"
        TOO_LONG = "too_long", "The recording is longer than a minute"
        TOO_SHORT = "too_short", "The recording is too short to hold speech"
        DECODE_LIMIT = "decode_limit", "Decoding the audio took more time or memory than allowed"
        NO_SPEECH = "no_speech", "The transcriber found no speech"
        TRANSCRIBER = "transcriber", "The transcriber could not transcribe the recording"
        MODEL = "model", "A model call failed, even after its repair"
        AUDIO_GONE = "audio_gone", "The audio file was gone before the worker reached it"
        STALE = "stale", "The worker did not finish in time"
        PIPELINE_ERROR = "pipeline_error", "A step failed unexpectedly"

    public_id = models.CharField(max_length=24, unique=True, default=new_public_id, editable=False)
    # A keyed hash of the visitor's signed session, never the session token itself.
    session_key = models.CharField(max_length=64, db_index=True)
    sample_key = models.CharField(max_length=40, blank=True, validators=[key_validator])
    mode = models.CharField(max_length=10, choices=Mode.choices)
    # The language the visitor asked the transcriber for, or empty to let it detect one.
    language = models.CharField(max_length=2, blank=True)
    status = models.CharField(max_length=12, choices=Status.choices, default=Status.RECEIVED)
    stage = models.CharField(max_length=14, choices=Stage.choices, default=Stage.RECEIVED)
    failure = models.CharField(max_length=16, choices=Failure.choices, blank=True)
    run_id = models.CharField(max_length=64, blank=True)
    # The audio file's name in the audio folder while it exists, then empty: never a path a visitor sent.
    audio_name = models.CharField(max_length=80, blank=True)
    # What the decoder measured: the recording's bytes as uploaded, and its length once decoded.
    source_bytes = models.PositiveIntegerField(default=0)
    duration_seconds = models.FloatField(default=0.0)
    # What the transcriber reported: the model that ran, and the language it heard.
    transcriber = models.CharField(max_length=120, blank=True)
    heard_language = models.CharField(max_length=40, blank=True)
    # How many items the model gave that the checks dropped, so the page never hides them.
    dropped_items = models.PositiveSmallIntegerField(default=0)
    # Chat calls the meeting made, which the page shows against the datasheet's 2 to 3.
    model_calls = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    expires_at = models.DateTimeField(default=visitor_data_expiry, db_index=True)

    class Meta:
        """Newest meetings first, and a length the decoder could not have measured is refused."""

        ordering = ("-created_at",)
        constraints = (
            models.CheckConstraint(
                condition=models.Q(duration_seconds__gte=0.0) & models.Q(duration_seconds__lte=MAX_RECORDING_SECONDS),
                name="lb09_meeting_duration_within_a_minute",
            ),
        )

    def __str__(self) -> str:
        """Name the meeting by its public ID."""
        return self.public_id


class Segment(models.Model):
    """One stretch of speech of a meeting: its seconds, its words and the speaker inferred from the words.

    `speaker` numbers the voices the labelling found, from 0; `label` is what the page shows: a name the
    speaker gave themselves, or "Speaker 1". The label is inferred from the text, never matched to a voice.
    """

    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name="segments")
    position = models.PositiveSmallIntegerField()
    start = models.FloatField()
    end = models.FloatField()
    text = models.TextField(max_length=MAX_SEGMENT_TEXT)
    speaker = models.PositiveSmallIntegerField()
    label = models.CharField(max_length=MAX_LABEL)

    class Meta:
        """In the order spoken, one row to a position, and never a segment that ends before it starts."""

        ordering = ("position",)
        constraints = (
            models.UniqueConstraint(fields=("meeting", "position"), name="lb09_segment_one_per_position"),
            models.CheckConstraint(
                condition=models.Q(end__gte=models.F("start")), name="lb09_segment_ends_after_start"
            ),
            models.CheckConstraint(
                condition=models.Q(
                    GreaterThanOrEqual(Length("text"), 1), LessThanOrEqual(Length("text"), MAX_SEGMENT_TEXT)
                ),
                name="lb09_segment_text_length",
            ),
        )

    def __str__(self) -> str:
        """Name the segment by its meeting and position."""
        return f"{self.meeting_id}/{self.position}"


class Item(models.Model):
    """A decision or an action the meeting holds, with the verbatim evidence and the seconds it was said in.

    `start` and `end` are derived by the code from the segments the evidence falls in; the model never
    supplies a time. An item without evidence in the transcript is never saved: it is counted as dropped.
    """

    class Kind(models.TextChoices):
        """What the item is."""

        DECISION = "decision", "Decision"
        ACTION = "action", "Action item"

    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name="items")
    position = models.PositiveSmallIntegerField()
    kind = models.CharField(max_length=8, choices=Kind.choices)
    text = models.CharField(max_length=MAX_ITEM_TEXT)
    owner = models.CharField(max_length=MAX_OWNER, blank=True)
    deadline = models.CharField(max_length=MAX_DEADLINE, blank=True)
    evidence = models.CharField(max_length=MAX_EVIDENCE)
    start = models.FloatField()
    end = models.FloatField()
    first_segment = models.PositiveSmallIntegerField()
    last_segment = models.PositiveSmallIntegerField()

    class Meta:
        """In the order found, one row to a position, and a span that is a span."""

        ordering = ("position",)
        constraints = (
            models.UniqueConstraint(fields=("meeting", "position"), name="lb09_item_one_per_position"),
            models.CheckConstraint(condition=models.Q(end__gte=models.F("start")), name="lb09_item_ends_after_start"),
            models.CheckConstraint(
                condition=models.Q(last_segment__gte=models.F("first_segment")), name="lb09_item_segments_in_order"
            ),
            models.CheckConstraint(
                condition=models.Q(GreaterThanOrEqual(Length("evidence"), 1)), name="lb09_item_has_evidence"
            ),
        )

    def __str__(self) -> str:
        """Name the item by its meeting and position."""
        return f"{self.meeting_id}/{self.position}"
