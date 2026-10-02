// The models a review asks and the guard that screens a contract, built from the gateway client. The
// module, the live eval command and the tests that put LB-04 behind the real gateway all build them
// here, so every one of them asks the same aliases, with the same limits, in the same way.
import type { Gateway } from '@lb/common'

import { ALIASES, GatewayJsonModel, MAX_OUTPUT_TOKENS } from '../analysis/model.ts'
import type { ReviewServices } from './deps.ts'

/** The models a review asks, behind the gateway's virtual aliases, and the guard. */
export function reviewServices(gateway: Gateway): ReviewServices {
  return {
    models: {
      long: new GatewayJsonModel(gateway.chat(ALIASES.long), MAX_OUTPUT_TOKENS.long),
      reason: new GatewayJsonModel(gateway.chat(ALIASES.reason), MAX_OUTPUT_TOKENS.reason),
      fast: new GatewayJsonModel(gateway.chat(ALIASES.fast), MAX_OUTPUT_TOKENS.fast),
    },
    guard: {
      check: async (text) => {
        const verdict = await gateway.guard(text)
        return { flagged: verdict.flagged, score: verdict.score }
      },
    },
  }
}
