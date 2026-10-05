"""Helpers LB-09's tests share: scripted meetings as transcripts, and a scripted extractor built from the golden set.

An oracle is what a perfectly careful pipeline would find: the labels the golden set expects, and every expected
item with the quote it names and the time span of the turns it is said in. The grader must give it a clean sheet,
and every flaw the tests plant in it must be caught by the check that names it.
"""

import json
from collections.abc import Callable
from dataclasses import dataclass, field, replace

from lb09.golden import ExpectedAction, ExpectedItem, GoldenCase, expected_labels
from lb09.pipeline import MeetingPipeline
from lb09.progress import record_stage
from lb09.results import FoundItem, ItemKind, LabelledSegment, MeetingResult
from lb09.scripts import Script
from lb09.storage import AudioStore
from lb09.timeline import TurnSpan
from lb09.transcribers import TranscriberError
from lb09.transcript import Segment, Transcript

from lb_common.tracing import Tracer
from tests.support import FakeChat, MemorySpanWriter


def script_segments(case: GoldenCase, script: Script, spans: list[TurnSpan]) -> list[LabelledSegment]:
    """Make the transcript a transcriber would give for a script: a segment a turn, labelled as the golden set says."""
    labels = expected_labels(case, script)
    order = list(labels)
    return [
        LabelledSegment(
            position=position,
            start=span.start,
            end=span.end,
            text=turn.text,
            speaker=order.index(turn.speaker),
            label=labels[turn.speaker],
        )
        for position, (turn, span) in enumerate(zip(script.turns, spans, strict=True))
    ]


def first_owner(action: ExpectedAction) -> str | None:
    """Return the first name the golden set accepts for an action's owner, or None where it gives the job to nobody."""
    return action.owner[0] if action.owner else None


def oracle_result(case: GoldenCase, script: Script, spans: list[TurnSpan]) -> MeetingResult:
    """Make the result a perfect pipeline gives for a case: every expected item, quoted and placed, and nothing else."""
    items: list[FoundItem] = []
    expected: list[tuple[ItemKind, ExpectedItem, str | None, str | None]] = [
        *(("decision", item, None, None) for item in case.expect.decisions),
        *(("action", item, first_owner(item), item.deadline) for item in case.expect.actions),
    ]
    for kind, item, owner, deadline in expected:
        quote, turns = item.quote, item.said_in
        said = [spans[turn] for turn in turns]
        items.append(
            FoundItem(
                kind=kind,
                text=item.summary,
                owner=owner,
                deadline=deadline,
                evidence=quote,
                start=min(span.start for span in said),
                end=max(span.end for span in said),
                first_segment=min(turns),
                last_segment=max(turns),
            )
        )
    return MeetingResult(segments=script_segments(case, script, spans), items=items, dropped=0)


def with_items(result: MeetingResult, items: list[FoundItem]) -> MeetingResult:
    """Return the result with other items, for planting a flaw."""
    return replace(result, items=items)


# What a model that does what the golden set expects would answer, for the pipeline's offline tests.


def oracle_label_reply(case: GoldenCase, script: Script) -> str:
    """Write the labeller's answer for a script: the voices in order of first word, named only where introduced."""
    labels = expected_labels(case, script)
    order = list(labels)
    speakers = [
        {"id": index, "name": script.speaker(speaker_id).name if speaker_id in case.expect.introduced else None}
        for index, speaker_id in enumerate(order)
    ]
    turns = [{"segment": position, "speaker": order.index(turn.speaker)} for position, turn in enumerate(script.turns)]
    return json.dumps({"speakers": speakers, "turns": turns})


def oracle_extract_reply(case: GoldenCase) -> str:
    """Write the extractor's answer for a case: every expected item with the quote the golden set names."""
    decisions = [{"text": item.summary, "evidence": item.quote} for item in case.expect.decisions]
    actions = [
        {"text": item.summary, "owner": first_owner(item), "deadline": item.deadline, "evidence": item.quote}
        for item in case.expect.actions
    ]
    return json.dumps({"decisions": decisions, "actions": actions})


@dataclass
class StubTranscriber:
    """A transcriber that answers with the segments it was given, or fails, and remembers what it was asked."""

    segments: list[Segment]
    mode: str = "fast"
    model: str = "test/stt"
    fails: bool = False
    heard: list[tuple[int, str | None]] = field(default_factory=list)

    def transcribe(self, pcm: bytes, language: str | None) -> Transcript:
        """Return the scripted transcript, after noting how many bytes and which language were asked."""
        self.heard.append((len(pcm), language))
        if self.fails:
            raise TranscriberError("The stub transcriber was told to fail.")
        return Transcript(language="en", model=self.model, segments=list(self.segments))


def script_transcript_segments(script: Script, spans: list[TurnSpan]) -> list[Segment]:
    """Make the transcript a transcriber would give for a script: a segment a turn, at the turns' times."""
    return [
        Segment(position=position, start=span.start, end=span.end, text=turn.text)
        for position, (turn, span) in enumerate(zip(script.turns, spans, strict=True))
    ]


def build_pipeline(
    chat: FakeChat,
    store: AudioStore,
    transcriber: StubTranscriber | None = None,
    report: Callable[..., None] | None = None,
) -> tuple[MeetingPipeline, MemorySpanWriter]:
    """Build the pipeline on fakes: the scripted chat, the given transcriber for both modes, spans kept in memory."""
    spans = MemorySpanWriter()
    transcriber = transcriber or StubTranscriber(segments=[])
    pipeline = MeetingPipeline(
        transcribers={"fast": transcriber, "private": transcriber},
        chat=chat,
        tracer=Tracer(spans),
        store=store,
        report=report or record_stage,
    )
    return pipeline, spans
