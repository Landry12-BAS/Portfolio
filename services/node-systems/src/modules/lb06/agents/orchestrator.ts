// The agents' orchestrator: an explicit loop in code, with no agent framework. The commander plans
// (one call on lb-reason), the three specialists each get at most two calls on lb-tools (a turn
// that may call tools, which the server runs, and a last turn that must answer), the commander
// ranks the hypotheses and proposes one typed action (one call), and later writes the postmortem's
// prose (one call). Each call gets one repair when its answer fails its schema or its checks.
//
// The step cap is the orchestrator's, not the model's: a call that would pass it is not made, and
// the model is never asked to count. Every evidence reference an agent cites is checked against
// what the server holds, and one it does not hold is dropped and counted. Nothing here changes the
// shop: a proposal is returned to the engine, which applies it only after the visitor's approval.
import { LB06_LIMITS, lb06HypothesisSchema } from '@lb/contracts'
import type { Lb06Agent, Lb06EventInput, Lb06Hypothesis, Lb06Plan, Lb06PostmortemProse, Lb06SpecialistReport } from '@lb/contracts'
import type { Tracer } from '@lb/common'
import type { z } from 'zod'

import { summarise } from '../detect/summary.ts'
import type { IncidentSummary } from '../detect/summary.ts'
import type { World } from '../sim/world.ts'
import type { AgentModels, JsonModel, PromptMessage } from './model.ts'
import { invalidReferences } from './postmortem.ts'
import type { TimelineEntry } from './postmortem.ts'
import { planPrompt, postmortemPrompt, rankingPrompt, repairMessages, specialistPrompt, toolResultMessages } from './prompts.ts'
import { planAnswerSchema, postmortemAnswerSchema, rankingAnswerSchema, specialistTurnSchema } from './schemas.ts'
import type { ProposalAnswer, RankingAnswer } from './schemas.ts'
import { flatArgs, runTool } from './tools.ts'
import type { ToolCall, ToolResult } from './tools.ts'

/** The step cap was reached before a call the investigation needed: the engine ends the incident. */
export class StepCapReached extends Error {
  constructor() {
    super('The incident reached its step cap before the agents finished.')
    this.name = 'StepCapReached'
  }
}

/** A model's answer was unusable after its one repair. */
export class ModelOutputInvalid extends Error {
  readonly problems: string[]

  constructor(step: string, problems: string[]) {
    super(`The ${step} answer was unusable after its repair.`)
    this.name = 'ModelOutputInvalid'
    this.problems = problems
  }
}

/** The incident's budget of model calls: the cap, and how many have been spent (the guard's call included). */
export interface Budget {
  cap: number
  used: number
}

/** What the orchestrator works with. */
export interface OrchestratorDeps {
  models: AgentModels
  tracer: Tracer
  // Appends an event to the incident's log as the agents work, so the board sees each step as it happens.
  emit: (event: Lb06EventInput) => Promise<void>
}

/** What the agents reason over: the world at the investigation's snapshot minute, its summary and its evidence. */
export interface Context {
  world: World
  summary: IncidentSummary
  evidence: ReadonlySet<string>
  minute: number
}

/** Builds the context from the world as it stands, and the kinds of event the log holds. */
export function contextOf(world: World, evidence: ReadonlySet<string>): Context {
  return { world, summary: summarise(world), evidence, minute: world.minutes - 1 }
}

/** What the investigation produced. */
export interface Investigation {
  plan: Lb06Plan
  reports: Lb06SpecialistReport[]
  hypotheses: Lb06Hypothesis[]
  proposal: ProposalAnswer
  // How many evidence references the agents cited that the server did not hold.
  discarded: number
}

/** What a second ranking produced, after a remediation that did not bring the SLO back. */
export interface Reranking {
  hypotheses: Lb06Hypothesis[]
  proposal: ProposalAnswer
  discarded: number
}

/** Spends one model call of the budget, or refuses when the cap is reached. */
function spend(budget: Budget): number {
  if (budget.used >= budget.cap) throw new StepCapReached()
  budget.used += 1
  return budget.used
}

/** The problems with a parsed answer: none, or the schema's issues in words. */
function problemsOf(parsed: z.ZodSafeParseResult<unknown>): string[] {
  if (parsed.success) return []
  return parsed.error.issues.slice(0, 8).map(issue => `${issue.path.join('.') || 'answer'}: ${issue.message}`)
}

/** The text of a reply, for the repair message: the JSON as it was, or the text that was not JSON. */
function textOf(reply: { kind: 'json', value: unknown } | { kind: 'text', text: string }): string {
  return reply.kind === 'json' ? JSON.stringify(reply.value) : reply.text.slice(0, 2_000)
}

/** What one checked call needs: the model, the messages, the schema, the extra checks, and how to name it. */
interface Ask<Answer> {
  model: JsonModel
  messages: PromptMessage[]
  schema: z.ZodType<Answer>
  // Checks beyond the schema; each problem found is a reason for the one repair.
  check?: (answer: Answer) => string[]
  stepName: string
  agent: Lb06Agent
}

/**
 * Asks a model once, and once more with the problems when the answer fails its schema or its checks.
 * Each call is a span of the incident's trace and spends one of the budget's calls. Two failures end it.
 */
async function askChecked<Answer>(deps: OrchestratorDeps, budget: Budget, ask: Ask<Answer>): Promise<{ answer: Answer, repaired: boolean }> {
  let messages = ask.messages
  let lastProblems: string[] = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const step = spend(budget)
    const reply = await deps.tracer.span(ask.stepName, async (span) => {
      span.set('agent', ask.agent)
      span.set('step', step)
      span.set('repair', attempt === 1)
      return ask.model.ask(messages)
    }, { kind: 'system.step' })
    const parsed = reply.kind === 'json' ? ask.schema.safeParse(reply.value) : undefined
    const problems = parsed === undefined ? ['the answer was not a JSON object'] : [...problemsOf(parsed), ...(parsed.success && ask.check ? ask.check(parsed.data) : [])]
    if (parsed?.success && problems.length === 0) return { answer: parsed.data, repaired: attempt === 1 }
    lastProblems = problems
    messages = [...messages, ...repairMessages(textOf(reply), problems)]
  }
  throw new ModelOutputInvalid(ask.stepName, lastProblems)
}

/** Keeps the evidence references the server holds, and counts the rest. */
function verifyEvidence(references: readonly string[], evidence: ReadonlySet<string>): { kept: string[], dropped: number } {
  const kept = [...new Set(references.filter(reference => evidence.has(reference)))]
  return { kept, dropped: references.filter(reference => !evidence.has(reference)).length }
}

/** Reports evidence the agents cited and the server did not hold. */
async function reportDiscarded(deps: OrchestratorDeps, context: Context, agent: Lb06Agent, count: number): Promise<void> {
  if (count > 0) await deps.emit({ kind: 'evidence.discarded', minute: context.minute, data: { agent, count } })
}

/** The commander's plan: one call, one repair. */
async function plan(deps: OrchestratorDeps, context: Context, budget: Budget): Promise<Lb06Plan> {
  const { answer, repaired } = await askChecked(deps, budget, { model: deps.models.reason, messages: planPrompt(context.summary), schema: planAnswerSchema, stepName: 'commander plans', agent: 'commander' })
  // One question per specialist: a second question to the same specialist is dropped.
  const seen = new Set<string>()
  const questions = answer.questions.filter((question) => {
    if (seen.has(question.agent)) return false
    seen.add(question.agent)
    return true
  })
  const kept: Lb06Plan = { questions }
  await deps.emit({ kind: 'agent.step', minute: context.minute, data: { step: budget.used, agent: 'commander', kind: repaired ? 'repair' : 'plan', plan: kept, modelCall: true } })
  return kept
}

/** Runs the tool calls of a turn, recording each as a step that cost no model call. */
async function runTools(deps: OrchestratorDeps, context: Context, budget: Budget, agent: 'logs' | 'metrics' | 'deploys', calls: readonly ToolCall[]): Promise<{ results: ToolResult[], made: Lb06SpecialistReport['toolCalls'] }> {
  const results: ToolResult[] = []
  const made: Lb06SpecialistReport['toolCalls'] = []
  for (const call of calls) {
    const result = await deps.tracer.span(`tool ${call.tool}`, async (span) => {
      span.set('agent', agent)
      span.set('tool', call.tool)
      const answer = runTool(context.world, call)
      span.set('rows', answer.rows.length)
      return answer
    }, { kind: 'system.tool' })
    results.push(result)
    const record = { tool: call.tool, args: flatArgs(call), rows: result.rows.length }
    made.push(record)
    await deps.emit({ kind: 'agent.step', minute: context.minute, data: { step: budget.used, agent, kind: 'tool_call', toolCall: record, modelCall: false } })
  }
  return { results, made }
}

/**
 * One specialist: a first turn that may call tools, and, when it did, a last turn that must answer.
 * Findings cite only evidence the server holds; the rest is dropped and counted.
 */
async function specialist(deps: OrchestratorDeps, context: Context, budget: Budget, agent: 'logs' | 'metrics' | 'deploys', question: string): Promise<{ report: Lb06SpecialistReport, dropped: number }> {
  const toolCalls: Lb06SpecialistReport['toolCalls'] = []
  let messages = specialistPrompt(agent, question, context.summary, false)
  let findings: Lb06SpecialistReport['findings'] = []
  let repaired = false
  for (let turn = 0; turn < 2; turn += 1) {
    const lastTurn = turn === 1
    const asked = await askChecked(deps, budget, { model: deps.models.tools, messages, schema: specialistTurnSchema, stepName: `${agent} agent ${lastTurn ? 'answers' : 'investigates'}`, agent })
    repaired = repaired || asked.repaired
    if ('findings' in asked.answer) {
      findings = asked.answer.findings
      break
    }
    if (lastTurn) break
    const { results, made } = await runTools(deps, context, budget, agent, asked.answer.toolCalls)
    toolCalls.push(...made)
    messages = [...specialistPrompt(agent, question, context.summary, true), ...toolResultMessages(JSON.stringify(asked.answer), results)]
  }
  let dropped = 0
  const verified = findings.map((finding) => {
    const { kept, dropped: count } = verifyEvidence(finding.evidence, context.evidence)
    dropped += count
    return { text: finding.text, evidence: kept }
  })
  const report: Lb06SpecialistReport = { agent, findings: verified, toolCalls: toolCalls.slice(0, 4) }
  await reportDiscarded(deps, context, agent, dropped)
  await deps.emit({ kind: 'agent.step', minute: context.minute, data: { step: budget.used, agent, kind: repaired ? 'repair' : 'report', report, modelCall: true } })
  return { report, dropped }
}

/** The checks on a proposal beyond its schema: it names a hypothesis that was ranked, a version the history shows, a flag the shop has. */
function proposalProblems(context: Context, answer: RankingAnswer): string[] {
  const problems: string[] = []
  if (!answer.hypotheses.some(hypothesis => hypothesis.id === answer.proposal.hypothesisId)) problems.push('proposal.hypothesisId: names no hypothesis of the ranking')
  const ids = answer.hypotheses.map(hypothesis => hypothesis.id)
  if (new Set(ids).size !== ids.length) problems.push('hypotheses: two hypotheses share an id')
  const action = answer.proposal.action
  if (action.kind === 'rollback') {
    const known = context.world.deploys.some(deploy => deploy.service === action.service && (deploy.previousVersion === action.toVersion || deploy.version === action.toVersion))
    if (!known) problems.push(`proposal.action.toVersion: the deploy history of ${action.service} shows no version ${action.toVersion}`)
  }
  if (action.kind === 'flip_flag' && !context.world.flags.some(flag => flag.name === action.flag)) problems.push(`proposal.action.flag: the shop has no flag ${action.flag}`)
  return problems
}

/** The commander's ranking and proposal: one call, one repair; the hypotheses' evidence verified. */
async function rank(deps: OrchestratorDeps, context: Context, budget: Budget, reports: readonly Lb06SpecialistReport[], tried: readonly string[]): Promise<Reranking> {
  const { answer, repaired } = await askChecked(deps, budget, {
    model: deps.models.reason,
    messages: rankingPrompt(context.summary, reports, tried),
    schema: rankingAnswerSchema,
    check: parsed => proposalProblems(context, parsed),
    stepName: tried.length === 0 ? 'commander ranks hypotheses' : 'commander ranks again',
    agent: 'commander',
  })
  let discarded = 0
  const hypotheses = answer.hypotheses.map((hypothesis) => {
    const { kept, dropped } = verifyEvidence(hypothesis.evidence, context.evidence)
    discarded += dropped
    return lb06HypothesisSchema.parse({ ...hypothesis, evidence: kept })
  })
  await reportDiscarded(deps, context, 'commander', discarded)
  await deps.emit({ kind: 'agent.step', minute: context.minute, data: { step: budget.used, agent: 'commander', kind: repaired ? 'repair' : 'ranking', modelCall: true } })
  await deps.emit({ kind: 'hypotheses.ranked', minute: context.minute, data: { hypotheses } })
  return { hypotheses, proposal: answer.proposal, discarded }
}

/** The whole investigation: the plan, the specialists, the ranking and the first proposal. */
export async function investigate(deps: OrchestratorDeps, context: Context, budget: Budget): Promise<Investigation> {
  const thePlan = await plan(deps, context, budget)
  const reports: Lb06SpecialistReport[] = []
  let discarded = 0
  for (const question of thePlan.questions) {
    const { report, dropped } = await specialist(deps, context, budget, question.agent, question.question)
    reports.push(report)
    discarded += dropped
  }
  const ranking = await rank(deps, context, budget, reports, [])
  return { plan: thePlan, reports, hypotheses: ranking.hypotheses, proposal: ranking.proposal, discarded: discarded + ranking.discarded }
}

/** A new ranking after a remediation that did not bring the SLO back: one call, with what was tried. */
export function proposeAgain(deps: OrchestratorDeps, context: Context, budget: Budget, reports: readonly Lb06SpecialistReport[], tried: readonly string[]): Promise<Reranking> {
  return rank(deps, context, budget, reports, tried)
}

/** The postmortem's prose: one call and one repair when the budget allows, null when it does not or the prose cannot be trusted. */
export async function writePostmortem(deps: OrchestratorDeps, timeline: readonly TimelineEntry[], budget: Budget, minute: number): Promise<Lb06PostmortemProse | null> {
  if (budget.used >= budget.cap) return null
  try {
    const { answer, repaired } = await askChecked(deps, budget, {
      model: deps.models.reason,
      messages: postmortemPrompt(timeline),
      schema: postmortemAnswerSchema,
      check: (prose) => {
        const invalid = invalidReferences(prose, timeline)
        return invalid.length === 0 ? [] : [`references: the timeline holds no event of kind ${invalid.join(', ')}`]
      },
      stepName: 'commander writes the postmortem',
      agent: 'commander',
    })
    await deps.emit({ kind: 'agent.step', minute, data: { step: budget.used, agent: 'commander', kind: repaired ? 'repair' : 'postmortem', modelCall: true } })
    return answer
  }
  catch (error) {
    // Out of steps or unusable twice: the timeline stands on its own, and the prose is left out.
    if (error instanceof StepCapReached || error instanceof ModelOutputInvalid) return null
    throw error
  }
}

/** The most model calls an incident may spend, from the limits. */
export const STEP_CAP = LB06_LIMITS.stepCap
