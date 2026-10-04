// The model and the guard the agent asks, built from the gateway client, and the sandbox the worker
// drives, built from the settings. The module, the live eval command and the tests that put LB-07
// behind the real gateway all build them here.
import type { Gateway } from '@lb/common'
import type { Lb07BugId } from '@lb/contracts'

import { AGENT_ALIAS, AGENT_MAX_OUTPUT_TOKENS, GatewayJsonModel } from '../agent/model.ts'
import { HttpRunner } from '../runner/client.ts'
import { signBugToken, TOKEN_LIFETIME_MS, tokenKeyFromHex } from '../shop/token.ts'
import type { AgentServices, SandboxServices } from './deps.ts'

/** The model behind `lb-tools` and the guard, from the gateway. */
export function agentServices(gateway: Gateway): AgentServices {
  return {
    model: new GatewayJsonModel(gateway.chat(AGENT_ALIAS), AGENT_MAX_OUTPUT_TOKENS),
    guard: {
      check: async (text) => {
        const verdict = await gateway.guard(text)
        return { flagged: verdict.flagged, score: verdict.score }
      },
    },
  }
}

/** The sandbox from its settings: the runner's address, the bug-token key (hex) and the shop's origin for the test's comment. */
export function sandboxServices(settings: { runnerUrl: string, tokenKeyHex: string, shopOrigin: string }, now: () => Date = () => new Date()): SandboxServices {
  const key = tokenKeyFromHex(settings.tokenKeyHex)
  return {
    runner: new HttpRunner(settings.runnerUrl),
    signToken: (runId: string, bugs: readonly Lb07BugId[]) => signBugToken(key, { runId, bugs: [...bugs], exp: now().getTime() + TOKEN_LIFETIME_MS }),
    shopOrigin: settings.shopOrigin,
  }
}
