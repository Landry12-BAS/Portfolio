// The conversation client: one WebSocket to LB-02's concierge, spoken exactly as the protocol says
// (wire.ts; services/django-systems/README.md, "LB-02 WebSocket"). It opens the connection, sends the
// visitor's token as the first frame and never in the address, and passes on only frames that fit the
// protocol: a frame that does not, a binary frame, or anything before the server's `ready` closes the
// connection (fail closed) and is never looked at again. When a connection that had been open drops,
// it asks for a fresh token and resumes the same conversation, a few times with growing waits, and
// tells its owner each time so the page can load the calendar again. It never writes what was said
// anywhere (no logging at all), and it holds no timers or sockets once it is ended or disposed.
//
// The class is plain TypeScript over a socket it is handed, so the tests drive it with a stand-in.
import { classifyClose } from './closing.ts'
import type { CloseKind } from './closing.ts'
import { CLOSE_CODE_MALFORMED, helloText, messageText, parseServerFrame } from './wire.ts'
import type { ServerEvent } from './wire.ts'

/** The value of `WebSocket.OPEN`, so the client does not depend on the global. */
const SOCKET_OPEN = 1

/** How long the server has to answer a hello before the connection is given up on. It closes a silent one itself at 10 seconds. */
export const HELLO_ANSWER_TIMEOUT_MS = 20_000
/** How many times a connection that had been open is opened again before the page says it was lost. */
export const RECONNECT_ATTEMPTS = 5
/** The wait before the first new attempt, and the longest wait between two. */
export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 16_000

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

/** What the client is doing: nothing yet, opening a first connection, open, opening again after a drop, or finished. */
export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

/** Why the client stopped for good: a kind of close the page words, or one of its own reasons. */
export type EndReason = Exclude<CloseKind, 'transient'> | 'lost' | 'malformed' | 'grant_failed' | 'visitor'

/** How the client ended, and what went wrong when it was a call for a token that failed. */
export interface End {
  reason: EndReason
  cause?: unknown
}

/** What the client needs from the page. */
export interface ConversationSocketOptions {
  // Asks the site for a new pass: five minutes of validity, for this system only.
  grant: () => Promise<Grant>
  // Opens a socket; the browser's WebSocket in the page.
  connect: SocketFactory
  // A number from 0 up to but not including 1, to spread the waits out; `Math.random` in the page.
  random: () => number
}

/** What the client tells the page. */
export interface ConversationHandlers {
  // The connection's status changed; `attempt` is how many new attempts have been made since it dropped.
  status: (status: ConnectionStatus, attempt: number) => void
  // An event that fits the protocol arrived. The first one of each connection is `ready` (or an error that explains the close).
  event: (event: ServerEvent) => void
  // The client has stopped and will not try again until `resume` or `open` is called.
  ended: (end: End) => void
}

/** What `send` did with a message. */
export type SendResult = 'sent' | 'not_open' | 'invalid'

/** How long to wait before attempt number `attempt` (1 for the first new attempt): doubling from a second, capped, and spread by up to a quarter either way. */
export function reconnectDelay(attempt: number, random: number): number {
  const base = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(attempt - 1, 0), RECONNECT_MAX_MS)
  return Math.round(base * (0.75 + random * 0.5))
}

/** A visitor's conversation with the concierge, over one WebSocket at a time. */
export class ConversationSocket {
  readonly #options: ConversationSocketOptions
  readonly #handlers: ConversationHandlers
  #socket: SocketLike | undefined
  #status: ConnectionStatus = 'idle'
  // Which connection attempt is current: every callback of an older one is ignored.
  #generation = 0
  #conversation: string | null = null
  // Whether the current socket has been told `ready`, and whether any has in this conversation.
  #ready = false
  #everOpen = false
  #attempt = 0
  #refusedTokens = 0
  #helloTimer: ReturnType<typeof setTimeout> | undefined
  #retryTimer: ReturnType<typeof setTimeout> | undefined

  /** Makes a client that has not connected yet. */
  constructor(options: ConversationSocketOptions, handlers: ConversationHandlers) {
    this.#options = options
    this.#handlers = handlers
  }

  /** The client's status. */
  get status(): ConnectionStatus {
    return this.#status
  }

  /** The ID of the conversation the connection is for, once the server has said it. */
  get conversation(): string | null {
    return this.#conversation
  }

  /** Starts a conversation, or resumes one of the visitor's own when its ID is given. */
  open(conversation: string | null): void {
    this.#reset()
    this.#conversation = conversation
    void this.#connect()
  }

  /** Picks the conversation up again after the client ended with a reason the conversation survives. */
  resume(): void {
    this.#reset()
    void this.#connect()
  }

  /** Sends a message of the visitor's, as the protocol says: trimmed, one to 500 characters. */
  send(text: string): SendResult {
    let frame: string
    try {
      frame = messageText(text)
    }
    catch {
      return 'invalid'
    }
    const socket = this.#socket
    if (!this.#ready || socket === undefined || socket.readyState !== SOCKET_OPEN) return 'not_open'
    try {
      socket.send(frame)
    }
    catch {
      return 'not_open'
    }
    return 'sent'
  }

  /** The visitor ends the conversation here: the connection closes, and the conversation stays on the server until it expires. */
  end(): void {
    this.#finish({ reason: 'visitor' }, true)
  }

  /** Stops everything without telling the page anything, for a page that is being left. */
  dispose(): void {
    this.#finish({ reason: 'visitor' }, false)
  }

  /** Forgets what an earlier run of the client counted. */
  #reset(): void {
    this.#cancelTimers()
    this.#generation += 1
    this.#closeSocket()
    this.#ready = false
    this.#everOpen = false
    this.#attempt = 0
    this.#refusedTokens = 0
  }

  /** Stops the timers that wait for a hello's answer and for the next attempt. */
  #cancelTimers(): void {
    if (this.#helloTimer !== undefined) clearTimeout(this.#helloTimer)
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer)
    this.#helloTimer = undefined
    this.#retryTimer = undefined
  }

  /** Closes the current socket, if there is one, and forgets it. */
  #closeSocket(): void {
    const socket = this.#socket
    this.#socket = undefined
    if (socket === undefined) return
    try {
      socket.close(1000, 'done')
    }
    catch {
      // A socket that cannot be closed is already gone.
    }
  }

  /** Tells the page the status changed. */
  #setStatus(status: ConnectionStatus): void {
    this.#status = status
    this.#handlers.status(status, this.#attempt)
  }

  /** Stops for good with a reason, tells the page when asked to, and ignores everything the old socket still says. */
  #finish(end: End, tell: boolean): void {
    this.#cancelTimers()
    this.#generation += 1
    this.#closeSocket()
    this.#ready = false
    if (!tell) {
      this.#status = 'closed'
      return
    }
    this.#setStatus('closed')
    this.#handlers.ended(end)
  }

  /** Gets a new pass and opens a socket with it. */
  async #connect(): Promise<void> {
    this.#generation += 1
    const generation = this.#generation
    this.#setStatus(this.#everOpen ? 'reconnecting' : 'connecting')
    let grant: Grant
    try {
      grant = await this.#options.grant()
    }
    catch (cause) {
      if (generation === this.#generation) this.#failed('grant_failed', cause)
      return
    }
    if (generation !== this.#generation) return
    let socket: SocketLike
    try {
      socket = this.#options.connect(grant.url)
    }
    catch (cause) {
      this.#failed('lost', cause)
      return
    }
    this.#attach(socket, grant.token, generation)
  }

  /** Wires a new socket: the token goes in the first frame, once the connection is open. */
  #attach(socket: SocketLike, token: string, generation: number): void {
    this.#socket = socket
    socket.addEventListener('open', () => {
      if (generation !== this.#generation) return
      socket.send(helloText(token, this.#conversation))
      this.#helloTimer = setTimeout(() => this.#helloNotAnswered(generation), HELLO_ANSWER_TIMEOUT_MS)
    })
    socket.addEventListener('message', (event) => {
      if (generation === this.#generation) this.#heard(event.data)
    })
    socket.addEventListener('close', (event) => {
      if (generation === this.#generation) this.#closed(event.code)
    })
  }

  /** The server did not answer the hello in time: the connection is treated as dropped. */
  #helloNotAnswered(generation: number): void {
    if (generation !== this.#generation) return
    this.#generation += 1
    this.#closeSocket()
    this.#failed('lost', undefined)
  }

  /** Takes one frame from the server: it must fit the protocol, and the first must be `ready` or an error that explains the close. */
  #heard(data: unknown): void {
    const event = parseServerFrame(data)
    if (event === undefined || (event.type === 'ready' && this.#ready) || (!this.#ready && event.type !== 'ready' && event.type !== 'error')) {
      this.#finishMalformed()
      return
    }
    if (event.type === 'ready') this.#becameReady(event.conversation)
    this.#handlers.event(event)
  }

  /** The server said `ready`: the connection is open and the attempts start afresh. */
  #becameReady(conversation: string): void {
    if (this.#helloTimer !== undefined) clearTimeout(this.#helloTimer)
    this.#helloTimer = undefined
    this.#ready = true
    this.#everOpen = true
    this.#attempt = 0
    this.#refusedTokens = 0
    this.#conversation = conversation
    this.#setStatus('open')
  }

  /** Closes a connection whose server broke the protocol, and stops. */
  #finishMalformed(): void {
    this.#cancelTimers()
    this.#generation += 1
    const socket = this.#socket
    this.#socket = undefined
    this.#ready = false
    try {
      socket?.close(CLOSE_CODE_MALFORMED, 'protocol error')
    }
    catch {
      // Already closed.
    }
    this.#setStatus('closed')
    this.#handlers.ended({ reason: 'malformed' })
  }

  /** The server or the network closed the connection with a code. */
  #closed(code: number): void {
    this.#cancelTimers()
    this.#socket = undefined
    this.#ready = false
    const kind = classifyClose(code)
    if (kind === 'transient') {
      this.#failed('lost', undefined)
      return
    }
    // A pass the server refused is asked for once more when a connection that had worked drops, in case it expired on the way.
    if (kind === 'unauthorized' && this.#everOpen && this.#refusedTokens < 1) {
      this.#refusedTokens += 1
      this.#failed('unauthorized', undefined)
      return
    }
    this.#setStatus('closed')
    this.#handlers.ended({ reason: kind })
  }

  /** A connection attempt failed: try again after a wait if the conversation had been open and attempts are left, else stop. */
  #failed(reason: EndReason, cause: unknown): void {
    if (!this.#everOpen || this.#attempt >= RECONNECT_ATTEMPTS) {
      this.#setStatus('closed')
      this.#handlers.ended({ reason, cause })
      return
    }
    this.#attempt += 1
    this.#setStatus('reconnecting')
    this.#retryTimer = setTimeout(() => void this.#connect(), reconnectDelay(this.#attempt, this.#options.random()))
  }
}
