// Asking a model for JSON that fits a schema, with one repair: a reply that does not fit is sent back once
// with what was wrong (the problems' paths and messages, never the values), and a second that does not fit
// is final. Every call is counted, because the gateway counts them and the run's budget is eight.
import type { ZodType } from 'zod'

import type { JsonModel, ModelReply, PromptMessage } from './model.ts'

// The most characters of a refused reply that are quoted back in a repair request, and the most problems it lists.
export const MAX_ECHO_CHARS = 2_000
const MAX_PROBLEMS = 6
const MAX_PROBLEM_CHARS = 140

/** A model answered, but not in a form the schema accepts, even after its one repair. */
export class ModelOutputInvalid extends Error {
  constructor() {
    super('The model\'s answer was not usable after its one repair.')
    this.name = 'ModelOutputInvalid'
  }
}

/** Reads what a model replied against a schema: the value, or the problems, never the values that were wrong. */
export function readReply<Value>(reply: ModelReply, schema: ZodType<Value>): { value: Value } | { problems: string[] } {
  if (reply.kind === 'text') return { problems: ['The reply was not a JSON object.'] }
  const parsed = schema.safeParse(reply.value)
  if (parsed.success) return { value: parsed.data }
  return { problems: parsed.error.issues.map(issue => `${issue.path.join('.') || '(reply)'}: ${issue.message}`) }
}

/** Writes a JSON reply back as text, or a note when it cannot be: JSON.stringify recurses, and a reply nested deeper than the stack would throw. */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  }
  catch {
    return '(an answer too deeply nested to repeat)'
  }
}

/** Writes the refused reply as text for the repair request, cut to its limit. */
function echoOf(reply: ModelReply): string {
  const text = reply.kind === 'json' ? jsonText(reply.value) : reply.text
  return text.length > MAX_ECHO_CHARS ? `${text.slice(0, MAX_ECHO_CHARS)}…` : text
}

/** The conversation for the one repair: the first exchange, then what was wrong and the ask to answer again. */
export function repairMessages(base: readonly PromptMessage[], reply: ModelReply, problems: readonly string[]): PromptMessage[] {
  const listed = problems.slice(0, MAX_PROBLEMS).map(problem => `- ${problem.length > MAX_PROBLEM_CHARS ? `${problem.slice(0, MAX_PROBLEM_CHARS)}…` : problem}`).join('\n')
  return [
    ...base,
    { role: 'assistant', content: echoOf(reply) },
    { role: 'user', content: `That answer does not follow the required JSON shape:\n${listed}\nAnswer again with one JSON object that does, and nothing else.` },
  ]
}

/** Asks a model for JSON that fits a schema, repairing once. Returns the value and how many calls it took (one or two). */
export async function askForJson<Value>(model: JsonModel, base: readonly PromptMessage[], schema: ZodType<Value>): Promise<{ value: Value, calls: number }> {
  const first = await model.ask(base)
  const firstRead = readReply(first, schema)
  if ('value' in firstRead) return { value: firstRead.value, calls: 1 }
  const second = await model.ask(repairMessages(base, first, firstRead.problems))
  const secondRead = readReply(second, schema)
  if ('value' in secondRead) return { value: secondRead.value, calls: 2 }
  throw new ModelOutputInvalid()
}

/** Asks once, with no repair: for a re-plan, whose budget is one call. Returns the value, or undefined when the reply does not fit. */
export async function askOnce<Value>(model: JsonModel, base: readonly PromptMessage[], schema: ZodType<Value>): Promise<Value | undefined> {
  const read = readReply(await model.ask(base), schema)
  return 'value' in read ? read.value : undefined
}
