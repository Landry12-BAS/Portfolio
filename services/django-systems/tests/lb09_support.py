"""Helpers LB-09's tests share: scripted meetings as transcripts, and a scripted extractor built from the golden set.

An oracle is what a perfectly careful pipeline would find: the labels the golden set expects, and every expected
item with the quote it names and the time span of the turns it is said in. The grader must give it a clean sheet,
and every flaw the tests plant in it must be caught by the check that names it.
"""

from dataclasses import replace

from lb09.golden import ExpectedAction, ExpectedItem, GoldenCase, expected_labels
from lb09.results import FoundItem, ItemKind, LabelledSegment, MeetingResult
from lb09.scripts import Script
from lb09.timeline import TurnSpan


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
