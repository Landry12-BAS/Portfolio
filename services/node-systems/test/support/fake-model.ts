// A stand-in for the chat model behind the gateway: a script that answers each conversation,
// and keeps every conversation it was shown. Every test of the generation pipeline uses it,
// because no provider key exists in the test environment and a live model would make the
// tests slow, costly and different on every run.
import type { JsonModel } from '../../src/modules/lb08/generate/model.ts'
import type { ModelReply, PromptMessage } from '../../src/modules/lb08/generate/prompts.ts'

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

/** Answers every conversation with the same JSON. */
export function alwaysJson(value: unknown): ScriptedModel {
  return new ScriptedModel(() => ({ kind: 'json', value }))
}

/** Answers the conversations in turn with the given replies, and fails the test if it is asked more often than that. */
export function replies(...answers: ModelReply[]): ScriptedModel {
  return new ScriptedModel((_messages, call) => {
    const answer = answers[call - 1]
    if (!answer) throw new Error(`The model was asked ${call} times, but only ${answers.length} answers were scripted.`)
    return answer
  })
}
