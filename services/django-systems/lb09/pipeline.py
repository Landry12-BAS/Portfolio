"""LB-09's pipeline: from a recording to decisions, owners and deadlines, each tied to the second it was said.

    decode -> transcribe (fast or private) -> label speakers -> extract items -> align evidence -> save

One meeting is one run of LB-09. Each step is a span of the run's trace, every model call goes through the
gateway labelled with the run, and the stage the worker is on is recorded on the meeting's row and announced
to its WebSocket group as it changes (lb09/progress.py). A meeting costs a transcription (fast mode only) and
two chat calls, the labeller on `lb-fast` and the extractor on `lb-tools`, plus one repair of each answer
that doesn't fit its schema: at most four chat calls, which lb09/limits.py and routing.yaml agree on.

The audio file is deleted the moment the transcriber is done with it, on success and on failure, in the
same step: nothing after it needs the audio, and nothing before it is allowed to leave it behind.
Whatever fails, the meeting is marked failed with a reason the page can explain, never with an error's words.
"""

import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from django.conf import settings
from django.db import transaction
from openai import OpenAIError
from redis import Redis

from core.structured import (
    ChatMessage,
    ChatModels,
    Completion,
    GatewayChat,
    StructuredAnswer,
    StructuredOutputError,
    ask_for_json,
)
from lb09.audio import AudioRefusedError, decode_recording
from lb09.extraction import check_items
from lb09.labelling import label_segments
from lb09.limits import EXTRACT_MAX_TOKENS, LABEL_MAX_TOKENS
from lb09.models import Item, Meeting
from lb09.models import Segment as SegmentRow
from lb09.progress import record_stage
from lb09.prompts import ExtractAnswer, LabelAnswer, extract_messages, label_messages
from lb09.results import LabelledSegment, MeetingResult
from lb09.storage import AudioStore
from lb09.transcribers import FastTranscriber, PrivateTranscriber, Transcriber, TranscriberError
from lb09.transcript import Segment, Transcript
from lb_common.gateway import Gateway
from lb_common.run import DataClass, Run, run_scope
from lb_common.tracing import RedisSpanWriter, Tracer

logger = logging.getLogger(__name__)

# The virtual models each step asks: a fast one to label, the strongest to extract.
LABEL_ALIAS = "lb-fast"
EXTRACT_ALIAS = "lb-tools"

# The validated extractor answer, with how many replies it took (core/structured.py).
type StructuredExtract = StructuredAnswer[ExtractAnswer]


class MeetingFailedError(Exception):
    """A step could not finish, for a reason the page can explain (one of `Meeting.Failure`).

    `model_calls` is how many chat calls the meeting had made when it failed, when a chat step is what failed:
    those calls were spent all the same, and the page counts them.
    """

    def __init__(self, reason: str, model_calls: int | None = None) -> None:
        """Keep the reason, and the chat calls spent when they are known."""
        super().__init__(reason)
        self.reason = reason
        self.model_calls = model_calls


@dataclass
class Analysis:
    """What the chat steps found, and how many calls they took."""

    result: MeetingResult
    calls: int


class CountedChat:
    """The chat models, counting every call made through them, whether it was answered or not.

    A step that fails (an answer that never fitted its schema, a provider out of reach) has spent its calls all
    the same, so a failed meeting's count comes from here rather than from the answers that arrived.
    """

    def __init__(self, chat: ChatModels) -> None:
        """Count the calls made through `chat`, from none."""
        self.chat = chat
        self.calls = 0

    def complete(self, alias: str, messages: Sequence[ChatMessage], max_tokens: int) -> Completion:
        """Count the call, then make it."""
        self.calls += 1
        return self.chat.complete(alias, messages, max_tokens)


class MeetingPipeline:
    """Runs meetings through every step, each meeting as one run of LB-09, and records the outcome."""

    def __init__(
        self,
        transcribers: Mapping[str, Transcriber],
        chat: ChatModels,
        tracer: Tracer,
        store: AudioStore,
        report: Callable[..., None] = record_stage,
    ) -> None:
        """Transcribe with the transcriber of the meeting's mode, chat through `chat`, trace with `tracer`.

        `store` is where the audio waits, and `report` records each stage (the row and the WebSocket group).
        """
        self.transcribers = transcribers
        self.chat = chat
        self.tracer = tracer
        self.store = store
        self.report = report

    def run(self, meeting: Meeting) -> None:
        """Run a meeting as one run of LB-09, save what was found, and mark it done or failed."""
        data_class: DataClass = "synthetic" if meeting.sample_key else "visitor"
        session = meeting.session_key if data_class == "visitor" else None
        run = Run(system="lb-09", run_id=meeting.run_id, data_class=data_class, session=session)
        with run_scope(run), self.tracer.span("meeting recording", kind="system.run", mode=meeting.mode) as span:
            try:
                analysis = self.work_through(meeting)
            except MeetingFailedError as failed:
                span.set("status", Meeting.Status.FAILED)
                span.set("reason", failed.reason)
                mark_failed(meeting, failed.reason, self.report, model_calls=failed.model_calls)
                return
            span.set("status", Meeting.Status.DONE)
            span.set("items", len(analysis.result.items))
            span.set("dropped", analysis.result.dropped)
            save_result(meeting, analysis, self.report)

    def work_through(self, meeting: Meeting) -> Analysis:
        """Take the meeting through each step, raising MeetingFailedError at the first one that cannot finish."""
        transcript = self.hear(meeting)
        if not transcript.segments:
            raise MeetingFailedError(Meeting.Failure.NO_SPEECH)
        chat = CountedChat(self.chat)
        try:
            return self.analyse(transcript.segments, meeting, chat)
        except (OpenAIError, StructuredOutputError):
            raise MeetingFailedError(Meeting.Failure.MODEL, model_calls=chat.calls) from None

    def hear(self, meeting: Meeting) -> Transcript:
        """Decode the audio and transcribe it, deleting the file whatever happens, and record what was heard."""
        try:
            try:
                pcm, seconds = self.decode(meeting)
                return self.transcribe(meeting, pcm, seconds)
            finally:
                self.store.delete(meeting.audio_name)
                meeting.audio_name = ""
        except AudioRefusedError as refused:
            raise MeetingFailedError(refused.reason) from None
        except TranscriberError:
            raise MeetingFailedError(Meeting.Failure.TRANSCRIBER) from None

    def decode(self, meeting: Meeting) -> tuple[bytes, float]:
        """Decode the stored recording in the bounded child and measure it from its samples."""
        self.report(meeting, Meeting.Stage.DECODING)
        with self.tracer.span("decode audio") as span:
            path = self.store.path_of(meeting.audio_name)
            if not path.is_file():
                raise MeetingFailedError(Meeting.Failure.AUDIO_GONE)
            span.set("bytes", path.stat().st_size)
            decoded = decode_recording(path)
            span.set("seconds", decoded.seconds)
        return decoded.pcm, decoded.seconds

    def transcribe(self, meeting: Meeting, pcm: bytes, seconds: float) -> Transcript:
        """Transcribe with the transcriber of the meeting's mode, and record which model ran."""
        transcriber = self.transcribers[meeting.mode]
        self.report(meeting, Meeting.Stage.TRANSCRIBING, duration_seconds=seconds)
        with self.tracer.span("transcribe", mode=transcriber.mode) as span:
            transcript = transcriber.transcribe(pcm, meeting.language or None)
            span.set("seconds", seconds)
            span.set("segments", len(transcript.segments))
            span.set("model", transcript.model)
        meeting.transcriber = transcript.model[:120]
        meeting.heard_language = transcript.language[:40]
        return transcript

    def analyse(
        self, segments: list[Segment], meeting: Meeting | None = None, chat: ChatModels | None = None
    ) -> Analysis:
        """Label the speakers, extract the items and align the evidence: the text-only part, which the eval runs too.

        `chat` is what the calls go through, the pipeline's own models when it is not given.
        """
        models = chat or self.chat
        calls = 0
        if meeting is not None:
            self.report(
                meeting, Meeting.Stage.LABELLING, transcriber=meeting.transcriber, heard_language=meeting.heard_language
            )
        labelled, attempts = self.label(segments, models)
        calls += attempts
        if meeting is not None:
            self.report(meeting, Meeting.Stage.EXTRACTING, model_calls=calls)
        answer = self.extract(labelled, models)
        calls += answer.attempts
        if meeting is not None:
            self.report(meeting, Meeting.Stage.ALIGNING, model_calls=calls)
        result = self.align(labelled, answer.value)
        return Analysis(result=result, calls=calls)

    def label(self, segments: list[Segment], chat: ChatModels) -> tuple[list[LabelledSegment], int]:
        """Ask the labeller which segments each voice said, and keep only the names the code can verify."""
        with self.tracer.span("label speakers") as span:
            answer = ask_for_json(chat, LABEL_ALIAS, label_messages(segments), LabelAnswer, LABEL_MAX_TOKENS)
            labelled = label_segments(segments, answer.value)
            span.set("speakers", len({segment.speaker for segment in labelled}))
            span.set("named", len({segment.label for segment in labelled if not segment.label.startswith("Speaker ")}))
            span.set("attempts", answer.attempts)
        return labelled, answer.attempts

    def extract(self, labelled: list[LabelledSegment], chat: ChatModels) -> "StructuredExtract":
        """Ask the extractor for the decisions and actions, each with its verbatim evidence."""
        with self.tracer.span("extract items") as span:
            labels = [segment.label for segment in labelled]
            segments = [Segment(s.position, s.start, s.end, s.text) for s in labelled]
            answer = ask_for_json(
                chat, EXTRACT_ALIAS, extract_messages(segments, labels), ExtractAnswer, EXTRACT_MAX_TOKENS
            )
            span.set("decisions", len(answer.value.decisions))
            span.set("actions", len(answer.value.actions))
            span.set("attempts", answer.attempts)
        return answer

    def align(self, labelled: list[LabelledSegment], answer: ExtractAnswer) -> MeetingResult:
        """Verify every quote against the transcript and take each item's seconds from the segments it falls in."""
        with self.tracer.span("align evidence") as span:
            checked = check_items(answer, labelled)
            span.set("kept", len(checked.items))
            span.set("dropped", checked.dropped)
        return MeetingResult(segments=labelled, items=checked.items, dropped=checked.dropped)


def mark_failed(
    meeting: Meeting, reason: str, report: Callable[..., None] = record_stage, model_calls: int | None = None
) -> None:
    """Record that a meeting failed, and why, with the chat calls it spent when they are known; tell its group."""
    meeting.status = Meeting.Status.FAILED
    spent = {} if model_calls is None else {"model_calls": model_calls}
    report(meeting, Meeting.Stage.FAILED, status=Meeting.Status.FAILED, failure=reason, audio_name="", **spent)


def save_result(meeting: Meeting, analysis: Analysis, report: Callable[..., None] = record_stage) -> None:
    """Save the labelled transcript and the items in one transaction, then mark the meeting done."""
    with transaction.atomic(using="lb09"):
        SegmentRow.objects.filter(meeting=meeting).delete()
        Item.objects.filter(meeting=meeting).delete()
        SegmentRow.objects.bulk_create(
            SegmentRow(
                meeting=meeting,
                position=segment.position,
                start=segment.start,
                end=segment.end,
                text=segment.text,
                speaker=segment.speaker,
                label=segment.label,
            )
            for segment in analysis.result.segments
        )
        Item.objects.bulk_create(
            Item(
                meeting=meeting,
                position=position,
                kind=item.kind,
                text=item.text,
                owner=item.owner or "",
                deadline=item.deadline or "",
                evidence=item.evidence,
                start=item.start,
                end=item.end,
                first_segment=item.first_segment,
                last_segment=item.last_segment,
            )
            for position, item in enumerate(analysis.result.items)
        )
        meeting.status = Meeting.Status.DONE
        report(
            meeting,
            Meeting.Stage.DONE,
            status=Meeting.Status.DONE,
            model_calls=analysis.calls,
            dropped_items=analysis.result.dropped,
            transcriber=meeting.transcriber,
            heard_language=meeting.heard_language,
            audio_name="",
        )


def connect_pipeline(store: AudioStore | None = None) -> MeetingPipeline:
    """Build the pipeline the service runs: the gateway from the environment, both transcribers, spans to Redis."""
    gateway = Gateway.from_env()
    writer = RedisSpanWriter(Redis.from_url(settings.REDIS_URL), prefix=settings.REDIS_PREFIX)
    transcribers: dict[str, Transcriber] = {
        Meeting.Mode.FAST: FastTranscriber(gateway),
        Meeting.Mode.PRIVATE: PrivateTranscriber(),
    }
    return MeetingPipeline(transcribers, GatewayChat(gateway), Tracer(writer), store or AudioStore())
