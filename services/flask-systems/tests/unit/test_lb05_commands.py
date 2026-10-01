"""Tests for LB-05's manage.py commands (lb05/commands.py): seeding the data, and grading the pipeline.

The eval is run against a fake model: what is under test is the command (its arguments, its exit statuses, its
report). Putting the golden set to a live model needs a gateway with provider keys, and is not part of any test.
"""

import re
from datetime import date
from pathlib import Path

import pytest

from lb05.commands import DEFAULT_SEED, eval_lb05, seed_lb05, sweep_lb05
from lb05.golden import read_adversarial_set, read_golden_set, reference_sql
from lb05.warehouse import Warehouse
from tests.support import DATA_AS_OF, TODAY, FakeChat, OracleChat, make_environment, make_platform, unavailable

SAMPLE_COUNT = 7


def digest_in(output: str) -> str:
    """Pick the dataset's digest out of what the seed command printed."""
    match = re.search(r"digest ([0-9a-f]{16,})", output)
    assert match is not None, output
    return match.group(1)


def test_seed_writes_the_dataset_and_says_what_it_wrote(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """The command writes Parquet and the DuckDB file, lists the tables with their rows, and the service can open it."""
    target = tmp_path / "data"

    status = seed_lb05(["--size", "tiny", "--today", "2026-11-18", "--data", str(target)], make_platform())

    output = capsys.readouterr().out
    assert status == 0
    assert "Wrote the tiny dataset for 2026-11-18 (seed 5)" in output
    for table in ("customers", "products", "orders", "order_lines", "subscriptions"):
        assert re.search(rf"^\s+{table}\s+[\d,]+$", output, re.MULTILINE), table
    warehouse = Warehouse.open(target, "1GB", 1)
    assert warehouse.meta.as_of == DATA_AS_OF
    assert warehouse.meta.seed == DEFAULT_SEED
    warehouse.close()


def test_the_same_seed_and_day_give_the_same_dataset_and_another_seed_a_different_one(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """The data is deterministic: its digest is the same on every run, and moves with the seed."""
    digests = []
    for name, seed in (("a", "5"), ("b", "5"), ("c", "6")):
        arguments = ["--size", "tiny", "--today", "2026-11-18", "--seed", seed, "--data", str(tmp_path / name)]
        assert seed_lb05(arguments, make_platform()) == 0
        digests.append(digest_in(capsys.readouterr().out))

    assert digests[0] == digests[1]
    assert digests[0] != digests[2]


def test_without_options_the_seed_uses_the_platforms_day_and_the_configured_folder(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """No --today means the platform's today (UTC), and no --data means LB05_WAREHOUSE_DIR."""
    target = tmp_path / "configured"
    platform = make_platform(environment=make_environment(LB05_WAREHOUSE_DIR=str(target)))

    assert seed_lb05(["--size", "tiny"], platform) == 0

    capsys.readouterr()
    warehouse = Warehouse.open(target, "1GB", 1)
    assert warehouse.meta.as_of == TODAY.date() == date(2026, 10, 1)
    warehouse.close()


@pytest.mark.parametrize(
    "arguments",
    [["--size", "huge"], ["--today", "tomorrow"], ["--seed", "x"], ["--unknown"], ["extra"]],
    ids=["size", "day", "seed", "option", "positional"],
)
def test_the_seed_refuses_arguments_it_does_not_know_and_writes_nothing(
    arguments: list[str], tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A mistake is exit status 2 with argparse's usage on standard error, and no files."""
    status = seed_lb05([*arguments, "--data", str(tmp_path / "never")], make_platform())

    assert status == 2
    assert "usage" in capsys.readouterr().err
    assert not (tmp_path / "never").exists()


def test_help_is_not_an_error(capsys: pytest.CaptureFixture[str]) -> None:
    """Asking for help prints it and exits 0 for every command that takes options."""
    for command in (seed_lb05, eval_lb05):
        assert command(["--help"], make_platform()) == 0

    assert capsys.readouterr().out.count("usage") == 2


def test_the_sweep_takes_no_arguments(capsys: pytest.CaptureFixture[str]) -> None:
    """An argument is a mistake, not something to ignore."""
    assert sweep_lb05(["--all"], make_platform()) == 2
    assert "takes no arguments" in capsys.readouterr().err


def test_the_eval_checks_its_arguments_before_it_needs_a_gateway_or_data(capsys: pytest.CaptureFixture[str]) -> None:
    """An ID no case has is a usage mistake (2), found first, whatever the gateway or the data are doing."""
    golden_id = read_golden_set().cases[0].id
    platform = make_platform()

    unknown = eval_lb05(["--case", "no-such-case"], platform)
    wrong_set = eval_lb05(["--adversarial", "--case", golden_id], platform)
    unknown_attempt = eval_lb05(["--adversarial", "--case", "no-such-attempt"], platform)

    assert (unknown, wrong_set, unknown_attempt) == (2, 2, 2)
    errors = capsys.readouterr().err
    assert "No case or attempt has the ID no-such-case." in errors
    assert f"No case or attempt has the ID {golden_id}." in errors


def test_the_eval_without_a_gateway_says_what_it_needs(capsys: pytest.CaptureFixture[str]) -> None:
    """With no gateway settings there is nothing to grade: exit status 1, naming the three settings."""
    status = eval_lb05(["--samples"], make_platform(chat=None))

    assert status == 1
    error = capsys.readouterr().err
    for name in ("LB_GATEWAY_URL", "LB_SERVICE_NAME", "LB_SERVICE_KEY_FILE"):
        assert name in error


def test_the_eval_without_data_says_to_seed_it(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """With a model but no dataset written: exit status 1, and the reason in the words of the data error."""
    platform = make_platform(
        chat=OracleChat({}), environment=make_environment(LB05_WAREHOUSE_DIR=str(tmp_path / "nothing"))
    )

    status = eval_lb05(["--samples"], platform)

    assert status == 1
    assert "The data isn't ready" in capsys.readouterr().err


def test_the_eval_runs_the_cases_it_is_asked_for_and_reports_each_one(
    small_data: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Two named cases are put to the pipeline and graded: a pass line each, the totals and the calls they took."""
    golden = read_golden_set()
    chosen = [golden.cases[0], golden.cases[1]]
    oracle = OracleChat({case.question: reference_sql(case, DATA_AS_OF) for case in chosen})
    platform = make_platform(chat=oracle, environment=make_environment(LB05_WAREHOUSE_DIR=str(small_data)))

    status = eval_lb05(["--case", chosen[0].id, "--case", chosen[1].id], platform)

    output = capsys.readouterr().out
    assert status == 0
    assert f"pass  {chosen[0].id}" in output
    assert f"pass  {chosen[1].id}" in output
    assert "2 of 2 cases matched the reference (100.0% execution accuracy)." in output
    assert "4 model calls (2.0 a case); 0 cases needed their self-correction." in output
    assert oracle.calls == 4


def test_the_eval_samples_runs_exactly_the_curated_samples(
    small_data: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--samples` picks the cases the demo opens on, and nothing else."""
    golden = read_golden_set()
    oracle = OracleChat({case.question: reference_sql(case, DATA_AS_OF) for case in golden.cases})
    platform = make_platform(chat=oracle, environment=make_environment(LB05_WAREHOUSE_DIR=str(small_data)))

    status = eval_lb05(["--samples"], platform)

    output = capsys.readouterr().out
    assert status == 0
    assert f"{SAMPLE_COUNT} of {SAMPLE_COUNT} cases matched the reference" in output
    for case in golden.samples():
        assert f"pass  {case.id}" in output
    assert oracle.calls == 2 * SAMPLE_COUNT


def test_a_wrong_answer_is_reported_by_case_and_by_check_and_is_not_an_error_status(
    small_data: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A model that writes a harmless count is graded wrong; the report names the case and what differed."""
    case = read_golden_set().cases[0]
    platform = make_platform(
        chat=OracleChat({case.question: "SELECT COUNT(*) AS n FROM orders"}),
        environment=make_environment(LB05_WAREHOUSE_DIR=str(small_data)),
    )

    status = eval_lb05(["--case", case.id], platform)

    output = capsys.readouterr().out
    assert status == 0
    assert f"FAIL  {case.id}" in output
    assert "0 of 1 cases matched the reference (0.0% execution accuracy)." in output
    assert re.search(r"^\s+\w+: 1 failures$", output, re.MULTILINE)


def test_the_adversarial_eval_passes_when_every_attempt_is_held(
    small_data: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A model that obeys every attack is still stopped by the layers: all held, exit status 0, layers named."""
    adversarial = read_adversarial_set()
    obedient = OracleChat({attempt.question: attempt.sql for attempt in adversarial.attempts})
    platform = make_platform(chat=obedient, environment=make_environment(LB05_WAREHOUSE_DIR=str(small_data)))

    status = eval_lb05(["--adversarial"], platform)

    output = capsys.readouterr().out
    assert status == 0
    assert (
        f"{len(adversarial.attempts)} of {len(adversarial.attempts)} conclusive attempts were held (100.0%)." in output
    )
    assert "FAIL" not in output
    assert re.search(r"^held  drop-orders-table \(refused; stopped by parse\)$", output, re.MULTILINE)
    assert "Outcomes: " in output


def test_the_adversarial_eval_fails_when_a_model_answers_what_it_must_refuse(
    small_data: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Holding is a gate, not a score: one attempt answered that should have been refused makes the status 1."""
    attempt = next(item for item in read_adversarial_set().attempts if item.must_refuse)
    harmless = OracleChat({attempt.question: "SELECT COUNT(*) AS n FROM orders"})
    platform = make_platform(chat=harmless, environment=make_environment(LB05_WAREHOUSE_DIR=str(small_data)))

    status = eval_lb05(["--adversarial", "--case", attempt.id], platform)

    output = capsys.readouterr().out
    assert status == 1
    assert f"FAIL  {attempt.id}" in output
    assert "0 of 1 conclusive attempts were held (0.0%)." in output


def test_the_adversarial_eval_does_not_pass_when_nothing_could_be_graded(
    small_data: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """If the models were unreachable for every attempt, nothing was proven, so the gate does not pass."""
    attempt = read_adversarial_set().attempts[0]
    platform = make_platform(
        chat=FakeChat({"lb-reason": [unavailable()], "lb-fast": []}),
        environment=make_environment(LB05_WAREHOUSE_DIR=str(small_data)),
    )

    status = eval_lb05(["--adversarial", "--case", attempt.id], platform)

    output = capsys.readouterr().out
    assert status == 1
    assert f"skip  {attempt.id}" in output
