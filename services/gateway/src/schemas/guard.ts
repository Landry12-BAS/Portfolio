// The guard request a caller sends, and the parts of a classifier's answer the guard reads.
import { z } from 'zod'

// The longest text accepted; the alias's token limit usually binds first.
const MAX_GUARD_INPUT = 65_536

/** The guard request: the guard alias, and the text to check before it reaches a model. */
export const guardRequestSchema = z.object({
  model: z.string().min(1).max(64),
  input: z.string().min(1).max(MAX_GUARD_INPUT),
})

/** A classifier's chat completion: at least one choice whose message holds text. */
export const guardAnswerSchema = z.looseObject({
  choices: z.array(z.looseObject({ message: z.looseObject({ content: z.string() }) })).min(1),
})
