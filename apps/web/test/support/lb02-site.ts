// A stand-in for the site as LB-02's board sees it, for the tests of its store and components: the
// site's own API (session, check, recordings, the Scope) played by the fake site the other boards
// use, LB-02's visitor API and the grant for its WebSocket played by the mock back end's LB-02, and a
// WebSocket that talks to the mock's conversation hub in memory. Nothing here opens a port. The mock
// is the same code the end-to-end tests run against, so a store that works here speaks the protocol.
import { Lb02Mock } from '@lb/api-clients/testing'
import type { Answer, Lb02MockOptions, MockSpan } from '@lb/api-clients/testing'

import { FakeSite } from './fake-site'
import type { FakeSiteOptions } from './fake-site'

// The visitor's one session, the clock the mock's day runs on, and the pass the fake site hands out.
export const SESSION = 'fake-session'
export const NOW = Date.parse('2026-10-02T09:30:00.000Z')
export const PASS = `fake-pass:${SESSION}`
/** The address the fake site names for the socket. */
export const SOCKET_URL = 'ws://api.test/ws/lb02/'

/** A function that wants to hear about a socket event. */
type Listener = (event: never) => void

/** A WebSocket the board can use, wired in memory to the mock's hub. */
export class FakeWebSocket {
  readonly url: string
  readonly sent: string[] = []
  readyState = 0
  readonly #site: FakeLb02Site
  readonly #listeners: Record<'open' | 'message' | 'close', Listener[]> = { open: [], message: [], close: [] }
  #connection: { receive: (text: string) => void, dispose: () => void } | undefined

  /** Starts connecting; the connection opens a moment later, as a real one does. */
  constructor(url: string, site: FakeLb02Site) {
    this.url = url
    this.#site = site
    site.sockets.push(this)
    void Promise.resolve().then(() => this.#open())
  }

  /** Opens the connection, or refuses it as a network that is down would. */
  #open(): void {
    if (this.readyState !== 0) return
    if (this.#site.refuseConnections) {
      this.#finish(1006)
      return
    }
    this.readyState = 1
    this.#connection = this.#site.lb02.hub.open({
      send: text => this.#later('message', { data: text }),
      close: code => this.#finish(code),
    })
    this.#dispatch('open', {})
  }

  /** Calls the listeners of an event type. */
  #dispatch(type: 'open' | 'message' | 'close', event: object): void {
    for (const listener of this.#listeners[type]) (listener as (event: object) => void)(event)
  }

  /** Calls the listeners a moment later, as a network delivers. */
  #later(type: 'open' | 'message' | 'close', event: object): void {
    void Promise.resolve().then(() => {
      if (this.readyState === 1 || type === 'close') this.#dispatch(type, event)
    })
  }

  /** The socket is closed: the hub forgets the connection and the listeners hear it. */
  #finish(code: number): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.#connection?.dispose()
    this.#later('close', { code })
  }

  /** Subscribes to an event, as the browser's socket allows. */
  addEventListener(type: 'open' | 'message' | 'close', listener: (event: never) => void): void {
    this.#listeners[type].push(listener)
  }

  /** Sends a frame to the hub. */
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('The socket is not open.')
    this.sent.push(data)
    if (!this.#site.loseFrames) this.#connection?.receive(data)
  }

  /** The page closes the socket. */
  close(code = 1000): void {
    this.#finish(code)
  }

  /** Makes the server say something the protocol does not allow, or anything else a test wants the page to hear. */
  serverSays(data: unknown): void {
    this.#later('message', { data })
  }

  /** Makes the server close the connection with a code. */
  serverCloses(code: number): void {
    this.#finish(code)
  }
}

/** Makes the class the page constructs when it opens a socket, tied to a site's hub. */
function socketClassFor(site: FakeLb02Site): typeof WebSocket {
  return class extends FakeWebSocket {
    /** Connects to the site's hub. */
    constructor(url: string) {
      super(url, site)
    }
  } as unknown as typeof WebSocket
}

/** What a test may choose about the fake LB-02 site. */
export interface FakeLb02Options extends FakeSiteOptions {
  lb02?: Partial<Lb02MockOptions>
}

/** A call to make fail once: which one, and with what answer. */
interface Scripted {
  match: string
  answer: Answer
}

/** Turns an answer into a `Response`. */
function respond(answer: Answer): Response {
  if (answer.body === undefined) return new Response(null, { status: answer.status })
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
}

/** Makes a platform error answer. */
function failure(status: number, code: string, message: string): Answer {
  return { status, body: { error: { code, message } } }
}

/** The fake site with LB-02 on it. */
export class FakeLb02Site {
  readonly site: FakeSite
  readonly lb02: Lb02Mock
  readonly sockets: FakeWebSocket[] = []
  // When set, every new socket fails to open, as it does with the network down.
  refuseConnections = false
  // When set, the frames the page sends are lost on the way: the page's socket takes them, the hub never hears them.
  loseFrames = false
  readonly #scripted: Scripted[] = []
  readonly #stalled: { match: string, gate: Promise<void> }[] = []

  /** Starts a fake site and a mock LB-02 with no conversations. */
  constructor(options: FakeLb02Options = {}) {
    const { lb02, ...siteOptions } = options
    this.site = new FakeSite(siteOptions)
    this.lb02 = new Lb02Mock({ now: () => NOW, verify: token => (token === PASS ? SESSION : undefined), ...lb02 })
  }

  /** The calls the browser made, in order. */
  get calls() {
    return this.site.calls
  }

  /** The calls made to paths that start with a prefix, in order. */
  callsTo(prefix: string, method?: string) {
    return this.site.callsTo(prefix, method)
  }

  /** The most recent socket the page opened. */
  get socket(): FakeWebSocket {
    const last = this.sockets.at(-1)
    if (!last) throw new Error('The page has not opened a socket.')
    return last
  }

  /**
   * Makes calls whose "METHOD /path" starts with `match` work out their answer now but deliver it only when the
   * returned function is called: a slow network, which lets a test make changes happen while an answer is on its way.
   */
  stall(match: string): () => void {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#stalled.push({ match, gate })
    return release
  }

  /** Makes the next call whose "METHOD /path" starts with `match` answer as given, once. */
  failNext(match: string, answer: Answer): void {
    this.#scripted.push({ match, answer })
  }

  /** Builds the socket class the page constructs, for `vi.stubGlobal('WebSocket', site.socketClass())`. */
  socketClass(): typeof WebSocket {
    return socketClassFor(this)
  }

  /** The browser's `fetch`, as this site answers it. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://site.test'), init)
    const url = new URL(request.url)
    const path = `${url.pathname}${url.search}`
    const mine = url.pathname === '/api/tokens/lb-02' || url.pathname.startsWith('/api/lb02/') || this.#isLb02Trace(url)
    if (!mine) return this.site.fetch(request)
    this.site.calls.push({ method: request.method, path, body: undefined })
    const key = `${request.method} ${path}`
    const index = this.#scripted.findIndex(item => key.startsWith(item.match))
    if (index >= 0) return respond(this.#scripted.splice(index, 1)[0]?.answer ?? failure(500, 'internal_error', 'x'))
    const answer = this.#answer(request.method, url)
    const stalled = this.#stalled.findIndex(item => key.startsWith(item.match))
    if (stalled >= 0) await this.#stalled.splice(stalled, 1)[0]?.gate
    return respond(answer)
  }

  /** Tells whether a read of a trace is for a conversation of LB-02's. */
  #isLb02Trace(url: URL): boolean {
    const match = /^\/api\/runs\/([^/]+)\/spans$/.exec(url.pathname)
    return match !== null && this.lb02.spansOf(decodeURIComponent(match[1] ?? '')) !== undefined
  }

  /** Routes a call to what answers it. */
  #answer(method: string, url: URL): Answer {
    const path = url.pathname
    if (path === '/api/tokens/lb-02') return this.#grant(method)
    if (path.startsWith('/api/runs/')) return this.#spans(decodeURIComponent(path.split('/')[3] ?? ''), url.searchParams)
    if (!this.site.available) return failure(503, 'unavailable', 'This part of the site is not available right now.')
    if (method !== 'GET') return failure(404, 'not_found', 'There is nothing at this address.')
    if (path === '/api/lb02/offerings') return this.lb02.offerings()
    if (path === '/api/lb02/calendar') return this.lb02.calendar(SESSION, url.searchParams)
    if (path === '/api/lb02/conversations') return this.lb02.conversations(SESSION)
    const one = /^\/api\/lb02\/conversations\/([^/]+)$/.exec(path)
    if (one) return this.lb02.conversation(SESSION, one[1] ?? '')
    return failure(404, 'not_found', 'There is nothing at this address.')
  }

  /** The grant for the socket: only a visitor who has passed the check gets one. */
  #grant(method: string): Answer {
    if (method !== 'POST') return failure(404, 'not_found', 'There is nothing at this address.')
    if (!this.site.available) return failure(503, 'unavailable', 'This part of the site is not available right now.')
    if (!this.site.verified) return failure(403, 'verification_required', 'Run the check that proves you are a person before using a demo with your own text.')
    return { status: 200, body: { system: 'lb-02', token: PASS, expiresAt: new Date(NOW + 300_000).toISOString(), socketUrl: SOCKET_URL } }
  }

  /** Answers a read of a conversation's trace with all the spans so far. A conversation's trace is never finished. */
  #spans(runId: string, search: URLSearchParams): Answer {
    const spans: MockSpan[] | undefined = this.lb02.spansOf(runId)
    if (!spans) return failure(404, 'run_not_found', 'There is no trace for that run: its ID is unknown, or its trace has expired.')
    const seen = Number(search.get('after')?.split('-')[0] ?? 0)
    return { status: 200, body: { runId, spans: spans.slice(seen), cursor: `${spans.length}-${spans.length}`, more: false, finished: false } }
  }
}
