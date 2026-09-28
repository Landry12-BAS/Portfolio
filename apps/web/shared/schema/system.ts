// The schema every datasheet must match, in every language. The unit tests validate
// each record against it, so the data can never drift from what the pages expect.
import { iconNames } from '@lb/icons'
import { z } from 'zod'

import { BACKENDS, TECHNIQUES } from '../catalog'

// Prose fields are whole sentences, ending with a full stop (or ! or ?).
const sentence = z.string().min(1).regex(/[.!?]$/, 'ends with a full stop')

/** One datasheet: identity, classification, the text a visitor reads, and its limits. */
export const SystemSchema = z.object({
  part: z.string().regex(/^LB-\d{2}$/),
  slug: z.string().regex(/^lb-\d{2}$/),
  icon: z.enum(iconNames),
  name: z.string().min(1),
  /** What the part does, in one sentence. */
  function: sentence,
  /** What a visitor does with it, for the selection guide. */
  visitorAction: z.string().min(1),
  backend: z.enum(BACKENDS),
  /** The back end as the datasheet names it, such as "Flask · async". */
  runtime: z.string().min(1),
  techniques: z.array(z.enum(TECHNIQUES)).min(1).readonly(),
  phase: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  size: z.enum(['M', 'L', 'XL']),
  problem: sentence,
  tryIt: sentence,
  proves: sentence,
  tags: z.array(z.string().min(1)).min(1).readonly(),
  chain: z.array(z.string().min(1)).min(3).readonly(),
  stack: z.array(z.string().min(1)).min(3).readonly(),
  highlights: z.array(sentence).min(2).readonly(),
  limits: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).min(2).readonly(),
})

/** One datasheet record, in any language. */
export type System = z.infer<typeof SystemSchema>
