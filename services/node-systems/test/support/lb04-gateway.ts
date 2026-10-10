// What the tests that put LB-04 behind the real gateway share: the gateway on its miniature routing
// table, and what a fake provider has to say for a whole review of a sample. The provider answers in
// the order it is told, and a review's calls come in a fixed order (the guard's segments, the reading,
// the rating), so a test queues the answers a correct reviewer would give before it starts the review.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { Tracer } from '@lb/common'

import { segmentSize, segmentsOf } from '../../../gateway/src/routes/guard.ts'
import { loadRouting } from '../../../gateway/src/routing/load.ts'
import { startContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import type { ContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import type { JsonModel } from '../../src/modules/lb04/analysis/model.ts'
import { reviewContract } from '../../src/modules/lb04/analysis/pipeline.ts'
import { findInstructionPassages, guardInput } from '../../src/modules/lb04/analysis/screen.ts'
import { buildSourceIndex } from '../../src/modules/lb04/analysis/source.ts'
import { referenceReview } from './lb04-engine.ts'
import { extractedPages, inTestRun, loadPlaybook, Recorder } from './lb04.ts'

// The miniature routing table: the real aliases' limits and the real quotas, on one fake provider.
const ROUTING_FILE = new URL('./routing.lb04.yaml', import.meta.url)

/** Starts the real gateway on the miniature routing table, in front of a fake provider. */
export function startLb04Gateway(redisUrl: string): Promise<ContractGateway> {
  return startContractGateway(redisUrl, ROUTING_FILE)
}

/** How many requests the gateway's guard makes of its model for a contract: one for each overlapping segment of what the guard reads. */
export async function guardSegments(sampleId: string): Promise<number> {
  const routing = loadRouting(readFileSync(ROUTING_FILE, 'utf8'), { ALPHA_URL: 'http://127.0.0.1:1', ALPHA_KEY: 'k' })
  const alias = routing.aliases.get('lb-guard')
  if (!alias) throw new Error('The test routing table has no guard.')
  const index = buildSourceIndex(await extractedPages(sampleId))
  return segmentsOf(guardInput(index, findInstructionPassages(index)), segmentSize(alias), 100).length
}

/** What the reference models say for a sample, as the JSON text a provider would send, found by running the pipeline once in this process. */
export async function referenceReplies(sampleId: string): Promise<{ long: string, reason: string | undefined }> {
  const { scripts } = referenceReview(sampleId)
  const said: { long?: string, reason?: string } = {}
  const recording = (label: 'long' | 'reason', model: JsonModel): JsonModel => ({
    ask: async (messages) => {
      const reply = await model.ask(messages)
      if (reply.kind === 'json') said[label] ??= JSON.stringify(reply.value)
      return reply
    },
  })
  await inTestRun(async () => reviewContract(
    { models: { long: recording('long', scripts.long), reason: recording('reason', scripts.reason), fast: scripts.fast }, guard: undefined, tracer: new Tracer(new Recorder()), playbook: loadPlaybook() },
    { contractId: randomUUID(), pages: await extractedPages(sampleId) },
    { calls: 0 },
    { onState: async () => {}, save: async () => {}, lastAttempt: false },
  ))
  if (said.long === undefined) throw new Error('The reference reviewer did not read the contract.')
  return { long: said.long, reason: said.reason }
}

/** Queues what the fake provider answers to a whole review: the guard's segments, the reading and the rating. */
export async function scriptReview(gw: ContractGateway, sampleId: string, guardScore = '0.0004'): Promise<void> {
  const replies = await referenceReplies(sampleId)
  const segments = await guardSegments(sampleId)
  for (let segment = 0; segment < segments; segment += 1) gw.provider.answerNext(guardScore)
  gw.provider.answerNext(replies.long)
  if (replies.reason !== undefined) gw.provider.answerNext(replies.reason)
}
