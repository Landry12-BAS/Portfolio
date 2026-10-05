// The one place LB-06 talks to a chat model: ask the model behind a virtual alias for a JSON answer,
// and say what came back, without trusting any of it. It follows LB-08's and LB-04's wrappers: the
// AI SDK's `generateObject` in its no-schema mode turns the reply's text into JSON, no response
// format is sent (the gateway's fallback chains cross providers whose JSON modes differ), the
// answer is checked afterwards against this module's own schemas, and a reply that isn't JSON comes
// back as text, for the one repair.
import { generateObject, NoObjectGeneratedError } from 'ai'
import type { LanguageModel } from 'ai'

/** One message of a chat request. */
export interface PromptMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** What the model said: JSON the SDK could read, or text that wasn't. */
export type ModelReply
  = | { kind: 'json', value: unknown }
    | { kind: 'text', text: string }

/** Something that answers a conversation with JSON: a model behind the gateway, or a script in a test. */
export interface JsonModel {
  // Sends the messages and returns what the model replied. Throws only when the model could not be reached.
  ask: (messages: readonly PromptMessage[]) => Promise<ModelReply>
}

/** The two models the agents use: the commander reasons on `lb-reason`, the specialists call tools on `lb-tools`. */
export interface AgentModels {
  reason: JsonModel
  tools: JsonModel
}

/** The virtual aliases the agents ask for (services/gateway/routing.yaml). */
export const ALIASES = { reason: 'lb-reason', tools: 'lb-tools' } as const

/** The most each alias may write, from its entry in routing.yaml, so an answer is never cut short by a limit this service doesn't know. */
export const MAX_OUTPUT_TOKENS = { reason: 3_072, tools: 2_048 } as const

/** Returns the part of a reply after its last `</think>`, for models that show their reasoning before the answer. */
function afterReasoning(text: string): string {
  const end = text.lastIndexOf('</think>')
  return end === -1 ? text : text.slice(end + '</think>'.length)
}

/** Finds the JSON object in a reply, from its first `{` to its last `}`, so a reply wrapped in a fence or a sentence still counts. Null when there is none. */
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

/** Splits a conversation into its system prompt and the rest; the SDK refuses a system message among the messages, so text from outside can't pose as the system. */
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
  readonly #maxOutputTokens: number

  /** Asks `model`, the AI SDK model the gateway client gives for an alias, for at most `maxOutputTokens` tokens. */
  constructor(model: LanguageModel, maxOutputTokens: number) {
    this.#model = model
    this.#maxOutputTokens = maxOutputTokens
  }

  /** Sends one request to the gateway (the SDK never retries: the gateway fails over itself, and a retry here would spend a call the budget counts). */
  async ask(messages: readonly PromptMessage[]): Promise<ModelReply> {
    const { instructions, conversation } = splitSystem(messages)
    try {
      const { object } = await generateObject({
        model: this.#model,
        output: 'no-schema',
        instructions,
        messages: conversation,
        temperature: 0,
        maxOutputTokens: this.#maxOutputTokens,
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
