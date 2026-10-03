// Running one golden case through the whole simulator, the detection, the orchestrator and the
// postmortem, in one process and with no database: the world ticks minute by minute, the alert
// fires, the agents investigate the snapshot, the first proposal is approved at once (the grader
// judges the proposal, not the visitor), the remediation is applied, the SLO's recovery is measured
// by code and the postmortem is written. Only the models are replaceable: the offline test gives
// it the reference agents, the live eval command the gateway's.
import { LB06_LIMITS } from '@lb/contracts'
import type { Lb06Action, Lb06Event, Lb06EventInput } from '@lb/contracts'
import { createRun, newRunId, runScope } from '@lb/common'
import type { Tracer } from '@lb/common'

import type { AgentModels } from '../agents/model.ts'
import { contextOf, investigate, proposeAgain, writePostmortem } from '../agents/orchestrator.ts'
import type { Budget } from '../agents/orchestrator.ts'
import { invalidReferences, timelineOf } from '../agents/postmortem.ts'
import { firstAlertMinute, recoveryMinute, sloAt } from '../detect/slo.ts'
import { evidenceIndex } from '../detect/summary.ts'
import { faultService } from '../sim/deploys.ts'
import type { Remediation } from '../sim/faults.ts'
import { buildWorld } from '../sim/world.ts'
import { gradeOutcome } from './grade.ts'
import type { CaseGrade, IncidentOutcome } from './grade.ts'
import { scenarioOf } from './cases.ts'
import type { GoldenCase } from './cases.ts'

/** What a run is built from. */
export interface RunDeps {
  models: AgentModels
  tracer: Tracer
  // Runs one case's work inside whatever scope its model calls need (the live command gives each case a run of its own).
  scope?: <Result>(work: () => Promise<Result>) => Promise<Result>
  // Model calls already spent on the case before the agents start (the guard's), for the budget.
  startingCalls?: number
}

/** How a run is paced and which cases it runs. */
export interface RunOptions {
  caseIds?: ReadonlySet<string>
  afterCase?: (grade: CaseGrade) => Promise<void>
}

// How many minutes the shop ticks after the alert before the agents look at it, and how long after a remediation recovery is waited for.
const MINUTES_BEFORE_INVESTIGATION = 2
const MINUTES_TO_RECOVER = 20
const MINUTES_AFTER_PROPOSAL = 1

/** An event log in memory, numbered without gaps and stamped with a fixed clock. */
export class MemoryLog {
  readonly events: Lb06Event[] = []

  /** Appends an event. */
  append(input: Lb06EventInput): Lb06Event {
    const event = { ...input, seq: this.events.length + 1, at: new Date(Date.UTC(2026, 9, 3, 12, 0, this.events.length)).toISOString() } as Lb06Event
    this.events.push(event)
    return event
  }

  /** The kinds the log holds, for the evidence index. */
  kinds(): string[] {
    return [...new Set(this.events.map(event => event.kind))]
  }
}

/** Runs work as a run of its own over synthetic data, which is what every golden case is. */
function syntheticRun<Result>(work: () => Promise<Result>): Promise<Result> {
  return runScope(createRun({ system: 'lb-06', runId: newRunId(), dataClass: 'synthetic' }), work)
}

/** Runs one case and returns what the grader reads, with the log it left. */
export async function runCase(deps: RunDeps, entry: GoldenCase): Promise<{ outcome: IncidentOutcome, log: MemoryLog }> {
  const scenario = scenarioOf(entry)
  const log = new MemoryLog()
  const remediations: Remediation[] = []
  const budget: Budget = { cap: LB06_LIMITS.stepCap, used: deps.startingCalls ?? 0 }
  const emit = async (event: Lb06EventInput) => {
    log.append(event)
  }
  const orchestrator = { models: deps.models, tracer: deps.tracer, emit }
  log.append({ kind: 'incident.started', minute: 0, data: scenario })
  for (let minute = 0; minute < scenario.baselineMinutes; minute += 1) log.append({ kind: 'tick', minute, data: {} })
  log.append({ kind: 'fault.injected', minute: scenario.baselineMinutes, data: { fault: scenario.fault, service: faultService(scenario.fault) } })

  const proposals: Lb06Action[] = []
  let recovered = false
  let closed = false
  let prose = null as Awaited<ReturnType<typeof writePostmortem>>
  let referencesValid = true
  let discarded = 0
  let hypotheses: IncidentOutcome['hypotheses'] = []

  const work = async () => {
    // Tick until the alert, then a couple of minutes more, so the summary has something to show.
    const calm = buildWorld(scenario, [], LB06_LIMITS.maxSimulatedMinutes)
    const alert = firstAlertMinute(calm, scenario.baselineMinutes) ?? scenario.baselineMinutes + 5
    for (let minute = scenario.baselineMinutes; minute <= alert; minute += 1) log.append({ kind: 'tick', minute, data: {} })
    log.append({ kind: 'alert.fired', minute: alert, data: { burn: sloAt(calm, alert).burns[0] as NonNullable<ReturnType<typeof sloAt>['burns'][0]> } })
    let minute = alert
    for (let extra = 0; extra < MINUTES_BEFORE_INVESTIGATION; extra += 1) {
      minute += 1
      log.append({ kind: 'tick', minute, data: {} })
    }
    log.append({ kind: 'investigation.started', minute, data: { snapshotMinute: minute } })
    let world = buildWorld(scenario, remediations, minute + 1)
    let context = contextOf(world, evidenceIndex(world, log.kinds()))
    const investigation = await investigate(orchestrator, context, budget)
    hypotheses = investigation.hypotheses
    discarded += investigation.discarded
    let proposal = investigation.proposal

    for (let round = 1; round <= LB06_LIMITS.maxProposals; round += 1) {
      const id = `p${round}` as 'p1' | 'p2' | 'p3'
      proposals.push(proposal.action)
      log.append({ kind: 'proposal.made', minute, data: { proposalId: id, hypothesisId: proposal.hypothesisId, action: proposal.action, rationale: proposal.rationale } })
      minute += MINUTES_AFTER_PROPOSAL
      log.append({ kind: 'tick', minute, data: {} })
      log.append({ kind: 'proposal.approved', minute, data: { proposalId: id } })
      remediations.push({ minute, action: proposal.action })
      log.append({ kind: 'remediation.applied', minute, data: { proposalId: id, action: proposal.action } })
      const after = buildWorld(scenario, remediations, minute + MINUTES_TO_RECOVER + 1)
      const recoveredAt = recoveryMinute(after, minute, LB06_LIMITS.recoveryMinutes)
      const until = recoveredAt ?? minute + MINUTES_TO_RECOVER
      for (let tick = minute + 1; tick <= until; tick += 1) log.append({ kind: 'tick', minute: tick, data: {} })
      minute = until
      if (recoveredAt !== undefined) {
        recovered = true
        log.append({ kind: 'slo.recovered', minute, data: { healthyMinutes: LB06_LIMITS.recoveryMinutes } })
        break
      }
      if (round === LB06_LIMITS.maxProposals) break
      world = buildWorld(scenario, remediations, minute + 1)
      context = contextOf(world, evidenceIndex(world, log.kinds()))
      const again = await proposeAgain(orchestrator, context, budget, investigation.reports, proposals.map(action => JSON.stringify(action)))
      discarded += again.discarded
      proposal = again.proposal
    }

    if (recovered) {
      const timeline = timelineOf(log.events)
      prose = await writePostmortem(orchestrator, timeline, budget, minute)
      referencesValid = prose === null ? false : invalidReferences(prose, timeline).length === 0
      log.append({ kind: 'postmortem.written', minute, data: { prose, modelCalls: budget.used } })
      log.append({ kind: 'incident.closed', minute, data: { modelCalls: budget.used, proposals: proposals.length } })
      closed = true
    }
    else {
      log.append({ kind: 'incident.aborted', minute, data: { reason: 'proposals_spent' } })
    }
  }
  await (deps.scope ?? syntheticRun)(work)

  return {
    outcome: { hypotheses, proposals, evidenceDiscarded: discarded, modelCalls: budget.used, recovered, closed, postmortem: { prose, referencesValid } },
    log,
  }
}

/** Writes a grade for a case that could not be run: only the error's name is kept. */
function unavailable(entry: GoldenCase, error: unknown): CaseGrade {
  const name = error instanceof Error ? error.name : 'unknown error'
  return { caseId: entry.id, failures: [`unavailable: ${name}`], modelCalls: 0, evidenceDiscarded: 0 }
}

/** Runs the chosen cases, grades each, and returns the grades in the set's order. */
export async function evaluate(deps: RunDeps, cases: readonly GoldenCase[], options: RunOptions = {}): Promise<CaseGrade[]> {
  const grades: CaseGrade[] = []
  for (const entry of cases) {
    if (options.caseIds && !options.caseIds.has(entry.id)) continue
    let grade: CaseGrade
    try {
      const { outcome } = await runCase(deps, entry)
      grade = gradeOutcome(entry, outcome)
    }
    catch (error) {
      grade = unavailable(entry, error)
    }
    grades.push(grade)
    if (options.afterCase) await options.afterCase(grade)
  }
  return grades
}
