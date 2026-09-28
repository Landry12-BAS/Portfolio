import { iconNames } from '@lb/icons'
import { z } from 'zod'

import { BACKENDS, TECHNIQUES } from '../catalog'

const keys = <T extends Record<string, string>>(record: T) => Object.keys(record) as [keyof T & string, ...(keyof T & string)[]]

const sentence = z.string().min(1).regex(/[.!?]$/, 'ends with a full stop')

/** One datasheet. The tests validate every record, so the data can never drift from it. */
export const SystemSchema = z.object({
  part: z.string().regex(/^LB-\d{2}$/),
  slug: z.string().regex(/^lb-\d{2}$/),
  icon: z.enum(iconNames),
  name: z.string().min(1),
  /** What the part does, in one sentence. */
  function: sentence,
  /** What a visitor does with it, for the selection guide. */
  visitorAction: z.string().min(1),
  backend: z.enum(keys(BACKENDS)),
  /** The back end as the datasheet names it, such as "Flask · async". */
  runtime: z.string().min(1),
  techniques: z.array(z.enum(keys(TECHNIQUES))).min(1),
  phase: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  size: z.enum(['M', 'L', 'XL']),
  problem: sentence,
  tryIt: sentence,
  proves: sentence,
  tags: z.array(z.string().min(1)).min(1),
  chain: z.array(z.string().min(1)).min(3),
  stack: z.array(z.string().min(1)).min(3),
  highlights: z.array(sentence).min(2),
  limits: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).min(2),
})

export type System = z.infer<typeof SystemSchema>
