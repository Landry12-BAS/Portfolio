"""LB-10's commands that put packs to models: the nightly eval, the judge, the CI gate and the fallback advisor.

    nightly_lb10  (just nightly-lb10)  run every pack's production prompt on every provider, store the results
    judge_lb10    (just judge-lb10)    calibrate the LLM judge on the labelled set, then grade stored answers
    gate_lb10     (just gate-lb10)     compare fresh scores with the committed baselines; exit 1 on a regression
    advise_lb10   (just advise-lb10)   say which pinned fallbacks pass a threshold for each route (advice only)

Each needs the gateway to measure anything, which no test here has, so each also runs offline on a results
file the nightly wrote (`--results`), graded by the same rules; the tests run them on a fake model. Nothing
here invents a measurement: a pack with no baseline is reported as such, not passed or failed, and the
judge's scores are marked as not counting when its calibration fails. The commands are plain functions of
their arguments and the platform (plus the chat, which tests replace), returning the exit status.
"""

import argparse
import asyncio
import contextvars
import functools
import json
import logging
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ValidationError

from core.cli import write_line
from core.data_files import DataFileError
from core.platform import Platform
from lb10.baselines import BaselineEntry, BaselineFile, read_baselines
from lb10.chat import EvalChat, GatewayEvalChat
from lb10.judge import Calibration, Judgement, calibrate, judge_one, read_calibration_set
from lb10.packs import EvalPack, ModelClass, read_packs
from lb10.pipeline import EvalPipeline, RunFailedError, RunRequest
from lb10.prompt_check import production_prompt_hash
from lb10.providers import PROVIDERS, providers_for
from lb10.report import IntervalOut, VariantOut
from lb10.repository import EvalRepository, ResultKey, StoredNightly, StoredResult
from lb10.sampling import sample_cases
from lb10.stats import bootstrap_interval
from lb_common.run import new_run_id

logger = logging.getLogger(__name__)

# How many cases the nightly runs and the gate measure: the budgets in routing.yaml are sized for these.
NIGHTLY_SAMPLE = 10
GATE_SAMPLE = 20
# The share of passing cases a fallback must reach on every pack of a route to be advised for it.
ADVICE_THRESHOLD = 0.8
# The results file's format version, so an old file is refused rather than misread.
RESULTS_FORMAT = 1
# Where the judge's labelled set lives, under the evals folder.
CALIBRATION_FILE = Path("judge") / "calibration.yaml"

type Outcome = Literal["pass", "regression", "no_baseline", "other_version"]


class CaseRecord(BaseModel):
    """One graded case, as the results file stores it."""

    case_id: str
    difficulty: str
    passed: bool
    output: str
    grades: list[dict[str, Any]]
    error: str | None
    latency_ms: int
    input_tokens: int
    output_tokens: int
    model: str


class VariantRecord(BaseModel):
    """One pack's production prompt on one alias: its score and every case."""

    pack: str
    pack_version: str
    model_class: ModelClass
    provider: str
    alias: str
    prompt_hash: str
    score: IntervalOut
    latency_p50_ms: int
    latency_p95_ms: int
    input_tokens: int
    output_tokens: int
    model_calls: int
    cached_calls: int
    failed_calls: int
    cases: list[CaseRecord]


class ResultsFile(BaseModel):
    """What the nightly writes and the other commands read offline."""

    format: Literal[1]
    run_on: date
    sample_size: int
    results: list[VariantRecord]


@dataclass
class MemoryStore:
    """A result cache for a command run without the lb10 database: results live for the command only."""

    rows: dict[ResultKey, StoredResult] = field(default_factory=dict)

    def cached_results(self, keys: Sequence[ResultKey]) -> dict[ResultKey, StoredResult]:
        """Return the usable results among the keys."""
        return {key: self.rows[key] for key in keys if key in self.rows and self.rows[key].error is None}

    def store_result(self, result: StoredResult) -> None:
        """Keep a result."""
        self.rows[result.key] = result


def parse(parser: argparse.ArgumentParser, arguments: Sequence[str]) -> argparse.Namespace | int:
    """Parse a command's arguments, or return the exit status to stop with (2 for a mistake, 0 for --help)."""
    try:
        return parser.parse_args(arguments)
    except SystemExit as stop:
        return stop.code if isinstance(stop.code, int) else 2


def eval_chat_from(platform: Platform) -> EvalChat | None:
    """Return the gateway's eval chat when the platform has a gateway, else None."""
    gateway = getattr(platform.chat, "gateway", None)
    return GatewayEvalChat(gateway) if gateway is not None else None


def store_from(platform: Platform) -> EvalRepository | MemoryStore:
    """Return the result cache: the lb10 database when the platform has it, else memory for this command."""
    engine = platform.engines.get("lb10")
    return EvalRepository(engine, platform.clock) if engine is not None else MemoryStore()


def repository_from(platform: Platform) -> EvalRepository | None:
    """Return the lb10 repository when the platform has the database, for storing nightly rows."""
    engine = platform.engines.get("lb10")
    return EvalRepository(engine, platform.clock) if engine is not None else None


def run_production(
    platform: Platform,
    chat: EvalChat,
    store: EvalRepository | MemoryStore,
    pack: EvalPack,
    providers: Sequence[str],
    sample_size: int,
) -> list[VariantOut]:
    """Run a pack's production prompt on its fixed sample on each provider as a synthetic run; return the variants."""
    executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="lb10-eval")

    async def offload(function: Callable[..., Any], *arguments: Any) -> Any:
        """Run a blocking call on the pool with the task's context, so the gateway client knows the run and span."""
        context = contextvars.copy_context()
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(executor, functools.partial(context.run, function, *arguments))

    pipeline = EvalPipeline(chat, store, platform.tracer, offload, platform.clock)
    request = RunRequest(
        run_id=new_run_id(),
        pack=pack,
        cases=sample_cases(pack, sample_size),
        prompt=pack.prompt.system,
        providers=providers,
        data_class="synthetic",
        compare_with_production=True,
    )
    try:
        report = asyncio.run(pipeline.run(request, lambda _done, _cached: None))
    finally:
        executor.shutdown(wait=True, cancel_futures=False)
    return report.variants


def record_of(pack: EvalPack, variant: VariantOut) -> VariantRecord:
    """Write a variant as the results file stores it."""
    difficulties = {case.id: case.difficulty for case in pack.cases}
    return VariantRecord(
        pack=pack.pack,
        pack_version=pack.version(),
        model_class=pack.target.model_class,
        provider=variant.provider,
        alias=variant.alias,
        prompt_hash=production_prompt_hash(pack),
        score=variant.score,
        latency_p50_ms=variant.latency_p50_ms,
        latency_p95_ms=variant.latency_p95_ms,
        input_tokens=variant.input_tokens,
        output_tokens=variant.output_tokens,
        model_calls=variant.model_calls,
        cached_calls=variant.cached_calls,
        failed_calls=variant.failed_calls,
        cases=[
            CaseRecord(
                case_id=case.case_id,
                difficulty=difficulties.get(case.case_id, "easy"),
                passed=case.passed,
                output=case.output,
                grades=[grade.model_dump() for grade in case.grades],
                error=case.error,
                latency_ms=case.latency_ms,
                input_tokens=0,
                output_tokens=0,
                model=case.model,
            )
            for case in variant.cases
        ],
    )


def read_results(path: Path) -> ResultsFile:
    """Read a results file the nightly wrote, refusing one of another format."""
    try:
        return ResultsFile.model_validate_json(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise DataFileError(f"{path} can't be read: {error.strerror}") from None
    except ValidationError as error:
        raise DataFileError(f"{path} isn't a results file this command reads: {error.error_count()} problems") from None


def write_results(path: Path, results: ResultsFile) -> None:
    """Write a results file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(results.model_dump_json(indent=2) + "\n", encoding="utf-8")


def measure(
    platform: Platform,
    chat: EvalChat,
    packs: Sequence[EvalPack],
    providers: Sequence[str],
    sample_size: int,
) -> ResultsFile:
    """Run every pack's production prompt on every provider and collect the results."""
    store = store_from(platform)
    records: list[VariantRecord] = []
    for pack in packs:
        for provider in providers:
            try:
                variants = run_production(platform, chat, store, pack, [provider], sample_size)
            except RunFailedError as error:
                write_line(f"{pack.pack} on {provider}: no answers ({error.failure})", error=True)
                continue
            records.extend(record_of(pack, variant) for variant in variants)
    return ResultsFile(format=RESULTS_FORMAT, run_on=platform.clock().date(), sample_size=sample_size, results=records)


def chosen_packs(platform: Platform, names: Sequence[str]) -> list[EvalPack] | None:
    """Read the packs, keeping the named ones (all when none is named); None, after a message, when one is unknown."""
    packs = read_packs(platform.evals_directory() / "packs")
    if not names:
        return list(packs.values())
    unknown = sorted(set(names) - set(packs))
    if unknown:
        write_line(f"No pack is called {', '.join(unknown)}.", error=True)
        return None
    return [packs[name] for name in names]


def chosen_providers(names: Sequence[str], default: Sequence[str]) -> list[str] | None:
    """Keep the named providers (the default when none is named); None, after a message, when one is unknown."""
    chosen = list(dict.fromkeys(names)) or list(default)
    allowed = {provider.id for provider in providers_for("synthetic")}
    unknown = sorted(set(chosen) - allowed)
    if unknown:
        write_line(f"No provider is called {', '.join(unknown)}.", error=True)
        return None
    return chosen


def print_variant_line(record: VariantRecord) -> None:
    """Print one line of a results table."""
    score = record.score
    write_line(
        f"{record.pack:<18} {record.alias:<22} {score.mean:6.1%}  [{score.low:.1%}, {score.high:.1%}]  "
        f"{record.model_calls:>3} calls, {record.cached_calls:>3} cached, {record.failed_calls:>2} failed, "
        f"p50 {record.latency_p50_ms} ms"
    )


def nightly_lb10(arguments: Sequence[str], platform: Platform) -> int:
    """Run every pack's production prompt on every provider (OpenRouter included: synthetic cases), store and print.

    Writes `nightly-<date>.json` to `--out` (the results file the gate, the judge and the advisor read
    offline) and, when the lb10 database is configured, a row per pack and alias in nightly_results, which
    the API serves. Needs the gateway with provider keys; about 150 calls a night, most of them cached.
    """
    return run_nightly(arguments, platform, eval_chat_from(platform))


def run_nightly(arguments: Sequence[str], platform: Platform, chat: EvalChat | None) -> int:
    """Do the nightly eval with the given chat (the gateway's, or a test's fake)."""
    parser = argparse.ArgumentParser(prog="manage.py nightly_lb10", description=nightly_lb10.__doc__)
    parser.add_argument("--pack", action="append", default=[], help="Run this pack only; repeat for more.")
    parser.add_argument("--provider", action="append", default=[], help="Run on this provider only; repeat for more.")
    parser.add_argument(
        "--cases", type=int, default=NIGHTLY_SAMPLE, help=f"Cases a pack ({NIGHTLY_SAMPLE} by default)."
    )
    parser.add_argument("--out", type=Path, default=None, help="Write the results file to this folder.")
    options = parse(parser, arguments)
    if isinstance(options, int):
        return options
    if chat is None:
        write_line(
            "nightly_lb10 needs the gateway: set LB_GATEWAY_URL, LB_SERVICE_NAME and LB_SERVICE_KEY_FILE.", error=True
        )
        return 1
    try:
        packs = chosen_packs(platform, options.pack)
    except DataFileError as error:
        write_line(str(error), error=True)
        return 1
    providers = chosen_providers(options.provider, [provider.id for provider in PROVIDERS])
    if packs is None or providers is None:
        return 2
    results = measure(platform, chat, packs, providers, max(1, options.cases))
    for record in results.results:
        print_variant_line(record)
    store_nightly(platform, results, "eval")
    if options.out is not None:
        path = options.out / f"nightly-{results.run_on.isoformat()}.json"
        write_results(path, results)
        write_line(f"Wrote {path}.")
    return 0 if results.results else 1


def store_nightly(platform: Platform, results: ResultsFile, kind: str) -> None:
    """Store each result as a nightly row when the lb10 database is configured; say so when it is not."""
    repository = repository_from(platform)
    if repository is None:
        write_line("No lb10 database: the results are not stored for the API (set LB_DATABASE_URL to the box's).")
        return
    for record in results.results:
        repository.store_nightly(
            StoredNightly(
                run_on=results.run_on,
                kind=kind,
                pack=record.pack,
                pack_version=record.pack_version,
                alias=record.alias,
                report=record.model_dump(mode="json", exclude={"cases"}),
                created_at=platform.clock(),
            )
        )
    write_line(f"Stored {len(results.results)} {kind} results.")


def baseline_of(baselines: Sequence[BaselineEntry], record: VariantRecord) -> tuple[Outcome, BaselineEntry | None]:
    """Find a record's baseline and say how the fresh score stands against it.

    A regression is a score below the baseline's lower bound: the baseline's own confidence margin is what a
    fresh score may fall by before the gate calls it a drop.
    """
    same = [entry for entry in baselines if entry.pack == record.pack and entry.alias == record.alias]
    if not same:
        return "no_baseline", None
    current = [entry for entry in same if entry.pack_version == record.pack_version]
    if not current:
        return "other_version", same[0]
    baseline = current[0]
    if record.score.mean < baseline.low:
        return "regression", baseline
    return "pass", baseline


def baseline_entry(record: VariantRecord, measured_on: date, source: Literal["live", "offline"]) -> BaselineEntry:
    """Write a fresh score as a baseline."""
    return BaselineEntry(
        pack=record.pack,
        pack_version=record.pack_version,
        alias=record.alias,
        score=record.score.mean,
        low=record.score.low,
        high=record.score.high,
        cases=record.score.cases,
        measured_on=measured_on,
        source=source,
    )


def write_baselines(directory: Path, entries: Sequence[BaselineEntry]) -> None:
    """Write the baselines of each pack to its file, replacing the aliases measured and keeping the others."""
    by_pack: dict[str, dict[str, BaselineEntry]] = {}
    for entry in read_baselines(directory):
        by_pack.setdefault(entry.pack, {})[entry.alias] = entry
    for entry in entries:
        by_pack.setdefault(entry.pack, {})[entry.alias] = entry
    directory.mkdir(parents=True, exist_ok=True)
    for pack, aliases in by_pack.items():
        if not any(entry.pack == pack for entry in entries):
            continue
        content = BaselineFile(baselines=[aliases[alias] for alias in sorted(aliases)]).model_dump(mode="json")
        header = (
            f"# The baselines of {pack}, written by `just gate-lb10 --write-baselines` from a measured run.\n"
            "# Do not edit.\n"
        )
        (directory / f"{pack}.yaml").write_text(header + yaml.safe_dump(content, sort_keys=False), encoding="utf-8")


def gate_lb10(arguments: Sequence[str], platform: Platform) -> int:
    """Compare fresh scores with the committed baselines (evals/baselines) and exit 1 when one drops past its margin.

    Fresh scores come from the gateway (every pack on Groq and Workers AI, 20 cases each) or, with
    `--results`, from a results file the nightly wrote. A pack with no baseline is reported, not graded;
    `--write-baselines` records the fresh scores as the new baselines; `--strict` fails on a missing one.
    """
    return run_gate(arguments, platform, eval_chat_from(platform))


def run_gate(arguments: Sequence[str], platform: Platform, chat: EvalChat | None) -> int:
    """Do the gate with the given chat (the gateway's, a test's fake, or none when a results file is read)."""
    parser = argparse.ArgumentParser(prog="manage.py gate_lb10", description=gate_lb10.__doc__)
    parser.add_argument("--results", type=Path, default=None, help="Grade this results file instead of running.")
    parser.add_argument("--provider", action="append", default=[], help="Run on this provider; repeat for more.")
    parser.add_argument("--cases", type=int, default=GATE_SAMPLE, help=f"Cases a pack ({GATE_SAMPLE} by default).")
    parser.add_argument("--baselines", type=Path, default=None, help="The baselines folder (evals/baselines).")
    parser.add_argument("--write-baselines", action="store_true", help="Record the fresh scores as the baselines.")
    parser.add_argument("--strict", action="store_true", help="Fail when a pack has no baseline.")
    options = parse(parser, arguments)
    if isinstance(options, int):
        return options
    directory = options.baselines or platform.evals_directory() / "baselines"
    try:
        results = fresh_results(options, platform, chat)
        baselines = read_baselines(directory)
    except DataFileError as error:
        write_line(str(error), error=True)
        return 1
    if results is None:
        return 1
    failed = False
    missing = False
    for record in results.results:
        outcome, baseline = baseline_of(baselines, record)
        failed = failed or outcome == "regression"
        missing = missing or outcome in ("no_baseline", "other_version")
        write_line(gate_line(record, outcome, baseline))
    if options.write_baselines:
        source: Literal["live", "offline"] = "offline" if options.results is not None else "live"
        write_baselines(directory, [baseline_entry(record, results.run_on, source) for record in results.results])
        write_line(f"Wrote the baselines of {len({record.pack for record in results.results})} packs to {directory}.")
    if failed:
        write_line("GATE FAILED: a score dropped below its baseline's margin.", error=True)
        return 1
    if missing and options.strict:
        write_line(
            "GATE FAILED: a pack has no baseline for this version (--write-baselines once measured).",
            error=True,
        )
        return 1
    write_line(
        "Gate passed."
        if not missing
        else "Gate passed on the packs that have a baseline; the others were only reported."
    )
    return 0


def fresh_results(options: argparse.Namespace, platform: Platform, chat: EvalChat | None) -> ResultsFile | None:
    """Get the scores to gate on: from the results file, or by running the packs now."""
    if options.results is not None:
        return read_results(options.results)
    if chat is None:
        write_line("gate_lb10 needs the gateway, or --results FILE to grade a stored run.", error=True)
        return None
    packs = chosen_packs(platform, [])
    providers = chosen_providers(options.provider, [provider.id for provider in providers_for("visitor")])
    if packs is None or providers is None:
        return None
    return measure(platform, chat, packs, providers, max(1, options.cases))


def gate_line(record: VariantRecord, outcome: Outcome, baseline: BaselineEntry | None) -> str:
    """Write one line of the gate's report."""
    fresh = f"{record.score.mean:.1%} [{record.score.low:.1%}, {record.score.high:.1%}]"
    if outcome == "pass" and baseline is not None:
        floor = f"(floor {baseline.low:.1%})"
        return f"PASS        {record.pack:<18} {record.alias:<22} {fresh} against {baseline.score:.1%} {floor}"
    if outcome == "regression" and baseline is not None:
        floor = f"below the floor {baseline.low:.1%} of {baseline.score:.1%}"
        return f"REGRESSION  {record.pack:<18} {record.alias:<22} {fresh} {floor}"
    if outcome == "other_version":
        return f"NO BASELINE {record.pack:<18} {record.alias:<22} {fresh} (the baseline is of another pack version)"
    return f"NO BASELINE {record.pack:<18} {record.alias:<22} {fresh} (nothing to compare with yet)"


def judge_lb10(arguments: Sequence[str], platform: Platform) -> int:
    """Calibrate the LLM judge on the labelled set, then grade the stored answers of a results file with it.

    The judge's scores count only when its agreement with the labels reaches the threshold; otherwise the
    report says so and the scores are kept for the record only. Needs the gateway (`lb-judge`): about a
    dozen calls for the calibration and one a case judged.
    """
    return run_judge(arguments, platform, eval_chat_from(platform))


def run_judge(arguments: Sequence[str], platform: Platform, chat: EvalChat | None) -> int:
    """Do the judging with the given chat (the gateway's, or a test's fake)."""
    parser = argparse.ArgumentParser(prog="manage.py judge_lb10", description=judge_lb10.__doc__)
    parser.add_argument(
        "--results", type=Path, required=True, help="The nightly's results file whose answers to judge."
    )
    parser.add_argument("--pack", action="append", default=[], help="Judge this pack only; repeat for more.")
    parser.add_argument(
        "--calibration", type=Path, default=None, help="The labelled set (evals/judge/calibration.yaml)."
    )
    parser.add_argument("--out", type=Path, default=None, help="Write the judge's report to this folder.")
    options = parse(parser, arguments)
    if isinstance(options, int):
        return options
    if chat is None:
        write_line(
            "judge_lb10 needs the gateway: set LB_GATEWAY_URL, LB_SERVICE_NAME and LB_SERVICE_KEY_FILE.", error=True
        )
        return 1
    try:
        labelled = read_calibration_set(options.calibration or platform.evals_directory() / CALIBRATION_FILE)
        results = read_results(options.results)
        packs = read_packs(platform.evals_directory() / "packs")
    except DataFileError as error:
        write_line(str(error), error=True)
        return 1
    calibration, _judgements = calibrate(chat, labelled.items)
    write_line(calibration_line(calibration))
    reports: list[dict[str, Any]] = []
    for record in results.results:
        if options.pack and record.pack not in options.pack:
            continue
        pack = packs.get(record.pack)
        if pack is None:
            write_line(f"{record.pack}: the pack is no longer in evals/packs; its answers are not judged.")
            continue
        report = judge_record(chat, pack, record, calibration)
        reports.append(report)
        write_line(
            f"{record.pack:<18} {record.alias:<22} judge {report['judge_pass_rate']:.1%}  "
            f"rules {report['rule_pass_rate']:.1%}  agreement {report['agreement_with_rules']:.1%}  "
            f"{'counts' if calibration.calibrated else 'DOES NOT COUNT'}"
        )
    store_judge(platform, results, reports)
    if options.out is not None:
        path = options.out / f"judge-{results.run_on.isoformat()}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"calibration": calibration_report(calibration), "reports": reports}, indent=2) + "\n"
        )
        write_line(f"Wrote {path}.")
    return 0


def calibration_report(calibration: Calibration) -> dict[str, Any]:
    """Write a calibration as the reports store it."""
    return {
        "items": calibration.items,
        "judged": calibration.judged,
        "agreed": calibration.agreed,
        "agreement": calibration.agreement,
        "kappa": calibration.kappa,
        "threshold": calibration.threshold,
        "kappa_threshold": calibration.kappa_threshold,
        "calibrated": calibration.calibrated,
    }


def calibration_line(calibration: Calibration) -> str:
    """Say how the judge did on the labelled set."""
    standing = "its scores count" if calibration.calibrated else "ITS SCORES DO NOT COUNT tonight"
    return (
        f"Calibration: {calibration.agreed} of {calibration.items} labels matched ({calibration.agreement:.1%}, "
        f"kappa {calibration.kappa:.2f}; threshold {calibration.threshold:.0%} and {calibration.kappa_threshold:.2f}): "
        f"{standing}."
    )


def judge_record(chat: EvalChat, pack: EvalPack, record: VariantRecord, calibration: Calibration) -> dict[str, Any]:
    """Judge every answered case of one record, and compare the judge's verdicts with the rules'."""
    verdicts: list[dict[str, Any]] = []
    for case in record.cases:
        if case.error is not None:
            continue
        expected = pack.case_by_id(case.case_id).expected if any(c.id == case.case_id for c in pack.cases) else {}
        judgement: Judgement = judge_one(chat, pack.target.description, expected, case.output)
        verdicts.append(
            {
                "case_id": case.case_id,
                "rules": "pass" if case.passed else "fail",
                "judge": judgement.verdict,
                "reason": judgement.reason,
            }
        )
    judged = [verdict for verdict in verdicts if verdict["judge"] is not None]
    judge_passes = [verdict["judge"] == "pass" for verdict in judged]
    agreement = sum(1 for verdict in judged if verdict["judge"] == verdict["rules"]) / len(judged) if judged else 0.0
    interval = bootstrap_interval(judge_passes)
    return {
        "pack": record.pack,
        "pack_version": record.pack_version,
        "alias": record.alias,
        "counts": calibration.calibrated,
        "judged": len(judged),
        "unreadable_verdicts": len(verdicts) - len(judged),
        "judge_pass_rate": interval.mean,
        "judge_low": interval.low,
        "judge_high": interval.high,
        "rule_pass_rate": record.score.mean,
        "agreement_with_rules": agreement,
        "verdicts": verdicts,
    }


def store_judge(platform: Platform, results: ResultsFile, reports: Sequence[dict[str, Any]]) -> None:
    """Store the judge's reports as nightly rows when the lb10 database is configured."""
    repository = repository_from(platform)
    if repository is None:
        write_line("No lb10 database: the judge's reports are not stored for the API.")
        return
    for report in reports:
        repository.store_nightly(
            StoredNightly(
                run_on=results.run_on,
                kind="judge",
                pack=str(report["pack"]),
                pack_version=str(report["pack_version"]),
                alias=str(report["alias"]),
                report={key: value for key, value in report.items() if key != "verdicts"},
                created_at=platform.clock(),
            )
        )
    write_line(f"Stored {len(reports)} judge reports.")


def advise_lb10(arguments: Sequence[str], _platform: Platform) -> int:
    """Say which pinned fallbacks pass a threshold on every pack of a route, from a results file. Advice only.

    A route is a production alias (lb-fast, lb-tools, lb-reason) and its fallbacks are the pinned eval
    aliases of its model class. This prints which of them scored at least the threshold on every pack of
    the route in the results file; it changes nothing in routing.yaml, which stays the owner's decision.
    """
    parser = argparse.ArgumentParser(prog="manage.py advise_lb10", description=advise_lb10.__doc__)
    parser.add_argument("--results", type=Path, required=True, help="The nightly's results file to read.")
    parser.add_argument(
        "--threshold", type=float, default=ADVICE_THRESHOLD, help="The share of passing cases a fallback needs."
    )
    options = parse(parser, arguments)
    if isinstance(options, int):
        return options
    try:
        results = read_results(options.results)
    except DataFileError as error:
        write_line(str(error), error=True)
        return 1
    for line in advice_lines(results, options.threshold):
        write_line(line)
    write_line("This advises; it changes nothing in services/gateway/routing.yaml.")
    return 0


def advice_lines(results: ResultsFile, threshold: float) -> list[str]:
    """Work out, for each route, which aliases pass the threshold on every pack of the route."""
    routes: dict[ModelClass, str] = {"fast": "lb-fast", "tools": "lb-tools", "reason": "lb-reason"}
    lines: list[str] = []
    for model_class, route in routes.items():
        records = [record for record in results.results if record.model_class == model_class]
        if not records:
            lines.append(f"{route}: no results in the file.")
            continue
        packs = sorted({record.pack for record in records})
        aliases = sorted({record.alias for record in records})
        lines.append(f"{route} ({', '.join(packs)}), threshold {threshold:.0%}:")
        for alias in aliases:
            scores = {record.pack: record.score.mean for record in records if record.alias == alias}
            covered = all(pack in scores for pack in packs)
            passing = covered and all(score >= threshold for score in scores.values())
            worst = min(scores.values()) if scores else 0.0
            standing = "may serve" if passing else ("below the threshold" if covered else "not measured on every pack")
            lines.append(f"  {alias:<22} {standing} (lowest {worst:.1%} over {len(scores)} of {len(packs)} packs)")
    return lines
