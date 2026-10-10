// A stand-in for the site's own API, as the browser sees it, for the tests of LB-08's board: the
// session and its Turnstile check and the recordings come from the shared `FakeSite`, LB-08's
// routes are played by the same in-memory mock the integration tests use, and the Scope's trace
// route answers for LB-08's runs as well as for LB-01's. It is a `fetch` replacement, so a test
// installs it with `vi.stubGlobal('fetch', site.fetch)`, and it keeps a log of every call so a test
// can say what the board did and did not ask for. The mock's clock is the page's, so a test that
// moves time with fake timers moves the engine's retries with it.
import { Lb08Mock, readLb08Seed } from '@lb/api-clients/testing'
import type { Answer } from '@lb/api-clients/testing'

import { FakeSite } from './fake-site'
import type { FakeCall, FakeSiteOptions } from './fake-site'

// The visitor's one session, as the shared fake names it.
const SESSION = 'fake-session'

/** Turns an answer into a `Response`. */
function respond(answer: Answer): Response {
  if (answer.body === undefined) return new Response(null, { status: answer.status })
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } })
}

/** Makes a platform error answer. */
function failure(status: number, code: string, message: string): Answer {
  return { status, body: { error: { code, message } } }
}

/** A call to make fail once: which one, and with what answer. */
interface Scripted {
  match: string
  answer: Answer
}

/** The fake site for LB-08. */
export class Lb08Site {
  readonly site: FakeSite
  readonly mock: Lb08Mock
  readonly calls: FakeCall[] = []
  // Keeps every run's root span out of its trace, to play the moment between a run ending and its root being written.
  withholdRoots = false
  readonly #scripted: Scripted[] = []

  /** Starts a fake site with an empty LB-08 mock. */
  constructor(options: FakeSiteOptions = {}) {
    this.site = new FakeSite(options)
    this.mock = new Lb08Mock(readLb08Seed(), () => Date.now())
  }

  /** Whether the visitor has passed the check, which a call that changes something needs. */
  get verified(): boolean {
    return this.site.verified
  }

  /** Whether this deployment has a back end. */
  get available(): boolean {
    return this.site.available
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
    const request = input instanceof Request ? input.clone() : new Request(new URL(String(input), 'http://site.test'), init)
    const url = new URL(request.url)
    const text = request.method === 'GET' ? '' : await request.text()
    const body: unknown = text === '' ? undefined : JSON.parse(text)
    this.calls.push({ method: request.method, path: `${url.pathname}${url.search}`, body })
    const key = `${request.method} ${url.pathname}${url.search}`
    const index = this.#scripted.findIndex(item => key.startsWith(item.match))
    if (index >= 0) return respond(this.#scripted.splice(index, 1)[0]?.answer ?? failure(500, 'internal_error', 'x'))
    const own = this.#answer(request.method, url, body)
    if (own) return respond(own)
    return this.site.fetch(new Request(request.url, { method: request.method, headers: request.headers, body: text === '' ? undefined : text }))
  }

  /** Answers the routes that are LB-08's, or undefined for any other. */
  #answer(method: string, url: URL, body: unknown): Answer | undefined {
    const path = url.pathname
    if (path.startsWith('/api/runs/')) return this.#spans(path.split('/')[3] ?? '', url.searchParams)
    if (!path.startsWith('/api/lb08/')) return undefined
    if (!this.site.available) return failure(503, 'unavailable', 'This part of the site is not available right now.')
    if (method !== 'GET' && !this.site.verified) return failure(403, 'verification_required', 'Run the check that proves you are a person before using a demo with your own text.')
    return this.#lb08(method, path, url.searchParams, body)
  }

  /** Answers a read of a run's trace with all the spans so far, when the run is LB-08's; the cursor is the count already seen. */
  #spans(runId: string, search: URLSearchParams): Answer | undefined {
    const written = this.mock.spansOf(runId)
    if (!written) return undefined
    const isRoot = (span: (typeof written)[number]): boolean => span.kind === 'system.run' && span.parentId === undefined
    const spans = this.withholdRoots ? written.filter(span => !isRoot(span)) : written
    const seen = Number(search.get('after')?.split('-')[0] ?? 0)
    const finished = spans.some(isRoot)
    return { status: 200, body: { runId, spans: spans.slice(seen), cursor: `${spans.length}-${spans.length}`, more: false, finished } }
  }

  /** Routes a call to what answers it. */
  #lb08(method: string, path: string, search: URLSearchParams, body: unknown): Answer {
    const parts = path.split('/').filter(Boolean).slice(2)
    const [first, id, third, fourth] = parts
    const key = `${method} ${first}${id ? '/:id' : ''}${third ? `/${third}` : ''}${fourth ? '/:node/decision' : ''}`
    switch (key) {
      case 'GET catalogue': return this.mock.catalogue()
      case 'GET samples': return this.mock.samples()
      case 'GET limits': return this.mock.limits(SESSION)
      case 'POST workflows': return this.mock.createWorkflow(SESSION, body as Parameters<Lb08Mock['createWorkflow']>[1])
      case 'GET workflows': return this.mock.listWorkflows(SESSION)
      case 'GET workflows/:id': return this.mock.getWorkflow(SESSION, id ?? '')
      case 'PUT workflows/:id': return this.mock.saveWorkflow(SESSION, id ?? '', body as Parameters<Lb08Mock['saveWorkflow']>[2])
      case 'DELETE workflows/:id': return this.mock.deleteWorkflow(SESSION, id ?? '')
      case 'POST workflows/:id/runs': return this.mock.startRun(SESSION, id ?? '', body as Parameters<Lb08Mock['startRun']>[2])
      case 'GET runs/:id': return this.mock.getRun(SESSION, id ?? '')
      case 'GET runs/:id/events': return this.mock.runEvents(SESSION, id ?? '', Number(search.get('after') ?? 0))
      case 'POST runs/:id/replay': return this.mock.replayRun(SESSION, id ?? '')
      case 'POST runs/:id/steps/:node/decision': return this.mock.decide(SESSION, id ?? '', fourth ?? '', (body as { decision: 'approved' | 'rejected' }).decision)
      case 'GET sent': return this.mock.sent(SESSION, search.get('rootRunId') ?? undefined)
      case 'GET dead-letters': return this.mock.deadLetters(SESSION)
      case 'POST dead-letters/:id/replay': return this.mock.replayDeadLetter(SESSION, id ?? '')
      default: return failure(404, 'not_found', 'There is nothing at this address.')
    }
  }
}
