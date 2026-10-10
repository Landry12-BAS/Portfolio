// LB-07 QA Engineer's operating limits and its closed lists: the numbers the service enforces,
// the board shows and the datasheet promises, and the names the shop, the runner, the agent and
// the board all agree on (the bugs, the states, the kinds of finding, the failure codes). A name
// outside a list is an error everywhere, which is what keeps a model's answer from naming a bug,
// a step or a severity nobody planned for.

/** LB-07's limits. The datasheet (apps/web/shared/data/systems.ts) promises the runs a day, the run time and the network. */
export const LB07_LIMITS = {
  // How many test runs a visitor may start in a day. A sample counts; a run the system could not start is given back.
  runsPerVisitorPerDay: 2,
  // The most characters a goal may have. A goal is a visitor's own words, and untrusted.
  maxGoalLength: 300,
  // The most steps a plan may have, first plan or re-plan.
  maxPlanSteps: 16,
  // How many times the agent may ask the model for a new plan after a step failed.
  maxReplans: 2,
  // The most model calls one run may make: the plan with its repair, two re-plans with theirs, the report with its repair.
  maxModelCalls: 8,
  // The wall clock of a whole run in the browser, after which the run is ended whatever it is doing.
  runTimeMs: 180_000,
  // How long one step may take in the browser.
  stepTimeoutMs: 10_000,
  // How long a run, its findings, its evidence, its report and its test are kept.
  keptMinutes: 60,
  // How many runs may wait for the one browser before a new one is told the system is busy.
  maxQueued: 4,
  // How many runs the system executes at once: one browser, one run.
  concurrentRuns: 1,
  // The most findings a run keeps; the rest are counted.
  maxFindings: 40,
  // The most bugs a visitor may switch on at once: every one of them.
  maxBugsPerRun: 6,
  // The most characters of an accessibility snapshot that are kept as evidence, or shown to the model.
  maxSnapshotChars: 6_000,
  // The most bytes a screenshot may have (PNG) to be kept as evidence.
  maxScreenshotBytes: 400_000,
  // The most characters a generated test may have.
  maxTestChars: 20_000,
  // How many runs one runner process serves before it exits and is started again.
  runsPerRunnerLife: 20,
} as const

/** The bugs the staging shop can switch on, by their stable ids. The catalogue (data/seed/lb07/bugs.yaml) says what each does. */
export const LB07_BUG_IDS = ['coupon-twice', 'checkout-engine', 'missing-alt', 'cart-off-by-one', 'broken-image', 'script-error'] as const
/** One switchable bug of the staging shop. */
export type Lb07BugId = (typeof LB07_BUG_IDS)[number]

/** The browser engines a plan can run in: real Chromium, and Chromium wearing Firefox's user agent, since only Chromium is installed in the sandbox. */
export const LB07_ENGINES = ['chromium', 'firefox-ua'] as const
/** One engine. */
export type Lb07Engine = (typeof LB07_ENGINES)[number]

/** The states of a run, in the order they happen. `failed` can follow any of them, and `busy` never reaches the database (the run is refused before it exists). */
export const LB07_STATES = ['queued', 'planning', 'running', 'replanning', 'cross_checking', 'reporting', 'verifying', 'done', 'failed'] as const
/** One state of a run. */
export type Lb07State = (typeof LB07_STATES)[number]

/** The reasons a run can end as failed. The board words each from its own locale files, never from a response. */
export const LB07_FAILURE_CODES = [
  // The model could not be reached, or its day's quota is spent: nothing the visitor did.
  'planning_unavailable',
  // The model answered, but never with a plan the schema accepts, even after its repair.
  'plan_invalid',
  // A plan or a re-plan asked for something outside the vocabulary or the shop: refused and recorded.
  'plan_refused',
  // The browser runner could not be reached, or died in the middle of the run.
  'runner_unavailable',
  // The run used its three minutes.
  'run_timeout',
  // The goal was refused by the injection guard or by the service's own checks.
  'goal_refused',
  'internal',
] as const
/** One reason a run failed. */
export type Lb07FailureCode = (typeof LB07_FAILURE_CODES)[number]

/** What a failed run says in plain words: a sentence for the API, shared by the service and the mock back end. */
export const LB07_FAILURE_MESSAGES: Readonly<Record<Lb07FailureCode, string>> = {
  planning_unavailable: 'The model could not be reached, or its free quota for today is spent.',
  plan_invalid: 'The model did not write a plan the system could accept, even after one repair.',
  plan_refused: 'The plan asked for something outside the test vocabulary or outside the staging shop, and was refused.',
  runner_unavailable: 'The browser sandbox could not be reached.',
  run_timeout: 'The run used its three minutes and was stopped.',
  goal_refused: 'The goal was refused.',
  internal: 'The run failed.',
}

/** The kinds of finding code can make. None of them comes from a model. */
export const LB07_FINDING_KINDS = [
  // An expectation of the plan did not hold: the page did not say, or did not have, what the goal needs.
  'expectation_failed',
  // The page logged an error to the console, or threw.
  'console_error',
  // A request the page made failed, or was answered with an error status.
  'failed_request',
  // axe-core found a WCAG violation.
  'accessibility',
  // The plan, or the page, tried to leave the staging shop and was stopped.
  'blocked_navigation',
] as const
/** One kind of finding. */
export type Lb07FindingKind = (typeof LB07_FINDING_KINDS)[number]

/** How serious a bug report says a bug is, lowest first. The model picks one; code checks it is on the list. */
export const LB07_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
/** One severity. */
export type Lb07Severity = (typeof LB07_SEVERITIES)[number]

/** What became of a step. */
export const LB07_STEP_STATUSES = ['pending', 'running', 'passed', 'failed', 'finding', 'blocked', 'skipped'] as const
/** One step status. `finding` is an expectation that did not hold, which is a result and not a mistake of the plan. */
export type Lb07StepStatus = (typeof LB07_STEP_STATUSES)[number]

/**
 * The verdict of the red-then-green verification of a generated test. `kept`: red with the bugs on,
 * green with them off. `passing`: no bug was on, so there is nothing to be red about, and the test
 * passes on the clean shop. `discarded_not_red`: the test did not catch the bug. `discarded_not_green`:
 * the test fails on the clean shop too, so it proves nothing. `not_verified`: the run ended before the
 * verification could happen.
 */
export const LB07_VERDICTS = ['kept', 'passing', 'discarded_not_red', 'discarded_not_green', 'not_verified'] as const
/** One verdict. */
export type Lb07Verdict = (typeof LB07_VERDICTS)[number]
