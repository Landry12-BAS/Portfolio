// The error every response of the platform uses, and so every response of the site's server:
// `{"error": {"code": "...", "message": "..."}}`. The code is stable and is what a caller
// branches on; the message is a sentence for people and never repeats what a visitor sent.
import { z } from 'zod'

/**
 * The error body. A back end may add a field for a case (`fields` names what a 422 faults,
 * `resets_at` says when a daily limit starts again, `problems` lists what is wrong in a
 * graph); anything else is dropped when a body is read with this schema, which is how the
 * site's server passes a back end's error on without passing on what it didn't plan for.
 */
export const platformErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(64),
    message: z.string().min(1).max(500),
    fields: z.string().max(400).nullish(),
    resets_at: z.string().max(40).nullish(),
    problems: z.array(z.object({
      code: z.string().max(64),
      path: z.string().max(120),
      message: z.string().max(400),
    })).max(50).optional(),
  }),
})

/** An error body, as read back. */
export type PlatformError = z.infer<typeof platformErrorSchema>
