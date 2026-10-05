"""Unit tests for the three exports: JSON, CSV and the plain-English follow-up for Automation Studio."""

import csv
import io
import json

from lb09.export import LABELS_NOTE, as_csv, as_json, as_text
from lb09.models import Item, Meeting, Segment

MEETING = Meeting(public_id="meeting-0123456789ab", mode="fast", duration_seconds=41.1, transcriber="lb-stt")
SEGMENTS = [Segment(position=0, start=0.3, end=4.3, text="This is Hannah.", speaker=0, label="Hannah")]
ITEMS = [
    Item(
        position=0,
        kind="decision",
        text="Roast the Colombian first",
        owner="",
        deadline="",
        evidence="Then we roast.",
        start=11.3,
        end=14.9,
        first_segment=2,
        last_segment=2,
    ),
    Item(
        position=1,
        kind="action",
        text="Order bags",
        owner="Peter",
        deadline="Wednesday",
        evidence="I will order.",
        start=20.1,
        end=23.8,
        first_segment=4,
        last_segment=4,
    ),
    Item(
        position=2,
        kind="action",
        text="Fix the grinder",
        owner="",
        deadline="",
        evidence="Someone should fix it.",
        start=30.0,
        end=31.0,
        first_segment=5,
        last_segment=5,
    ),
]


def test_json_holds_the_meeting_its_items_and_its_transcript_with_the_labels_note() -> None:
    """A program gets everything, with nulls where the meeting said nothing, and the note about the labels."""
    document = json.loads(as_json(MEETING, SEGMENTS, ITEMS))
    assert document["meeting"] == {
        "id": "meeting-0123456789ab",
        "mode": "fast",
        "duration_seconds": 41.1,
        "transcriber": "lb-stt",
        "labels_note": LABELS_NOTE,
    }
    assert document["items"][1] == {
        "kind": "action",
        "text": "Order bags",
        "owner": "Peter",
        "deadline": "Wednesday",
        "evidence": "I will order.",
        "start": 20.1,
        "end": 23.8,
    }
    assert document["items"][0]["owner"] is None
    assert document["transcript"] == [{"start": 0.3, "end": 4.3, "speaker": "Hannah", "text": "This is Hannah."}]


def test_csv_has_a_header_and_one_row_an_item() -> None:
    """A spreadsheet reads the header and the rows; a quote with a comma stays in its cell."""
    rows = list(csv.reader(io.StringIO(as_csv(ITEMS))))
    assert rows[0] == ["kind", "text", "owner", "deadline", "start_seconds", "end_seconds", "evidence"]
    assert rows[2] == ["action", "Order bags", "Peter", "Wednesday", "20.1", "23.8", "I will order."]
    assert len(rows) == 4


def test_a_csv_cell_that_begins_like_a_formula_is_written_as_text() -> None:
    """Model output and spoken words that begin with =, +, - or @ (full-width too) open in a spreadsheet as text."""
    full_width_equals = chr(0xFF1D)
    hostile = Item(
        position=0,
        kind="action",
        text='=HYPERLINK("http://evil.example/x","Click")',
        owner="=Peter",
        deadline="+1 day",
        evidence="@SUM(A1:A9) I will order the beans by Friday.",
        start=1.0,
        end=2.0,
        first_segment=0,
        last_segment=0,
    )
    wide = Item(
        position=1,
        kind="decision",
        text=f"{full_width_equals}1+1",
        owner="",
        deadline="",
        evidence="-2 boxes, we agreed.",
        start=3.0,
        end=4.0,
        first_segment=1,
        last_segment=1,
    )
    rows = list(csv.reader(io.StringIO(as_csv([hostile, wide]))))
    assert rows[1] == [
        "action",
        '\'=HYPERLINK("http://evil.example/x","Click")',
        "'=Peter",
        "'+1 day",
        "1.0",
        "2.0",
        "'@SUM(A1:A9) I will order the beans by Friday.",
    ]
    assert rows[2][1] == f"'{full_width_equals}1+1"
    assert rows[2][6] == "'-2 boxes, we agreed."
    assert (rows[2][2], rows[2][3]) == ("", "")


def test_the_text_export_describes_the_follow_up_as_a_process_for_lb_08() -> None:
    """One sentence a decision, one an action with its owner and deadline, and a name for an action nobody took."""
    text = as_text(ITEMS)
    assert text.startswith("When the minutes of this meeting are approved, follow up on them.")
    assert "Post these decisions to the team channel: Roast the Colombian first." in text
    assert "- Peter: Order bags by Wednesday." in text
    assert "- Someone still to be named: Fix the grinder." in text
    assert LABELS_NOTE in text


def test_the_text_export_says_when_there_is_nothing_to_remind_anyone_of() -> None:
    """A meeting with decisions only, or nothing at all, still reads as a sentence."""
    assert "There are no action items to remind anyone of." in as_text(ITEMS[:1])
    assert "There are no action items" in as_text([])
