// Tests of LB-02's wire protocol as the page speaks it: every event the server may send is read
// strictly (an unknown type, a field nobody planned for, a wrong type, a value out of range, text that
// is not JSON, a binary frame, an enormous frame are all refused), the frames the page sends are exactly
// the protocol's, and the mock back end's conversations, which the end-to-end tests run against, say
// nothing the board's strict schemas would refuse.
import { Lb02Hub, readOfferings } from '@lb/api-clients/testing'
import type { Lb02HubTransport } from '@lb/api-clients/testing'
import { describe, expect, it } from 'vitest'

import { LB02_SAMPLES } from '#shared/data/samples/lb02'

import { CLOSE_CODES, MAX_OPTION_NUMBER, MAX_SERVER_FRAME_LENGTH, clientFrameSchema, helloText, messageText, parseServerFrame } from '~/boards/lb-02/wire'

const READY = {
  type: 'ready',
  conversation: 'AbCdEfGhIjKlMnOp',
  resumed: false,
  transcript: [{ role: 'visitor', text: 'Hi' }],
  step: 'details',
  language: 'en',
  messages_left: 29,
  closed: false,
  options: [],
  hold: null,
  booking: null,
}

const REPLY = {
  type: 'reply',
  text: 'Hello!',
  receipt: null,
  tools: [{ name: 'update_details', executed: true, ok: true, error: '' }],
  model_calls: 3,
  step: 'availability',
  language: 'en',
  messages_left: 28,
  closed: false,
  options: [{ number: 1, slot: 7, offering: 'cupping', starts_at: '2026-10-06T12:30:00Z', ends_at: '2026-10-06T13:30:00Z' }],
  hold: null,
  booking: null,
}

/** Reads an object as a server frame. */
function read(value: unknown) {
  return parseServerFrame(JSON.stringify(value))
}

describe('events from the server', () => {
  it('accepts each event of the protocol', () => {
    expect(read(READY)?.type).toBe('ready')
    expect(read({ type: 'working' })?.type).toBe('working')
    expect(read(REPLY)?.type).toBe('reply')
    expect(read({ type: 'calendar', changes: [{ slot: 1, offering: 'tasting', starts_at: '2026-10-06T10:00:00Z', ends_at: '2026-10-06T10:45:00Z', status: 'held', mine: true, until: '2026-10-02T09:35:00+00:00' }] })?.type).toBe('calendar')
    expect(read({ type: 'calendar_reset' })?.type).toBe('calendar_reset')
    expect(read({ type: 'error', code: 'message_too_long', message: 'A message may be at most 500 characters.' })?.type).toBe('error')
    for (const code of ['turn_failed', 'too_many_pending', 'too_many_connections']) {
      expect(read({ type: 'error', code, message: 'x' })?.type).toBe('error')
    }
  })

  it('reads whether the answer to the last message is still on its way, and counts a ready that does not say as not pending', () => {
    const waiting = read({ ...READY, pending: true })
    const quiet = read(READY)
    expect(waiting?.type === 'ready' && waiting.pending).toBe(true)
    expect(quiet?.type === 'ready' && quiet.pending).toBe(false)
    expect(read({ ...READY, pending: 'yes' })).toBeUndefined()
  })

  it('refuses a type nobody defined, a missing field, a field nobody planned for and a wrong type', () => {
    expect(read({ type: 'typing' })).toBeUndefined()
    expect(read({ ...READY, transcript: undefined })).toBeUndefined()
    expect(read({ ...READY, extra: true })).toBeUndefined()
    expect(read({ ...REPLY, tools: [{ name: 'x', executed: true, ok: true, error: '', result: {} }] })).toBeUndefined()
    expect(read({ ...REPLY, model_calls: '3' })).toBeUndefined()
    expect(read({ type: 'working', extra: 1 })).toBeUndefined()
  })

  it('refuses values the protocol does not allow: a step, a receipt, a status, an ID, a moment, a count', () => {
    expect(read({ ...READY, step: 'paying' })).toBeUndefined()
    expect(read({ ...REPLY, receipt: 'gift' })).toBeUndefined()
    expect(read({ ...READY, conversation: 'short' })).toBeUndefined()
    expect(read({ ...READY, conversation: 'has spaces and <b> in it' })).toBeUndefined()
    expect(read({ ...READY, messages_left: 31 })).toBeUndefined()
    expect(read({ ...READY, messages_left: -1 })).toBeUndefined()
    expect(read({ ...REPLY, options: [{ ...REPLY.options[0], starts_at: 'tomorrow' }] })).toBeUndefined()
    expect(read({ type: 'calendar', changes: [{ slot: 1, offering: 'Tasting Room', starts_at: '2026-10-06T10:00:00Z', ends_at: '2026-10-06T10:45:00Z', status: 'free', mine: false, until: null }] })).toBeUndefined()
    expect(read({ type: 'error', code: 'made_up', message: 'x' })).toBeUndefined()
  })

  it('reads an option number past the six a list holds, because a slot keeps its number all conversation', () => {
    const option = REPLY.options[0]
    expect(read({ ...REPLY, options: [{ ...option, number: 23 }] })?.type).toBe('reply')
    expect(read({ ...REPLY, options: [{ ...option, number: MAX_OPTION_NUMBER }] })?.type).toBe('reply')
    expect(read({ ...REPLY, options: [{ ...option, number: MAX_OPTION_NUMBER + 1 }] })).toBeUndefined()
    expect(read({ ...REPLY, options: [{ ...option, number: 0 }] })).toBeUndefined()
  })

  it('refuses text that is not JSON, JSON that is not an object, a binary frame and an enormous frame', () => {
    expect(parseServerFrame('not json')).toBeUndefined()
    expect(parseServerFrame('[]')).toBeUndefined()
    expect(parseServerFrame('null')).toBeUndefined()
    expect(parseServerFrame(new ArrayBuffer(8))).toBeUndefined()
    expect(parseServerFrame(new Blob(['{}']))).toBeUndefined()
    expect(parseServerFrame(undefined)).toBeUndefined()
    expect(parseServerFrame(`{"type":"working"}${' '.repeat(MAX_SERVER_FRAME_LENGTH)}`)).toBeUndefined()
  })

  it('does not take a model-made tool name for a safe one: it is kept as text, bounded', () => {
    const event = read({ ...REPLY, tools: [{ name: '<script>alert(1)</script>', executed: false, ok: false, error: 'step_refused' }] })
    expect(event?.type === 'reply' && event.tools[0]?.name).toBe('<script>alert(1)</script>')
    expect(read({ ...REPLY, tools: [{ name: 'x'.repeat(65), executed: false, ok: false, error: '' }] })).toBeUndefined()
  })
})

describe('frames from the page', () => {
  it('writes the hello with the token in the frame, and the conversation to resume or null', () => {
    expect(JSON.parse(helloText('a-token', null))).toEqual({ type: 'hello', token: 'a-token', conversation: null })
    expect(JSON.parse(helloText('a-token', 'AbCdEfGhIjKlMnOp'))).toEqual({ type: 'hello', token: 'a-token', conversation: 'AbCdEfGhIjKlMnOp' })
    expect(() => helloText('', null)).toThrow()
    expect(() => helloText('a-token', 'nope')).toThrow()
  })

  it('writes a message trimmed, of one to 500 characters, and refuses the rest', () => {
    expect(JSON.parse(messageText('  Hello  '))).toEqual({ type: 'message', text: 'Hello' })
    expect(() => messageText('   ')).toThrow()
    expect(() => messageText('x'.repeat(501))).toThrow()
    expect(messageText('x'.repeat(500)).length).toBeLessThan(600)
  })

  it('knows no other frame', () => {
    expect(clientFrameSchema.safeParse({ type: 'hello', token: 't', conversation: null, extra: 1 }).success).toBe(false)
    expect(clientFrameSchema.safeParse({ type: 'ping' }).success).toBe(false)
  })

  it('names the close codes the README lists', () => {
    expect(CLOSE_CODES).toMatchObject({ unauthorized: 4401, notFound: 4404, timedOut: 4408, tooManyConversations: 4429, badFrame: 4400, tooBig: 1009, unsupported: 1003, unavailable: 1011, tryAgainLater: 1013 })
  })
})

describe('the mock back end speaks only what the board accepts', () => {
  it('sends nothing the strict schemas refuse in any of the curated conversations', async () => {
    let clock = Date.UTC(2026, 9, 5, 9, 0, 0)
    const hub = new Lb02Hub(readOfferings(), { now: () => clock, verify: token => (token === 'pass' ? 'session-aaaaaaaaaaaaaaaa' : undefined) })
    for (const sample of LB02_SAMPLES) {
      const frames: string[] = []
      const transport: Lb02HubTransport = { send: text => frames.push(text), close: () => {} }
      const connection = hub.open(transport)
      connection.receive(JSON.stringify({ type: 'hello', token: 'pass', conversation: null }))
      for (const turn of sample.turns) {
        if (turn.waitMinutes > 0) {
          clock += turn.waitMinutes * 60_000
          hub.sweep()
        }
        connection.receive(JSON.stringify({ type: 'message', text: turn.say }))
        await new Promise(resolve => setImmediate(resolve))
      }
      hub.resetCalendar()
      expect(frames.length, sample.id).toBeGreaterThan(sample.turns.length)
      for (const frame of frames) expect(parseServerFrame(frame), `${sample.id}: ${frame.slice(0, 120)}`).toBeDefined()
      connection.dispose()
    }
  })
})
