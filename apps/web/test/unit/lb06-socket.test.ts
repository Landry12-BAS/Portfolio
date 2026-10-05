// Tests of the incident feed client against a scripted socket: the pass goes in the first frame and
// never in the address, with the number of the last event the page holds; only frames that fit the
// protocol get through, and anything else closes the connection and is never looked at again; a
// connection that drops is opened again with a fresh pass and continues after the last event it
// heard, with growing waits and a limit; and every close code the server uses ends the client the way
// the page words it. The frames are real ones from an incident the mock's simulator played.
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HELLO_ANSWER_TIMEOUT_MS, IncidentSocket, RECONNECT_ATTEMPTS, reconnectDelay } from '~/boards/lb-06/socket'
import type { ConnectionStatus, End, Grant, SocketLike } from '~/boards/lb-06/socket'
import { CLOSE_CODE_MALFORMED, CLOSE_CODES } from '~/boards/lb-06/wire'
import type { ServerFrame } from '~/boards/lb-06/wire'
import { playIncident } from '../support/lb06-incident'
import type { PlayedIncident } from '../support/lb06-incident'

const INCIDENT_ID = '3f2b7c1e-5a4d-4c8e-9b6a-1d2e3f4a5b6c'
let incident: PlayedIncident

beforeAll(async () => {
  incident = await playIncident({ sampleId: 'bad-deploy' })
})

/** A `ready` frame holding the first events of the incident. */
function ready(count: number): string {
  const events = incident.events.slice(0, count)
  return JSON.stringify({ type: 'ready', incident: { ...incident.view, lastSeq: events.at(-1)?.seq ?? 0 }, events })
}

/** An `event` frame for one event of the incident. */
function eventFrame(index: number): string {
  return JSON.stringify({ type: 'event', event: incident.events[index] })
}

/** A socket the test drives by hand. */
class ScriptedSocket implements SocketLike {
  readyState = 0
  readonly sent: string[] = []
  closedWith: number | undefined
  readonly url: string
  readonly #listeners: Record<string, ((event: never) => void)[]> = { open: [], message: [], close: [] }

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
  const frames: ServerFrame[] = []
  const ends: End[] = []
  let grants = 0
  const client = new IncidentSocket({
    grant: async (): Promise<Grant> => {
      grants += 1
      const failure = grantFails(grants)
      if (failure !== undefined) throw failure
      return { url: 'wss://api.example.com/ws/lb06/', token: `token-${grants}` }
    },
    connect: (url) => {
      const socket = new ScriptedSocket(url)
      sockets.push(socket)
      return socket
    },
    random: () => 0.5,
  }, {
    status: (status, attempt) => statuses.push({ status, attempt }),
    frame: frame => frames.push(frame),
    ended: end => ends.push(end),
  })
  return { client, sockets, statuses, frames, ends, grants: () => grants }
}

/** Lets the client's promises settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/** Opens a client's first socket and gets it to `ready` with some events. */
async function openToReady(rig: ReturnType<typeof setup>, after = 0, held = 6) {
  rig.client.open(INCIDENT_ID, after)
  await settle()
  const socket = rig.sockets.at(-1)!
  socket.open()
  socket.say(ready(held))
  return socket
}

describe('the incident feed client', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('opens the connection without the pass in the address, and sends it as the first frame with the incident and the last event held', async () => {
    const rig = setup()
    rig.client.open(INCIDENT_ID, 7)
    await settle()
    const socket = rig.sockets[0]!
    expect(socket.url).toBe('wss://api.example.com/ws/lb06/')
    expect(socket.url).not.toContain('token')
    expect(socket.sent).toEqual([])
    socket.open()
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: 'hello', token: 'token-1', incident: INCIDENT_ID, after: 7 })
    expect(rig.statuses.map(item => item.status)).toEqual(['connecting'])
  })

  it('is open after `ready`, passes the frames on, and keeps the number of the last event it heard', async () => {
    const rig = setup()
    const socket = await openToReady(rig, 0, 6)
    expect(rig.client.status).toBe('open')
    expect(rig.frames.map(frame => frame.type)).toEqual(['ready'])
    expect(rig.client.lastSeq).toBe(incident.events[5]!.seq)
    socket.say(eventFrame(6))
    socket.say(eventFrame(7))
    expect(rig.frames.map(frame => frame.type)).toEqual(['ready', 'event', 'event'])
    expect(rig.client.lastSeq).toBe(incident.events[7]!.seq)
  })

  it('refuses an event before `ready`, a second `ready`, a frame that does not fit and a binary frame, closing the connection each time', async () => {
    for (const make of [
      (socket: ScriptedSocket) => socket.say(eventFrame(0)),
      (socket: ScriptedSocket) => {
        socket.say(ready(2))
        socket.say(ready(2))
      },
      (socket: ScriptedSocket) => socket.say('{"type":"surprise"}'),
      (socket: ScriptedSocket) => socket.say(new ArrayBuffer(4)),
    ]) {
      const rig = setup()
      rig.client.open(INCIDENT_ID)
      await settle()
      const socket = rig.sockets[0]!
      socket.open()
      make(socket)
      expect(socket.closedWith).toBe(CLOSE_CODE_MALFORMED)
      expect(rig.ends).toEqual([{ reason: 'malformed' }])
      expect(rig.client.status).toBe('closed')
    }
  })

  it('stops hearing a socket it has ended', async () => {
    const rig = setup()
    const socket = await openToReady(rig)
    rig.client.end()
    socket.say(eventFrame(6))
    expect(rig.frames.map(frame => frame.type)).toEqual(['ready'])
    expect(rig.ends).toEqual([{ reason: 'visitor' }])
  })

  it('says nothing when it is disposed, and holds no timer', async () => {
    const rig = setup()
    await openToReady(rig)
    rig.client.dispose()
    expect(rig.ends).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('opens again with a fresh pass after a drop, continuing after the last event it heard', async () => {
    const rig = setup()
    const first = await openToReady(rig, 0, 6)
    first.say(eventFrame(6))
    first.drop(1006)
    expect(rig.client.status).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(reconnectDelay(1, 0.5))
    const second = rig.sockets[1]!
    second.open()
    expect(JSON.parse(second.sent[0]!)).toEqual({ type: 'hello', token: 'token-2', incident: INCIDENT_ID, after: incident.events[6]!.seq })
    second.say(ready(8))
    expect(rig.client.status).toBe('open')
    expect(rig.ends).toEqual([])
  })

  it('gives up after its attempts, with growing waits, and says the connection was lost', async () => {
    const rig = setup()
    const first = await openToReady(rig)
    first.drop(1006)
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt += 1) {
      expect(rig.client.status).toBe('reconnecting')
      await vi.advanceTimersByTimeAsync(reconnectDelay(attempt, 0.5))
      rig.sockets.at(-1)!.drop(1006)
    }
    expect(rig.ends).toEqual([{ reason: 'lost', cause: undefined }])
    expect(reconnectDelay(2, 0.5)).toBeGreaterThan(reconnectDelay(1, 0.5))
    expect(reconnectDelay(99, 0.5)).toBeLessThanOrEqual(16_000)
  })

  it('does not try again for a connection that never opened, and says why', async () => {
    const rig = setup()
    rig.client.open(INCIDENT_ID)
    await settle()
    rig.sockets[0]!.drop(1006)
    expect(rig.ends).toEqual([{ reason: 'lost', cause: undefined }])
    expect(rig.sockets).toHaveLength(1)
  })

  it('ends with the reason of a grant that failed', async () => {
    const rig = setup(() => new Error('no pass'))
    rig.client.open(INCIDENT_ID)
    await settle()
    expect(rig.ends).toHaveLength(1)
    expect(rig.ends[0]?.reason).toBe('grant_failed')
    expect(rig.sockets).toHaveLength(0)
  })

  it('treats a hello that is never answered as a dropped connection', async () => {
    const rig = setup()
    rig.client.open(INCIDENT_ID)
    await settle()
    rig.sockets[0]!.open()
    await vi.advanceTimersByTimeAsync(HELLO_ANSWER_TIMEOUT_MS + 1)
    expect(rig.ends).toEqual([{ reason: 'lost', cause: undefined }])
  })

  it('ends with the kind of close the server used, and does not try again for one that is final', async () => {
    const kinds: [number, string][] = [
      [CLOSE_CODES.notFound, 'not_found'],
      [CLOSE_CODES.timedOut, 'timed_out'],
      [CLOSE_CODES.tooBig, 'too_big'],
      [CLOSE_CODES.unavailable, 'unavailable'],
      [CLOSE_CODES.badFrame, 'bad_frame'],
    ]
    for (const [code, reason] of kinds) {
      const rig = setup()
      const socket = await openToReady(rig)
      socket.drop(code)
      expect(rig.ends).toEqual([{ reason }])
      expect(rig.sockets).toHaveLength(1)
    }
  })

  it('asks for a fresh pass once when a connection that had worked is refused, and ends if it is refused again', async () => {
    const rig = setup()
    const first = await openToReady(rig)
    first.drop(CLOSE_CODES.unauthorized)
    await vi.advanceTimersByTimeAsync(reconnectDelay(1, 0.5))
    expect(rig.grants()).toBe(2)
    const second = rig.sockets[1]!
    second.open()
    second.drop(CLOSE_CODES.unauthorized)
    expect(rig.ends).toEqual([{ reason: 'unauthorized' }])
  })

  it('says nothing on the console, whatever it hears', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')]
    const rig = setup()
    const socket = await openToReady(rig)
    socket.say('{"type":"surprise"}')
    expect(logs.every(spy => spy.mock.calls.length === 0)).toBe(true)
  })
})
