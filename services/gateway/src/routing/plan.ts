// Plans a call: which models on an alias's chain may take it, and why the others can't.
// Visitor content may only reach providers that don't train on inputs; synthetic
// samples may use the whole chain (docs/STACK.md, Routing rules 2 and 3).
import type { Alias, Model } from './load.ts'
import type { Capability } from './schema.ts'

/** Whose content a call carries: a visitor's, or the site's own synthetic samples. */
export type DataClass = 'visitor' | 'synthetic'
/** Which terms apply: `production` for the live site, `dev` for private experiments. */
export type Profile = 'production' | 'dev'

/** Why a model was left out of a plan. */
export type Exclusion = 'terms' | 'visitor-data' | 'capability' | 'not-configured'

/** The models that may serve a call, in chain order, and the ones left out with the reason. */
export interface Plan {
  candidates: Model[]
  excluded: { model: Model, reason: Exclusion }[]
}

/**
 * Says why a model may not take this call, or undefined when it may. The checks run in
 * order of importance: the provider's terms, then the data rules, then capabilities,
 * then whether the provider is configured at all.
 */
function exclusion(model: Model, alias: Alias, dataClass: DataClass, profile: Profile, needs: ReadonlySet<Capability>): Exclusion | undefined {
  if (profile === 'production' && model.provider.terms === 'dev-only') return 'terms'
  // An alias that takes synthetic content only turns visitor content away whichever model it names.
  if (dataClass === 'visitor' && (alias.syntheticOnly || model.provider.trainsOnInputs || model.provider.terms === 'dev-only')) return 'visitor-data'
  for (const capability of needs) {
    if (!model.capabilities.has(capability)) return 'capability'
  }
  if (!model.provider.configured) return 'not-configured'
  return undefined
}

/** Splits an alias's chain into the models that may serve this call and the ones that may not. */
export function planChain(alias: Alias, dataClass: DataClass, profile: Profile, needs: ReadonlySet<Capability>): Plan {
  const plan: Plan = { candidates: [], excluded: [] }
  for (const model of alias.chain) {
    const reason = exclusion(model, alias, dataClass, profile, needs)
    if (reason) plan.excluded.push({ model, reason })
    else plan.candidates.push(model)
  }
  return plan
}
