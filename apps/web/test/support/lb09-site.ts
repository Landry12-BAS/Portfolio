// A stand-in for the site as LB-09's board sees it, for the tests of its store and components: the
// site's own API (session, check, recordings, the Scope) played by the fake site the other boards
// use, LB-09's visitor API and the grant for its WebSocket played by the mock back end's LB-09, and a
// WebSocket that talks to the mock's progress hub in memory. Nothing here opens a port. The mock is
// the same code the end-to-end tests run against, so a store that works here speaks the protocol.
// The mock's stages move with the clock, so a test runs under fake timers with the system time set.
import { Lb09Mock, readLb09Seed } from '@lb/api-clients/testing'
import type { Answer, Lb09MockOptions, MockSpan } from '@lb/api-clients/testing'

import { FakeSite } from './fake-site'
import type { FakeSiteOptions } from './fake-site'

// The visitor's one session, the moment the tests start at, and the pass the fake site hands out.
export const SESSION = 'fake-session'
export const NOW = Date.parse('2026-10-02T09:30:00.000Z')
export const PASS = `fake-pass:${SESSION}`
/** The address the fake site names for the socket. */
export const SOCKET_URL = 'ws://api.test/ws/lb09/'

/** A function that wants to hear about a socket event. */
type Listener = (event: never) => void

/** A WebSocket the board can use, wired in memory to the mock's hub. */
export class FakeWebSocket {
  readonly url: string
  readonly sent: string[] = []
  readyState = 0
  readonly #site: FakeLb09Site
  readonly #listeners: Record<'open' | 'message' | 'close', Listener[]> = { open: [], message: [], close: [] }
  #connection: { receive: (text: string) => void, dispose: () => void } | undefined

  /** Starts connecting; the connection opens a moment later, as a real one does. */
  constructor(url: string, site: FakeLb09Site) {
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
    this.#connection = this.#site.lb09.open({
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
    this.#connection?.receive(data)
  }

  /** Closes from the page's side. */
  close(code = 1000): void {
    this.#finish(code)
  }

  /** Has the server say something to the page, bypassing the hub: for frames the hub would never send. */
  serverSays(data: unknown): void {
    this.#later('message', { data })
  }

  /** Has the server close the connection with a code. */
  serverCloses(code: number): void {
    this.#finish(code)
  }
}

/** Makes the class the page constructs when it opens a socket, tied to a site's hub. */
function socketClassFor(site: FakeLb09Site): typeof WebSocket {
  return class extends FakeWebSocket {
    /** Connects to the site's hub. */
    constructor(url: string) {
      super(url, site)
    }
  } as unknown as typeof WebSocket
}

/** What a test may choose about the fake LB-09 site. */
export interface FakeLb09Options extends FakeSiteOptions {
  lb09?: Partial<Lb09MockOptions>
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

/** Reads a request's JSON body, or undefined when it has none. */
async function bodyOf(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

/** The fake site with LB-09 on it. */
export class FakeLb09Site {
  readonly site: FakeSite
  readonly lb09: Lb09Mock
  readonly sockets: FakeWebSocket[] = []
  // When set, every new socket fails to open, as it does with the network down.
  refuseConnections = false
  // When set, the grant for the socket is refused, as it is when the site has no API.
  refuseGrants = false
  readonly #scripted: Scripted[] = []

  /** Starts a fake site and a mock LB-09 with no meetings, whose stages move with the (fake) clock. */
  constructor(options: FakeLb09Options = {}) {
    const { lb09, ...siteOptions } = options
    this.site = new FakeSite(siteOptions)
    this.lb09 = new Lb09Mock(readLb09Seed(), { now: () => Date.now(), verify: token => (token === PASS ? SESSION : undefined), lingerMs: 1_000, ...lb09 })
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
    const mine = url.pathname === '/api/tokens/lb-09' || url.pathname.startsWith('/api/lb09/') || this.#isLb09Trace(url)
    if (!mine) return this.site.fetch(request)
    const body = await bodyOf(request)
    this.site.calls.push({ method: request.method, path, body })
    const key = `${request.method} ${path}`
    const index = this.#scripted.findIndex(item => key.startsWith(item.match))
    if (index >= 0) return respond(this.#scripted.splice(index, 1)[0]?.answer ?? failure(500, 'internal_error', 'x'))
    return respond(this.#answer(request.method, url, body))
  }

  /** Tells whether a read of a trace is for a meeting of LB-09's. */
  #isLb09Trace(url: URL): boolean {
    const match = /^\/api\/runs\/([^/]+)\/spans$/.exec(url.pathname)
    return match !== null && this.lb09.spansOf(decodeURIComponent(match[1] ?? '')) !== undefined
  }

  /** Routes a call to what answers it. */
  #answer(method: string, url: URL, body: unknown): Answer {
    const path = url.pathname
    if (path === '/api/tokens/lb-09') return this.#grant(method)
    if (path.startsWith('/api/runs/')) return this.#spans(decodeURIComponent(path.split('/')[3] ?? ''), url.searchParams)
    if (!this.site.available) return failure(503, 'unavailable', 'This part of the site is not available right now.')
    if (path === '/api/lb09/limits' && method === 'GET') return this.lb09.limits(SESSION)
    if (path === '/api/lb09/samples' && method === 'GET') return this.lb09.samples()
    if (path === '/api/lb09/meetings') {
      if (method === 'GET') return this.lb09.list(SESSION)
      if (method === 'POST') return this.#start(body)
    }
    const one = /^\/api\/lb09\/meetings\/([^/]+)(\/transcript|\/items|\/export)?$/.exec(path)
    if (one && method === 'GET') {
      const id = one[1] ?? ''
      if (one[2] === '/transcript') return this.lb09.transcript(SESSION, id)
      if (one[2] === '/items') return this.lb09.items(SESSION, id)
      if (one[2] === '/export') return this.lb09.export(SESSION, id, url.searchParams.get('format'))
      return this.lb09.get(SESSION, id)
    }
    return failure(404, 'not_found', 'There is nothing at this address.')
  }

  /** Starts a meeting, after the check the site's proxy and the service both make. */
  #start(body: unknown): Answer {
    if (!this.site.verified) return failure(403, 'verification_required', 'Complete the check first.')
    if (typeof body !== 'object' || body === null) return failure(422, 'invalid_request', 'The request is not what the recorder takes.')
    return this.lb09.start(SESSION, body as Parameters<Lb09Mock['start']>[1])
  }

  /** Hands out the pass for the socket, as the site's token route does once the visitor has passed the check. */
  #grant(method: string): Answer {
    if (method !== 'POST') return failure(404, 'not_found', 'There is nothing at this address.')
    if (!this.site.available || this.refuseGrants) return failure(503, 'unavailable', 'This part of the site is not available right now.')
    if (!this.site.verified) return failure(403, 'verification_required', 'Complete the check first.')
    return { status: 200, body: { system: 'lb-09', token: PASS, expiresAt: new Date(Date.now() + 300_000).toISOString(), socketUrl: SOCKET_URL } }
  }

  /** Answers a read of a run's trace with all the spans so far; the cursor is the count already seen. */
  #spans(runId: string, params: URLSearchParams): Answer {
    const spans: MockSpan[] | undefined = this.lb09.spansOf(runId)
    if (!spans) return failure(404, 'run_not_found', 'There is no trace for that run: its ID is unknown, or its trace has expired.')
    const seen = Number(params.get('after')?.split('-')[0] ?? 0)
    // The root span is written when the meeting ends, so the trace is finished once it is there.
    const finished = spans.some(span => span.kind === 'system.run')
    return { status: 200, body: { runId, spans: spans.slice(seen), cursor: `${spans.length}-${spans.length}`, more: false, finished } }
  }
}
