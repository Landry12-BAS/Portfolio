// Tests of the conversation client against a scripted socket: the token goes in the first frame and
// never in the address, only frames that fit the protocol get through, anything else closes the
// connection and is never looked at again, a connection that drops is opened again with a fresh pass
// and the same conversation, with growing waits and a limit, and every close code the server uses ends
// the client in the way the page words. Nothing here logs: a spy on the console proves it says nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { classifyClose, isResumable } from '~/boards/lb-02/closing'
import { ConversationSocket, HELLO_ANSWER_TIMEOUT_MS, RECONNECT_ATTEMPTS, reconnectDelay } from '~/boards/lb-02/socket'
import type { ConnectionStatus, End, Grant, SocketLike } from '~/boards/lb-02/socket'
import { CLOSE_CODE_MALFORMED } from '~/boards/lb-02/wire'
import type { ServerEvent } from '~/boards/lb-02/wire'

const READY = { type: 'ready', conversation: 'AbCdEfGhIjKlMnOp', resumed: false, transcript: [], step: 'details', language: 'en', messages_left: 30, closed: false, options: [], hold: null, booking: null }

/** A socket the test drives by hand. */
class ScriptedSocket implements SocketLike {
  readyState = 0
  readonly sent: string[] = []
  closedWith: number | undefined
  readonly #listeners: Record<string, ((event: never) => void)[]> = { open: [], message: [], close: [] }

  readonly url: string

  /** Starts a socket that is connecting to an address. */
  constructor(url: string) {
    this.url = url
  }

  /** Subscribes to an event, as the browser's socket allows. */
  addEventListener(type: 'open' | 'message' | 'close', listener: (event: never) => void): void {
    this.#listeners[type]?.push(listener)
  }

  /** Keeps a frame the page sent. */
  send(data: string): void {
    this.sent.push(data)
  }

  /** The page closes the socket. */
  close(code?: number): void {
    this.closedWith = code
    this.readyState = 3
  }

  /** The connection opens. */
  open(): void {
    this.readyState = 1
    for (const listener of this.#listeners.open ?? []) (listener as () => void)()
  }

  /** The server says something. */
  say(data: unknown): void {
    for (const listener of this.#listeners.message ?? []) (listener as (event: { data: unknown }) => void)({ data })
  }

  /** The server or the network closes the connection. */
  drop(code: number): void {
    this.readyState = 3
    for (const listener of this.#listeners.close ?? []) (listener as (event: { code: number }) => void)({ code })
  }
}

/** What a client was set up with, and what happened to it. */
function setup(grantFails: (attempt: number) => unknown = () => undefined) {
  const sockets: ScriptedSocket[] = []
  const statuses: { status: ConnectionStatus, attempt: number }[] = []
  const events: ServerEvent[] = []
  const ends: End[] = []
  let grants = 0
  const client = new ConversationSocket({
    grant: async (): Promise<Grant> => {
      grants += 1
      const failure = grantFails(grants)
      if (failure !== undefined) throw failure
      return { url: 'wss://api.example.com/ws/lb02/', token: `token-${grants}` }
    },
    connect: (url) => {
      const socket = new ScriptedSocket(url)
      sockets.push(socket)
      return socket
    },
    random: () => 0.5,
  }, {
    status: (status, attempt) => statuses.push({ status, attempt }),
    event: event => events.push(event),
    ended: end => ends.push(end),
  })
  return { client, sockets, statuses, events, ends, grants: () => grants }
}

/** Lets the client's promises settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/** Opens a client's first socket and gets it to `ready`. */
async function openToReady(rig: ReturnType<typeof setup>, conversation: string | null = null) {
  rig.client.open(conversation)
  await settle()
  const socket = rig.sockets.at(-1)!
  socket.open()
  socket.say(JSON.stringify(READY))
  return socket
}

describe('the conversation client', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens the connection without the token in the address, and sends it as the first frame, once the connection is open', async () => {
    const rig = setup()
    rig.client.open(null)
    await settle()
    const socket = rig.sockets[0]!
    expect(socket.url).toBe('wss://api.example.com/ws/lb02/')
    expect(socket.url).not.toContain('token')
    expect(socket.sent).toEqual([])
    socket.open()
    expect(socket.sent).toHaveLength(1)
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'hello', token: 'token-1', conversation: null })
    expect(rig.statuses.map(item => item.status)).toEqual(['connecting'])
  })

  it('is open after `ready`, which is passed on, and knows the conversation', async () => {
    const rig = setup()
    await openToReady(rig)
    expect(rig.client.status).toBe('open')
    expect(rig.client.conversation).toBe('AbCdEfGhIjKlMnOp')
    expect(rig.events.map(event => event.type)).toEqual(['ready'])
  })

  it('sends a message only when open, trimmed, and says what it did', async () => {
    const rig = setup()
    rig.client.open(null)
    await settle()
    expect(rig.client.send('hi')).toBe('not_open')
    const socket = rig.sockets[0]!
    socket.open()
    expect(rig.client.send('hi')).toBe('not_open')
    socket.say(JSON.stringify(READY))
    expect(rig.client.send('  hi  ')).toBe('sent')
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: 'message', text: 'hi' })
    expect(rig.client.send('   ')).toBe('invalid')
    expect(rig.client.send('x'.repeat(501))).toBe('invalid')
  })

  it('closes and stops, for good, at a frame that is not in the protocol, and never looks at the connection again', async () => {
    for (const frame of ['not json', '{"type":"typing"}', JSON.stringify({ ...READY, extra: 1 }), new ArrayBuffer(4)]) {
      const rig = setup()
      const socket = await openToReady(rig)
      socket.say(frame)
      expect(socket.closedWith, String(frame)).toBe(CLOSE_CODE_MALFORMED)
      expect(rig.ends).toEqual([{ reason: 'malformed' }])
      socket.say(JSON.stringify({ type: 'working' }))
      socket.drop(1006)
      expect(rig.events.map(event => event.type)).toEqual(['ready'])
      expect(rig.ends).toHaveLength(1)
    }
  })

  it('refuses anything before `ready` but an error that explains the close', async () => {
    const rig = setup()
    rig.client.open(null)
    await settle()
    const socket = rig.sockets[0]!
    socket.open()
    socket.say(JSON.stringify({ type: 'calendar', changes: [] }))
    expect(rig.ends).toEqual([{ reason: 'malformed' }])

    const explained = setup()
    explained.client.open(null)
    await settle()
    explained.sockets[0]!.open()
    explained.sockets[0]!.say(JSON.stringify({ type: 'error', code: 'conversation_gone', message: 'x' }))
    explained.sockets[0]!.drop(4404)
    expect(explained.events.map(event => event.type)).toEqual(['error'])
    expect(explained.ends).toEqual([{ reason: 'not_found' }])
  })

  it('refuses a second `ready` on one connection', async () => {
    const rig = setup()
    const socket = await openToReady(rig)
    socket.say(JSON.stringify(READY))
    expect(rig.ends).toEqual([{ reason: 'malformed' }])
  })

  it('says nothing to the console, whatever it hears', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
    const rig = setup()
    const socket = await openToReady(rig)
    rig.client.send('a private message')
    socket.say('garbage a private message')
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

describe('when the connection drops', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks for a fresh pass and resumes the same conversation, after a wait, and is open again at `ready`', async () => {
    const rig = setup()
    const first = await openToReady(rig)
    first.drop(1006)
    expect(rig.client.status).toBe('reconnecting')
    expect(rig.statuses.at(-1)).toEqual({ status: 'reconnecting', attempt: 1 })
    await vi.advanceTimersByTimeAsync(reconnectDelay(1, 0.5) - 1)
    expect(rig.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2)
    expect(rig.sockets).toHaveLength(2)
    const second = rig.sockets[1]!
    second.open()
    expect(JSON.parse(second.sent[0]!)).toEqual({ type: 'hello', token: 'token-2', conversation: 'AbCdEfGhIjKlMnOp' })
    second.say(JSON.stringify({ ...READY, resumed: true }))
    expect(rig.client.status).toBe('open')
    expect(rig.events.map(event => event.type)).toEqual(['ready', 'ready'])
    expect(rig.ends).toEqual([])
  })

  it('waits longer each time, up to a cap, and gives up after a few attempts with `lost`', async () => {
    expect([1, 2, 3, 4, 5, 6].map(attempt => reconnectDelay(attempt, 0.5))).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 16_000])
    expect(reconnectDelay(1, 0)).toBe(750)
    expect(reconnectDelay(1, 1)).toBe(1_250)

    const rig = setup()
    const first = await openToReady(rig)
    first.drop(1006)
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt += 1) {
      await vi.advanceTimersByTimeAsync(reconnectDelay(attempt, 0.5) + 1)
      expect(rig.sockets).toHaveLength(attempt + 1)
      rig.sockets.at(-1)!.drop(1006)
    }
    expect(rig.ends).toEqual([{ reason: 'lost', cause: undefined }])
    expect(rig.client.status).toBe('closed')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.sockets).toHaveLength(RECONNECT_ATTEMPTS + 1)
  })

  it('does not try again by itself when the first connection never opened', async () => {
    const rig = setup()
    rig.client.open(null)
    await settle()
    rig.sockets[0]!.drop(1006)
    expect(rig.ends).toEqual([{ reason: 'lost', cause: undefined }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.sockets).toHaveLength(1)
  })

  it('treats a server that never answers the hello as a drop', async () => {
    const rig = setup()
    const first = await openToReady(rig)
    first.drop(1006)
    await vi.advanceTimersByTimeAsync(1_100)
    const second = rig.sockets[1]!
    second.open()
    await vi.advanceTimersByTimeAsync(HELLO_ANSWER_TIMEOUT_MS + 1)
    expect(second.closedWith).toBe(1000)
    expect(rig.statuses.at(-1)?.status).toBe('reconnecting')
    second.drop(1000)
    expect(rig.ends).toEqual([])
  })

  it('retries a failed request for a pass while attempts are left, and ends with the cause when they are not', async () => {
    const failing = new Error('network')
    let broken = false
    const rig = setup(() => (broken ? failing : undefined))
    const first = await openToReady(rig)
    broken = true
    first.drop(1006)
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt += 1) await vi.advanceTimersByTimeAsync(reconnectDelay(attempt, 0.5) + 1)
    expect(rig.ends).toEqual([{ reason: 'grant_failed', cause: failing }])
  })

  it('ends at once, with the cause, when the very first pass cannot be had', async () => {
    const failing = new Error('verification')
    const rig = setup(() => failing)
    rig.client.open(null)
    await settle()
    expect(rig.ends).toEqual([{ reason: 'grant_failed', cause: failing }])
    expect(rig.sockets).toHaveLength(0)
  })
})

describe('every close code the server uses', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is read as one kind, and the kinds that leave the conversation on the server can be picked up', () => {
    expect(classifyClose(4401)).toBe('unauthorized')
    expect(classifyClose(4404)).toBe('not_found')
    expect(classifyClose(4408)).toBe('timed_out')
    expect(classifyClose(4429)).toBe('too_many')
    expect(classifyClose(1009)).toBe('too_big')
    expect(classifyClose(1011)).toBe('unavailable')
    for (const code of [4400, 1003, 1002]) expect(classifyClose(code)).toBe('bad_frame')
    for (const code of [1000, 1001, 1005, 1006, 1012, 4999]) expect(classifyClose(code)).toBe('transient')
    expect(['transient', 'timed_out', 'too_big', 'unavailable', 'unauthorized'].every(kind => isResumable(kind as never))).toBe(true)
    expect(['not_found', 'too_many', 'bad_frame'].some(kind => isResumable(kind as never))).toBe(false)
  })

  it('ends the client with the reason, without trying again, for each code that is not a drop', async () => {
    for (const [code, reason] of [[4404, 'not_found'], [4408, 'timed_out'], [4429, 'too_many'], [1009, 'too_big'], [1011, 'unavailable'], [4400, 'bad_frame']] as const) {
      const rig = setup()
      const socket = await openToReady(rig)
      socket.drop(code)
      expect(rig.ends, String(code)).toEqual([{ reason }])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(rig.sockets).toHaveLength(1)
    }
  })

  it('asks once more for a pass when a connection that had worked is refused with 4401, and stops if it is refused again', async () => {
    const rig = setup()
    const first = await openToReady(rig)
    first.drop(4401)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(rig.sockets).toHaveLength(2)
    rig.sockets[1]!.open()
    rig.sockets[1]!.drop(4401)
    expect(rig.ends).toEqual([{ reason: 'unauthorized' }])
  })

  it('stops at 4401 for a connection that never worked, without a second try', async () => {
    const rig = setup()
    rig.client.open(null)
    await settle()
    rig.sockets[0]!.open()
    rig.sockets[0]!.drop(4401)
    expect(rig.ends).toEqual([{ reason: 'unauthorized' }])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.sockets).toHaveLength(1)
  })
})

describe('ending', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports the visitor ending the conversation, closes the socket and ignores what comes after', async () => {
    const rig = setup()
    const socket = await openToReady(rig)
    rig.client.end()
    expect(socket.closedWith).toBe(1000)
    expect(rig.ends).toEqual([{ reason: 'visitor' }])
    socket.drop(1006)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.sockets).toHaveLength(1)
    expect(rig.client.send('hi')).toBe('not_open')
  })

  it('stops silently when the page is left, with no timer or socket left', async () => {
    const rig = setup()
    const first = await openToReady(rig)
    first.drop(1006)
    const statuses = rig.statuses.length
    rig.client.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rig.sockets).toHaveLength(1)
    expect(rig.ends).toEqual([])
    expect(rig.statuses).toHaveLength(statuses)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('picks the conversation up again with `resume`, with a fresh pass', async () => {
    const rig = setup()
    const first = await openToReady(rig)
    first.drop(4408)
    expect(rig.ends).toEqual([{ reason: 'timed_out' }])
    rig.client.resume()
    await settle()
    const second = rig.sockets[1]!
    second.open()
    expect(JSON.parse(second.sent[0]!)).toEqual({ type: 'hello', token: 'token-2', conversation: 'AbCdEfGhIjKlMnOp' })
  })
})
