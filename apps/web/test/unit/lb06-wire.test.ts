// Tests of the words LB-06's WebSocket speaks (wire.ts) and of what each close code means for the page
// (closing.ts): the one frame the page sends is checked before it is sent, every frame the server sends
// is checked before the page looks at it, and anything that is not text, is too long, is not JSON or
// does not fit the protocol is refused. The good frames are real ones, from an incident the mock's
// simulator played.
import { LB06_LIMITS } from '@lb/contracts'
import { beforeAll, describe, expect, it } from 'vitest'
import { classifyClose } from '~/boards/lb-06/closing'
import { CLOSE_CODE_MALFORMED, CLOSE_CODES, helloText, MAX_FRAME_CHARS, parseServerFrame } from '~/boards/lb-06/wire'
import { playIncident } from '../support/lb06-incident'
import type { PlayedIncident } from '../support/lb06-incident'

const INCIDENT_ID = '3f2b7c1e-5a4d-4c8e-9b6a-1d2e3f4a5b6c'
let incident: PlayedIncident

beforeAll(async () => {
  incident = await playIncident({ sampleId: 'bad-deploy' })
})

describe('the hello', () => {
  it('carries the pass, the incident and the number of the last event the page holds, and nothing else', () => {
    expect(JSON.parse(helloText('a-pass', INCIDENT_ID, 12))).toEqual({ type: 'hello', token: 'a-pass', incident: INCIDENT_ID, after: 12 })
  })

  it('is refused before it is sent when the pass is empty or too long, the incident is not an id, or the number is out of range', () => {
    expect(() => helloText('', INCIDENT_ID, 0)).toThrow()
    expect(() => helloText('x'.repeat(1_025), INCIDENT_ID, 0)).toThrow()
    expect(() => helloText('a-pass', 'not-an-id', 0)).toThrow()
    expect(() => helloText('a-pass', INCIDENT_ID, -1)).toThrow()
    expect(() => helloText('a-pass', INCIDENT_ID, LB06_LIMITS.maxEvents + 1)).toThrow()
    expect(() => helloText('a-pass', INCIDENT_ID, 1.5)).toThrow()
  })
})

describe('the frames the server sends', () => {
  it('reads a ready frame with the incident and its events, and an event frame', () => {
    const ready = parseServerFrame(JSON.stringify({ type: 'ready', incident: incident.view, events: incident.events }))
    expect(ready?.type).toBe('ready')
    const first = incident.events[0]!
    expect(parseServerFrame(JSON.stringify({ type: 'event', event: first }))).toEqual({ type: 'event', event: first })
  })

  it('reads the error frames the server may send', () => {
    for (const code of ['invalid_frame', 'already_said_hello', 'too_many_connections']) {
      expect(parseServerFrame(JSON.stringify({ type: 'error', code }))).toEqual({ type: 'error', code })
    }
  })

  it('refuses everything else: binary data, text that is not JSON, an unknown type, a field nobody planned for, a code the server does not use, an event that does not fit', () => {
    const first = incident.events[0]!
    expect(parseServerFrame(new ArrayBuffer(8))).toBeUndefined()
    expect(parseServerFrame('not json')).toBeUndefined()
    expect(parseServerFrame(JSON.stringify({ type: 'surprise' }))).toBeUndefined()
    expect(parseServerFrame(JSON.stringify({ type: 'event', event: first, extra: true }))).toBeUndefined()
    expect(parseServerFrame(JSON.stringify({ type: 'error', code: 'made_up' }))).toBeUndefined()
    expect(parseServerFrame(JSON.stringify({ type: 'event', event: { ...first, kind: 'incident.exploded' } }))).toBeUndefined()
    expect(parseServerFrame(JSON.stringify({ type: 'event', event: { ...first, seq: 0 } }))).toBeUndefined()
  })

  it('refuses a frame longer than the page reads', () => {
    expect(parseServerFrame(`{"type":"error","code":"invalid_frame","pad":"${'x'.repeat(MAX_FRAME_CHARS)}"}`)).toBeUndefined()
  })
})

describe('what a close means', () => {
  it('reads each code the server uses', () => {
    expect(classifyClose(CLOSE_CODES.unauthorized)).toBe('unauthorized')
    expect(classifyClose(CLOSE_CODES.notFound)).toBe('not_found')
    expect(classifyClose(CLOSE_CODES.timedOut)).toBe('timed_out')
    expect(classifyClose(CLOSE_CODES.tooBig)).toBe('too_big')
    expect(classifyClose(CLOSE_CODES.unavailable)).toBe('unavailable')
    expect(classifyClose(CLOSE_CODES.badFrame)).toBe('bad_frame')
    expect(classifyClose(CLOSE_CODES.unsupported)).toBe('bad_frame')
    expect(classifyClose(CLOSE_CODE_MALFORMED)).toBe('bad_frame')
  })

  it('treats a visitor with too many connections, a dropped connection and anything unknown as worth trying again', () => {
    expect(classifyClose(CLOSE_CODES.tryAgainLater)).toBe('transient')
    expect(classifyClose(1006)).toBe('transient')
    expect(classifyClose(1001)).toBe('transient')
    expect(classifyClose(4999)).toBe('transient')
  })
})
