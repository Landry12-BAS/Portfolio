// A stand-in for the site's own API, as the browser sees it, for the tests of stores and
// components: the session and its Turnstile check, LB-01's routes played by the same in-memory
// mock the integration tests use, the Scope's trace route, and the recordings. It is a `fetch`
// replacement, so a test installs it with `vi.stubGlobal('fetch', site.fetch)`, and it keeps a log
// of every call so a test can say what the board did and did not ask for.
import { Lb01Mock, readSeed } from '@lb/api-clients/testing'
import type { Answer, MockSpan } from '@lb/api-clients/testing'
import type { Recording } from '@lb/contracts'

import { TEST_TURNSTILE_STAND_IN } from '#shared/turnstile-stand-in'

/** What a test may set about the fake site. */
export interface FakeSiteOptions {
  // Whether this deployment has a back end. On by default.
  available?: boolean
  // Whether the visitor has passed the check already. Off by default.
  verified?: boolean
  // Whether the fake accepts the test build's stand-in token, as the test build does. On by default.
  testMode?: boolean
  // The recordings the site offers.
  recordings?: Recording[]
  // How many times a ticket is read before the mock's pipeline has finished with it.
  pollsToFinish?: number
}

/** One call the browser made. */
export interface FakeCall {
  method: string
  path: string
  body: unknown
}

/** A call to make fail once: which one, and with what answer. */
interface Scripted {
  match: string
  answer: Answer
}

// The visitor's one session, and the clock the mock's day runs on.
const SESSION = 'fake-session'
const NOW = Date.parse('2026-10-02T09:30:00.000Z')

/** Turns an answer into a `Response`. */
function respond(answer: Answer): Response {
  if (answer.body === undefined) return new Response(null, { status: answer.status })
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
}

/** Makes a platform error answer. */
function failure(status: number, code: string, message: string): Answer {
  return { status, body: { error: { code, message } } }
}

/** The fake site, its mock back end and its log. */
export class FakeSite {
  readonly mock: Lb01Mock
  readonly calls: FakeCall[] = []
  verified: boolean
  available: boolean
  readonly #options: FakeSiteOptions
  readonly #scripted: Scripted[] = []

  /** Starts a fake site with an empty mock back end. */
  constructor(options: FakeSiteOptions = {}) {
    this.#options = options
    this.mock = new Lb01Mock(readSeed(), () => NOW, options.pollsToFinish ?? 2)
    this.verified = options.verified ?? false
    this.available = options.available ?? true
  }

  /** Makes the next call whose "METHOD /path" starts with `match` answer as given, once. */
  failNext(match: string, answer: Answer): void {
    this.#scripted.push({ match, answer })
  }

  /** The calls made to paths that start with a prefix, in order. */
  callsTo(prefix: string, method?: string): FakeCall[] {
    return this.calls.filter(call => call.path.startsWith(prefix) && (method === undefined || call.method === method))
  }

  /** The browser's `fetch`, as this site answers it. */
  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://site.test'), init)
    const url = new URL(request.url)
    const text = request.method === 'GET' ? '' : await request.text()
    const body: unknown = text === '' ? undefined : JSON.parse(text)
    const path = `${url.pathname}${url.search}`
    this.calls.push({ method: request.method, path, body })
    const key = `${request.method} ${path}`
    const index = this.#scripted.findIndex(item => key.startsWith(item.match))
    if (index >= 0) return respond(this.#scripted.splice(index, 1)[0]?.answer ?? failure(500, 'internal_error', 'x'))
    return respond(this.#answer(request.method, url, body))
  }

  /** Routes a call to what answers it. */
  #answer(method: string, url: URL, body: unknown): Answer {
    const path = url.pathname
    if (path === '/api/session') return { status: 200, body: this.#state() }
    if (path === '/api/session/verify' && method === 'POST') return this.#verify(body)
    if (path.startsWith('/api/runs/')) return this.#spans(path.split('/')[3] ?? '', url.searchParams)
    if (path.startsWith('/api/recordings/')) return this.#recordings(path)
    if (path.startsWith('/api/lb01/')) {
      if (!this.available) return failure(503, 'unavailable', 'This part of the site is not available right now.')
      if (method !== 'GET' && !this.verified) return failure(403, 'verification_required', 'Run the check that proves you are a person before using a demo with your own text.')
      return this.#lb01(method, path, body)
    }
    return failure(404, 'not_found', 'There is nothing at this address.')
  }

  /** The session's state, as `/api/session` says it. */
  #state(): Record<string, unknown> {
    return { available: this.available, verified: this.verified, siteKey: this.#options.testMode === false ? 'test-site-key' : null, testMode: this.#options.testMode ?? true, resetsAt: '2026-10-03T00:00:00.000Z' }
  }

  /** Checks a Turnstile token: the stand-in passes, and so does `good-token`. */
  #verify(body: unknown): Answer {
    const token = (body as { token?: string } | undefined)?.token
    if (token !== TEST_TURNSTILE_STAND_IN && token !== 'good-token') return failure(403, 'verification_failed', 'The check could not tell that you are a person. Try again.')
    this.verified = true
    return { status: 200, body: this.#state() }
  }

  /** Answers LB-01's routes from the mock. */
  #lb01(method: string, path: string, body: unknown): Answer {
    const parts = path.split('/').filter(Boolean)
    if (method === 'GET' && parts[2] === 'customers') return this.mock.customers()
    if (method === 'GET' && parts[2] === 'stats') return this.mock.stats(SESSION)
    if (method === 'GET' && parts[2] === 'tickets' && parts[3] === undefined) return this.mock.list(SESSION)
    if (method === 'POST' && parts[2] === 'tickets' && parts[3] === undefined) return this.mock.file(SESSION, body as { customer: string, language: 'en' | 'cs', body: string })
    if (method === 'GET' && parts[2] === 'tickets' && parts[3]) return this.mock.get(SESSION, parts[3])
    if (method === 'POST' && parts[4] === 'decision' && parts[3]) return this.mock.decide(SESSION, parts[3], body as { action: string, text?: string | null })
    return failure(404, 'not_found', 'There is nothing at this address.')
  }

  /** Answers a read of a run's trace with all the spans so far; the cursor is the count already seen. */
  #spans(runId: string, search: URLSearchParams): Answer {
    const spans: MockSpan[] | undefined = this.mock.spansOf(runId)
    if (!spans) return failure(404, 'run_not_found', 'There is no trace for that run: its ID is unknown, or its trace has expired.')
    const seen = Number(search.get('after')?.split('-')[0] ?? 0)
    const finished = spans.some(span => span.kind === 'system.run' && span.parentId === undefined)
    return { status: 200, body: { runId, spans: spans.slice(seen), cursor: `${spans.length}-${spans.length}`, more: false, finished } }
  }

  /** Answers the recordings routes. */
  #recordings(path: string): Answer {
    const [, , , system, sample] = path.split('/')
    const mine = (this.#options.recordings ?? []).filter(recording => recording.system === system)
    if (sample === undefined) return { status: 200, body: { system, samples: mine.map(recording => recording.sample) } }
    const found = mine.find(recording => recording.sample === sample)
    return found ? { status: 200, body: found } : failure(404, 'not_found', 'There is nothing at this address.')
  }
}
