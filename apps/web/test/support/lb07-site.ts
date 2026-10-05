// A stand-in for the site as LB-07's board sees it, for the tests of its store and components: the site's
// own API (session, check, recordings, the Scope) played by the fake site the other boards use, and LB-07's
// visitor API played by the mock back end's LB-07 (the service's state machine over a model of the shop,
// with the golden set's plans, the service's own finding ledger, verdict rule and test template). Nothing
// here opens a port. The mock's clock is the page's, so a test that moves time with fake timers moves the
// runs with it, and the mock is the same code the end-to-end tests run against, so a store that works here
// speaks the protocol. A call can be made to fail (`failNext`) or held back (`delayNext`) once.
import { Lb07Mock, readLb07Seed } from '@lb/api-clients/testing'
import type { Answer, Lb07MockOptions, MockSpan } from '@lb/api-clients/testing'

import { FakeSite } from './fake-site'
import type { FakeSiteOptions } from './fake-site'

/** The visitor's one session. A session key is a hash of at least 16 characters, as the service's runs require. */
export const SESSION = 'fake-session-for-lb07'

/** What a test may choose about the fake LB-07 site. */
export interface FakeLb07Options extends FakeSiteOptions {
  lb07?: Partial<Lb07MockOptions>
}

/** A call to answer otherwise once: which one, and with what answer. */
interface Scripted {
  match: string
  answer: Answer
}

/** A call to hold back once: which one, and for how long. */
interface Delayed {
  match: string
  ms: number
}

/** Turns an answer into a `Response`. */
function respond(answer: Answer): Response {
  if (answer.body === undefined) return new Response(null, { status: answer.status, headers: answer.headers })
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json', ...answer.headers } })
}

/** Makes a platform error answer. */
function failure(status: number, code: string, message: string): Answer {
  return { status, body: { error: { code, message } } }
}

/** The fake site with LB-07 on it. */
export class FakeLb07Site {
  readonly site: FakeSite
  readonly lb07: Lb07Mock
  readonly #scripted: Scripted[] = []
  readonly #delayed: Delayed[] = []

  /** Starts a fake site and a mock LB-07 with no runs. */
  constructor(options: FakeLb07Options = {}) {
    const { lb07, ...siteOptions } = options
    this.site = new FakeSite(siteOptions)
    this.lb07 = new Lb07Mock(readLb07Seed(), () => Date.now(), { tickMs: 100, ...lb07 })
  }

  /** The calls the browser made, in order. */
  get calls() {
    return this.site.calls
  }

  /** The calls made to paths that start with a prefix, in order. */
  callsTo(prefix: string, method?: string) {
    return this.site.callsTo(prefix, method)
  }

  /** Makes the next call whose "METHOD /path" starts with `match` answer as given, once. */
  failNext(match: string, answer: Answer): void {
    this.#scripted.push({ match, answer })
  }

  /** Holds back the next call whose "METHOD /path" starts with `match` for `ms` milliseconds before it is answered, once. */
  delayNext(match: string, ms: number): void {
    this.#delayed.push({ match, ms })
  }

  /** The browser's `fetch`, as this site answers it. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://site.test'), init)
    const url = new URL(request.url)
    const mine = url.pathname.startsWith('/api/lb07/') || this.#isLb07Trace(url)
    if (!mine) return this.site.fetch(request)
    const text = request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text()
    const body: unknown = text === '' ? undefined : JSON.parse(text)
    const path = `${url.pathname}${url.search}`
    this.site.calls.push({ method: request.method, path, body })
    const key = `${request.method} ${path}`
    const held = this.#delayed.findIndex(item => key.startsWith(item.match))
    // Taken at the moment of asking, so a held-back answer says what was true when it was asked, as a slow network's does.
    const answer = this.#takeScripted(key) ?? this.#answer(request.method, url, body)
    if (held >= 0) await new Promise(resolve => setTimeout(resolve, this.#delayed.splice(held, 1)[0]?.ms ?? 0))
    return respond(answer)
  }

  /** Takes the first scripted answer for a call, if there is one. */
  #takeScripted(key: string): Answer | undefined {
    const index = this.#scripted.findIndex(item => key.startsWith(item.match))
    return index >= 0 ? this.#scripted.splice(index, 1)[0]?.answer : undefined
  }

  /** Tells whether a read of a trace is for a run of LB-07's. */
  #isLb07Trace(url: URL): boolean {
    const match = /^\/api\/runs\/([^/]+)\/spans$/.exec(url.pathname)
    return match !== null && this.lb07.spansOf(decodeURIComponent(match[1] ?? '')) !== undefined
  }

  /** Routes a call to what answers it. */
  #answer(method: string, url: URL, body: unknown): Answer {
    const path = url.pathname
    if (path.startsWith('/api/runs/')) return this.#spans(decodeURIComponent(path.split('/')[3] ?? ''), url.searchParams)
    if (!this.site.available) return failure(503, 'unavailable', 'This part of the site is not available right now.')
    if (method !== 'GET' && !this.site.verified) return failure(403, 'verification_required', 'Run the check that proves you are a person before using a demo with your own text.')
    if (path === '/api/lb07/limits') return this.lb07.limits(SESSION)
    if (path === '/api/lb07/bugs') return this.lb07.bugs()
    if (path === '/api/lb07/samples') return this.lb07.samples()
    if (path === '/api/lb07/runs') return method === 'POST' ? this.lb07.start(SESSION, body) : this.lb07.list(SESSION)
    const one = /^\/api\/lb07\/runs\/([^/]+)$/.exec(path)
    if (one) return method === 'DELETE' ? this.lb07.remove(SESSION, one[1] ?? '') : this.lb07.get(SESSION, one[1] ?? '')
    const part = /^\/api\/lb07\/runs\/([^/]+)\/(report|test)$/.exec(path)
    if (part) return part[2] === 'report' ? this.lb07.report(SESSION, part[1] ?? '') : this.lb07.test(SESSION, part[1] ?? '')
    const evidence = /^\/api\/lb07\/runs\/([^/]+)\/evidence\/([^/]+)$/.exec(path)
    if (evidence) return this.lb07.evidence(SESSION, evidence[1] ?? '', evidence[2] ?? '')
    return failure(404, 'not_found', 'There is nothing at this address.')
  }

  /** Answers a read of a run's trace with the spans after the cursor; it is finished once the root span is there. */
  #spans(runId: string, search: URLSearchParams): Answer {
    const spans: MockSpan[] | undefined = this.lb07.spansOf(runId)
    if (!spans) return failure(404, 'run_not_found', 'There is no trace for that run: its ID is unknown, or its trace has expired.')
    const seen = Number(search.get('after')?.split('-')[0] ?? 0)
    return { status: 200, body: { runId, spans: spans.slice(seen), cursor: `${spans.length}-${spans.length}`, more: false, finished: spans.some(span => span.kind === 'system.run' && span.parentId === undefined) } }
  }
}
