// What LB-06's tests share: a tracer that keeps its spans in memory, a scripted model, and the golden set.
import { createRun, newRunId, runScope, Tracer } from '@lb/common'
import type { Span } from '@lb/common'

import { evalsDirectory } from '../../src/core/data-files.ts'
import type { JsonModel, ModelReply, PromptMessage } from '../../src/modules/lb06/agents/model.ts'
import { readGoldenSet } from '../../src/modules/lb06/golden/cases.ts'
import type { GoldenCase } from '../../src/modules/lb06/golden/cases.ts'

/** A span writer that keeps every span, so a test can read the trace. */
export class Recorder {
  readonly spans: Span[] = []

  /** Keeps the spans. */
  async write(spans: readonly Span[]): Promise<void> {
    this.spans.push(...spans)
  }
}

/** A tracer over a recorder, with a clock that moves a second a span. */
export function recordingTracer(): { tracer: Tracer, recorder: Recorder } {
  const recorder = new Recorder()
  let now = Date.UTC(2026, 9, 3, 12, 0, 0)
  const tracer = new Tracer(recorder, () => {
    now += 1_000
    return now
  })
  return { tracer, recorder }
}

/** What a script is given: the conversation so far, and which call this is (the first is 1). */
export type Script = (messages: readonly PromptMessage[], call: number) => ModelReply | Promise<ModelReply>

/** A model that follows a script and records what it was asked. */
export class ScriptedModel implements JsonModel {
  readonly conversations: PromptMessage[][] = []
  readonly #script: Script

  /** Answers every conversation with whatever `script` returns for it. */
  constructor(script: Script) {
    this.#script = script
  }

  /** Records the conversation and returns the script's answer; a script that throws stands in for a gateway that fails. */
  async ask(messages: readonly PromptMessage[]): Promise<ModelReply> {
    this.conversations.push([...messages])
    return this.#script(messages, this.conversations.length)
  }
}

/** Answers the conversations in turn with the given replies, and fails the test if asked more often than that. */
export function replies(...answers: ModelReply[]): ScriptedModel {
  return new ScriptedModel((_messages, call) => {
    const answer = answers[call - 1]
    if (!answer) throw new Error(`The model was asked ${call} times, but only ${answers.length} answers were scripted.`)
    return answer
  })
}

/** The golden set, read strictly. */
export function goldenCases(): GoldenCase[] {
  return readGoldenSet(`${evalsDirectory()}/lb06/golden.yaml`)
}

/** One golden case by id. */
export function goldenCase(id: string): GoldenCase {
  const entry = goldenCases().find(candidate => candidate.id === id)
  if (!entry) throw new Error(`No golden case ${id}.`)
  return entry
}

/** Runs work inside a synthetic run of LB-06, as the engine does for an incident. */
export function inRun<Result>(work: () => Promise<Result>): Promise<Result> {
  return runScope(createRun({ system: 'lb-06', runId: newRunId(), dataClass: 'synthetic' }), work)
}
