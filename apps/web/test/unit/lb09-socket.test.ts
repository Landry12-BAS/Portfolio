// Tests of LB-09's progress client over a hand-driven socket: the pass goes in the first frame and
// never in the address, states are passed on, the meeting's end closes it cleanly, and every way the
// connection can go wrong ends the client once with the right reason (a dropped connection, a
// refusal, a meeting that is gone, a frame outside the protocol, a grant that fails, a server that
// never answers the hello), after which nothing it hears touches the page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HELLO_ANSWER_TIMEOUT_MS, ProgressSocket } from '~/boards/lb-09/socket'
import type { EndReason, SocketLike } from '~/boards/lb-09/socket'
import type { StateEvent } from '~/boards/lb-09/wire'

const MEETING = 'abcdefghijklmnop'

/** A socket the test opens, feeds and closes by hand. */
class HandSocket implements SocketLike {
  readyState = 0
  readonly sent: string[] = []
  readonly closes: number[] = []
  readonly listeners: Record<string, ((event: never) => void)[]> = { open: [], message: [], close: [] }

  /** Subscribes, as the browser's socket allows. */
  addEventListener(type: string, listener: (event: never) => void): void {
    this.listeners[type]?.push(listener)
  }

  /** Sends a frame to the server. */
  send(data: string): void {
    this.sent.push(data)
  }

  /** Closes from the page's side. */
  close(code?: number): void {
    this.closes.push(code ?? 1005)
    this.readyState = 3
  }

  /** The server accepts the connection. */
  opens(): void {
    this.readyState = 1
    for (const listener of this.listeners.open ?? []) (listener as () => void)()
  }

  /** The server sends a frame. */
  says(data: unknown): void {
    for (const listener of this.listeners.message ?? []) (listener as (event: { data: unknown }) => void)({ data })
  }

  /** The connection closes with a code. */
  closes_(code: number): void {
    this.readyState = 3
    for (const listener of this.listeners.close ?? []) (listener as (event: { code: number }) => void)({ code })
  }
}

/** A state frame as the server writes one. */
function state(changes: Partial<StateEvent> = {}): string {
  return JSON.stringify({ type: 'state', meeting: MEETING, status: 'processing', stage: 'decoding', failure: null, run_id: 'lb09-run', model_calls: 0, dropped_items: 0, updated_at: '2026-10-02T09:30:00Z', ...changes })
}

/** Makes a client over a hand socket and records what it tells the page. */
function connect(options: { grantFails?: boolean } = {}) {
  const sockets: HandSocket[] = []
  const states: StateEvent[] = []
  const ends: EndReason[] = []
  const client = new ProgressSocket(
    {
      grant: () => (options.grantFails ? Promise.reject(new Error('no')) : Promise.resolve({ url: 'ws://api.test/ws/lb09/', token: 'pass' })),
      connect: () => {
        const socket = new HandSocket()
        sockets.push(socket)
        return socket
      },
    },
    { state: event => states.push(event), ended: reason => ends.push(reason) },
  )
  return { client, sockets, states, ends, socket: () => sockets[0] as HandSocket }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the progress client', () => {
  it('sends the pass in the first frame, passes states on, and ends cleanly when the server closes after the end', async () => {
    const { client, socket, states, ends } = connect()
    client.open(MEETING)
    await vi.advanceTimersByTimeAsync(0)
    const hand = socket()
    hand.opens()
    expect(JSON.parse(hand.sent[0] ?? '{}')).toEqual({ type: 'hello', token: 'pass', meeting: MEETING })
    hand.says(state())
    hand.says(state({ stage: 'transcribing' }))
    hand.says(state({ status: 'done', stage: 'done', model_calls: 2 }))
    expect(states.map(event => event.stage)).toEqual(['decoding', 'transcribing', 'done'])
    hand.closes_(1000)
    expect(ends).toEqual(['over'])
  })

  it('says the connection dropped when it closes before the end, and refused on the service\'s codes', async () => {
    for (const [code, reason] of [[1006, 'dropped'], [4401, 'refused'], [1013, 'refused'], [4404, 'gone']] as const) {
      const { client, socket, ends } = connect()
      client.open(MEETING)
      await vi.advanceTimersByTimeAsync(0)
      socket().opens()
      socket().closes_(code)
      expect(ends, String(code)).toEqual([reason])
    }
  })

  it('closes on a frame outside the protocol and never passes it on', async () => {
    const { client, socket, states, ends } = connect()
    client.open(MEETING)
    await vi.advanceTimersByTimeAsync(0)
    socket().opens()
    socket().says(JSON.stringify({ type: 'state', meeting: MEETING, status: 'processing', stage: 'decoding', failure: null, run_id: '', model_calls: 0, dropped_items: 0, updated_at: 'x', surprise: '<script>' }))
    expect(states).toEqual([])
    expect(socket().closes).toEqual([4000])
    expect(ends).toEqual(['malformed'])
    socket().says(state())
    expect(states).toEqual([])
  })

  it('ends on the server\'s error events', async () => {
    const { client, socket, ends } = connect()
    client.open(MEETING)
    await vi.advanceTimersByTimeAsync(0)
    socket().opens()
    socket().says(JSON.stringify({ type: 'error', code: 'meeting_gone', message: 'Gone.' }))
    expect(ends).toEqual(['gone'])
    socket().closes_(4404)
    expect(ends).toEqual(['gone'])
  })

  it('ends when the grant fails, without opening a socket', async () => {
    const { client, sockets, ends } = connect({ grantFails: true })
    client.open(MEETING)
    await vi.advanceTimersByTimeAsync(0)
    expect(sockets).toHaveLength(0)
    expect(ends).toEqual(['grant_failed'])
  })

  it('gives up on a server that never answers the hello', async () => {
    const { client, socket, ends } = connect()
    client.open(MEETING)
    await vi.advanceTimersByTimeAsync(0)
    socket().opens()
    await vi.advanceTimersByTimeAsync(HELLO_ANSWER_TIMEOUT_MS)
    expect(socket().closes).toEqual([1000])
    expect(ends).toEqual(['dropped'])
  })

  it('tells the page nothing when the page closes it, and ignores the old connection afterwards', async () => {
    const { client, socket, states, ends } = connect()
    client.open(MEETING)
    await vi.advanceTimersByTimeAsync(0)
    socket().opens()
    client.close()
    expect(socket().closes).toEqual([1000])
    socket().says(state())
    socket().closes_(1006)
    expect(states).toEqual([])
    expect(ends).toEqual([])
  })
})
