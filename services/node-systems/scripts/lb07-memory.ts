// Measures what LB-07's sandbox costs in memory, for the size of its container. It starts the sandbox process as
// its container runs it (src/sandbox.ts: the shop and the runner in one Node process, Chromium started with the
// first run), runs a golden case through the runner's API with the real agent and a scripted model (no gateway, no
// database: the browser does exactly what a run makes it do), as many times as asked, and samples the memory of the
// whole process tree (the Node process, Chromium and each of its helper processes) every 100 ms:
//
//   - RSS, summed: what `ps` shows, process by process; a page several processes share is counted once for each;
//   - PSS, summed: each shared page divided among the processes that share it, so the sum counts it once: what the
//     tree really occupies, and the nearer figure to what a container's memory limit charges.
//
// It prints, for every run, the tree's memory before the run, at the run's peak and after it, in MiB.
//
//   node scripts/lb07-memory.ts [--case everything-on] [--runs 5] [--shop-port 8163] [--runner-port 8164] [--cgroup DIR] [--home DIR]
//
// With --cgroup, the sandbox is moved into that memory cgroup (version 1; the caller makes it, sets no limit and
// removes it afterwards), and the charge it reports too is the one a container's memory limit counts: its anonymous
// memory and the files it brought into the cache (a file another process on the machine already cached is not
// charged again, so on a busy machine the charge is the lower bound of what a fresh container pays).
//
// Needs a Chromium (LB07_BROWSER_PATH, or PLAYWRIGHT_CHROMIUM_EXECUTABLE) and Linux's /proc.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { createRun, runScope, Tracer } from '@lb/common'
import type { Span, SpanWriter } from '@lb/common'
import type { Lb07Step } from '@lb/contracts'

import { evalsDirectory, seedDirectory } from '../src/core/data-files.ts'
import { runAgent } from '../src/modules/lb07/agent/machine.ts'
import type { JsonModel, ModelReply, PromptMessage } from '../src/modules/lb07/agent/model.ts'
import { freshWorking } from '../src/modules/lb07/agent/working.ts'
import { readBugCatalogue } from '../src/modules/lb07/data/bugs.ts'
import { readGoldenSet } from '../src/modules/lb07/golden/cases.ts'
import type { GoldenCase } from '../src/modules/lb07/golden/cases.ts'
import { HttpRunner } from '../src/modules/lb07/runner/client.ts'
import { runnerKeyFrom } from '../src/modules/lb07/runner/key.ts'
import { signBugToken, TOKEN_LIFETIME_MS } from '../src/modules/lb07/shop/token.ts'

/** The tree's memory at one moment, in kibibytes. */
interface Memory {
  rss: number
  pss: number
  processes: number
}

/** A span writer that keeps nothing: the measurement needs no trace. */
class NoSpans implements SpanWriter {
  /** Drops the spans. */
  async write(_spans: readonly Span[]): Promise<void> {}
}

/** A model that answers as a correct planner would for one golden case: its plan, its scripted re-plans, and no bug report prose (the browser's work is what is measured). */
class CaseModel implements JsonModel {
  readonly #entry: GoldenCase
  #replans = 0

  /** Answers for this case. */
  constructor(entry: GoldenCase) {
    this.#entry = entry
  }

  /** Answers one conversation. */
  async ask(messages: readonly PromptMessage[]): Promise<ModelReply> {
    const system = messages[0]?.content ?? ''
    if (system.startsWith('You are a QA engineer writing bug reports')) return { kind: 'json', value: { reports: [] } }
    if (system.includes('A step of your plan failed')) {
      const steps: Lb07Step[] = this.#entry.replans[this.#replans] ?? []
      this.#replans += 1
      return { kind: 'json', value: { reason: 'The page names the control differently.', steps } }
    }
    return { kind: 'json', value: { reading: `Checking: ${this.#entry.title}.`, steps: this.#entry.plan } }
  }
}

/** Reads one number field (in kB) of a file of /proc, or 0 when the process has gone. */
function kilobytes(path: string, field: string): number {
  try {
    const line = readFileSync(path, 'utf8').split('\n').find(entry => entry.startsWith(`${field}:`))
    return Number.parseInt(line?.slice(field.length + 1).trim() ?? '0', 10) || 0
  }
  catch {
    return 0
  }
}

/** The process ids of a process and all its descendants, from /proc. */
function treeOf(root: number): number[] {
  const children = new Map<number, number[]>()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      // The command name sits in parentheses and may hold spaces: the fields after its closing parenthesis are fixed.
      const parent = Number.parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1] ?? '0', 10)
      children.set(parent, [...(children.get(parent) ?? []), Number(name)])
    }
    catch {
      // The process ended while the tree was read.
    }
  }
  const tree: number[] = []
  for (const queue = [root]; queue.length > 0;) {
    const pid = queue.shift() as number
    tree.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return tree
}

/** The memory of a process tree now. */
function memoryOf(root: number): Memory {
  const pids = treeOf(root)
  let rss = 0
  let pss = 0
  for (const pid of pids) {
    rss += kilobytes(`/proc/${pid}/status`, 'VmRSS')
    pss += kilobytes(`/proc/${pid}/smaps_rollup`, 'Pss')
  }
  return { rss, pss, processes: pids.length }
}

/** Writes kibibytes as MiB with one decimal. */
function mib(kib: number): string {
  return (kib / 1_024).toFixed(1)
}

/** Waits for a number of milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A memory cgroup (version 1) the caller made, which the sandbox is moved into: what it charges is what a container's limit counts. */
class Cgroup {
  readonly #directory: string

  /** Uses the cgroup at `directory`. */
  constructor(directory: string) {
    this.#directory = directory
  }

  /** Moves a process into the cgroup; the processes it starts later are in it too. */
  join(pid: number): void {
    writeFileSync(`${this.#directory}/cgroup.procs`, String(pid))
  }

  /** Forgets the highest charge so far, so the next reading is one run's. */
  resetPeak(): void {
    writeFileSync(`${this.#directory}/memory.max_usage_in_bytes`, '0')
  }

  /** The charge now and the highest since the last reset, and of the charge now, the anonymous memory (what cannot be dropped like a cached file), in kibibytes. */
  read(): { current: number, peak: number, anonymous: number } {
    const bytes = (name: string): number => Number(readFileSync(`${this.#directory}/${name}`, 'utf8').trim())
    const stat = readFileSync(`${this.#directory}/memory.stat`, 'utf8').split('\n').find(line => line.startsWith('total_rss '))
    return { current: bytes('memory.usage_in_bytes') / 1_024, peak: bytes('memory.max_usage_in_bytes') / 1_024, anonymous: Number(stat?.split(' ')[1] ?? '0') / 1_024 }
  }
}

const { values } = parseArgs({ options: { 'case': { type: 'string', default: 'everything-on' }, 'runs': { type: 'string', default: '5' }, 'shop-port': { type: 'string', default: '8163' }, 'runner-port': { type: 'string', default: '8164' }, 'cgroup': { type: 'string' }, 'home': { type: 'string' } } })
const browserPath = process.env.LB07_BROWSER_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? ''
const entry = readGoldenSet(`${evalsDirectory()}/lb07/golden.yaml`, readBugCatalogue(seedDirectory())).find(candidate => candidate.id === values.case)
if (!entry) throw new RangeError(`There is no golden case ${values.case}.`)
const runs = Number(values.runs)
const tokenKey = randomBytes(32)
const cgroup = values.cgroup === undefined ? undefined : new Cgroup(values.cgroup)

const sandbox = spawn(process.execPath, [fileURLToPath(new URL('../src/sandbox.ts', import.meta.url))], {
  // A run opens up to three browser sessions (its passes), and the runner counts sessions: enough for every run here.
  env: { PATH: process.env.PATH, HOME: values.home ?? process.env.HOME, LB07_SHOP_PORT: values['shop-port'], LB07_SANDBOX_PORT: values['runner-port'], LB07_SANDBOX_HOST: '127.0.0.1', LB07_SHOP_TOKEN_KEY: tokenKey.toString('hex'), LB07_BROWSER_PATH: browserPath, LB07_RUNS_PER_LIFE: String(runs * 3 + 10) },
  stdio: ['ignore', 'pipe', 'inherit'],
})
cgroup?.join(sandbox.pid ?? 0)
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('The sandbox did not start in 30 seconds.')), 30_000)
  sandbox.stdout.on('data', (chunk: Buffer) => {
    if (chunk.toString().includes('lb07 sandbox: the shop on')) {
      clearTimeout(timer)
      resolve()
    }
  })
})
await pause(1_000)
const runner = new HttpRunner(`http://127.0.0.1:${values['runner-port']}`, runnerKeyFrom(tokenKey))
const started = memoryOf(sandbox.pid ?? 0)
const startedCharge = cgroup?.read()
console.log(`The sandbox, started, before any run (Node only, no browser yet): RSS ${mib(started.rss)} MiB, PSS ${mib(started.pss)} MiB, ${started.processes} process${startedCharge ? `; the cgroup charges ${mib(startedCharge.current)} MiB, ${mib(startedCharge.anonymous)} MiB of it anonymous` : ''}`)
console.log(`Case ${entry.id}: ${entry.plan.length} steps, bugs ${entry.bugs.join(', ') || 'none'}; three passes a run (bugs on, second engine, clean shop)`)
console.log(`run | before RSS | before PSS | peak RSS | peak PSS | peak processes | after RSS | after PSS | seconds | verdict, findings, steps passed${cgroup ? ' | cgroup before | cgroup peak | cgroup after | anonymous after' : ''}`)
try {
  for (let run = 1; run <= runs; run += 1) {
    const before = memoryOf(sandbox.pid ?? 0)
    const chargeBefore = cgroup?.read()
    cgroup?.resetPeak()
    const peak: Memory = { ...before }
    const sampler = setInterval(() => {
      const now = memoryOf(sandbox.pid ?? 0)
      peak.rss = Math.max(peak.rss, now.rss)
      peak.pss = Math.max(peak.pss, now.pss)
      peak.processes = Math.max(peak.processes, now.processes)
    }, 100)
    const runId = `memory-run-${run.toString().padStart(4, '0')}`
    const startedAt = Date.now()
    const result = await runScope(createRun({ system: 'lb-07', runId, dataClass: 'synthetic' }), () => runAgent(
      { runner, model: new CaseModel(entry), guard: undefined, tracer: new Tracer(new NoSpans()), log: { warn: () => {} }, runTimeMs: 180_000, busyWaitMs: 500, busyWaits: 10, shopOrigin: `http://127.0.0.1:${values['shop-port']}`, now: () => Date.now() },
      { runId, goal: entry.goal, bugs: entry.bugs, bugToken: signBugToken(tokenKey, { runId, bugs: [...entry.bugs], exp: Date.now() + TOKEN_LIFETIME_MS }), origin: 'sample' },
      freshWorking(),
      { onState: async () => {}, onSteps: async () => {}, onFinding: async () => {}, onEvidence: async () => {}, save: async () => {} },
    ))
    clearInterval(sampler)
    const seconds = ((Date.now() - startedAt) / 1_000).toFixed(1)
    const peakCharge = cgroup?.read().peak ?? 0
    await pause(1_000)
    const after = memoryOf(sandbox.pid ?? 0)
    const chargeAfter = cgroup?.read()
    const charges = chargeBefore && chargeAfter ? ` | ${mib(chargeBefore.current)} | ${mib(peakCharge)} | ${mib(chargeAfter.current)} | ${mib(chargeAfter.anonymous)}` : ''
    console.log(`${run} | ${mib(before.rss)} | ${mib(before.pss)} | ${mib(peak.rss)} | ${mib(peak.pss)} | ${peak.processes} | ${mib(after.rss)} | ${mib(after.pss)} | ${seconds} | ${result.verification.verdict}, ${result.findings.length}, ${result.steps.filter(step => step.status === 'passed').length}/${result.steps.length}${charges}`)
  }
}
finally {
  sandbox.kill('SIGTERM')
}
