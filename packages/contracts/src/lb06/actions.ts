// The actions an agent may propose and a visitor may approve: a closed list, each with typed
// parameters, so nothing outside it can be proposed, approved or applied. The simulator applies
// exactly these; the board words each one and its blast radius from this shape.
import { z } from 'zod'

import { LB06_LIMITS, LB06_PARAM_PATTERN, LB06_SERVICES } from './limits.ts'

const service = z.enum(LB06_SERVICES)
// A version label or a flag's name: the visitor may have written it, so it is bounded and plain.
const label = z.string().min(1).max(LB06_LIMITS.maxParamLength).regex(LB06_PARAM_PATTERN)

/** One action, by kind. */
export const lb06ActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('rollback'), service, toVersion: label }),
  z.strictObject({ kind: z.literal('restart'), service }),
  z.strictObject({ kind: z.literal('scale'), service, replicas: z.int().min(2).max(6) }),
  z.strictObject({ kind: z.literal('flush_cache') }),
  z.strictObject({ kind: z.literal('flip_flag'), flag: label, value: z.boolean() }),
])
/** One action. */
export type Lb06Action = z.infer<typeof lb06ActionSchema>

/** Writes an action as one short line, the same everywhere (the grader, the cache key, the logs' labels). */
export function describeAction(action: Lb06Action): string {
  switch (action.kind) {
    case 'rollback': return `rollback ${action.service} to ${action.toVersion}`
    case 'restart': return `restart ${action.service}`
    case 'scale': return `scale ${action.service} to ${action.replicas}`
    case 'flush_cache': return 'flush the cache'
    case 'flip_flag': return `flip ${action.flag} ${action.value ? 'on' : 'off'}`
  }
}

/** Tells whether two actions are the same action, parameters included. */
export function sameAction(a: Lb06Action, b: Lb06Action): boolean {
  return describeAction(a) === describeAction(b)
}
