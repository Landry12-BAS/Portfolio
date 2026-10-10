// Tests of LB-09's wire protocol as the page speaks it: the hello frame, and which frames from the
// server are events of the protocol (a state, an error) and which are refused (a binary frame, an
// oversized one, an unknown type, a state with a field the protocol does not have).
import { describe, expect, it } from 'vitest'

import { CLOSE_CODES, helloText, MAX_SERVER_FRAME_LENGTH, parseServerFrame } from '~/boards/lb-09/wire'

const MEETING = 'abcdefghijklmnop'

/** A state frame as the server writes one. */
function stateFrame(changes: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'state', meeting: MEETING, status: 'processing', stage: 'transcribing', failure: null, run_id: 'lb09-run', model_calls: 0, dropped_items: 0, updated_at: '2026-10-02T09:30:00Z', ...changes })
}

describe('the hello frame', () => {
  it('carries the pass and the meeting, and nothing else', () => {
    expect(JSON.parse(helloText('pass', MEETING))).toEqual({ type: 'hello', token: 'pass', meeting: MEETING })
  })

  it('refuses to name something that is not a meeting ID', () => {
    expect(() => helloText('pass', '../admin')).toThrow()
    expect(() => helloText('pass', 'short')).toThrow()
  })
})

describe('frames from the server', () => {
  it('reads a state', () => {
    const event = parseServerFrame(stateFrame())
    expect(event?.type).toBe('state')
    if (event?.type === 'state') expect(event.stage).toBe('transcribing')
  })

  it('reads an error event', () => {
    expect(parseServerFrame(JSON.stringify({ type: 'error', code: 'meeting_gone', message: 'Gone.' }))).toEqual({ type: 'error', code: 'meeting_gone', message: 'Gone.' })
  })

  it('refuses what is not of the protocol', () => {
    expect(parseServerFrame(new ArrayBuffer(8))).toBeUndefined()
    expect(parseServerFrame('not json')).toBeUndefined()
    expect(parseServerFrame(JSON.stringify({ type: 'surprise' }))).toBeUndefined()
    expect(parseServerFrame(stateFrame({ extra: 1 }))).toBeUndefined()
    expect(parseServerFrame(stateFrame({ stage: 'thinking' }))).toBeUndefined()
    expect(parseServerFrame(stateFrame({ failure: 'bad_luck' }))).toBeUndefined()
    expect(parseServerFrame(JSON.stringify({ type: 'error', code: 'unknown_code', message: 'x' }))).toBeUndefined()
    expect(parseServerFrame(`${stateFrame()}${' '.repeat(MAX_SERVER_FRAME_LENGTH)}`)).toBeUndefined()
  })

  it('names the close codes the service uses', () => {
    expect(CLOSE_CODES.unauthorized).toBe(4401)
    expect(CLOSE_CODES.notFound).toBe(4404)
    expect(CLOSE_CODES.timedOut).toBe(4408)
  })
})
