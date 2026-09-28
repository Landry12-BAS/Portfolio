import type { Alias, Model } from './load.ts'
import type { Capability } from './schema.ts'

// Visitor content may only reach providers that don't train on inputs; synthetic
// samples may use the whole chain (docs/STACK.md, Routing rules 2 and 3).
export type DataClass = 'visitor' | 'synthetic'
export type Profile = 'production' | 'dev'

export type Exclusion = 'terms' | 'visitor-data' | 'capability' | 'not-configured'

export interface Plan {
  candidates: Model[]
  excluded: { model: Model, reason: Exclusion }[]
}

function exclusion(model: Model, dataClass: DataClass, profile: Profile, needs: ReadonlySet<Capability>): Exclusion | undefined {
  if (profile === 'production' && model.provider.terms === 'dev-only') return 'terms'
  if (dataClass === 'visitor' && (model.provider.trainsOnInputs || model.provider.terms === 'dev-only')) return 'visitor-data'
  for (const capability of needs) {
    if (!model.capabilities.has(capability)) return 'capability'
  }
  if (!model.provider.configured) return 'not-configured'
  return undefined
}

/** The models on an alias's chain that may serve this request, in chain order. */
export function planChain(alias: Alias, dataClass: DataClass, profile: Profile, needs: ReadonlySet<Capability>): Plan {
  const plan: Plan = { candidates: [], excluded: [] }
  for (const model of alias.chain) {
    const reason = exclusion(model, dataClass, profile, needs)
    if (reason) plan.excluded.push({ model, reason })
    else plan.candidates.push(model)
  }
  return plan
}
