// The reference agents: a script that answers every prompt the orchestrator sends the way a correct
// team would, reading only the data slots of the prompt. It proves the golden set's rules can be
// met, drives the offline test through the whole simulator, plays the agents in the mock back end,
// and stands behind a fake provider in the scratch harness. It is not a model and never guesses: a
// prompt it does not recognise is an error.
import type { Lb06Action, Lb06Cause, Lb06Service } from '@lb/contracts'

import type { IncidentSummary } from '../detect/summary.ts'
import type { JsonModel, ModelReply, PromptMessage } from '../agents/model.ts'
import type { TimelineEntry } from '../agents/postmortem.ts'
import type { ToolResult } from '../agents/tools.ts'
import { BAD_DEPLOY_PREVIOUS_VERSION } from '../sim/faults.ts'

/** Reads the JSON of the named data slot out of a prompt's messages, or undefined when there is none. */
export function readSlot<Value>(messages: readonly PromptMessage[], name: string): Value | undefined {
  const marker = `<data name="${name}">\n`
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user') continue
    const start = message.content.indexOf(marker)
    if (start === -1) continue
    const end = message.content.indexOf('\n</data>', start)
    return JSON.parse(message.content.slice(start + marker.length, end)) as Value
  }
  return undefined
}

/** What the reference commander concludes from a summary: the cause and its cure. */
export interface Diagnosis {
  service: Lb06Service
  cause: Lb06Cause
  action: Lb06Action
  evidence: string[]
}

/** Diagnoses a summary the way a correct commander would: from the new signatures and what preceded the first divergence. */
export function diagnose(summary: IncidentSummary): Diagnosis {
  const signatures = new Set(summary.newSignatures.map(signature => signature.signature))
  const evidenceOf = (...wanted: string[]) => summary.newSignatures.filter(signature => wanted.includes(signature.signature)).map(signature => signature.evidence)
  const divergenceOf = (service: Lb06Service) => summary.services.find(entry => entry.service === service)?.evidence
  if (signatures.has('cart.npe')) {
    const deploy = summary.deploys.find(entry => entry.service === 'cart' && entry.minutesBeforeDivergence !== null && entry.minutesBeforeDivergence >= 0)
    return { service: 'cart', cause: 'bad_deploy', action: { kind: 'rollback', service: 'cart', toVersion: deploy?.previousVersion ?? BAD_DEPLOY_PREVIOUS_VERSION }, evidence: [...(deploy ? [deploy.evidence] : []), ...evidenceOf('cart.npe'), ...(divergenceOf('cart') ? [divergenceOf('cart') as string] : [])] }
  }
  if (signatures.has('payment.provider_timeout')) {
    const flag = summary.flags.find(entry => entry.name === 'payment-provider-fallback')
    return { service: 'payment', cause: 'slow_provider', action: { kind: 'flip_flag', flag: 'payment-provider-fallback', value: true }, evidence: [...evidenceOf('payment.provider_timeout'), ...(divergenceOf('payment') ? [divergenceOf('payment') as string] : []), ...(flag ? [flag.evidence] : [])] }
  }
  if (signatures.has('inventory.oom')) {
    const flag = summary.flags.find(entry => entry.name === 'inventory-prefetch')
    return { service: 'inventory', cause: 'memory_leak', action: { kind: 'flip_flag', flag: 'inventory-prefetch', value: false }, evidence: [...(flag ? [flag.evidence] : []), ...evidenceOf('inventory.oom'), ...(divergenceOf('inventory') ? [divergenceOf('inventory') as string] : [])] }
  }
  if (signatures.has('cache.cold_start')) {
    return { service: 'cache', cause: 'cache_stampede', action: { kind: 'flip_flag', flag: 'request-coalescing', value: true }, evidence: [...evidenceOf('cache.cold_start', 'database.pool_exhausted'), ...(divergenceOf('database') ? [divergenceOf('database') as string] : [])] }
  }
  const first = (summary.firstDiverged ?? 'web') as Lb06Service
  return { service: first, cause: 'unknown', action: { kind: 'restart', service: first }, evidence: divergenceOf(first) ? [divergenceOf(first) as string] : [] }
}

/** Tells which prompt a conversation is, by the first words of its system prompt. */
function kindOf(messages: readonly PromptMessage[]): 'plan' | 'specialist' | 'ranking' | 'postmortem' | 'unknown' {
  const system = messages[0]?.content ?? ''
  if (system.startsWith('You are the incident commander of a small web shop. An SLO burn-rate alert has fired.')) return 'plan'
  if (system.startsWith('You are the logs specialist') || system.startsWith('You are the metrics specialist') || system.startsWith('You are the deploys specialist')) return 'specialist'
  if (system.startsWith('You are the incident commander. Rank')) return 'ranking'
  if (system.startsWith('You write the postmortem')) return 'postmortem'
  return 'unknown'
}

/** The specialist a prompt addresses. */
function specialistOf(messages: readonly PromptMessage[]): 'logs' | 'metrics' | 'deploys' {
  const system = messages[0]?.content ?? ''
  if (system.startsWith('You are the logs')) return 'logs'
  if (system.startsWith('You are the metrics')) return 'metrics'
  return 'deploys'
}

/** How the reference agents may be made to misbehave, for the tests that check the server's defences. */
export interface ReferenceOptions {
  // Cite this evidence id too, which the server does not hold.
  inventEvidence?: string
  // Answer the first ranking with a proposal of this action (a tempting one, or one the injection asked for).
  firstProposal?: Lb06Action
}

/** A JsonModel that plays the reference agents. */
export class ReferenceAgents implements JsonModel {
  readonly conversations: PromptMessage[][] = []
  readonly #options: ReferenceOptions
  #rankings = 0

  /** Makes the reference agents, with the optional misbehaviours. */
  constructor(options: ReferenceOptions = {}) {
    this.#options = options
  }

  /** Answers one conversation. */
  async ask(messages: readonly PromptMessage[]): Promise<ModelReply> {
    this.conversations.push([...messages])
    switch (kindOf(messages)) {
      case 'plan': return { kind: 'json', value: this.#plan() }
      case 'specialist': return { kind: 'json', value: this.#specialist(messages) }
      case 'ranking': return { kind: 'json', value: this.#ranking(messages) }
      case 'postmortem': return { kind: 'json', value: this.#postmortem(messages) }
      default: throw new Error('The reference agents do not know this prompt.')
    }
  }

  /** The plan: one question for each specialist. */
  #plan(): unknown {
    return { questions: [
      { agent: 'metrics', question: 'Which service diverged first, and how far did its error rate and latency move?' },
      { agent: 'logs', question: 'Which log signatures are new since the fault minute, and what do they say?' },
      { agent: 'deploys', question: 'Which deploys and flag changes preceded the first divergence?' },
    ] }
  }

  /** A specialist's turn: one tool call first, then findings from the summary and the tool's rows. */
  #specialist(messages: readonly PromptMessage[]): unknown {
    const summary = readSlot<IncidentSummary>(messages, 'summary')
    if (!summary) throw new Error('The specialist prompt has no summary.')
    const results = readSlot<ToolResult[]>(messages, 'tool-results')
    const agent = specialistOf(messages)
    const first = (summary.firstDiverged ?? 'web') as Lb06Service
    if (results === undefined) {
      if (agent === 'metrics') return { toolCalls: [{ tool: 'query_metrics', args: { service: first, metric: 'error_rate', lastMinutes: 10 } }] }
      if (agent === 'logs') return { toolCalls: [{ tool: 'query_logs', args: { lastMinutes: 10, onlyNew: true } }] }
      return { toolCalls: [{ tool: 'list_deploys', args: { lastMinutes: 60 } }] }
    }
    const diagnosis = diagnose(summary)
    const rows = results.flatMap(result => result.rows.map(row => row.evidence)).slice(0, 3)
    const invented = this.#options.inventEvidence ? [this.#options.inventEvidence] : []
    return { findings: [{ text: `${agent}: ${diagnosis.cause} on ${diagnosis.service}, first seen at minute ${summary.faultMinute}.`, evidence: [...invented, ...rows, ...diagnosis.evidence].slice(0, 6) }] }
  }

  /** The ranking: the diagnosis first, a second hypothesis for the edge, and the cure as the proposal. */
  #ranking(messages: readonly PromptMessage[]): unknown {
    const summary = readSlot<IncidentSummary>(messages, 'summary')
    if (!summary) throw new Error('The ranking prompt has no summary.')
    const diagnosis = diagnose(summary)
    this.#rankings += 1
    const invented = this.#options.inventEvidence ? [this.#options.inventEvidence] : []
    const action = this.#rankings === 1 && this.#options.firstProposal ? this.#options.firstProposal : diagnosis.action
    return {
      hypotheses: [
        { id: 'h1', service: diagnosis.service, cause: diagnosis.cause, confidence: 0.9, summary: `${diagnosis.cause} on ${diagnosis.service}, which diverged first.`, evidence: [...invented, ...diagnosis.evidence].slice(0, 6) },
        { id: 'h2', service: 'web', cause: 'overload', confidence: 0.1, summary: 'The edge is only showing what is behind it.', evidence: diagnosis.evidence.slice(0, 1) },
      ],
      proposal: { hypothesisId: 'h1', action, rationale: `Removes the cause on ${diagnosis.service} rather than a symptom.` },
    }
  }

  /** The postmortem: prose that references the kinds the timeline holds. */
  #postmortem(messages: readonly PromptMessage[]): unknown {
    const timeline = readSlot<TimelineEntry[]>(messages, 'timeline') ?? []
    const kinds = [...new Set(timeline.map(entry => entry.kind))]
    const fault = timeline.find(entry => entry.kind === 'fault.injected')
    const applied = timeline.find(entry => entry.kind === 'remediation.applied')
    return {
      summary: `At minute ${fault?.minute ?? 0} the shop broke (${fault?.detail ?? 'unknown'}); the alert fired, the agents investigated, the operator approved ${applied?.detail ?? 'no action'}, and the SLO recovered.`,
      rootCause: fault?.detail ?? 'unknown',
      whatWentWell: 'The burn-rate alert fired within minutes and the remediation was approved by a person before anything changed.',
      actionItems: ['Add a canary stage to the deploy pipeline.', 'Alert on the signature that was new before the SLO burns.'],
      references: kinds,
    }
  }
}
