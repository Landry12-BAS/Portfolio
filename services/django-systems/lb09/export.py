"""The exports of a meeting: JSON for a program, CSV for a spreadsheet, and plain English for LB-08's board.

The text export is written so a visitor can paste it into Automation Studio (LB-08) as the description of a
process to automate: one sentence a decision, one an action with its owner and deadline. Every export is made
from the rows, in code, and says that the speaker labels were inferred from the words, not matched to voices.
"""

import csv
import io
import json
from collections.abc import Sequence

from lb09.models import Item, Meeting, Segment

# What every export says about the labels.
LABELS_NOTE = "Speaker labels are inferred from the words, not matched to voices."


def item_record(item: Item) -> dict[str, object]:
    """Describe one item as plain values."""
    return {
        "kind": item.kind,
        "text": item.text,
        "owner": item.owner or None,
        "deadline": item.deadline or None,
        "evidence": item.evidence,
        "start": item.start,
        "end": item.end,
    }


def segment_record(segment: Segment) -> dict[str, object]:
    """Describe one segment as plain values."""
    return {"start": segment.start, "end": segment.end, "speaker": segment.label, "text": segment.text}


def as_json(meeting: Meeting, segments: Sequence[Segment], items: Sequence[Item]) -> str:
    """Write the meeting, its transcript and its items as one JSON document."""
    document = {
        "meeting": {
            "id": meeting.public_id,
            "mode": meeting.mode,
            "duration_seconds": meeting.duration_seconds,
            "transcriber": meeting.transcriber,
            "labels_note": LABELS_NOTE,
        },
        "items": [item_record(item) for item in items],
        "transcript": [segment_record(segment) for segment in segments],
    }
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def as_csv(items: Sequence[Item]) -> str:
    """Write the items as CSV, one row an item, with a header."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(["kind", "text", "owner", "deadline", "start_seconds", "end_seconds", "evidence"])
    for item in items:
        writer.writerow([item.kind, item.text, item.owner, item.deadline, item.start, item.end, item.evidence])
    return buffer.getvalue()


def action_sentence(item: Item) -> str:
    """Say an action as a sentence: who does what, and by when, as far as the meeting said."""
    owner = item.owner or "Someone still to be named"
    deadline = f" by {item.deadline}" if item.deadline else ""
    return f"{owner}: {item.text}{deadline}."


def as_text(items: Sequence[Item]) -> str:
    """Write the follow-up as the description of a process, for Automation Studio (LB-08) to turn into a workflow."""
    decisions = [item for item in items if item.kind == Item.Kind.DECISION]
    actions = [item for item in items if item.kind == Item.Kind.ACTION]
    lines = ["When the minutes of this meeting are approved, follow up on them."]
    if decisions:
        lines.append("Post these decisions to the team channel: " + " ".join(f"{d.text}." for d in decisions))
    if actions:
        lines.append("Send each owner a reminder of their action item, and a second one the day before its deadline:")
        lines += [f"- {action_sentence(action)}" for action in actions]
    else:
        lines.append("There are no action items to remind anyone of.")
    lines.append(f"({LABELS_NOTE})")
    return "\n".join(lines) + "\n"
