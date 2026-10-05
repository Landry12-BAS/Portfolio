// A stand-in for the site as LB-10's board sees it, for the tests of its store and components: the site's own API
// (session, check, recordings, the Scope) played by the fake site the other boards use, and LB-10's visitor API played
// by the mock back end's LB-10 (the real packs, the service's prompt check, ledger, cache and refusals, and a run that
// moves on as it is read). Nothing here opens a port. The mock is the same code the end-to-end tests run against, so a
// store that works here speaks the protocol. An error answer goes through the site's own reading of a back end's error
// (only the platform's shape and the fields it allows), as it would in the browser. A call can be made to fail
// (`failNext`) or held back (`delayNext`) once.
import { platformErrorSchema } from '@lb/contracts'
import { Lb10Mock, readLb10Seed } from '@lb/api-clients/testing'
import type { Answer, Lb10MockOptions, MockSpan } from '@lb/api-clients/testing'

import { FakeSite } from './fake-site'
import type { FakeSiteOptions } from './fake-site'

/** The visitor's one session. A session key is a hash of at least 16 characters, as the service's runs require. */
export const SESSION = 'fake-session-for-lb10'

/** What a test may choose about the fake LB-10 site. */
export interface FakeLb10Options extends FakeSiteOptions {
  lb10?: Partial<Lb10MockOptions>
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

/** Turns an answer into a `Response`, passing an error on only in the platform's shape, as the site's server does. */
function respond(answer: Answer): Response {
  if (answer.body === undefined) return new Response(null, { status: answer.status, headers: answer.headers })
  let body = answer.body
  if (answer.status >= 400) {
    const parsed = platformErrorSchema.safeParse(body)
    body = parsed.success ? parsed.data : { error: { code: 'upstream_error', message: 'The system behind this demo could not do that.' } }
  }
  return new Response(JSON.stringify(body), { status: answer.status, headers: { 'content-type': 'application/json', ...answer.headers } })
}

/** Makes a platform error answer. */
function failure(status: number, code: string, message: string): Answer {
  return { status, body: { error: { code, message } } }
}

/** The fake site with LB-10 on it. */
export class FakeLb10Site {
  readonly site: FakeSite
  readonly lb10: Lb10Mock
  readonly #scripted: Scripted[] = []
  readonly #delayed: Delayed[] = []

  /** Starts a fake site and a mock LB-10 with no runs. */
  constructor(options: FakeLb10Options = {}) {
    const { lb10, ...siteOptions } = options
    this.site = new FakeSite(siteOptions)
    this.lb10 = new Lb10Mock(readLb10Seed(), () => Date.now(), { ...lb10 })
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
    const mine = url.pathname.startsWith('/api/lb10/') || this.#isLb10Trace(url)
    if (!mine) return this.site.fetch(request)
    const text = request.method === 'GET' ? '' : await request.text()
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

  /** Tells whether a read of a trace is for a run of LB-10's. */
  #isLb10Trace(url: URL): boolean {
    const match = /^\/api\/runs\/([^/]+)\/spans$/.exec(url.pathname)
    return match !== null && this.lb10.spansOf(decodeURIComponent(match[1] ?? '')) !== undefined
  }

  /** Routes a call to what answers it. */
  #answer(method: string, url: URL, body: unknown): Answer {
    const path = url.pathname
    if (path.startsWith('/api/runs/')) return this.#spans(decodeURIComponent(path.split('/')[3] ?? ''), url.searchParams)
    if (!this.site.available) return failure(503, 'unavailable', 'This part of the site is not available right now.')
    if (method !== 'GET' && !this.site.verified) return failure(403, 'verification_required', 'Run the check that proves you are a person before using a demo with your own text.')
    if (path === '/api/lb10/targets') return this.lb10.targets()
    if (path === '/api/lb10/quota') return this.lb10.quota(SESSION)
    if (path === '/api/lb10/nightly') return this.lb10.nightly()
    if (path === '/api/lb10/baselines') return this.lb10.baselines()
    if (path === '/api/lb10/runs') return method === 'POST' ? this.lb10.start(SESSION, body as { target: string, prompt: string, providers: string[] }) : this.lb10.runsToday(SESSION)
    const one = /^\/api\/lb10\/runs\/([^/]+)$/.exec(path)
    if (one) return this.lb10.run(SESSION, one[1] ?? '')
    return failure(404, 'not_found', 'There is nothing at this address.')
  }

  /** Answers a read of a run's trace with the spans after the cursor; it is finished once the root span is there. */
  #spans(runId: string, search: URLSearchParams): Answer {
    const spans: MockSpan[] | undefined = this.lb10.spansOf(runId)
    if (!spans) return failure(404, 'run_not_found', 'There is no trace for that run: its ID is unknown, or its trace has expired.')
    const seen = Number(search.get('after')?.split('-')[0] ?? 0)
    return { status: 200, body: { runId, spans: spans.slice(seen), cursor: `${spans.length}-${spans.length}`, more: false, finished: spans.some(span => span.kind === 'system.run' && span.parentId === undefined) } }
  }
}
