// The progress client: one WebSocket to LB-09's meeting progress, spoken exactly as the protocol says
// (wire.ts; services/django-systems/README.md, "LB-09 WebSocket"). It asks the site for a pass, opens
// the connection, sends the pass as the first frame and never in the address, and passes on only
// events that fit the protocol: a frame that does not, a binary frame, or anything else closes the
// connection (fail closed) and is never looked at again. The connection only listens, so there is
// nothing to resend: when it drops before the meeting is over, the client says so once and the store
// polls the meeting instead. It holds no timers or sockets once it has ended.
//
// The class is plain TypeScript over a socket it is handed, so the tests drive it with a stand-in.
import { CLOSE_CODE_MALFORMED, CLOSE_CODES, helloText, parseServerFrame } from './wire.ts'
import type { StateEvent } from './wire.ts'

/** The value of `WebSocket.OPEN`, so the client does not depend on the global. */
const SOCKET_OPEN = 1

/** How long the server has to answer a hello before the connection is given up on. It closes a silent one itself at 10 seconds. */
export const HELLO_ANSWER_TIMEOUT_MS = 20_000

/** The part of the browser's WebSocket the client uses. */
export interface SocketLike {
  readonly readyState: number
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
  addEventListener: ((type: 'open', listener: () => void) => void)
    & ((type: 'message', listener: (event: { data: unknown }) => void) => void)
    & ((type: 'close', listener: (event: { code: number }) => void) => void)
}

/** Opens a socket to an address. */
export type SocketFactory = (url: string) => SocketLike

/** What the site's token endpoint gave: where to connect, and the visitor's pass for the first frame. */
export interface Grant {
  url: string
  token: string
}

/** Why the client stopped: the meeting ended and the server closed; the connection dropped or was refused; the page closed it. */
export type EndReason = 'over' | 'dropped' | 'refused' | 'gone' | 'malformed' | 'grant_failed' | 'visitor'

/** What the client needs from the page. */
export interface ProgressSocketOptions {
  // Asks the site for a new pass: five minutes of validity, for this system only.
  grant: () => Promise<Grant>
  // Opens a socket; the browser's WebSocket in the page.
  connect: SocketFactory
}

/** What the client tells the page. */
export interface ProgressHandlers {
  // A state of the meeting arrived.
  state: (event: StateEvent) => void
  // The client has stopped and will not try again.
  ended: (reason: EndReason) => void
}

/** A visitor's view of one meeting's progress, over one WebSocket. */
export class ProgressSocket {
  readonly #options: ProgressSocketOptions
  readonly #handlers: ProgressHandlers
  #socket: SocketLike | undefined
  // Which connection attempt is current: every callback of an older one is ignored.
  #generation = 0
  #over = false
  #ended = false
  #helloTimer: ReturnType<typeof setTimeout> | undefined

  /** Makes a client that has not connected yet. */
  constructor(options: ProgressSocketOptions, handlers: ProgressHandlers) {
    this.#options = options
    this.#handlers = handlers
  }

  /** Starts following a meeting. */
  open(meeting: string): void {
    this.#reset()
    void this.#connect(meeting)
  }

  /** Stops following, from the page's side, without a word to the page. */
  close(): void {
    this.#reset()
  }

  /** Whether the connection is open. */
  get open_(): boolean {
    return this.#socket !== undefined && this.#socket.readyState === SOCKET_OPEN
  }

  /** Forgets the current connection and its timer. */
  #reset(): void {
    this.#generation += 1
    this.#clearHelloTimer()
    const socket = this.#socket
    this.#socket = undefined
    this.#over = false
    this.#ended = false
    if (socket && socket.readyState === SOCKET_OPEN) socket.close(CLOSE_CODES.normal)
  }

  /** Asks for a pass, opens the socket and sends the hello. */
  async #connect(meeting: string): Promise<void> {
    const generation = this.#generation
    let grant: Grant
    try {
      grant = await this.#options.grant()
    }
    catch {
      if (generation === this.#generation) this.#end('grant_failed')
      return
    }
    if (generation !== this.#generation) return
    let socket: SocketLike
    try {
      socket = this.#options.connect(grant.url)
    }
    catch {
      this.#end('dropped')
      return
    }
    this.#socket = socket
    socket.addEventListener('open', () => {
      if (generation !== this.#generation) return
      try {
        socket.send(helloText(grant.token, meeting))
      }
      catch {
        this.#end('dropped')
        return
      }
      this.#helloTimer = setTimeout(() => {
        if (generation === this.#generation) {
          socket.close(CLOSE_CODES.normal)
          this.#end('dropped')
        }
      }, HELLO_ANSWER_TIMEOUT_MS)
    })
    socket.addEventListener('message', (event) => {
      if (generation !== this.#generation) return
      this.#hear(socket, event.data)
    })
    socket.addEventListener('close', (event) => {
      if (generation !== this.#generation) return
      this.#closed(event.code)
    })
  }

  /** Reads one frame: a state is passed on; an error event or anything unreadable ends the client. */
  #hear(socket: SocketLike, data: unknown): void {
    if (this.#ended) return
    this.#clearHelloTimer()
    const event = parseServerFrame(data)
    if (!event) {
      socket.close(CLOSE_CODE_MALFORMED)
      this.#end('malformed')
      return
    }
    if (event.type === 'error') {
      // The server closes right after `meeting_gone` and `too_many_connections`; the close says the rest.
      if (event.code === 'meeting_gone') this.#end('gone')
      else if (event.code === 'too_many_connections' || event.code === 'unavailable') this.#end('refused')
      return
    }
    if (event.status === 'done' || event.status === 'failed') this.#over = true
    this.#handlers.state(event)
  }

  /** The socket closed: after the end of the meeting that is the normal end; before it, the connection dropped. */
  #closed(code: number): void {
    this.#clearHelloTimer()
    this.#socket = undefined
    if (this.#over) {
      this.#end('over')
      return
    }
    if (code === CLOSE_CODES.unauthorized || code === CLOSE_CODES.tryAgainLater || code === CLOSE_CODES.unavailable) this.#end('refused')
    else if (code === CLOSE_CODES.notFound) this.#end('gone')
    else this.#end('dropped')
  }

  /** Tells the page the client has stopped, once. */
  #end(reason: EndReason): void {
    if (this.#ended) return
    this.#ended = true
    this.#clearHelloTimer()
    this.#handlers.ended(reason)
  }

  /** Stops waiting for the hello's answer. */
  #clearHelloTimer(): void {
    if (this.#helloTimer !== undefined) clearTimeout(this.#helloTimer)
    this.#helloTimer = undefined
  }
}
