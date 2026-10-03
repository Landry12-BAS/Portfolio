"""Integration tests for LB-09's worker: a meeting runs once, its audio is deleted whatever happens, and the sweep.

The pipeline runs on fakes: a stub transcriber that hears the script, a scripted model that answers as the
golden set expects, and spans kept in memory. The audio is the committed sample, decoded for real.
"""

import os
import time
from datetime import timedelta
from pathlib import Path

import pytest
from django.utils import timezone
from lb09 import tasks
from lb09.golden import read_golden_set
from lb09.models import Item, Meeting, Segment
from lb09.pipeline import MeetingPipeline
from lb09.samples import sample_audio
from lb09.scripts import read_scripts
from lb09.storage import AudioStore
from lb09.tts import read_manifest

from lb_common.audio import wav_from_pcm
from tests.lb09_support import (
    StubTranscriber,
    build_pipeline,
    oracle_extract_reply,
    oracle_label_reply,
    script_transcript_segments,
)
from tests.support import FakeChat, MemorySpanWriter

pytestmark = [pytest.mark.integration, pytest.mark.django_db(databases=["lb09"])]

JANA = "session-of-jana-visitor-01"
SAMPLE = "monday-roasting-plan"


class Rig:
    """The pipeline on fakes for the sample meeting, and the store its audio waits in."""

    def __init__(self, tmp_path: Path, fails: bool = False) -> None:
        """Script the model from the golden set and the transcriber from the script."""
        golden, scripts, manifest = read_golden_set(), read_scripts(), read_manifest()
        case, script = golden.case(SAMPLE), scripts[SAMPLE]
        self.chat = FakeChat(
            replies={"lb-fast": [oracle_label_reply(case, script)], "lb-tools": [oracle_extract_reply(case)]}
        )
        self.transcriber = StubTranscriber(
            segments=script_transcript_segments(script, manifest.spans(SAMPLE)), fails=fails
        )
        self.store = AudioStore(tmp_path / "audio")
        self.pipeline, self.spans = build_pipeline(self.chat, self.store, self.transcriber)
        self.stages: list[str] = []
        original = self.pipeline.report

        def report(meeting: Meeting, stage: str, **fields: object) -> None:
            """Keep each stage as it is reported, then report it for real."""
            self.stages.append(stage)
            original(meeting, stage, **fields)

        self.pipeline.report = report

    def meeting(self, audio: bytes | None = None, mode: str = "fast", sample: str = SAMPLE) -> Meeting:
        """Store the audio (the sample's by default) and make the received meeting, as the API does."""
        name = self.store.save(sample_audio(SAMPLE) if audio is None else audio)
        return Meeting.objects.create(
            session_key=JANA, sample_key=sample, mode=mode, run_id="run-" + "c" * 12, audio_name=name
        )


@pytest.fixture
def rig(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Rig:
    """Give the worker the rig's pipeline."""
    built = Rig(tmp_path)
    monkeypatch.setattr(tasks, "worker_pipeline", lambda: built.pipeline)
    return built


def test_a_meeting_runs_through_every_stage_and_its_audio_is_deleted_on_success(rig: Rig) -> None:
    """The sample is decoded, heard, labelled, extracted and aligned; the rows are saved; the file is gone."""
    meeting = rig.meeting()
    name = meeting.audio_name
    tasks.run_meeting(meeting.pk)
    meeting.refresh_from_db()
    assert (meeting.status, meeting.stage, meeting.failure) == ("done", "done", "")
    assert rig.stages == ["decoding", "transcribing", "labelling", "extracting", "aligning", "done"]
    assert 40 < meeting.duration_seconds < 42
    assert (meeting.transcriber, meeting.heard_language, meeting.model_calls, meeting.dropped_items) == (
        "test/stt",
        "en",
        2,
        0,
    )
    assert meeting.audio_name == ""
    assert not rig.store.path_of(name).exists()
    assert Segment.objects.filter(meeting=meeting).count() == 10
    items = list(Item.objects.filter(meeting=meeting))
    assert [item.kind for item in items] == ["decision", "decision", "action", "action", "action"]
    assert items[2].owner == "Peter"
    assert items[2].deadline == "Wednesday"
    # The re-profiling is asked in turn 5 of the committed audio (24.2 s to 28.3 s), and the span says so.
    assert 24 < items[3].start < 25
    assert 28 < items[3].end < 29
    # The transcriber was handed 16 kHz PCM of the decoded length, and a run of LB-09 was traced.
    assert abs(rig.transcriber.heard[0][0] / 32_000 - meeting.duration_seconds) < 0.01
    assert rig.spans.names() == [
        "decode audio",
        "transcribe",
        "label speakers",
        "extract items",
        "align evidence",
        "meeting recording",
    ]
    root = rig.spans.named("meeting recording")
    assert root.attrs["status"] == "done"
    assert root.attrs["items"] == 5
    assert all(run is not None and run.system == "lb-09" and run.data_class == "synthetic" for run in rig.chat.runs)


def test_a_visitors_own_meeting_runs_as_visitor_data(rig: Rig) -> None:
    """A recording that isn't a sample runs on the visitor's session, so their quotas apply at the gateway."""
    meeting = rig.meeting(sample="")
    tasks.run_meeting(meeting.pk)
    assert all(run is not None and run.data_class == "visitor" and run.session == JANA for run in rig.chat.runs)


def test_a_meeting_whose_transcriber_fails_is_marked_failed_and_its_audio_is_deleted(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Failure deletes the file as surely as success does."""
    rig = Rig(tmp_path, fails=True)
    monkeypatch.setattr(tasks, "worker_pipeline", lambda: rig.pipeline)
    meeting = rig.meeting()
    name = meeting.audio_name
    tasks.run_meeting(meeting.pk)
    meeting.refresh_from_db()
    assert (meeting.status, meeting.stage, meeting.failure, meeting.audio_name) == (
        "failed",
        "failed",
        "transcriber",
        "",
    )
    assert not rig.store.path_of(name).exists()
    assert rig.spans.named("meeting recording").attrs["reason"] == "transcriber"
    assert Segment.objects.filter(meeting=meeting).count() == 0


def test_audio_that_cannot_be_decoded_fails_the_meeting_and_is_deleted(rig: Rig) -> None:
    """Bytes with an audio container's first bytes and nothing decodable behind them."""
    meeting = rig.meeting(audio=b"OggS" + bytes(range(256)) * 4)
    name = meeting.audio_name
    tasks.run_meeting(meeting.pk)
    meeting.refresh_from_db()
    assert (meeting.status, meeting.failure) == ("failed", "undecodable")
    assert not rig.store.path_of(name).exists()
    assert rig.stages == ["decoding", "failed"]


def test_a_recording_over_a_minute_fails_as_too_long(rig: Rig) -> None:
    """The decoded length, not the header, is what refuses it."""
    meeting = rig.meeting(audio=wav_from_pcm(bytes(65 * 32_000)))
    tasks.run_meeting(meeting.pk)
    meeting.refresh_from_db()
    assert (meeting.status, meeting.failure) == ("failed", "too_long")


def test_a_meeting_whose_audio_is_already_gone_fails_cleanly(rig: Rig) -> None:
    """A file removed before the worker got to it is a failure with its own reason, not a crash."""
    meeting = rig.meeting()
    rig.store.delete(meeting.audio_name)
    tasks.run_meeting(meeting.pk)
    meeting.refresh_from_db()
    assert (meeting.status, meeting.failure) == ("failed", "audio_gone")


def test_a_model_that_cannot_be_repaired_fails_the_meeting_as_a_model_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Two bad answers from the labeller end the meeting with the `model` reason, after the audio is gone."""
    rig = Rig(tmp_path)
    rig.chat.replies["lb-fast"] = ["nope", "nope again"]
    monkeypatch.setattr(tasks, "worker_pipeline", lambda: rig.pipeline)
    meeting = rig.meeting()
    name = meeting.audio_name
    tasks.run_meeting(meeting.pk)
    meeting.refresh_from_db()
    assert (meeting.status, meeting.failure) == ("failed", "model")
    assert not rig.store.path_of(name).exists()


def test_a_crash_nobody_planned_for_fails_the_meeting_and_leaves_no_audio(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unexpected error in a step is caught by the task, which marks the meeting failed and removes the file."""

    def explode(*args: object, **kwargs: object) -> None:
        """Fail as a bug would."""
        raise RuntimeError("a bug")

    monkeypatch.setattr(MeetingPipeline, "decode", explode)
    meeting = rig.meeting()
    name = meeting.audio_name
    tasks.run_meeting(meeting.pk)
    meeting.refresh_from_db()
    assert (meeting.status, meeting.failure) == ("failed", "pipeline_error")
    assert not rig.store.path_of(name).exists()


def test_a_meeting_runs_once_however_often_its_message_is_delivered(rig: Rig) -> None:
    """The second delivery finds the meeting claimed and does nothing; a done meeting is not run again either."""
    meeting = rig.meeting()
    tasks.run_meeting(meeting.pk)
    tasks.run_meeting(meeting.pk)
    assert len(rig.chat.requests) == 2
    assert tasks.claim_meeting(meeting.pk) is None
    assert tasks.claim_meeting(meeting.pk + 1_000) is None


def test_the_sweep_deletes_expired_meetings_gives_up_on_lost_ones_and_removes_old_audio(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An expired meeting goes with its rows; a stale one is failed and its audio removed; a forgotten file goes too."""
    monkeypatch.setattr(tasks, "AudioStore", lambda: rig.store)
    now = timezone.now()
    expired = rig.meeting()
    Meeting.objects.filter(pk=expired.pk).update(expires_at=now, status="done", stage="done")
    stale = rig.meeting()
    Meeting.objects.filter(pk=stale.pk).update(
        status="processing", stage="transcribing", updated_at=now - timedelta(minutes=15)
    )
    fresh = rig.meeting()
    forgotten = rig.store.folder / "forgottenforgottenforgot.audio"
    forgotten.write_bytes(b"x")
    long_ago = time.time() - 7_200
    os.utime(forgotten, (long_ago, long_ago))
    counts = tasks.sweep()
    assert counts == {"expired": 1, "stale": 1, "audio": 1}
    assert not Meeting.objects.filter(pk=expired.pk).exists()
    stale.refresh_from_db()
    assert (stale.status, stale.failure, stale.audio_name) == ("failed", "stale", "")
    assert not forgotten.exists()
    fresh.refresh_from_db()
    assert fresh.status == "received"
    assert rig.store.path_of(fresh.audio_name).exists()


def test_the_worker_pipeline_is_built_once(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """`worker_pipeline` connects once per process."""
    built: list[int] = []

    def connect(store: AudioStore | None = None) -> MeetingPipeline:  # noqa: ARG001 - the real function's signature
        """Count the connections."""
        built.append(1)
        pipeline, _ = build_pipeline(FakeChat(replies={}), AudioStore(tmp_path))
        return pipeline

    monkeypatch.setattr(tasks, "connect_pipeline", connect)
    tasks.worker_pipeline.cache_clear()
    assert tasks.worker_pipeline() is tasks.worker_pipeline()
    assert built == [1]
    tasks.worker_pipeline.cache_clear()
    assert isinstance(MemorySpanWriter(), MemorySpanWriter)
