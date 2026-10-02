// LB-04's review against the real gateway: services/gateway's own app, on a real Redis, in front of a
// fake provider, with the real engine, extraction and database. A scripted model can't show that the
// requests the pipeline builds are ones the gateway accepts, that the calls land in the right quotas and
// the right trace, or that the worst case a review can make is one the gateway lets through. This can: what
// the service sends is checked by the gateway's own checks, and what the provider receives is read off the wire.
import { randomBytes } from 'node:crypto'

import { createRun, gatewayErrorOf, RedisSpanWriter, runScope, Tracer } from '@lb/common'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest'

import type { ContractGateway } from '../../../../packages/common/test/support/contract-gateway.ts'
import { ALIASES, GatewayJsonModel, MAX_OUTPUT_TOKENS } from '../../src/modules/lb04/analysis/model.ts'
import { makeRedline, startContract } from '../../src/modules/lb04/engine/service.ts'
import { readContractView, readReportView } from '../../src/modules/lb04/engine/store.ts'
import { reviewServices } from '../../src/modules/lb04/index.ts'
import { createLb04Harness, drive } from '../support/lb04-engine.ts'
import type { Lb04Harness } from '../support/lb04-engine.ts'
import { guardSegments, referenceReplies, scriptReview, startLb04Gateway } from '../support/lb04-gateway.ts'

let gw: ContractGateway
let harness: Lb04Harness

/** Starts a gateway on a fake provider and points the engine at it: the models, the guard and the tracer all go through it. */
async function useNewGateway(): Promise<void> {
  gw = await startLb04Gateway(inject('redisUrl'))
  harness.deps.review = reviewServices(gw.client)
  harness.deps.tracer = new Tracer(new RedisSpanWriter(gw.redis, gw.prefix))
}

beforeAll(async () => {
  harness = await createLb04Harness(inject('databaseUrl'))
})

afterAll(async () => {
  await harness.close()
})

beforeEach(async () => {
  harness.clock.set('2026-10-02T09:00:00.000Z')
  harness.retries.length = 0
  await harness.query('DELETE FROM lb04.contracts')
  await harness.query('DELETE FROM lb04.usage_counters')
})

/** A visitor of its own, so no test spends another's daily calls. */
function newVisitor(): string {
  return `session-${randomBytes(8).toString('hex')}`
}

/** Starts the review of a sample as a visitor of its own. */
async function start(session: string, sampleId: string): Promise<string> {
  return (await startContract(harness.deps, session, { from: 'sample', sampleId })).id
}

describe('a review through the gateway', () => {
  beforeAll(useNewGateway)
  afterAll(async () => {
    await gw.close()
  })
  beforeEach(() => {
    gw.provider.reset()
  })

  it('makes the three calls a contract needs, as the gateway expects them, and finishes with the report the reference reviewer would write', async () => {
    await scriptReview(gw, 'wholesale-supply')
    const session = newVisitor()
    const id = await start(session, 'wholesale-supply')

    await drive(harness)

    const view = await readContractView(harness.deps.db, session, id, harness.clock.now())
    expect(view).toMatchObject({ state: 'done', pages: 11 })
    const report = await readReportView(harness.deps.db, session, id, harness.clock.now())
    expect(report.calls).toBe(3)
    expect(report.findings.length).toBeGreaterThan(3)
    const segments = await guardSegments('wholesale-supply')
    expect(gw.provider.requests).toHaveLength(segments + 2)
    const sent = gw.provider.requests as { body: { model: string, messages: { role: string, content: string }[], [key: string]: unknown }, headers: Record<string, string | string[] | undefined> }[]
    // The guard reads each overlapping segment as a message of its own, on the classifier.
    for (const request of sent.slice(0, segments)) {
      expect(request.body.model).toBe('alpha/guard-model')
      expect(request.body.messages.map(message => message.role)).toEqual(['user'])
    }
    // The reading goes to the long-document model with the system prompt that says the contract is data, and the rating to the same provider's model with its own limit.
    const [reading, rating] = sent.slice(segments)
    expect(reading?.body).toMatchObject({ model: 'alpha/small-model', max_completion_tokens: MAX_OUTPUT_TOKENS.long, temperature: 0 })
    expect(rating?.body).toMatchObject({ model: 'alpha/small-model', max_completion_tokens: MAX_OUTPUT_TOKENS.reason, temperature: 0 })
    for (const request of [reading, rating]) {
      expect(request?.body).not.toHaveProperty('response_format')
      expect(request?.body.messages.map(message => message.role)).toEqual(['system', 'user'])
      expect(request?.body.messages[0]?.content).toContain('untrusted data')
      expect(request?.headers.authorization).toBe('Bearer alpha-key')
    }
  })

  it('counts the guard as one call however many segments it reads, so a review with its repairs and its three redlines is exactly the eight calls the system may make', async () => {
    const replies = await referenceReplies('wholesale-supply')
    const segments = await guardSegments('wholesale-supply')
    for (let segment = 0; segment < segments; segment += 1) gw.provider.answerNext('0.0004')
    // The reading and the rating each answer wrongly once and are repaired: five calls with the guard's.
    gw.provider.answerNext('I have read the contract and found nothing in JSON, sorry.')
    gw.provider.answerNext(replies.long)
    gw.provider.answerNext('Here is my rating, in prose.')
    if (replies.reason === undefined) throw new Error('The reference reviewer did not rate anything.')
    gw.provider.answerNext(replies.reason)
    const session = newVisitor()
    const id = await start(session, 'wholesale-supply')
    await drive(harness)
    const report = await readReportView(harness.deps.db, session, id, harness.clock.now())
    expect(report.calls).toBe(5)

    // Three redlines, one call each.
    for (const finding of report.findings.slice(0, 3)) {
      gw.provider.answerNext(JSON.stringify({ replacement: `The parties agree wording that meets the playbook for ${finding.rule}.` }))
      await makeRedline(harness.deps, session, id, finding.id)
    }

    // The gateway has counted eight calls for the run, and refuses a ninth with its own code.
    const ninth = await runScope(createRun({ system: 'lb-04', runId: id, session }), () => new GatewayJsonModel(gw.client.chat(ALIASES.fast), MAX_OUTPUT_TOKENS.fast).ask([{ role: 'system', content: 'Answer in JSON.' }, { role: 'user', content: 'one more' }]).catch((error: unknown) => error))
    expect(gatewayErrorOf(ninth)).toMatchObject({ status: 429, code: 'quota_exceeded' })
    expect(gw.provider.requests).toHaveLength(segments + 4 + 3)
  })

  it('writes one trace under the contract\'s id: the root span, the pipeline\'s steps under it, and the gateway\'s calls under their steps, finished for the Scope', async () => {
    await scriptReview(gw, 'wholesale-supply')
    const session = newVisitor()
    const id = await start(session, 'wholesale-supply')

    await drive(harness)

    const spans = await gw.runSpans(id)
    const root = spans.find(span => span.name === 'contract review')
    expect(root).toMatchObject({ kind: 'system.run', system: 'lb-04', status: 'ok', attrs: { outcome: 'done', origin: 'sample', pages: 11, model_calls: 3 } })
    const steps = new Map(spans.filter(span => span.kind === 'system.step').map(span => [span.spanId as string, span]))
    expect([...steps.values()].map(step => step.name)).toEqual(['extract text', 'split clauses', 'screen for injection', 'cited analysis', 'verify quotes', 'structured report', 'assemble report'])
    for (const step of steps.values()) expect(step.parentId, step.name as string).toBe(root?.spanId)
    // The gateway's calls are named for their alias, nest under the step that made them, and each holds the provider attempts that served it.
    const calls = spans.filter(span => span.kind === 'gateway.call')
    expect(calls.map(call => call.name)).toEqual(['lb-guard', 'lb-long', 'lb-reason'])
    expect(calls.map(call => steps.get(call.parentId as string)?.name)).toEqual(['screen for injection', 'cited analysis', 'structured report'])
    const attempts = spans.filter(span => span.kind === 'gateway.attempt')
    expect(attempts.map(attempt => calls.find(call => call.spanId === attempt.parentId)?.name)).toEqual(['lb-guard', 'lb-long', 'lb-reason'])
    const answer = await gw.readTrace(id)
    expect(answer.status).toBe(200)
    expect(((await answer.json()) as { finished: boolean }).finished).toBe(true)
  })

  it('carries nothing the contract says into the trace: not a clause, not a quote, not the title', async () => {
    await scriptReview(gw, 'wholesale-supply')
    const session = newVisitor()
    const id = await start(session, 'wholesale-supply')

    await drive(harness)

    const trace = JSON.stringify(await gw.runSpans(id))
    const report = await readReportView(harness.deps.db, session, id, harness.clock.now())
    for (const finding of report.findings) {
      if (finding.kind === 'risk') expect(trace).not.toContain(finding.quote.slice(0, 30))
    }
    expect(trace).not.toContain('Wholesale supply agreement')
    expect(trace).not.toContain('Basalt')
  })

  it('flags a contract that talks to its reviewer when the guard says so, and still reports only what the verifier kept', async () => {
    await scriptReview(gw, 'hostile-supply', '0.97')
    const session = newVisitor()
    const id = await start(session, 'hostile-supply')

    await drive(harness)

    const report = await readReportView(harness.deps.db, session, id, harness.clock.now())
    expect(report.screen).toMatchObject({ verdict: 'flagged', guardScore: 0.97 })
    expect(report.screen.passageCount).toBeGreaterThan(0)
    expect(report.findings.length).toBeGreaterThan(0)
  })
})

// A gateway keeps a circuit breaker for each model, and a provider that fails opens it for half a minute, so each of these tests has a gateway of its own.
describe('when the provider fails', () => {
  beforeEach(useNewGateway)
  afterEach(async () => {
    await gw.close()
  })

  it('retries after the gateway\'s own refusal, then ends the contract as unavailable without a word of the provider\'s in what the visitor sees', async () => {
    for (let segment = 0; segment < await guardSegments('wholesale-supply'); segment += 1) gw.provider.answerNext('0.0004')
    // Every attempt at the reading meets a provider that is down, with a message that must not travel.
    for (let attempt = 0; attempt < 12; attempt += 1) gw.provider.enqueue({ status: 500, body: { error: { message: 'alpha is down: the contract said ACME owes 4,000,000' } } })
    const session = newVisitor()
    const id = await start(session, 'wholesale-supply')

    await drive(harness)

    const view = await readContractView(harness.deps.db, session, id, harness.clock.now())
    expect(view).toMatchObject({ state: 'failed', failure: { code: 'analysis_unavailable' } })
    expect(JSON.stringify(view)).not.toMatch(/alpha|ACME|4,000,000/)
    const counter = await harness.query(`SELECT used FROM lb04.usage_counters WHERE session_key = $1 AND kind = 'contract'`, [session])
    expect(counter[0]?.used).toBe(0)
    expect(harness.retries).toHaveLength(2)
  })

  it('goes on without the guard when the guard cannot be read: the screen says unchecked, and the verifier still holds', async () => {
    // The classifier answers in a form the gateway refuses, for every segment.
    const segments = await guardSegments('wholesale-supply')
    for (let segment = 0; segment < segments; segment += 1) gw.provider.answerNext('maybe')
    const replies = await referenceReplies('wholesale-supply')
    gw.provider.answerNext(replies.long)
    if (replies.reason !== undefined) gw.provider.answerNext(replies.reason)
    const session = newVisitor()
    const id = await start(session, 'wholesale-supply')

    await drive(harness)

    const report = await readReportView(harness.deps.db, session, id, harness.clock.now())
    expect(report.screen.verdict).toBe('unchecked')
    expect(report.findings.length).toBeGreaterThan(0)
    // The guard's failed call is not counted as one the review paid for.
    expect(report.calls).toBe(2)
  })
})
