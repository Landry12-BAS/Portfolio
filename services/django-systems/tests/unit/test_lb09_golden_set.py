"""Offline tests for LB-09's golden set: it follows its rules and agrees with the scripts it points at.

The golden set grades the pipeline, so a mistake in it would pass a wrong answer or fail a right one. These
checks keep every reference real (every turn, quote, name and deadline is in the script that says it), keep the
set honest about what it covers, and prove that a golden set that drifts from its scripts is caught. Nothing
here needs a database or a model.
"""

from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest
import yaml
from django.conf import settings
from lb09.golden import (
    GoldenSet,
    check_against_scripts,
    expected_labels,
    introduces_themselves,
    read_golden_set,
)
from lb09.scripts import Script, read_scripts

from core.data_files import DataFileError, read_data_file


@pytest.fixture(scope="module")
def golden() -> GoldenSet:
    """Read the golden set once for the module."""
    return read_golden_set()


@pytest.fixture(scope="module")
def scripts() -> dict[str, Script]:
    """Read the scripted meetings once for the module."""
    return read_scripts()


@pytest.fixture
def raw() -> dict[str, Any]:
    """Return the golden file as a plain dict, for a test to break one field of."""
    content: dict[str, Any] = yaml.safe_load((settings.EVALS_DIR / "lb09" / "golden.yaml").read_text(encoding="utf-8"))
    return deepcopy(content)


def problems_of(raw: dict[str, Any], scripts: dict[str, Script], tmp_path: Path) -> list[str]:
    """Write a changed golden set, read it back with the strict reader, and say how it disagrees with the scripts."""
    path = tmp_path / "golden.yaml"
    path.write_text(yaml.safe_dump(raw), encoding="utf-8")
    return check_against_scripts(read_data_file(path, GoldenSet), scripts)


def test_the_set_covers_every_scripted_meeting_once(golden: GoldenSet, scripts: dict[str, Script]) -> None:
    """Six cases, one for each meeting, with the Monday roasting plan the first sample."""
    assert [case.meeting for case in golden.cases] == [
        "monday-roasting-plan",
        "quarterly-check-in",
        "weekend-staffing",
        "newsletter-draft",
        "tasting-notes-overlap",
        "grinder-repair",
    ]
    assert {case.meeting for case in golden.cases} == set(scripts)
    assert golden.samples()[0].id == "monday-roasting-plan"


def test_the_golden_set_and_the_scripts_agree(golden: GoldenSet, scripts: dict[str, Script]) -> None:
    """Every turn named exists, every quote and match word is in the turns it is said in, and every name is real."""
    assert check_against_scripts(golden, scripts) == []


def test_the_set_plants_each_kind_of_trap_the_task_asks_for(golden: GoldenSet, scripts: dict[str, Script]) -> None:
    """A meeting with no actions, a joke, a hostile line, overlapping talk, and an owner nobody takes."""
    by_id = {case.id: case for case in golden.cases}
    assert by_id["quarterly-check-in"].expect.actions == []
    assert by_id["quarterly-check-in"].expect.decisions
    assert [rule.contains for rule in by_id["weekend-staffing"].expect.forbidden] == [["campfire"]]
    assert ["email", "everyone"] in [rule.contains for rule in by_id["newsletter-draft"].expect.forbidden]
    assert any(turn.overlap for turn in scripts["tasting-notes-overlap"].turns)
    assert by_id["tasting-notes-overlap"].grade_labels is False
    assert by_id["grinder-repair"].expect.actions[0].owner is None
    assert by_id["grinder-repair"].expect.forbidden


def test_the_monday_meeting_has_decisions_and_actions_with_owners_and_deadlines(golden: GoldenSet) -> None:
    """The sample meeting is the one with the full story: two decisions, three actions, each owned and dated."""
    monday = golden.case("monday-roasting-plan").expect

    assert len(monday.decisions) == 2
    assert [(action.owner, action.deadline) for action in monday.actions] == [
        (["Peter"], "Wednesday"),
        (["Kevin", "Speaker 1"], "Sunday"),
        (["David"], "Friday"),
    ]


def test_only_speakers_who_say_their_name_are_called_by_it(golden: GoldenSet, scripts: dict[str, Script]) -> None:
    """Hannah, Peter and David introduce themselves in the sample; Kevin is only addressed, so he is a number."""
    case = golden.case("monday-roasting-plan")

    assert expected_labels(case, scripts[case.meeting]) == {
        "hannah": "Hannah",
        "peter": "Peter",
        "david": "David",
        "kevin": "Speaker 1",
    }
    quarterly = golden.case("quarterly-check-in")
    assert expected_labels(quarterly, scripts[quarterly.meeting]) == {
        "hannah": "Speaker 1",
        "peter": "Speaker 2",
        "david": "Speaker 3",
    }


@pytest.mark.parametrize(
    ("text", "name", "introduces"),
    [
        ("Good morning everyone, this is Hannah.", "Hannah", True),
        ("I'm David, I run packaging.", "David", True),
        ("I\u2019m David, I run packaging.", "David", True),
        ("Peter here. The beans arrived.", "Peter", True),
        ("My name is Kevin.", "Kevin", True),
        ("Kevin, can you re-profile the Colombian?", "Kevin", False),
        ("Thanks David. Then the tasting stays.", "David", False),
        ("Peter, who are you talking to?", "Peter", False),
        ("Tell Hannah about it.", "Hannah", False),
    ],
)
def test_saying_your_name_is_told_from_being_addressed(text: str, name: str, introduces: bool) -> None:
    """A label may be a name only for someone who gives their own: addressing a person does not name a voice."""
    assert introduces_themselves(text, name) is introduces


def test_a_quote_that_is_not_in_the_turns_it_is_said_in_is_caught(
    raw: dict[str, Any], scripts: dict[str, Script], tmp_path: Path
) -> None:
    """The set cannot say a turn holds words it does not."""
    raw["cases"][0]["expect"]["decisions"][0]["quote"] = "We roast the Brazilian first on Monday."

    assert problems_of(raw, scripts, tmp_path) == [
        "monday-roasting-plan/colombian-first-monday: the quote is not in the turns it is said in"
    ]


def test_a_turn_the_script_does_not_have_is_caught(
    raw: dict[str, Any], scripts: dict[str, Script], tmp_path: Path
) -> None:
    """A turn number past the end of the meeting is a mistake, not an item nobody said."""
    raw["cases"][0]["expect"]["decisions"][0]["said_in"] = [42]

    assert problems_of(raw, scripts, tmp_path) == [
        "monday-roasting-plan/colombian-first-monday: said_in names a turn the script does not have"
    ]


def test_a_match_word_that_is_not_said_is_caught(
    raw: dict[str, Any], scripts: dict[str, Script], tmp_path: Path
) -> None:
    """An item cannot be paired by a word its turns never say."""
    raw["cases"][0]["expect"]["decisions"][0]["match"] = ["colombian", "brazilian"]

    assert problems_of(raw, scripts, tmp_path) == [
        "monday-roasting-plan/colombian-first-monday: the turns it is said in do not hold every match word",
        "monday-roasting-plan/colombian-first-monday: the summary does not hold every match word",
    ]


def test_a_deadline_or_owner_that_is_not_in_the_meeting_is_caught(
    raw: dict[str, Any], scripts: dict[str, Script], tmp_path: Path
) -> None:
    """The golden set cannot expect a day nobody named, or a person nobody mentions or speaks as."""
    action = raw["cases"][0]["expect"]["actions"][0]
    action["deadline"] = "Thursday"
    action["owner"] = "Zdenek"

    assert problems_of(raw, scripts, tmp_path) == [
        "monday-roasting-plan/order-bags: the deadline 'Thursday' is not said near the action",
        "monday-roasting-plan/order-bags: none of the owners ['Zdenek'] is named, or speaks, near the action",
    ]


def test_a_cast_that_disagrees_with_who_says_their_name_is_caught(
    raw: dict[str, Any], scripts: dict[str, Script], tmp_path: Path
) -> None:
    """Naming Kevin as introduced, or leaving Hannah out, is a disagreement with what the script says."""
    raw["cases"][0]["expect"]["introduced"] = ["hannah", "peter", "kevin"]

    # David's action is also no longer his to own: with him unnamed, no turn near it names or labels him "David".
    assert problems_of(raw, scripts, tmp_path) == [
        "monday-roasting-plan: david says their own name but is not in introduced",
        "monday-roasting-plan: kevin is in introduced but never says their own name",
        "monday-roasting-plan/update-label-template: none of the owners ['David'] is named, or speaks, near the action",
    ]


def test_a_forbidden_rule_that_guards_against_nothing_is_caught(
    raw: dict[str, Any], scripts: dict[str, Script], tmp_path: Path
) -> None:
    """A trap the script does not plant is a rule that can never fire."""
    raw["cases"][2]["expect"]["forbidden"][0]["contains"] = ["bonfire"]

    assert problems_of(raw, scripts, tmp_path) == [
        "weekend-staffing: no script turn holds bonfire, so campfire-joke guards against nothing"
    ]


def test_a_script_without_a_case_or_a_case_without_a_script_is_caught(
    raw: dict[str, Any], scripts: dict[str, Script], tmp_path: Path
) -> None:
    """Both directions: every meeting is graded, and every case has its meeting."""
    raw["cases"][1]["meeting"] = "no-such-meeting"

    assert problems_of(raw, scripts, tmp_path) == [
        "the script quarterly-check-in has no case in the golden set",
        "quarterly-check-in: there is no script called no-such-meeting",
    ]


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda g: g["cases"][0]["expect"]["decisions"][0].update(extra="field"), "extra"),
        (lambda g: g["cases"][0]["expect"]["decisions"][0].update(match=["Two words"]), "pattern"),
        (lambda g: g["cases"][0]["expect"]["decisions"][0].update(said_in=[2, 2]), "once"),
        (lambda g: g["cases"][0]["expect"]["decisions"][0].update(said_in=[]), "at least 1"),
        (lambda g: g["cases"][1].update(id=g["cases"][0]["id"]), "used more than once"),
        (lambda g: g["cases"][1].update(meeting=g["cases"][0]["meeting"]), "used more than once"),
        (lambda g: g["gate"].update(recall=1.5), "less than or equal to 1"),
        (lambda g: [case.update(sample=False) for case in g["cases"]], "curated sample"),
        (lambda g: g["cases"].pop(), "at least 6"),
    ],
)
def test_the_strict_reader_refuses_a_set_that_breaks_a_rule(
    raw: dict[str, Any], tmp_path: Path, change: Any, message: str
) -> None:
    """An unknown field, an odd match word, a repeated turn, a repeated case or an unreachable gate all stop it."""
    change(raw)
    path = tmp_path / "golden.yaml"
    path.write_text(yaml.safe_dump(raw), encoding="utf-8")

    with pytest.raises(DataFileError, match=message):
        read_data_file(path, GoldenSet)
