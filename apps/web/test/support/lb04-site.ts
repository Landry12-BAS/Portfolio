// A stand-in for the site's own API, as the browser sees it, for the tests of LB-04's board: the
// session and its Turnstile check and the recordings come from the shared `FakeSite`, LB-04's routes
// are played by the mock back end's own LB-04 (the real upload checks, the real PDF extraction and the
// real review pipeline, with the reference reviewer for a model), and the Scope's trace route answers
// for LB-04's reviews as well as for LB-01's. It is a `fetch` replacement, so a test installs it with
// `vi.stubGlobal('fetch', site.fetch)`, and it keeps a log of every call so a test can say what the
// board did and did not ask for. The mock's clock is the page's, so a test that moves time with fake
// timers moves the contract's hour with it.
import { Lb04Mock, readLb04Seed } from '@lb/api-clients/testing'
import type { Answer } from '@lb/api-clients/testing'

import { FakeSite } from './fake-site'
import type { FakeCall, FakeSiteOptions } from './fake-site'

// The visitor's one session, as the shared fake names it.
const SESSION = 'fake-session-0123456789'

// One mock for all the tests of a file, emptied for each test: reading the seed (the PDFs and the golden
// set) and opening a PDF with pdf.js in a worker thread cost real time, and the mock keeps what it
// learned of each file, so a test that runs on fake timers finds the extraction already done.
let shared: Lb04Mock | undefined

/** The mock every site of this file shares, made on first use. */
function sharedMock(): Lb04Mock {
  shared ??= new Lb04Mock(readLb04Seed(), () => Date.now())
  return shared
}

/**
 * Opens each of these samples once with the real timers, so the tests that follow, which run on fake ones,
 * never wait for a worker thread. Each sample is opened by a visitor of its own, because one visitor may
 * start only three contracts in a day and a sample refused for the limit would not be opened at all.
 */
export async function warmUp(sampleIds: readonly string[]): Promise<void> {
  const mock = sharedMock()
  for (const [index, sampleId] of sampleIds.entries()) {
    const visitor = `warm-up-session-${String(index).padStart(4, '0')}`
    const created = mock.create(visitor, { from: 'sample', sampleId })
    if (created.status >= 300) throw new Error(`The sample ${sampleId} could not be started for the warm-up: ${created.status}.`)
    const id = (created.body as { id: string }).id
    for (let poll = 0; poll < 6; poll += 1) await mock.get(visitor, id)
  }
  mock.reset()
}

/** Turns an answer into a `Response`, with the headers it carries. */
function respond(answer: Answer): Response {
  const headers = { ...(answer.body === undefined ? {} : { 'content-type': 'application/json' }), ...answer.headers }
  if (answer.body === undefined) return new Response(null, { status: answer.status, headers })
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers })
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

/** The fake site for LB-04. */
export class Lb04Site {
  readonly site: FakeSite
  readonly mock: Lb04Mock
  readonly calls: FakeCall[] = []
  readonly #scripted: Scripted[] = []

  /** Starts a fake site with an empty LB-04 mock. */
  constructor(options: FakeSiteOptions = {}) {
    this.site = new FakeSite(options)
    this.mock = sharedMock()
    this.mock.reset()
  }

  /** Whether the visitor has passed the check, which a call that changes something needs. */
  get verified(): boolean {
    return this.site.verified
  }

  /** Makes the next call whose "METHOD /path" starts with `match` answer as given, once. */
  failNext(match: string, answer: Answer): void {
    this.#scripted.push({ match, answer })
  }

  /** The calls made to paths that start with a prefix, in order. */
  callsTo(prefix: string, method?: string): FakeCall[] {
    return this.calls.filter(call => call.path.startsWith(prefix) && (method === undefined || call.method === method))
  }

  /** The calls that fetched a contract's PDF, in order: they are the ones with the file's name at the end of the path. */
  fileCalls(): FakeCall[] {
    return this.calls.filter(call => call.path.startsWith('/api/lb04/contracts/') && call.path.endsWith('/file'))
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
    const own = await this.#answer(request.method, url, body)
    if (own) return respond(own)
    return this.site.fetch(new Request(request.url, { method: request.method, headers: request.headers, body: text === '' ? undefined : text }))
  }

  /** Answers the routes that are LB-04's, or undefined for any other. */
  async #answer(method: string, url: URL, body: unknown): Promise<Answer | undefined> {
    const path = url.pathname
    if (path.startsWith('/api/runs/')) return this.#spans(path.split('/')[3] ?? '', url.searchParams)
    if (!path.startsWith('/api/lb04/')) return undefined
    if (!this.site.available) return failure(503, 'unavailable', 'This part of the site is not available right now.')
    if (method !== 'GET' && !this.site.verified) return failure(403, 'verification_required', 'Run the check that proves you are a person before using a demo with your own text.')
    return this.#lb04(method, path, body)
  }

  /** Answers a read of a review's trace with all the spans so far, when the review is LB-04's; the cursor is the count already seen. */
  #spans(runId: string, search: URLSearchParams): Answer | undefined {
    const spans = this.mock.spansOf(runId)
    if (!spans) return undefined
    const seen = Number(search.get('after')?.split('-')[0] ?? 0)
    const finished = spans.some(span => span.kind === 'system.run' && span.parentId === undefined)
    return { status: 200, body: { runId, spans: spans.slice(seen), cursor: `${spans.length}-${spans.length}`, more: false, finished } }
  }

  /** Routes a call to what answers it. */
  async #lb04(method: string, path: string, body: unknown): Promise<Answer> {
    const parts = path.split('/').filter(Boolean).slice(2)
    const [first, id, third, fourth] = parts
    const key = `${method} ${first}${id ? '/:id' : ''}${third ? `/${third}` : ''}${fourth ? '/:finding/redline' : ''}`
    switch (key) {
      case 'GET limits': return this.mock.limits(SESSION)
      case 'GET samples': return this.mock.samples()
      case 'GET playbook': return this.mock.playbook()
      case 'POST contracts': return this.mock.create(SESSION, body as Parameters<Lb04Mock['create']>[1])
      case 'GET contracts': return this.mock.list(SESSION)
      case 'GET contracts/:id': return this.mock.get(SESSION, id ?? '')
      case 'GET contracts/:id/pages': return this.mock.pages(SESSION, id ?? '')
      case 'GET contracts/:id/file': return this.mock.file(SESSION, id ?? '')
      case 'GET contracts/:id/report': return this.mock.report(SESSION, id ?? '')
      case 'POST contracts/:id/findings/:finding/redline': return this.mock.redline(SESSION, id ?? '', fourth ?? '')
      case 'DELETE contracts/:id': return this.mock.delete(SESSION, id ?? '')
      default: return failure(404, 'not_found', 'There is nothing at this address.')
    }
  }
}
