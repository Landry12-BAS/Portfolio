// The stand-in for node-worker in infra/sandbox/test.sh. It runs in a container of its own on the
// sandbox network and calls LB-07's runner as the worker does: through the service's own client
// (HttpRunner), with bug tokens signed by the key the sandbox was given, running a golden plan in
// the three passes the agent makes (src/modules/lb07/agent/machine.ts): the bugs on in Chromium,
// the bugs on behind Firefox's user agent, and the bugs off in Chromium. Each command prints what
// it saw and exits 1 when that is not what the sandbox must do.
//
//   node client.mjs health                   the runner answers, and is ready for a run
//   node client.mjs golden <case id>...      the cases' passes, graded by the bug catalogue's truths
//   node client.mjs heavy <runs>             the heaviest case, run after run (the memory test)
//   node client.mjs exhaust <runs per life>  the last run of the runner's life, then its restart
//   node client.mjs connect <host> <port>    whether a TCP connection opens: connected, refused or blocked
//
// Settings: LB07_RUNNER_URL (default http://lb07-sandbox:8008) and LB07_SHOP_TOKEN_KEY (the key
// the sandbox verifies bug tokens with, as hex). The repository is read from where this file is.
import { connect } from 'node:net'

import { matchesTruth, readBugCatalogue } from '../../services/node-systems/src/modules/lb07/data/bugs.ts'
import { readGoldenSet } from '../../services/node-systems/src/modules/lb07/golden/cases.ts'
import { HttpRunner, RunnerError } from '../../services/node-systems/src/modules/lb07/runner/client.ts'
import { signBugToken, TOKEN_LIFETIME_MS, tokenKeyFromHex } from '../../services/node-systems/src/modules/lb07/shop/token.ts'

const REPOSITORY = new URL('../../', import.meta.url).pathname
const RUNNER_URL = process.env.LB07_RUNNER_URL?.trim() || 'http://lb07-sandbox:8008'
// The heaviest plan of the golden set: fifteen steps, every bug on, the checkout included.
const HEAVIEST_CASE = 'everything-on'
// The finding kinds that mean the shop has a bug (src/modules/lb07/golden/grade.ts).
const BUG_KINDS = new Set(['expectation_failed', 'console_error', 'failed_request', 'accessibility'])
// How long the runner may take to come back after it exits, in half-second polls.
const RESTART_POLLS = 120

const runner = new HttpRunner(RUNNER_URL)
let failures = 0

/** Prints a check that held. */
function pass(label) {
  console.log(`  ok    ${label}`)
}

/** Prints a check that did not hold, and remembers it. */
function fail(label) {
  console.log(`  FAIL  ${label}`)
  failures += 1
}

/** Waits for a number of milliseconds. */
function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** The key the bug tokens are signed with, from the environment. */
function tokenKey() {
  const hex = process.env.LB07_SHOP_TOKEN_KEY?.trim()
  if (!hex) throw new Error('LB07_SHOP_TOKEN_KEY is required: the key the sandbox verifies bug tokens with.')
  return tokenKeyFromHex(hex)
}

/** Signs a bug token for a run, as the worker does, or gives none when no bug is on. */
function bugTokenFor(bugs, runId) {
  if (bugs.length === 0) return null
  return signBugToken(tokenKey(), { runId, bugs: [...bugs], exp: Date.now() + TOKEN_LIFETIME_MS })
}

/** The bug catalogue and the golden set, from the repository. */
function loadGolden() {
  const catalogue = readBugCatalogue(`${REPOSITORY}data/seed`)
  const cases = readGoldenSet(`${REPOSITORY}evals/lb07/golden.yaml`, catalogue)
  return { catalogue, cases }
}

/** Runs a plan in one session, the way the agent's passes do: axe after each page opened and at the end when asked, a blocked step ending the plan, and the session always closed. */
async function runPass(plan, options) {
  const sessionId = await runner.open({ runId: options.runId, engine: options.engine, bugToken: options.bugToken, wallClockMs: 120_000 })
  const findings = []
  let failure
  try {
    for (const [index, step] of plan.entries()) {
      const answer = await runner.step(sessionId, index, step)
      findings.push(...answer.findings)
      if (options.axe && step.action === 'goto' && answer.outcome === 'ok') findings.push(...(await runner.axe(sessionId, index)).findings)
      if (answer.outcome === 'blocked') break
    }
    if (options.axe) findings.push(...(await runner.axe(sessionId, null)).findings)
  }
  catch (error) {
    failure = error
  }
  const closed = await runner.close(sessionId)
  if (failure !== undefined) throw failure
  findings.push(...closed.findings)
  return { findings, offOriginRequests: closed.offOriginRequests, blocked: closed.blocked }
}

/** Runs a golden case's three passes: red in Chromium, red behind Firefox's user agent, green in Chromium. */
async function runCase(entry) {
  const runId = `run-sandbox-${entry.id}`.slice(0, 60)
  const bugToken = bugTokenFor(entry.bugs, runId)
  const main = await runPass(entry.plan, { runId, engine: 'chromium', bugToken, axe: true })
  const cross = await runPass(entry.plan, { runId, engine: 'firefox-ua', bugToken, axe: false })
  const green = await runPass(entry.plan, { runId, engine: 'chromium', bugToken: null, axe: true })
  return { main, cross, green }
}

/** Grades a case's passes by the golden set's rules that the runner alone decides: the bugs found, a clean shop left clean, nothing that left the shop, and a green pass with none of the bugs. */
function gradeCase(entry, passes, catalogue) {
  const red = [...passes.main.findings, ...passes.cross.findings]
  const problems = []
  let found = 0
  for (const bug of entry.expect.found) {
    const truth = catalogue.get(bug).truth
    if (red.some(finding => matchesTruth(truth, finding))) found += 1
    else problems.push(`${bug} was on and no finding matches it`)
    if (passes.green.findings.some(finding => matchesTruth(truth, finding))) problems.push(`${bug} was found with every bug off`)
  }
  if (entry.bugs.length === 0) {
    const wrong = red.filter(finding => BUG_KINDS.has(finding.kind))
    if (wrong.length > 0) problems.push(`${wrong.length} finding(s) on a clean shop`)
  }
  const escaped = passes.main.offOriginRequests + passes.cross.offOriginRequests + passes.green.offOriginRequests
  if (escaped > 0) problems.push(`${escaped} request(s) left the shop`)
  const blocked = passes.main.findings.filter(finding => finding.kind === 'blocked_navigation').length
  if (blocked !== entry.expect.blocked) problems.push(`${blocked} blocked navigation(s), ${entry.expect.blocked} expected`)
  return { problems, found, blocked }
}

/** `health`: the runner answers, is ok, and holds no run. */
async function health() {
  const answer = await runner.health()
  console.log(JSON.stringify(answer))
  if (!answer.ok) fail('the runner says it is not ok')
}

/** `golden`: the named cases, each graded. */
async function golden(caseIds) {
  const { catalogue, cases } = loadGolden()
  for (const id of caseIds) {
    const entry = cases.find(candidate => candidate.id === id)
    if (!entry) {
      fail(`there is no golden case ${id}`)
      continue
    }
    const started = Date.now()
    const grade = gradeCase(entry, await runCase(entry), catalogue)
    const seconds = ((Date.now() - started) / 1_000).toFixed(1)
    const verdict = entry.bugs.length === 0
      ? 'no bug on, and no finding of a bug\'s kind'
      : `${grade.found} of ${entry.expect.found.length} bug(s) found by the red passes, none by the green pass`
    const summary = `${entry.id}: ${verdict}, nothing left the shop, ${grade.blocked} navigation(s) blocked (${seconds} s, three passes)`
    if (grade.problems.length === 0) pass(summary)
    else fail(`${entry.id}: ${grade.problems.join('; ')}`)
  }
}

/** `heavy`: the heaviest case, run after run, each run graded; prints each run's time for the memory test to line up with. */
async function heavy(runs) {
  const { catalogue, cases } = loadGolden()
  const entry = cases.find(candidate => candidate.id === HEAVIEST_CASE)
  for (let run = 1; run <= runs; run += 1) {
    const started = Date.now()
    const grade = gradeCase(entry, await runCase(entry), catalogue)
    const label = `run ${run} of ${runs} of ${HEAVIEST_CASE} (${entry.plan.length} steps, three passes) in ${((Date.now() - started) / 1_000).toFixed(1)} s`
    if (grade.problems.length === 0) pass(label)
    else fail(`${label}: ${grade.problems.join('; ')}`)
  }
}

/** Waits until a fresh runner answers (one that has served no run: the old one cannot say that again), and returns how many polls found no runner at all, or undefined when none came. */
async function untilFreshRunner() {
  let unanswered = 0
  for (let poll = 0; poll < RESTART_POLLS; poll += 1) {
    try {
      const answer = await runner.health()
      if (answer.runsServed === 0 && !answer.exhausted) return unanswered
    }
    catch (error) {
      if (!(error instanceof RunnerError)) throw error
      unanswered += 1
    }
    await wait(500)
  }
  return undefined
}

/** `exhaust`: the runner serves its share of runs, the last one is never cut short by the restart it causes, and a fresh process takes over. */
async function exhaust(runsPerLife) {
  const { cases } = loadGolden()
  const plan = cases.find(candidate => candidate.id === HEAVIEST_CASE).plan
  const before = await runner.health()
  if (before.runsServed === 0 && !before.exhausted) pass('a fresh runner has served no run')
  else fail(`the runner had already served ${before.runsServed} run(s)`)
  for (let run = 1; run < runsPerLife; run += 1) {
    await runPass(plan.slice(0, 2), { runId: `run-sandbox-life-${run}`, engine: 'chromium', bugToken: null, axe: false })
  }
  pass(`${runsPerLife - 1} run(s) served, the runner still up`)

  const runId = 'run-sandbox-life-last'
  const sessionId = await runner.open({ runId, engine: 'chromium', bugToken: bugTokenFor(['coupon-twice'], runId), wallClockMs: 120_000 })
  const half = Math.floor(plan.length / 2)
  for (const [index, step] of plan.slice(0, half).entries()) await runner.step(sessionId, index, step)
  const during = await runner.health()
  if (during.busy && during.exhausted) pass(`during run ${runsPerLife}, the runner says it is busy and has served its share`)
  else fail(`during run ${runsPerLife}, the runner said ${JSON.stringify(during)}`)
  try {
    await runner.open({ runId: 'run-sandbox-life-extra', engine: 'chromium', bugToken: null, wallClockMs: 120_000 })
    fail('a run was opened beside the last one')
  }
  catch (error) {
    if (error instanceof RunnerError && error.code === 'busy') pass('a second run is refused while the last one holds the browser')
    else throw error
  }
  let outcomes = []
  for (const [offset, step] of plan.slice(half).entries()) outcomes.push((await runner.step(sessionId, half + offset, step)).outcome)
  const closed = await runner.close(sessionId)
  // A step that ran gives `ok`, or `expectation` where the bug that is on made it fail: anything
  // else (a timeout, a browser error) would be the run cut short.
  outcomes = outcomes.filter(outcome => outcome !== 'ok' && outcome !== 'expectation')
  if (outcomes.length === 0 && closed.offOriginRequests === 0) pass(`the last run ran all ${plan.length} steps and closed with its findings: nothing cut it short`)
  else fail(`the last run ended with ${outcomes.join(', ')} (${closed.offOriginRequests} off-origin)`)

  const unanswered = await untilFreshRunner()
  if (unanswered === undefined) fail('no fresh runner took over after the runner had served its share')
  else pass(`then the process exited, and a fresh runner answers, having served no run (${unanswered} poll(s) of half a second found none)`)
  await runPass(plan.slice(0, 2), { runId: 'run-sandbox-life-next', engine: 'chromium', bugToken: null, axe: false })
  pass('the fresh runner serves the next run')
}

/** `connect`: opens a TCP connection and says how it went, for the network checks: connected; refused (the address was reached); or blocked (no route, or no answer). */
function tryConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port: Number(port), timeout: 3_000 })
    socket.once('connect', () => {
      socket.destroy()
      resolve('connected')
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve('blocked')
    })
    socket.once('error', error => resolve(error.code === 'ECONNREFUSED' ? 'refused' : 'blocked'))
  })
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'health') await health()
else if (command === 'golden') await golden(rest)
else if (command === 'heavy') await heavy(Number(rest[0] ?? 5))
else if (command === 'exhaust') await exhaust(Number(rest[0]))
else if (command === 'connect') console.log(await tryConnect(rest[0], rest[1]))
else {
  console.error('usage: client.mjs health | golden <case id>... | heavy <runs> | exhaust <runs per life> | connect <host> <port>')
  process.exit(2)
}
process.exit(failures === 0 ? 0 : 1)
