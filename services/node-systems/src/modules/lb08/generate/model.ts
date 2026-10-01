// The one place LB-08 talks to a chat model: ask the model behind a virtual alias for a JSON
// answer, and say what came back, without trusting any of it.
//
// The question goes through the AI SDK's `generateObject` in its no-schema mode, so the SDK
// only turns the reply's text into JSON. It sends no response format: the gateway's
// fallback chains cross providers whose JSON modes differ, so the format is described in the
// prompt and the answer is checked afterwards against LB-08's own schema (`validateWorkflow`),
// the same on every provider. A reply that isn't JSON is not an error here: it comes back as
// text, and the pipeline spends its one repair on it.
//
// `generateObject` is deprecated in AI SDK 7 in favour of `generateText` with an output
// setting. It is used because the SDK's repairText hook is what lets a reply that wraps its
// JSON in a Markdown fence or a sentence still count; moving to the replacement is a small
// change in this file only.
import { generateObject, NoObjectGeneratedError } from 'ai'
import type { LanguageModel } from 'ai'

import { DESCRIBE_MAX_OUTPUT_TOKENS } from './prompts.ts'
import type { ModelReply, PromptMessage } from './prompts.ts'

/** The virtual model alias LB-08 describes workflows with (services/gateway/routing.yaml). */
export const DESCRIBE_ALIAS = 'lb-tools'

/** Something that answers a conversation with JSON: the gateway's `lb-tools`, or a script in a test. */
export interface JsonModel {
  // Sends the messages and returns what the model replied. Throws only when the model could not be reached.
  ask: (messages: readonly PromptMessage[]) => Promise<ModelReply>
}

/** Returns the part of a reply after its last `</think>`, for models that show their reasoning before the answer. */
function afterReasoning(text: string): string {
  const end = text.lastIndexOf('</think>')
  return end === -1 ? text : text.slice(end + '</think>'.length)
}

/**
 * Finds the JSON object in a reply, from its first `{` to its last `}`, so a reply that
 * wraps it in a Markdown fence or a sentence still counts. Returns null when there is none,
 * or when what lies between the braces isn't JSON.
 */
export function jsonObjectIn(text: string): string | null {
  const answer = afterReasoning(text)
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  if (start === -1 || end < start) return null
  const candidate = answer.slice(start, end + 1)
  try {
    JSON.parse(candidate)
  }
  catch {
    return null
  }
  return candidate
}

/** What the AI SDK takes in place of a system message: the instructions, and the rest of the conversation. */
interface SplitPrompt {
  instructions: string
  conversation: { role: 'user' | 'assistant', content: string }[]
}

/**
 * Splits a conversation into its system prompt and the rest. The AI SDK refuses a system
 * message among the messages (so text that reaches `messages` from outside can't pose as
 * the system), and takes the system prompt as `instructions` instead.
 */
function splitSystem(messages: readonly PromptMessage[]): SplitPrompt {
  const [first, ...rest] = messages
  if (first?.role !== 'system') throw new RangeError('A conversation starts with its system prompt.')
  const conversation: SplitPrompt['conversation'] = []
  for (const message of rest) {
    if (message.role === 'system') throw new RangeError('A conversation has one system prompt, at its start.')
    conversation.push({ role: message.role, content: message.content })
  }
  return { instructions: first.content, conversation }
}

/** A chat model behind the gateway, asked for a JSON answer at temperature 0, for repeatable results. */
export class GatewayJsonModel implements JsonModel {
  readonly #model: LanguageModel

  /** Asks `model`, the AI SDK model the gateway client gives for an alias such as `lb-tools`. */
  constructor(model: LanguageModel) {
    this.#model = model
  }

  /**
   * Sends one request to the gateway (the AI SDK never retries: the gateway fails over
   * between providers itself, and a retry here would spend a model call the budget counts).
   */
  async ask(messages: readonly PromptMessage[]): Promise<ModelReply> {
    const { instructions, conversation } = splitSystem(messages)
    try {
      const { object } = await generateObject({
        model: this.#model,
        output: 'no-schema',
        instructions,
        messages: conversation,
        temperature: 0,
        maxOutputTokens: DESCRIBE_MAX_OUTPUT_TOKENS,
        maxRetries: 0,
        repairText: async ({ text }) => jsonObjectIn(text),
      })
      return { kind: 'json', value: object }
    }
    catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) return { kind: 'text', text: error.text ?? '' }
      throw error
    }
  }
}
