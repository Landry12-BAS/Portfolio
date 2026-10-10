"""Grading LB-09's analysis of a meeting on the golden set, by rules alone.

Each golden case is a scripted meeting. The pipeline reads its transcript, labels the speakers, extracts the
decisions and actions and works out where each was said; the result is graded on what evals/lb09/golden.yaml
expects (lb09/golden.py says how each field is read): which items were found, whether their owner and deadline
are right, whether their evidence is really in the transcript, whether their time span is inside the turns they
are said in, whether any forbidden text got through, and whether the speaker labels are right.

A live eval costs the gateway's two chat calls a case (one for the labels, one for the items), plus a repair when
an answer does not validate, so run it when prompts or routes change, not on every commit.
"""

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field

from lb09.golden import ExpectedAction, ExpectedItem, GoldenCase, GoldenSet, expected_labels
from lb09.results import FoundItem, ItemKind, LabelledSegment, MeetingResult
from lb09.scripts import Script
from lb09.textnorm import fold, has_all_words
from lb09.timeline import TurnSpan

# How far outside the turns an item is said in its span may reach: a speech engine's pause, or a transcriber's rounding.
SPAN_TOLERANCE_SECONDS = 1.0
# What a label for a speaker nobody named looks like.
GENERIC_LABEL = re.compile(r"^Speaker \d+$")


@dataclass
class CaseGrade:
    """One case's grade: what was expected, what was found, and every check that failed, each as a sentence."""

    case_id: str
    expected: int = 0
    extracted: int = 0
    matched: int = 0
    owners_checked: int = 0
    owners_right: int = 0
    deadlines_checked: int = 0
    deadlines_right: int = 0
    spans_checked: int = 0
    spans_right: int = 0
    evidence_checked: int = 0
    evidence_found: int = 0
    labels_checked: int = 0
    labels_right: int = 0
    forbidden_hits: list[str] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        """Tell whether the case broke no hard rule: nothing forbidden got through, every quote is in the transcript."""
        return not self.forbidden_hits and self.evidence_found == self.evidence_checked


def ratio(right: int, checked: int) -> float:
    """Return the share that is right; a check that had nothing to check is not failed."""
    return right / checked if checked else 1.0


@dataclass(frozen=True)
class EvalReport:
    """The grades of one eval run, and the share of each check they add up to."""

    grades: list[CaseGrade]

    def total(self, name: str) -> int:
        """Add up one counter over every case."""
        return sum(getattr(grade, name) for grade in self.grades)

    @property
    def recall(self) -> float:
        """The share of expected items that were found."""
        return ratio(self.total("matched"), self.total("expected"))

    @property
    def precision(self) -> float:
        """The share of extracted items that were expected."""
        return ratio(self.total("matched"), self.total("extracted"))

    @property
    def owner(self) -> float:
        """The share of found actions whose owner was right."""
        return ratio(self.total("owners_right"), self.total("owners_checked"))

    @property
    def deadline(self) -> float:
        """The share of found actions whose deadline was right."""
        return ratio(self.total("deadlines_right"), self.total("deadlines_checked"))

    @property
    def span(self) -> float:
        """The share of found items whose time span is inside the turns they are said in."""
        return ratio(self.total("spans_right"), self.total("spans_checked"))

    @property
    def labels(self) -> float:
        """The share of speaker-label checks that were right."""
        return ratio(self.total("labels_right"), self.total("labels_checked"))

    @property
    def evidence(self) -> float:
        """The share of extracted items whose quote is in the transcript."""
        return ratio(self.total("evidence_found"), self.total("evidence_checked"))

    def forbidden_hits(self) -> list[str]:
        """List every forbidden rule an item broke, with its case."""
        return [f"{grade.case_id}: {rule}" for grade in self.grades for rule in grade.forbidden_hits]

    def failures(self, gate: GoldenSet) -> list[str]:
        """List what stops the run from passing: each check under its gate, and every hard rule broken."""
        scores = {
            "recall": self.recall,
            "precision": self.precision,
            "owner": self.owner,
            "deadline": self.deadline,
            "span": self.span,
            "labels": self.labels,
        }
        failing = [
            f"{name} {score:.2f} is under the gate of {getattr(gate.gate, name):.2f}"
            for name, score in scores.items()
            if score < getattr(gate.gate, name)
        ]
        failing += [f"forbidden: {hit}" for hit in self.forbidden_hits()]
        if self.evidence < 1.0:
            failing.append(f"evidence {self.evidence:.2f}: an item's quote is not in the transcript")
        return failing


def haystack(item: FoundItem) -> str:
    """Return the words an item is judged by for forbidden text: what it says and what it quotes."""
    return f"{item.text} {item.evidence}"


def find_match(expected: ExpectedItem, kind: ItemKind, items: list[FoundItem], taken: set[int]) -> int | None:
    """Return the index of the first unclaimed extracted item of this kind that holds every match word, or None."""
    for index, item in enumerate(items):
        if index not in taken and item.kind == kind and has_all_words(item.text, list(expected.match)):
            return index
    return None


def owner_is_right(expected: ExpectedAction, found: FoundItem) -> bool:
    """Check an action's owner: one of the accepted names, or empty where the meeting gave the job to nobody."""
    if expected.owner is None:
        return found.owner is None
    return found.owner is not None and any(fold(name) in fold(found.owner) for name in expected.owner)


def deadline_is_right(expected: ExpectedAction, found: FoundItem) -> bool:
    """Check an action's deadline: it holds the expected word, or is empty where the meeting named no day."""
    if expected.deadline is None:
        return found.deadline is None
    return found.deadline is not None and fold(expected.deadline) in fold(found.deadline)


def span_is_right(expected: ExpectedItem, found: FoundItem, turns: list[TurnSpan]) -> bool:
    """Check that an item's time span lies inside the turns it is said in, give or take a second."""
    said = [turns[turn] for turn in expected.said_in]
    earliest = min(span.start for span in said) - SPAN_TOLERANCE_SECONDS
    latest = max(span.end for span in said) + SPAN_TOLERANCE_SECONDS
    return found.start >= earliest and found.end <= latest


def grade_items(case: GoldenCase, result: MeetingResult, turns: list[TurnSpan], grade: CaseGrade) -> None:
    """Pair every expected item with an extracted one and grade what each states, counting the rest as extras."""
    taken: set[int] = set()
    grade.expected = len(case.items())
    grade.extracted = len(result.items)
    expected_by_kind: list[tuple[ItemKind, ExpectedItem]] = [
        *(("decision", item) for item in case.expect.decisions),
        *(("action", item) for item in case.expect.actions),
    ]
    for kind, expected in expected_by_kind:
        index = find_match(expected, kind, result.items, taken)
        if index is None:
            grade.problems.append(f"missing {kind} {expected.id}")
            continue
        taken.add(index)
        grade.matched += 1
        found = result.items[index]
        grade.spans_checked += 1
        grade.spans_right += span_is_right(expected, found, turns)
        if not span_is_right(expected, found, turns):
            grade.problems.append(f"{expected.id}: the span {found.start:.1f}-{found.end:.1f} is outside its turns")
        if isinstance(expected, ExpectedAction):
            grade_action(expected, found, grade)
    grade.problems += [
        f"extra {item.kind}: {item.text}" for index, item in enumerate(result.items) if index not in taken
    ]


def grade_action(expected: ExpectedAction, found: FoundItem, grade: CaseGrade) -> None:
    """Grade a found action's owner and deadline against the expected ones."""
    grade.owners_checked += 1
    grade.owners_right += owner_is_right(expected, found)
    if not owner_is_right(expected, found):
        grade.problems.append(f"{expected.id}: the owner is {found.owner!r}, not {expected.owner}")
    grade.deadlines_checked += 1
    grade.deadlines_right += deadline_is_right(expected, found)
    if not deadline_is_right(expected, found):
        grade.problems.append(f"{expected.id}: the deadline is {found.deadline!r}, not {expected.deadline!r}")


def grade_evidence(result: MeetingResult, grade: CaseGrade) -> None:
    """Check again, apart from the pipeline, that every item's quote is in the transcript it was found in."""
    transcript = fold(" ".join(segment.text for segment in result.segments))
    for item in result.items:
        grade.evidence_checked += 1
        if fold(item.evidence) in transcript:
            grade.evidence_found += 1
        else:
            grade.problems.append(f"the quote for {item.text!r} is not in the transcript")


def grade_forbidden(case: GoldenCase, result: MeetingResult, grade: CaseGrade) -> None:
    """Record every extracted item that holds text the golden set forbids."""
    for rule in case.expect.forbidden:
        for item in result.items:
            words = haystack(item)
            if has_all_words(words, list(rule.contains)) and not any(
                has_all_words(words, [word]) for word in rule.unless
            ):
                grade.forbidden_hits.append(f"{rule.id} ({item.text})")


def segment_for_turn(span: TurnSpan, segments: list[LabelledSegment]) -> LabelledSegment | None:
    """Return the segment that overlaps a turn the most, or None when none overlaps it at all."""
    best: LabelledSegment | None = None
    best_overlap = 0.0
    for segment in segments:
        overlap = min(span.end, segment.end) - max(span.start, segment.start)
        if overlap > best_overlap:
            best, best_overlap = segment, overlap
    return best


def grade_labels(
    case: GoldenCase, script: Script, result: MeetingResult, turns: list[TurnSpan], grade: CaseGrade
) -> None:
    """Grade the speaker labels turn by turn: who may be named, and that a voice always gets one label."""
    if not case.grade_labels:
        return
    wanted = expected_labels(case, script)
    heard = [segment_for_turn(span, result.segments) for span in turns]
    labels = [segment.label if segment else None for segment in heard]
    for turn, label in zip(script.turns, labels, strict=True):
        grade.labels_checked += 1
        right = label is not None and (
            fold(label) == fold(wanted[turn.speaker])
            if turn.speaker in case.expect.introduced
            else bool(GENERIC_LABEL.match(label))
        )
        grade.labels_right += right
        if not right:
            grade.problems.append(f"{turn.speaker} is labelled {label!r}, not {wanted[turn.speaker]!r}")
    # Every pair of turns: the same voice has the same label, and two voices never share one.
    for first in range(len(labels)):
        for second in range(first + 1, len(labels)):
            same_voice = script.turns[first].speaker == script.turns[second].speaker
            grade.labels_checked += 1
            grade.labels_right += labels[first] is not None and (labels[first] == labels[second]) == same_voice


def grade_case(case: GoldenCase, script: Script, result: MeetingResult, turns: list[TurnSpan]) -> CaseGrade:
    """Grade one meeting's result against its golden case."""
    grade = CaseGrade(case_id=case.id)
    grade_items(case, result, turns, grade)
    grade_evidence(result, grade)
    grade_forbidden(case, result, grade)
    grade_labels(case, script, result, turns, grade)
    return grade


type Analyse = Callable[[Script, list[TurnSpan]], MeetingResult]


def evaluate(
    golden: GoldenSet,
    scripts: dict[str, Script],
    spans_of: Callable[[Script], list[TurnSpan]],
    analyse: Analyse,
    case_ids: Iterable[str] | None = None,
) -> EvalReport:
    """Analyse each golden case's meeting and grade the result: every case, or only those in `case_ids`.

    `spans_of` says when each turn of a script is spoken (the committed audio's timeline, or an estimate), and
    `analyse` turns the script and those times into a result, through the live pipeline in the real eval.
    """
    wanted = set(case_ids) if case_ids is not None else None
    grades: list[CaseGrade] = []
    for case in golden.cases:
        if wanted is not None and case.id not in wanted:
            continue
        script = scripts[case.meeting]
        turns = spans_of(script)
        grades.append(grade_case(case, script, analyse(script, turns), turns))
    return EvalReport(grades=grades)
