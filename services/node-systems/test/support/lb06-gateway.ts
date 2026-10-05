// What the tests that put LB-06 behind the real gateway share: the gateway on its miniature routing
// table, and what a fake provider has to say for a whole incident. The provider answers in the order
// it is told, and an incident's calls come in a fixed order (the plan, each specialist's two turns,
// the ranking, the postmortem), so a test queues the answers the reference agents would give, found by
// running the same case once in this process.
import { Tracer } from '@lb/common'

import { startContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import type { ContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import type { JsonModel, ModelReply, PromptMessage } from '../../src/modules/lb06/agents/model.ts'
import { ReferenceAgents } from '../../src/modules/lb06/golden/reference.ts'
import { runCase } from '../../src/modules/lb06/golden/run.ts'
import { goldenCase, Recorder } from './lb06.ts'

// The miniature routing table: the real aliases' limits and the real quotas, on one fake provider.
const ROUTING_FILE = new URL('./routing.lb06.yaml', import.meta.url)

/** Starts the real gateway on the miniature routing table, in front of a fake provider. */
export function startLb06Gateway(redisUrl: string): Promise<ContractGateway> {
  return startContractGateway(redisUrl, ROUTING_FILE)
}

/** What the reference agents say for a case, in order, as the JSON text a provider would send, found by running the case once in this process. */
export async function referenceReplies(caseId: string, options: ConstructorParameters<typeof ReferenceAgents>[0] = {}): Promise<string[]> {
  const agents = new ReferenceAgents(options)
  const said: string[] = []
  const recording: JsonModel = {
    ask: async (messages: readonly PromptMessage[]): Promise<ModelReply> => {
      const reply = await agents.ask(messages)
      if (reply.kind === 'json') said.push(JSON.stringify(reply.value))
      return reply
    },
  }
  await runCase({ models: { reason: recording, tools: recording }, tracer: new Tracer(new Recorder()) }, goldenCase(caseId))
  return said
}

/** Queues what the fake provider answers to a whole incident of a case, the guard's verdict first when the case has visitor text. */
export async function scriptIncident(gw: ContractGateway, caseId: string, options: ConstructorParameters<typeof ReferenceAgents>[0] = {}): Promise<number> {
  const replies = await referenceReplies(caseId, options)
  for (const reply of replies) gw.provider.answerNext(reply)
  return replies.length
}
