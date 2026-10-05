// LB-06's WebSocket: how a dashboard follows an incident live. The browser connects straight to the
// API (a Vercel function cannot hold a socket) at `/ws/lb06/`, and the first frame is a hello with
// the visitor's token and the incident's id; the token travels in the frame and never in the
// address, because addresses end up in logs. The server answers `ready` with the incident as it
// stands and the events after the one the page last saw, then forwards every event the worker
// appends, read from the incident's Redis Stream by a hub shared by every socket of that incident.
//
// Hardened as LB-02's is: only text frames under 4 KB, a hello within ten seconds, a ping every
// half minute and a close after fifteen minutes of silence, four connections a visitor and a few
// hundred a process, every failure the same close code, and nothing a visitor wrote in any log.
// Everything the socket sends is checked against the contracts' schemas first, and the hub drops
// an entry that does not fit.
import { LB06_LIMITS, lb06EventSchema, lb06IncidentViewSchema } from '@lb/contracts'
import type { Lb06Event, Lb06IncidentView } from '@lb/contracts'
import type { VisitorVerifier } from '@lb/common'
import { VisitorTokenError } from '@lb/common'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import type { WebSocket } from '@fastify/websocket'
import { z } from 'zod'

import type { Lb06Config } from '../config.ts'
import type { Lb06Deps } from './deps.ts'
import { feedKey, readFeed } from './feed.ts'
import { readEvents, readIncidentView } from './store.ts'

/** The path the socket listens on. */
export const SOCKET_PATH = '/ws/lb06/'
/** The largest frame a client may send, in bytes. */
export const MAX_FRAME_BYTES = 4_096
/** Connections one visitor may hold at once in one process: two tabs, and two still being torn down. */
export const MAX_CONNECTIONS_PER_VISITOR = 4
/** Connections one process holds at once, across every visitor. */
export const MAX_CONNECTIONS = 256

/** The close codes, LB-02's. */
export const CLOSE = {
  unsupported: 1003,
  tooBig: 1009,
  unavailable: 1011,
  tryAgainLater: 1013,
  badFrame: 4400,
  unauthorized: 4401,
  notFound: 4404,
  timedOut: 4408,
} as const

/** The hello, the one frame a client sends. */
const helloSchema = z.strictObject({
  type: z.literal('hello'),
  token: z.string().min(1).max(1_024),
  incident: z.uuid(),
  // The number of the last event the page holds; the server sends what follows.
  after: z.int().min(0).max(LB06_LIMITS.maxEvents).default(0),
})

/** What the server sends. */
export const serverFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), incident: lb06IncidentViewSchema, events: z.array(lb06EventSchema).max(LB06_LIMITS.maxEvents) }),
  z.strictObject({ type: z.literal('event'), event: lb06EventSchema }),
  z.strictObject({ type: z.literal('error'), code: z.enum(['invalid_frame', 'already_said_hello', 'too_many_connections']) }),
])
/** A frame the server sends. */
export type ServerFrame = z.infer<typeof serverFrameSchema>

/** One socket the hub forwards to. */
interface Subscriber {
  send: (event: Lb06Event) => void
  lastSeq: number
}

/** The reader of one incident's stream, shared by its sockets. It runs while someone listens and stops a little after the last one leaves. */
class IncidentHub {
  readonly #subscribers = new Set<Subscriber>()
  readonly #redis: Redis
  readonly #key: string
  readonly #onIdle: () => void
  #running = false
  #stopped = false

  /** A hub over a stream, on a Redis connection of its own (a blocking read holds the connection). */
  constructor(redis: Redis, key: string, onIdle: () => void) {
    this.#redis = redis
    this.#key = key
    this.#onIdle = onIdle
  }

  /** Adds a socket, which gets the entries after its last seq from now on. */
  subscribe(subscriber: Subscriber): void {
    this.#subscribers.add(subscriber)
    if (!this.#running) void this.#loop()
  }

  /** Removes a socket; the hub stops once nobody listens. */
  unsubscribe(subscriber: Subscriber): void {
    this.#subscribers.delete(subscriber)
    if (this.#subscribers.size === 0) this.#onIdle()
  }

  /** Whether anyone listens. */
  get empty(): boolean {
    return this.#subscribers.size === 0
  }

  /** Stops the loop and the connection. */
  stop(): void {
    this.#stopped = true
    this.#redis.disconnect()
  }

  /** Reads the stream from its start and forwards every entry to the subscribers whose last seq is below it, until stopped. */
  async #loop(): Promise<void> {
    this.#running = true
    let after = '0-0'
    while (!this.#stopped && this.#subscribers.size > 0) {
      let entries: Awaited<ReturnType<typeof readFeed>>
      try {
        entries = await readFeed(this.#redis, this.#key, after, 5_000)
      }
      catch {
        if (this.#stopped) break
        await new Promise(resolve => setTimeout(resolve, 1_000))
        continue
      }
      for (const entry of entries) {
        after = entry.streamId
        for (const subscriber of this.#subscribers) {
          if (entry.event.seq > subscriber.lastSeq) {
            subscriber.lastSeq = entry.event.seq
            subscriber.send(entry.event)
          }
        }
      }
    }
    this.#running = false
  }
}

/** What the socket route needs: the engine, the verifier, how to open a Redis connection for a hub, and the settings. */
export interface SocketServices {
  deps: Lb06Deps
  verify: VisitorVerifier
  openRedis: () => Redis
  redisPrefix: string
  config: Lb06Config
}

/** Counts the open connections of each visitor in this process. */
class ConnectionCounts {
  readonly #counts = new Map<string, number>()
  #total = 0

  /** Takes a place for the visitor, or refuses when they or the process hold enough. */
  enter(visitor: string): boolean {
    const held = this.#counts.get(visitor) ?? 0
    if (held >= MAX_CONNECTIONS_PER_VISITOR || this.#total >= MAX_CONNECTIONS) return false
    this.#counts.set(visitor, held + 1)
    this.#total += 1
    return true
  }

  /** Gives a visitor's place back. */
  leave(visitor: string): void {
    const held = this.#counts.get(visitor) ?? 0
    if (held <= 1) this.#counts.delete(visitor)
    else this.#counts.set(visitor, held - 1)
    this.#total = Math.max(0, this.#total - 1)
  }

  /** How many connections are open, for a test. */
  get total(): number {
    return this.#total
  }
}

/** Sends a frame checked against the schema; a frame that does not fit is a bug and closes the socket. */
function sendFrame(socket: WebSocket, frame: ServerFrame): void {
  const checked = serverFrameSchema.safeParse(frame)
  if (!checked.success) {
    socket.close(CLOSE.unavailable, 'bad frame')
    return
  }
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(checked.data))
}

/** Registers the socket route at the root of the app (outside the API prefix), and returns a way to stop every hub. */
export function registerSocket(app: FastifyInstance, services: SocketServices): { close: () => void, connections: ConnectionCounts } {
  const hubs = new Map<string, IncidentHub>()
  const connections = new ConnectionCounts()
  const { deps, config } = services

  const hubOf = (incidentId: string): IncidentHub => {
    const existing = hubs.get(incidentId)
    if (existing) return existing
    const key = feedKey(services.redisPrefix, incidentId)
    const hub: IncidentHub = new IncidentHub(services.openRedis(), key, () => {
      // Nobody listens: stop a little later, unless someone came back.
      setTimeout(() => {
        if (hub.empty && hubs.get(incidentId) === hub) {
          hubs.delete(incidentId)
          hub.stop()
        }
      }, 10_000).unref()
    })
    hubs.set(incidentId, hub)
    return hub
  }

  app.get(SOCKET_PATH, { websocket: true, schema: { hide: true } }, (socket) => {
    let said = false
    let visitor: string | undefined
    let hub: IncidentHub | undefined
    let subscriber: Subscriber | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const helloTimer = setTimeout(() => socket.close(CLOSE.timedOut, 'no hello'), config.socketHelloMs)
    const pingTimer = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping()
    }, config.socketPingMs)

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => socket.close(CLOSE.timedOut, 'idle'), config.socketIdleMs)
    }
    const cleanUp = () => {
      clearTimeout(helloTimer)
      clearInterval(pingTimer)
      if (idleTimer) clearTimeout(idleTimer)
      if (hub && subscriber) hub.unsubscribe(subscriber)
      if (visitor !== undefined) connections.leave(visitor)
      visitor = undefined
      hub = undefined
      subscriber = undefined
    }

    const hello = async (text: string): Promise<void> => {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      }
      catch {
        socket.close(CLOSE.badFrame, 'not json')
        return
      }
      const frame = helloSchema.safeParse(parsed)
      if (!frame.success) {
        socket.close(CLOSE.badFrame, 'not a hello')
        return
      }
      let session: string
      try {
        session = services.verify(`Bearer ${frame.data.token}`).sessionKey
      }
      catch (error) {
        socket.close(error instanceof VisitorTokenError ? CLOSE.unauthorized : CLOSE.unavailable, 'refused')
        return
      }
      if (!connections.enter(session)) {
        sendFrame(socket, { type: 'error', code: 'too_many_connections' })
        socket.close(CLOSE.tryAgainLater, 'too many')
        return
      }
      visitor = session
      const moment = deps.now()
      let view: Lb06IncidentView | undefined
      let events: Lb06Event[]
      try {
        view = await readIncidentView(deps.db, session, frame.data.incident, moment)
        events = view ? await readEvents(deps.db, frame.data.incident, frame.data.after, LB06_LIMITS.maxEvents) : []
      }
      catch {
        socket.close(CLOSE.unavailable, 'unavailable')
        return
      }
      if (!view) {
        socket.close(CLOSE.notFound, 'no such incident')
        return
      }
      said = true
      clearTimeout(helloTimer)
      armIdle()
      sendFrame(socket, { type: 'ready', incident: view, events })
      const last = events.at(-1)?.seq ?? frame.data.after
      subscriber = { lastSeq: Math.max(last, view.lastSeq), send: event => sendFrame(socket, { type: 'event', event }) }
      hub = hubOf(frame.data.incident)
      hub.subscribe(subscriber)
    }

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(CLOSE.unsupported, 'binary')
        return
      }
      const text = data.toString('utf8')
      if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
        socket.close(CLOSE.tooBig, 'too big')
        return
      }
      armIdle()
      if (said) {
        sendFrame(socket, { type: 'error', code: 'already_said_hello' })
        return
      }
      void hello(text)
    })
    socket.on('pong', armIdle)
    socket.on('close', cleanUp)
    socket.on('error', cleanUp)
  })

  return {
    connections,
    close: () => {
      for (const hub of hubs.values()) hub.stop()
      hubs.clear()
    },
  }
}
