"""Running the golden set through the pipeline's text steps: the live eval's glue, which a fake model can drive too.

A scripted meeting becomes the transcript a transcriber would give for it, one segment to a turn, timed by
the committed audio's manifest (or, without it, the estimate in lb09/timeline.py). The pipeline's labelling,
extraction and alignment run on that transcript as a synthetic run of LB-09, and the result is graded by the
rules in lb09/golden_eval.py. The transcriber itself is left out on purpose: its word error rate is measured
by `just wer-lb09`, which needs audio and a real model.
"""

from collections.abc import Callable

from lb09.golden import GoldenSet
from lb09.golden_eval import Analyse, EvalReport, evaluate
from lb09.pipeline import MeetingPipeline
from lb09.results import MeetingResult
from lb09.scripts import Script
from lb09.timeline import TurnSpan, estimate_turn_spans
from lb09.transcript import Segment
from lb09.tts import Manifest
from lb_common.run import Run, new_run_id, run_scope


def script_transcript(script: Script, spans: list[TurnSpan]) -> list[Segment]:
    """Make the transcript a transcriber would give for a script: one segment to a turn, at the turns' times."""
    return [
        Segment(position=position, start=span.start, end=span.end, text=turn.text)
        for position, (turn, span) in enumerate(zip(script.turns, spans, strict=True))
    ]


def spans_from(manifest: Manifest | None) -> Callable[[Script], list[TurnSpan]]:
    """Return the function that times a script's turns: by the committed audio's manifest, or else estimated."""

    def spans_of(script: Script) -> list[TurnSpan]:
        """Time one script's turns."""
        if manifest is not None and script.key in manifest.meetings:
            return manifest.spans(script.key)
        return estimate_turn_spans(script)

    return spans_of


def analyse_with(pipeline: MeetingPipeline) -> Analyse:
    """Return the function that analyses one script through the pipeline's text steps, as a synthetic run."""

    def analyse(script: Script, spans: list[TurnSpan]) -> MeetingResult:
        """Label, extract and align one script's transcript."""
        run = Run(system="lb-09", run_id=new_run_id(), data_class="synthetic")
        with run_scope(run), pipeline.tracer.span("golden case", kind="system.run", case=script.key):
            return pipeline.analyse(script_transcript(script, spans)).result

    return analyse


def evaluate_pipeline(
    golden: GoldenSet,
    scripts: dict[str, Script],
    pipeline: MeetingPipeline,
    manifest: Manifest | None,
    case_ids: list[str] | None = None,
) -> EvalReport:
    """Run the chosen golden cases through the pipeline's text steps and grade them."""
    return evaluate(golden, scripts, spans_from(manifest), analyse_with(pipeline), case_ids)
