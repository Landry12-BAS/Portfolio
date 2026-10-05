// The spans of a mock LB-09 run, in the format the gateway's Scope route returns and the real
// pipeline writes (services/django-systems/lb09/pipeline.py): the steps in order, the gateway's
// calls nested under the ones that make them, and a root span for the whole meeting, written
// last. They are fixtures: the step names are the pipeline's real ones, and every timing and
// token count is made up, so no test or page may show them as a measurement. The spans of a
// meeting that is still being worked on are the ones of the stages it has finished.
import { createHash } from 'node:crypto'
import type { MockSpan } from './spans.ts'

/** The stages of a meeting, in the order the worker reaches them. */
export const STAGES = ['received', 'decoding', 'transcribing', 'labelling', 'extracting', 'aligning', 'done'] as const
/** One stage. */
export type Stage = (typeof STAGES)[number]

/** Makes a span ID of 16 hex digits that is the same for the same run and key. */
function spanId(runId: string, key: string): string {
  return createHash('sha256').update(`${runId}:${key}`).digest('hex').slice(0, 16)
}

/** A span before it has its run and its ID. */
interface Plan {
  key: string
  parent: string | undefined
  kind: MockSpan['kind']
  name: string
  from: number
  to: number
  attrs: Record<string, string | number | boolean>
  // The stage the span belongs to: it is written once that stage is over.
  stage: Stage
}

/** Plans a gateway call under a step, with its one attempt under the call. */
function gatewayCall(step: string, alias: string, model: string, from: number, to: number, tokens: number, stage: Stage, dataClass: 'visitor' | 'synthetic'): Plan[] {
  const provider = model.split('/')[0] ?? ''
  return [
    { key: `${step}.call`, parent: step, kind: 'gateway.call', name: alias, from, to, attrs: { alias, dataClass, stream: false, attempts: 1, provider, model, inputTokens: tokens, outputTokens: Math.round(tokens / 6), usage: 'reported' }, stage },
    { key: `${step}.attempt`, parent: `${step}.call`, kind: 'gateway.attempt', name: model, from: from + 2, to: to - 2, attrs: { provider, model, inputTokens: tokens, outputTokens: Math.round(tokens / 6) }, stage },
  ]
}

/** What the spans of a meeting say about it. */
export interface MeetingTraceFacts {
  mode: 'fast' | 'private'
  sample: boolean
  seconds: number
  segments: number
  speakers: number
  decisions: number
  actions: number
  dropped: number
  failure: string | undefined
}

/** Plans the whole run, one stage after another, with the lengths of a meeting of the given facts. */
function plan(facts: MeetingTraceFacts, stageMs: number): Plan[] {
  const dataClass = facts.sample ? 'synthetic' : 'visitor'
  const at = (stage: number) => stage * stageMs
  const plans: Plan[] = [
    { key: 'decode', parent: 'run', kind: 'system.step', name: 'decode audio', from: at(0) + 5, to: at(1), attrs: { bytes: Math.round(facts.seconds * 16_000), seconds: facts.seconds }, stage: 'decoding' },
    { key: 'transcribe', parent: 'run', kind: 'system.step', name: 'transcribe', from: at(1) + 5, to: at(2), attrs: { mode: facts.mode, seconds: facts.seconds, segments: facts.segments, model: facts.mode === 'fast' ? 'lb-stt' : 'local/faster-whisper/base' }, stage: 'transcribing' },
  ]
  if (facts.mode === 'fast') plans.push(...gatewayCall('transcribe', 'lb-stt', 'groq/whisper-large-v3-turbo', at(1) + 10, at(2) - 5, 0, 'transcribing', dataClass))
  plans.push(
    { key: 'label', parent: 'run', kind: 'system.step', name: 'label speakers', from: at(2) + 5, to: at(3), attrs: { speakers: facts.speakers, named: 0, attempts: 1 }, stage: 'labelling' },
    ...gatewayCall('label', 'lb-fast', 'groq/gpt-oss-20b', at(2) + 10, at(3) - 5, 900 + facts.segments * 20, 'labelling', dataClass),
    { key: 'extract', parent: 'run', kind: 'system.step', name: 'extract items', from: at(3) + 5, to: at(4), attrs: { decisions: facts.decisions, actions: facts.actions, attempts: 1 }, stage: 'extracting' },
    ...gatewayCall('extract', 'lb-tools', 'groq/gpt-oss-120b', at(3) + 10, at(4) - 5, 1_400 + facts.segments * 24, 'extracting', dataClass),
    { key: 'align', parent: 'run', kind: 'system.step', name: 'align evidence', from: at(4) + 5, to: at(5), attrs: { kept: facts.decisions + facts.actions, dropped: facts.dropped }, stage: 'aligning' },
  )
  return plans
}

/** The index of a stage in the order the worker reaches them. */
export function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage)
}

/** Writes the spans of a meeting as far as it has got: the finished stages' spans, and the root once the meeting is over. */
export function meetingSpans(runId: string, startedAt: number, stageMs: number, facts: MeetingTraceFacts, reached: Stage, over: boolean): MockSpan[] {
  const common = { v: 1 as const, runId, system: 'lb-09' as const }
  const reachedIndex = stageIndex(reached)
  // A failed meeting stops at the stage it failed in: the spans of the stages before it are written, and that stage's own is an error.
  const spans: MockSpan[] = plan(facts, stageMs)
    .filter(item => stageIndex(item.stage) < reachedIndex || (over && stageIndex(item.stage) === reachedIndex && item.kind === 'system.step'))
    .map(item => ({
      ...common,
      spanId: spanId(runId, item.key),
      ...(item.parent ? { parentId: spanId(runId, item.parent) } : {}),
      kind: item.kind,
      name: item.name,
      status: facts.failure !== undefined && stageIndex(item.stage) === reachedIndex ? 'error' as const : 'ok' as const,
      startMs: startedAt + item.from,
      endMs: startedAt + item.to,
      attrs: facts.failure !== undefined && stageIndex(item.stage) === reachedIndex ? { ...item.attrs, error: 'MeetingFailedError' } : item.attrs,
    }))
  if (over) {
    const end = facts.failure === undefined ? 6 * stageMs : (reachedIndex + 1) * stageMs
    spans.push({
      ...common,
      spanId: spanId(runId, 'run'),
      kind: 'system.run',
      name: 'meeting recording',
      status: facts.failure === undefined ? 'ok' : 'error',
      startMs: startedAt,
      endMs: startedAt + end,
      attrs: facts.failure === undefined
        ? { mode: facts.mode, status: 'done', items: facts.decisions + facts.actions, dropped: facts.dropped }
        : { mode: facts.mode, status: 'failed', reason: facts.failure },
    })
  }
  return spans
}
