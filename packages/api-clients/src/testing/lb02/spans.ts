// The spans of a mock LB-02 turn, in the format the gateway's Scope route returns and the real
// concierge writes (services/gateway/src/spans.ts): each message is a step of the conversation's run,
// with the language check, the injection screen and the calls to the chat model under it, and a tool
// span for every tool the model called. Like the real concierge, it writes the root span of the run
// when the conversation ends (it is handed to a person), and not before: a conversation has no end
// that is known in advance, and a booked one may still be written to. The turns name that root as
// their parent in advance. A message to a conversation that is over writes nothing. Every timing and
// token count here is made up, so no test or page may show them as a measurement.
import { createHash } from 'node:crypto'

import type { MockSpan } from '../spans.ts'
import type { TurnOutput } from './concierge.ts'

// The key of the run's root span, which the turns name as their parent before it is written.
const CONVERSATION = 'conversation'

/** A span before it has its run, its place in time and its ID. */
interface Plan {
  key: string
  parent: string | undefined
  kind: MockSpan['kind']
  name: string
  from: number
  to: number
  attrs: Record<string, string | number | boolean>
}

/** Makes a span ID of 16 hex digits that is the same for the same run and key. */
function spanId(runId: string, key: string): string {
  return createHash('sha256').update(`${runId}:${key}`).digest('hex').slice(0, 16)
}

/** Plans a gateway call under a step, with its one attempt under the call. */
function gatewayCall(step: string, alias: string, model: string, from: number, to: number, tokens: number): Plan[] {
  const provider = model.split('/')[0] ?? ''
  return [
    { key: `${step}.call`, parent: step, kind: 'gateway.call', name: alias, from, to, attrs: { alias, dataClass: 'visitor', stream: false, attempts: 1, provider, model, inputTokens: tokens, outputTokens: Math.round(tokens / 8), usage: 'reported' } },
    { key: `${step}.attempt`, parent: `${step}.call`, kind: 'gateway.attempt', name: model, from: from + 2, to: to - 2, attrs: { provider, model, inputTokens: tokens, outputTokens: Math.round(tokens / 8) } },
  ]
}

/** Plans the spans of one turn: the message, the checks, the calls to the model and the tools it called. */
function planTurn(turn: number, output: TurnOutput, step: string): Plan[] {
  const root = `t${turn}`
  const plans: Plan[] = []
  let cursor = 0
  if (output.detectedLanguage) {
    plans.push({ key: `${root}.language`, parent: root, kind: 'system.step', name: 'detect language', from: 0, to: 3, attrs: { language: 'detected' } })
    cursor = 3
  }
  const guard = `${root}.guard`
  if (output.calls.guard > 0) {
    plans.push({ key: guard, parent: root, kind: 'system.step', name: 'screen for injection', from: cursor, to: cursor + 187, attrs: { flagged: output.receipt === 'injection_refused', score: output.receipt === 'injection_refused' ? 0.99 : 0.01 } })
    plans.push(...gatewayCall(guard, 'lb-guard', 'groq/llama-prompt-guard-2-86m', cursor + 5, cursor + 182, 140))
    cursor += 187
  }
  for (let call = 0; call < output.calls.chat; call += 1) {
    const converse = `${root}.converse${call}`
    plans.push({ key: converse, parent: root, kind: 'system.step', name: 'converse', from: cursor, to: cursor + 900, attrs: { step, tool_calls: call === 0 ? output.tools.length : 0 } })
    plans.push(...gatewayCall(converse, 'lb-tools', 'groq/gpt-oss-120b', cursor + 5, cursor + 895, 2_300))
    if (call === 0) {
      output.tools.forEach((tool, index) => {
        plans.push({ key: `${converse}.tool${index}`, parent: converse, kind: 'system.tool', name: tool.name.replace(/[^\w .:/-]/g, '_').slice(0, 60) || 'tool', from: cursor + 895, to: cursor + 899, attrs: { executed: tool.executed, ok: tool.ok } })
      })
    }
    cursor += 900
  }
  plans.push({ key: root, parent: CONVERSATION, kind: 'system.step', name: 'visitor message', from: 0, to: cursor + 10, attrs: { step, calls: output.calls.guard + output.calls.chat, tools: output.tools.length } })
  return plans
}

/** Makes the root span of a conversation that has just ended: the whole run, from when it began to now, written last. */
export function conversationSpan(runId: string, startedAt: number, endedAt: number, attrs: Record<string, string | number | boolean>): MockSpan {
  return {
    v: 1,
    runId,
    system: 'lb-02',
    spanId: spanId(runId, CONVERSATION),
    kind: 'system.run',
    name: 'booking conversation',
    status: 'ok',
    startMs: startedAt,
    endMs: Math.max(endedAt, startedAt),
    attrs,
  }
}

/**
 * Makes the spans of one turn that started at `startedAt` (Unix milliseconds), in the order a stream
 * holds them, which is the order the spans ended.
 */
export function turnSpans(runId: string, turn: number, startedAt: number, output: TurnOutput, step: string): MockSpan[] {
  return planTurn(turn, output, step)
    .map((plan, index) => ({ plan, index }))
    .sort((a, b) => a.plan.to - b.plan.to || b.index - a.index)
    .map(({ plan }): MockSpan => ({
      v: 1,
      runId,
      system: 'lb-02',
      spanId: spanId(runId, plan.key),
      ...(plan.parent === undefined ? {} : { parentId: spanId(runId, plan.parent) }),
      kind: plan.kind,
      name: plan.name,
      status: 'ok',
      startMs: startedAt + plan.from,
      endMs: startedAt + plan.to,
      attrs: plan.attrs,
    }))
}
