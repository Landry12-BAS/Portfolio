// A stand-in for the site as LB-06's board sees it, for the tests of its store and components: the
// site's own API (session, check, recordings, the Scope) played by the fake site the other boards
// use, LB-06's visitor API and the grant for its WebSocket played by the mock back end's LB-06 (the
// real simulator, the real SLO and the real orchestrator with the reference agents), and a WebSocket
// that talks to the mock's incident hub in memory. Nothing here opens a port. The mock's clock is the
// page's, so a test that moves time with fake timers moves the shop's minutes with it, and the mock is
// the same code the end-to-end tests run against, so a store that works here speaks the protocol.
import { Lb06Hub, Lb06Mock } from '@lb/api-clients/testing'
import type { Answer, Lb06MockOptions, MockSpan } from '@lb/api-clients/testing'
import { FakeSite } from './fake-site'
import type { FakeSiteOptions } from './fake-site'

/** The visitor's one session, and the pass the fake site hands out. A session key is at least 16 characters long, as the service's runs require. */
export const SESSION = 'fake-session-for-lb06'
export const PASS = `fake-pass:${SESSION}`

/** The address the fake site names for the socket. */
export const SOCKET_URL = 'ws://api.test/ws/lb06/'

/** A function that wants to hear about a socket event. */
type Listener = (event: never) => void

/** What the hub is given to talk to a socket. */
interface Transport {
  send: (text: string) => void
  close: (code: number, reason?: string) => void
}

/** A WebSocket the board can use, wired in memory to the mock's hub. */
export class FakeWebSocket {
  readonly url: string
  readonly sent: string[] = []
  readyState = 0
  readonly #site: FakeLb06Site
  readonly #listeners: Record<'open' | 'message' | 'close', Listener[]> = { open: [], message: [], close: [] }
  #connection: { receive: (text: string) => void, dispose: () => void } | undefined

  /** Starts connecting; the connection opens a moment later, as a real one does. */
  constructor(url: string, site: FakeLb06Site) {
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
    const transport: Transport = {
      send: text => this.#later('message', { data: text }),
      close: code => this.#finish(code),
    }
    this.#connection = this.#site.hub.open(transport)
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
    this.#connection?.receive(data)
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
function socketClassFor(site: FakeLb06Site): typeof WebSocket {
  return class extends FakeWebSocket {
    /** Connects to the site's hub. */
    constructor(url: string) {
      super(url, site)
    }
  } as unknown as typeof WebSocket
}

/** What a test may choose about the fake LB-06 site. */
export interface FakeLb06Options extends FakeSiteOptions {
  lb06?: Partial<Lb06MockOptions>
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

/** The fake site with LB-06 on it. */
export class FakeLb06Site {
  readonly site: FakeSite
  readonly lb06: Lb06Mock
  readonly hub: Lb06Hub
  readonly sockets: FakeWebSocket[] = []
  // When set, every new socket fails to open, as it does with the network down.
  refuseConnections = false
  readonly #scripted: Scripted[] = []

  /** Starts a fake site and a mock LB-06 with no incidents. */
  constructor(options: FakeLb06Options = {}) {
    const { lb06, ...siteOptions } = options
    this.site = new FakeSite(siteOptions)
    this.lb06 = new Lb06Mock(() => Date.now(), { tickMs: 60, ...lb06 })
    this.hub = new Lb06Hub(this.lb06, token => (token === PASS ? SESSION : undefined))
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
    const mine = url.pathname === '/api/tokens/lb-06' || url.pathname.startsWith('/api/lb06/') || this.#isLb06Trace(url)
    if (!mine) return this.site.fetch(request)
    const text = request.method === 'GET' ? '' : await request.text()
    const body: unknown = text === '' ? undefined : JSON.parse(text)
    this.site.calls.push({ method: request.method, path, body })
    const key = `${request.method} ${path}`
    const index = this.#scripted.findIndex(item => key.startsWith(item.match))
    if (index >= 0) return respond(this.#scripted.splice(index, 1)[0]?.answer ?? failure(500, 'internal_error', 'x'))
    return respond(this.#answer(request.method, url, body))
  }

  /** Tells whether a read of a trace is for an incident of LB-06's. */
  #isLb06Trace(url: URL): boolean {
    const match = /^\/api\/runs\/([^/]+)\/spans$/.exec(url.pathname)
    return match !== null && this.lb06.spansOf(decodeURIComponent(match[1] ?? '')) !== undefined
  }

  /** Routes a call to what answers it. */
  #answer(method: string, url: URL, body: unknown): Answer {
    const path = url.pathname
    if (path === '/api/tokens/lb-06') return this.#grant(method)
    if (path.startsWith('/api/runs/')) return this.#spans(decodeURIComponent(path.split('/')[3] ?? ''), url.searchParams)
    if (!this.site.available) return failure(503, 'unavailable', 'This part of the site is not available right now.')
    if (method !== 'GET' && !this.site.verified) return failure(403, 'verification_required', 'Run the check that proves you are a person before using a demo with your own text.')
    if (path === '/api/lb06/limits') return this.lb06.limits(SESSION)
    if (path === '/api/lb06/catalogue') return this.lb06.catalogue()
    if (path === '/api/lb06/incidents') return method === 'POST' ? this.lb06.start(SESSION, body) : this.lb06.list(SESSION)
    const one = /^\/api\/lb06\/incidents\/([^/]+)$/.exec(path)
    if (one) return this.lb06.get(SESSION, one[1] ?? '')
    const events = /^\/api\/lb06\/incidents\/([^/]+)\/events$/.exec(path)
    if (events) return this.lb06.events(SESSION, events[1] ?? '', url.searchParams)
    const decision = /^\/api\/lb06\/incidents\/([^/]+)\/proposals\/([^/]+)\/decision$/.exec(path)
    if (decision && method === 'POST') return this.lb06.decide(SESSION, decision[1] ?? '', decision[2] ?? '', body)
    const abort = /^\/api\/lb06\/incidents\/([^/]+)\/abort$/.exec(path)
    if (abort && method === 'POST') return this.lb06.abort(SESSION, abort[1] ?? '')
    const postmortem = /^\/api\/lb06\/incidents\/([^/]+)\/postmortem$/.exec(path)
    if (postmortem) return this.lb06.postmortem(SESSION, postmortem[1] ?? '')
    return failure(404, 'not_found', 'There is nothing at this address.')
  }

  /** The grant for the socket: only a visitor who has passed the check gets one. */
  #grant(method: string): Answer {
    if (method !== 'POST') return failure(404, 'not_found', 'There is nothing at this address.')
    if (!this.site.available) return failure(503, 'unavailable', 'This part of the site is not available right now.')
    if (!this.site.verified) return failure(403, 'verification_required', 'Run the check that proves you are a person before using a demo with your own text.')
    return { status: 200, body: { system: 'lb-06', token: PASS, expiresAt: new Date(Date.now() + 300_000).toISOString(), socketUrl: SOCKET_URL } }
  }

  /** Answers a read of an incident's trace with the spans after the cursor; it is finished once the root span is there. */
  #spans(runId: string, search: URLSearchParams): Answer {
    const spans: MockSpan[] | undefined = this.lb06.spansOf(runId)
    if (!spans) return failure(404, 'run_not_found', 'There is no trace for that run: its ID is unknown, or its trace has expired.')
    const seen = Number(search.get('after')?.split('-')[0] ?? 0)
    return { status: 200, body: { runId, spans: spans.slice(seen), cursor: `${spans.length}-${spans.length}`, more: false, finished: spans.some(span => span.kind === 'system.run') } }
  }
}
