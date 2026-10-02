// Tests of the recorder's runner for LB-02 (scripts/record/lb02.ts), against the test mock's real
// HTTP server and WebSocket: it opens a conversation as one synthetic visitor, says a sample's
// messages, lets other visitors do what the sample says they do, and keeps what the board would have
// been told. Every curated sample is recorded and checked against what the golden set says it shows.
// Against a live back end the runner has never run, and this file says so by running nowhere but on
// the mock.
import { startMockBackend } from '@lb/api-clients/testing'
import type { MockBackend } from '@lb/api-clients/testing'
import { ServiceTokens, privateKeyFromJwk } from '@lb/common/tokens'
import { recordingSchema } from '@lb/contracts'
import type { Recording } from '@lb/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { LB02_SAMPLES } from '../../shared/data/samples/lb02.ts'
import { readRecordedExchange } from '../../app/boards/lb-02/recorded.ts'
import type { RecordedExchange } from '../../app/boards/lb-02/recorded.ts'
import { Backend } from '../../scripts/record/backend.ts'
import { recordSample } from '../../scripts/record/record.ts'
import { makeTestKeys } from '../support/site-app.ts'

const keys = makeTestKeys()
// The moment the mock's clock stands still at, as in the fixtures: 2 October 2026, 11:30 in Prague.
const NOW = Date.parse('2026-10-02T09:30:00.000Z')
const clock = { now: () => NOW, sleep: () => Promise.resolve() }
let mock: MockBackend

/** Builds a recorder against the mock. */
function recorder(): Backend {
  return new Backend({
    apiUrl: new URL(mock.url),
    gatewayUrl: new URL(mock.url),
    signingKey: privateKeyFromJwk(JSON.parse(keys.siteJwk)),
    gatewayTokens: new ServiceTokens('web', privateKeyFromJwk(JSON.parse(keys.webJwk)), () => NOW / 1_000),
    fetch,
    clock,
  })
}

/** Reads a recording's exchanges by what they are. */
function exchangesOf(recording: Recording): RecordedExchange[] {
  return recording.exchanges.map(exchange => readRecordedExchange(exchange)).filter((item): item is RecordedExchange => item !== undefined)
}

/** Picks the exchanges of one kind. */
function ofKind<K extends RecordedExchange['kind']>(items: RecordedExchange[], kind: K): Extract<RecordedExchange, { kind: K }>[] {
  return items.filter((item): item is Extract<RecordedExchange, { kind: K }> => item.kind === kind)
}

/** Lays the mock's LB-02 out afresh, as every sample expects. */
async function resetCalendar(): Promise<void> {
  await fetch(new URL('/__mock/lb02/reset', mock.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
}

beforeAll(async () => {
  mock = await startMockBackend({ siteKey: keys.sitePublic, webKey: keys.webPublic, now: () => NOW })
})

afterAll(async () => {
  await mock.close()
})

beforeEach(async () => {
  await resetCalendar()
})

describe('recording LB-02 samples against the mock', () => {
  it('records the booking in English: the calendar, the hello, three messages with their receipts and the finished conversation', async () => {
    const recording = await recordSample(recorder(), 'lb-02', 'book-cupping-en')
    expect(recordingSchema.parse(recording)).toMatchObject({ v: 1, system: 'lb-02', sample: 'book-cupping-en', origin: 'mock', language: 'en' })

    const items = exchangesOf(recording)
    expect(items.map(item => item.kind)).toEqual(['calendar', 'hello', 'message', 'message', 'message', 'conversation'])
    expect(recording.exchanges.map(exchange => exchange.request.method)).toEqual(['GET', 'POST', 'POST', 'POST', 'POST', 'GET'])
    const turns = ofKind(items, 'message')
    expect(turns.map(turn => turn.request.text)).toEqual(LB02_SAMPLES[0].turns.map(turn => turn.say))
    expect(turns.map(turn => turn.turn.reply.receipt)).toEqual([null, 'hold_placed', 'booking_confirmed'])
    expect(turns.map(turn => turn.turn.reply.step)).toEqual(['availability', 'hold', 'done'])
    const [detail] = ofKind(items, 'conversation')
    expect(detail?.detail.booking).toMatchObject({ party_size: 2 })
    expect(detail?.detail.confirmation).toMatchObject({ to: 'jana@example.test', delivery: 'mock' })
  })

  it('keeps the calendar as the conversation opened on it, before any slot was the visitor\'s, and the changes each turn brought', async () => {
    const recording = await recordSample(recorder(), 'lb-02', 'book-cupping-en')
    const items = exchangesOf(recording)
    const [snapshot] = ofKind(items, 'calendar')
    expect(snapshot?.snapshot.slots.length).toBe(14 * 8)
    expect(snapshot?.snapshot.slots.some(slot => slot.mine || slot.status !== 'free')).toBe(false)
    const changes = ofKind(items, 'message').map(turn => turn.turn.calendar.flatMap(event => event.changes))
    expect(changes[0]).toEqual([])
    expect(changes[1]?.some(change => change.status === 'held' && change.mine)).toBe(true)
    expect(changes[2]?.some(change => change.status === 'booked' && change.mine)).toBe(true)
  })

  it('never keeps the visitor\'s token, anywhere in the recording', async () => {
    const recording = await recordSample(recorder(), 'lb-02', 'book-cupping-en')
    const text = JSON.stringify(recording)
    expect(text).not.toMatch(/"token"/)
    expect(text).not.toMatch(/eyJ|v1\./)
    const [hello] = ofKind(exchangesOf(recording), 'hello')
    expect(recording.exchanges[1]?.request.body).toEqual({ conversation: null })
    expect(hello?.ready.conversation).toMatch(/^[\w-]{16}$/)
  })

  it('records a conversation as a trace with no root span, complete but not finished, labelled as the mock\'s', async () => {
    const recording = await recordSample(recorder(), 'lb-02', 'book-cupping-en')
    expect(recording.trace.spans.some(span => span.kind === 'system.run')).toBe(false)
    expect(recording.stats).toMatchObject({ modelCalls: 7 })
    expect(recording.trace.spans.every(span => span.system === 'lb-02' && span.runId === recording.trace.runId)).toBe(true)
    expect(recording.origin).toBe('mock')
  })

  it('records the double-booking attempt: another visitor books the noon tasting, and the visitor never gets it', async () => {
    const recording = await recordSample(recorder(), 'lb-02', 'double-book-taken-slot-en')
    const items = exchangesOf(recording)
    const turns = ofKind(items, 'message')
    expect(turns).toHaveLength(2)
    const first = turns[0]?.turn.calendar.flatMap(event => event.changes) ?? []
    expect(first.some(change => change.offering === 'tasting' && change.status === 'booked' && !change.mine)).toBe(true)
    const [detail] = ofKind(items, 'conversation')
    expect(detail?.detail.booking).toBeNull()
    expect(detail?.detail.hold).toBeNull()
    expect(turns.every(turn => turn.turn.reply.receipt !== 'hold_placed' && turn.turn.reply.receipt !== 'booking_confirmed')).toBe(true)
  })

  it('records the Czech conversation in which another visitor\'s hold runs out: the wait, the slot freed, then the booking', async () => {
    const recording = await recordSample(recorder(), 'lb-02', 'two-tabs-held-by-other-cs')
    expect(recording.language).toBe('cs')
    const items = exchangesOf(recording)
    const turns = ofKind(items, 'message')
    expect(turns.map(turn => turn.request.waitMinutes)).toEqual([0, 6, 0, 0])
    const heldByOther = turns[0]?.turn.calendar.flatMap(event => event.changes) ?? []
    expect(heldByOther.some(change => change.offering === 'cupping' && change.status === 'held' && !change.mine)).toBe(true)
    const afterWait = turns[1]?.turn.calendar.flatMap(event => event.changes) ?? []
    expect(afterWait.some(change => change.offering === 'cupping' && change.status === 'free')).toBe(true)
    expect(turns.map(turn => turn.turn.reply.receipt)).toEqual([null, null, 'hold_placed', 'booking_confirmed'])
    expect(ofKind(items, 'conversation')[0]?.detail.booking).not.toBeNull()
  })

  it('records the injection attempt: the message is refused before any model reads it, and nothing is held or booked', async () => {
    const recording = await recordSample(recorder(), 'lb-02', 'injection-confirm-slot-en')
    const items = exchangesOf(recording)
    expect(ofKind(items, 'message').map(turn => turn.turn.reply.receipt)).toEqual(['injection_refused'])
    const [detail] = ofKind(items, 'conversation')
    expect(detail?.detail.booking).toBeNull()
    expect(detail?.detail.hold).toBeNull()
  })

  it('records the Czech booking with Czech receipts', async () => {
    const recording = await recordSample(recorder(), 'lb-02', 'book-tasting-cs')
    expect(recording.language).toBe('cs')
    const turns = ofKind(exchangesOf(recording), 'message')
    expect(turns.map(turn => turn.turn.reply.receipt)).toEqual([null, 'hold_placed', 'booking_confirmed'])
    expect(turns[1]?.turn.reply.text).toMatch(/podržen/)
  })

  it('records every curated sample, so each can be replayed', async () => {
    for (const sample of LB02_SAMPLES) {
      await resetCalendar()
      const recording = await recordSample(recorder(), 'lb-02', sample.id)
      expect(recordingSchema.safeParse(recording).success).toBe(true)
      expect(exchangesOf(recording)).toHaveLength(recording.exchanges.length)
    }
  })

  it('refuses a sample that does not exist, naming those that do', async () => {
    await expect(recordSample(recorder(), 'lb-02', 'no-such-sample')).rejects.toThrow(/no sample called "no-such-sample".*book-cupping-en/)
  })

  it('records nothing when the other visitor could not do what the sample says, rather than a replay that shows something else', async () => {
    // Someone has already booked the cupping the other visitor is to hold, so the sample's world cannot be made.
    expect((await (await fetch(new URL('/__mock/lb02/other-visitor', mock.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'books', offering: 'cupping', day: 1, time: '14:30' }) })).json() as { ok: boolean }).ok).toBe(true)
    await expect(recordSample(recorder(), 'lb-02', 'two-tabs-held-by-other-cs')).rejects.toThrow(/did not hold the cupping on 2026-10-03 at 14:30/)
  })
})
