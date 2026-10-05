// The job that runs one run: read it, start the agent with what an earlier attempt saved, write what the
// agent does as it does it, and end the run as done or as failed. The queue (queue.ts) calls it with the
// run's id and which attempt this is.
//
// A retry resumes what cost a model call (the guard, the plan, the reports) and runs the browser passes
// again from the plan: the steps and findings of a pass that was cut short are forgotten first, so the
// visitor sees one clean pass. Ending a run is a single guarded transition, so a job that runs twice, or
// late, cannot end a finished run again or give a place back twice.
import { createRun, runScope, spanScope } from '@lb/common'
import type { Lb07FailureCode } from '@lb/contracts'

import { runAgent } from '../agent/machine.ts'
import type { MachineHooks } from '../agent/machine.ts'
import type { Lb07Deps } from './deps.ts'
import { reactionTo, RunRetry } from './failures.ts'
import { abandonQueuedRun, addEvidence, addFinding, clearFindings, completeRun, countAttempt, failRun, readRunForWork, readWorking, replaceSteps, saveWorking, setState } from './store.ts'
import type { RunRow } from './store.ts'
import { recordRunEnd, rootSpanIdOf } from './trace.ts'

/** Which attempt a job is on. */
export interface Attempt {
  number: number
  last: boolean
}

/** Writes the root span of a run that has just ended, from what the database now says of it. */
async function recordEnd(deps: Lb07Deps, runId: string, outcome: string): Promise<void> {
  const row = await readRunForWork(deps.db, runId, deps.now())
  if (!row) return
  await recordRunEnd(deps, { runId, sessionKey: row.sessionKey, origin: row.origin, startMs: row.createdAt.getTime(), endMs: deps.now().getTime(), outcome, modelCalls: row.modelCalls, findings: row.findingsCount, replans: row.replans, bugs: row.bugs.length })
}

/** Ends the run as failed, and writes the root span if this call is the one that ended it. */
async function fail(deps: Lb07Deps, runId: string, code: Lb07FailureCode): Promise<void> {
  if (await failRun(deps.db, runId, code, deps.now())) await recordEnd(deps, runId, code)
}

/** Ends a run that waited too long in the queue, unless a worker started it meanwhile, and writes its root span. Returns whether it was ended. */
export async function abandonOverdue(deps: Lb07Deps, runId: string): Promise<boolean> {
  if (!(await abandonQueuedRun(deps.db, runId, deps.now(), deps.config.maxQueueWaitMs))) return false
  await recordEnd(deps, runId, 'runner_unavailable')
  return true
}

/** The hooks the agent reports through: its states, steps, findings and evidence are the run's. */
function hooksFor(deps: Lb07Deps, runId: string): MachineHooks {
  return {
    onState: async (state) => {
      await setState(deps.db, runId, state, deps.now())
    },
    onSteps: async (views) => {
      await replaceSteps(deps.db, runId, views, deps.now())
    },
    onFinding: async (finding) => {
      await addFinding(deps.db, runId, finding, deps.now())
    },
    onEvidence: async (record) => {
      await addEvidence(deps.db, runId, record, deps.now())
    },
    save: async (working) => {
      await saveWorking(deps.db, runId, working, deps.now())
    },
  }
}

/** The work of one attempt: run the agent and end the run as done. Errors go to the caller. */
async function attempt(deps: Lb07Deps, row: RunRow): Promise<void> {
  if (!deps.agent) {
    deps.log.error({ runId: row.id }, 'a run was queued in a process with no model gateway')
    await fail(deps, row.id, 'planning_unavailable')
    return
  }
  if (!deps.sandbox) {
    deps.log.error({ runId: row.id }, 'a run was queued in a process with no browser runner configured (LB07_RUNNER_URL, LB07_SHOP_TOKEN_KEY)')
    await fail(deps, row.id, 'runner_unavailable')
    return
  }
  await clearFindings(deps.db, row.id)
  await replaceSteps(deps.db, row.id, [], deps.now())
  const result = await runAgent(
    {
      runner: deps.sandbox.runner,
      model: deps.agent.model,
      guard: deps.agent.guard,
      tracer: deps.tracer,
      log: deps.log,
      runTimeMs: deps.config.runTimeMs,
      busyWaitMs: deps.config.busyWaitMs,
      busyWaits: deps.config.busyWaits,
      shopOrigin: deps.sandbox.shopOrigin,
      now: () => deps.now().getTime(),
    },
    { runId: row.id, goal: row.goal, bugs: row.bugs, bugToken: deps.sandbox.signToken(row.id, row.bugs), origin: row.origin },
    await readWorking(deps.db, row.id),
    hooksFor(deps, row.id),
  )
  if (await completeRun(deps.db, row, result, deps.now())) await recordEnd(deps, row.id, 'done')
}

/** Does one attempt, and turns what goes wrong into what the queue needs: a run ended as failed, or an error that asks for another attempt. */
async function tryRun(deps: Lb07Deps, row: RunRow, which: Attempt): Promise<void> {
  try {
    await attempt(deps, row)
  }
  catch (error) {
    const reaction = reactionTo(error)
    if (reaction?.kind === 'fail') {
      await fail(deps, row.id, reaction.code)
      return
    }
    if (which.last) {
      deps.log.warn({ runId: row.id, error: error instanceof Error ? error.name : 'unknown' }, 'a run ran out of attempts')
      await fail(deps, row.id, reaction ? (error instanceof Error && error.name === 'RunnerError' ? 'runner_unavailable' : 'planning_unavailable') : 'internal')
      return
    }
    throw new RunRetry(reaction?.kind === 'retry' ? reaction.retryAfterSeconds : undefined)
  }
}

/** Runs one run. Does nothing for a run that is gone, expired or ended. Throws `RunRetry` when the queue should try again. */
export async function runJob(deps: Lb07Deps, runId: string, which: Attempt): Promise<void> {
  const row = await readRunForWork(deps.db, runId, deps.now())
  if (!row || row.state === 'done' || row.state === 'failed') return
  const run = createRun({ system: 'lb-07', runId: row.id, session: row.sessionKey, dataClass: row.origin === 'sample' ? 'synthetic' : 'visitor' })
  await runScope(run, async () => spanScope(rootSpanIdOf(row.id), async () => {
    const starts = await countAttempt(deps.db, row.id, deps.now())
    // The run ended between the read and the start (the sweep ended it for waiting too long): nothing to do.
    if (starts === 0) return
    if (starts > deps.config.maxAttempts * 2) {
      deps.log.warn({ runId: row.id }, 'a run was started too often')
      await fail(deps, row.id, 'internal')
      return
    }
    await tryRun(deps, row, which)
  }))
}
