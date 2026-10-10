// The run a piece of work belongs to, and the span it is currently inside.
//
// A run is one visitor action, such as describing a workflow, from start to finish. The
// system's own steps and every model call behind them are recorded against the run's ID,
// so the Scope can draw the whole trace, and the gateway counts the run's calls against
// its quotas.
//
// The current run and span live in an AsyncLocalStorage store. They follow the code
// through awaits, timers and promise chains, so the gateway client can label every call
// without the run being passed along by hand. Start a run with `runScope`; the tracer
// opens spans inside it. This is the twin of python/lb-common's lb_common.run.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'

/** Whose content a run carries: a visitor's own input, or the site's synthetic samples. */
export type DataClass = 'visitor' | 'synthetic'

// The formats the gateway accepts (services/gateway/src/call.ts). ASCII only: \w without
// the unicode flag is [A-Za-z0-9_].
const SYSTEM_KEY = /^lb-\d{2}$/
const RUN_ID = /^[\w-]{8,64}$/
const SESSION_KEY = /^[\w-]{16,128}$/
const SPAN_ID = /^[0-9a-f]{16}$/

/** Thrown when something that belongs to a run (a model call, a span) is attempted outside any run. */
export class OutsideRunError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutsideRunError'
  }
}

/**
 * One visitor action from start to finish. `system` is a part number such as `lb-08`.
 * `session` is the visitor's hashed session key, never the raw cookie: a visitor run
 * must have one, so the visitor's daily quota applies. Runs over synthetic samples have none.
 */
export interface Run {
  readonly system: string
  readonly runId: string
  readonly dataClass: DataClass
  readonly session: string | undefined
}

/** What `createRun` needs to know; the data class is `visitor` unless said otherwise. */
export interface RunInput {
  system: string
  runId: string
  dataClass?: DataClass
  session?: string | undefined
}

/** Checks every field against the gateway's rules, so a bad run fails before its first call. */
export function createRun(input: RunInput): Run {
  const dataClass = input.dataClass ?? 'visitor'
  if (!SYSTEM_KEY.test(input.system)) throw new RangeError(`${JSON.stringify(input.system)} is not a system part number such as lb-08.`)
  if (!RUN_ID.test(input.runId)) throw new RangeError('A run ID is 8 to 64 letters, digits, underscores or hyphens.')
  if (dataClass !== 'visitor' && dataClass !== 'synthetic') throw new RangeError('The data class is visitor or synthetic.')
  if (input.session !== undefined && !SESSION_KEY.test(input.session)) throw new RangeError('A session key is 16 to 128 letters, digits, underscores or hyphens.')
  if (dataClass === 'visitor' && input.session === undefined) throw new RangeError('A visitor run needs the visitor\'s session key, so their daily quota applies.')
  return { system: input.system, runId: input.runId, dataClass, session: input.session }
}

/** Makes a random run ID: 22 characters, safe in URLs and in Redis keys. */
export function newRunId(): string {
  return randomBytes(16).toString('base64url')
}

/** What the store holds: the current run, and the innermost open span in it. */
interface Scope {
  run: Run
  spanId: string | undefined
}

const storage = new AsyncLocalStorage<Scope>()

/** Returns the run the code is running in, or undefined outside any run. */
export function currentRun(): Run | undefined {
  return storage.getStore()?.run
}

/** Returns the ID of the innermost open span, or undefined when no span is open. */
export function currentSpanId(): string | undefined {
  return storage.getStore()?.spanId
}

/** Runs `work` with `run` as the current run, starting with no open span. */
export function runScope<Result>(run: Run, work: () => Result): Result {
  return storage.run({ run, spanId: undefined }, work)
}

/**
 * Runs `work` with `spanId` as the innermost open span. The tracer calls this; model
 * calls made inside the work nest under the span in the trace.
 */
export function spanScope<Result>(spanId: string, work: () => Result): Result {
  if (!SPAN_ID.test(spanId)) throw new RangeError('A span ID is 16 lowercase hex digits.')
  const scope = storage.getStore()
  if (!scope) throw new OutsideRunError('Spans belong to a run: open one with runScope() first.')
  return storage.run({ run: scope.run, spanId }, work)
}
