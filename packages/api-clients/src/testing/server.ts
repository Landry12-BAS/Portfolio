// A mock of the back ends and of the gateway's Scope route, on one local port: what the site's
// server talks to in the unit, integration and end-to-end tests, and in development without
// a back end. It serves exactly the operations the three committed OpenAPI documents describe,
// answers LB-01 like the real one (a ticket's pipeline moves on as it is polled, drafts cite the
// real policies), answers every other operation with an example that fits its schema, checks
// every visitor token with the real verifier, and checks its own answers against the documents,
// so it cannot quietly drift from them. Besides those operations it has one route of its own,
// `GET /__mock`, which says `{"mock": true}`, so the sample recorder can tell it from a real back end.
//
// It is a test fixture and listens on the loopback address only. For tests that need a back
// end misbehaving, `script()` queues an answer (a status, a body, a delay, a dropped connection,
// a redirect, a huge body); `requests` records everything it received, headers included.
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createVisitorVerifier, VisitorTokenError } from '@lb/common/visitors'
import type { Visitor, VisitorVerifier } from '@lb/common/visitors'

import { MOCK_IDENTITY_PATH } from '../mock-identity.ts'
import { MockGateway } from './gateway.ts'
import { Lb01Mock, errorAnswer } from './lb01.ts'
import type { Answer, RunIdDisclosure } from './lb01.ts'
import { Lb08Mock } from './lb08.ts'
import { readLb08Seed } from './lb08-seed.ts'
import { OpenApiDocuments } from './openapi.ts'
import type { MockOperation } from './openapi.ts'
import { readSeed } from './seed.ts'
import type { Language } from './seed.ts'
import { Lb02Mock } from './lb02/index.ts'
import { MAX_FRAME_BYTES as LB02_MAX_FRAME_BYTES } from './lb02/hub.ts'
import { attachSockets } from './lb02/socket-server.ts'
import { Lb09Mock, MAX_FRAME_BYTES as LB09_MAX_FRAME_BYTES } from './lb09.ts'
import type { Lb09MockOptions, StartMeetingRequest } from './lb09.ts'
import { readLb09Seed } from './lb09-seed.ts'
import { Lb05Mock } from './lb05.ts'
import { readLb05Seed } from './lb05-seed.ts'

// Nothing the site sends is bigger than this; a bigger body is refused unread. LB-09's recording, up to 3 MiB
// of audio as base64 in a JSON body, is the one big body (infra/caddy/Caddyfile gives that route 5 MB too).
const MAX_BODY_BYTES = 5 * 1_048_576

/** What the mock was set up with. */
export interface MockBackendOptions {
  // The site's public key, base64url: visitor tokens are checked against it, as LB_WEB_TOKEN_KEY does.
  siteKey: string
  // The `web` service's public key, base64url: the Scope route's service tokens are checked against it.
  webKey: string
  // The clock, in Unix milliseconds. Tests move it to expire tokens and to start a new day.
  now?: () => number
  // The port to listen on; a free one by default.
  port?: number
  // How many times a ticket is polled before its pipeline has finished.
  pollsToFinish?: number
  // When the API names a ticket's run: `when-finished`, as Django does today, or `at-filing`.
  runId?: RunIdDisclosure
  // Whether answers carry the headers a real framework adds (a server banner, a cookie, a
  // permissive CORS header), so tests can see the site's server drop them. On by default.
  leakyHeaders?: boolean
  // LB-02's conversation: how long a connection has to say hello and may be silent, how many messages and
  // conversations are allowed, and how long the concierge "thinks". The real service's limits by default.
  lb02?: { helloTimeoutMs?: number, idleTimeoutMs?: number, messagesPerConversation?: number, conversationsPerDay?: number, thinkMs?: number }
  // LB-09's meetings: how long each stage of the worker takes, how long a connection has to say hello, and how long it lingers after the end.
  lb09?: Pick<Lb09MockOptions, 'stageMs' | 'helloTimeoutMs' | 'lingerMs'>
}

/** Something the mock should do instead of answering normally, once or several times. */
export interface ScriptedAnswer {
  // Which requests it is for; absent means any.
  method?: string
  path?: string
  // Instead of a status and a body: drop the connection without a word.
  destroy?: boolean
  status?: number
  headers?: Record<string, string>
  // The body as JSON, as raw text (to send what isn't JSON), or as that many bytes of filler.
  json?: unknown
  text?: string
  bytes?: number
  // How long to wait before answering.
  delayMs?: number
  // How many matching requests it answers; once by default.
  times?: number
}

/** A request the mock received, as a test can look at it. */
export interface RecordedRequest {
  method: string
  path: string
  query: string
  // Header names in lower case.
  headers: Record<string, string>
  // The body as sent, or an empty text.
  body: string
}

/** A running mock back end. */
export interface MockBackend {
  // Where it listens, such as http://127.0.0.1:43211. Use it as the site's API and gateway URL.
  url: string
  // Every request received since the start or the last reset, oldest first.
  requests: RecordedRequest[]
  // Answers its documents' checks failed, such as an answer that doesn't fit its schema. Empty when all is well.
  violations: string[]
  // LB-01's state, for tests that look inside.
  lb01: Lb01Mock
  // LB-02's state and controls: other visitors, the clock, the connections.
  lb02: Lb02Mock
  // LB-05's state, for tests that look inside.
  lb05: Lb05Mock
  // LB-08's state: its workflows, runs and sandbox.
  lb08: Lb08Mock
  // LB-09's state: its meetings and the connections that follow them, and the control that makes the next one fail.
  lb09: Lb09Mock
  // Queues an answer to use instead of the normal one.
  script: (answer: ScriptedAnswer) => void
  // Forgets the requests, the scripts and every ticket.
  reset: () => void
  close: () => Promise<void>
}

// Headers a real framework adds and the site must not pass on to a visitor.
const LEAKY_HEADERS: Record<string, string> = {
  'server': 'gunicorn/22.0 (mock)',
  'x-powered-by': 'Mock',
  'set-cookie': 'mock_session=1; Path=/',
  'access-control-allow-origin': '*',
  'x-internal-host': 'db-1.internal',
  'via': '1.1 mock-proxy',
}

/** Reads a request's body, or returns undefined when it is bigger than the limit. */
async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    length += (chunk as Buffer).length
    if (length > MAX_BODY_BYTES) return undefined
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Turns the header values of a request into one lower-case map of single values. */
function flatten(headers: IncomingMessage['headers']): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : (value ?? '')]))
}

/** Waits for the given number of milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The mock's state and the way it answers; `startMockBackend` puts it behind a port. */
class MockSite {
  readonly requests: RecordedRequest[] = []
  readonly violations: string[] = []
  readonly lb01: Lb01Mock
  readonly lb02: Lb02Mock
  readonly lb05: Lb05Mock
  readonly lb08: Lb08Mock
  readonly lb09: Lb09Mock
  readonly #documents = new OpenApiDocuments()
  readonly #gateway: MockGateway
  readonly #verifiers = new Map<string, VisitorVerifier>()
  readonly #scripts: (ScriptedAnswer & { remaining: number })[] = []
  readonly #options: MockBackendOptions
  readonly #now: () => number

  /** Reads the seed and the documents, and sets up LB-01 and the Scope route. */
  constructor(options: MockBackendOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.lb01 = new Lb01Mock(readSeed(), this.#now, { pollsToFinish: options.pollsToFinish, runId: options.runId })
    this.lb02 = new Lb02Mock({ ...options.lb02, now: this.#now, verify: token => this.#visitor(`Bearer ${token}`, 'lb-02')?.sessionKey })
    this.lb05 = new Lb05Mock(readLb05Seed(), this.#now)
    this.lb08 = new Lb08Mock(readLb08Seed(), this.#now)
    this.lb09 = new Lb09Mock(readLb09Seed(), { ...options.lb09, now: this.#now, verify: token => this.#visitor(`Bearer ${token}`, 'lb-09')?.sessionKey })
    this.#gateway = new MockGateway(options.webKey, this.#now, runId => this.lb01.spansOf(runId) ?? this.lb02.spansOf(runId) ?? this.lb05.spansOf(runId) ?? this.lb08.spansOf(runId) ?? this.lb09.spansOf(runId))
  }

  /** Queues a scripted answer. */
  script(answer: ScriptedAnswer): void {
    this.#scripts.push({ ...answer, remaining: answer.times ?? 1 })
  }

  /** Forgets the requests, the scripts, the violations and every ticket. */
  reset(): void {
    this.requests.length = 0
    this.violations.length = 0
    this.#scripts.length = 0
    this.lb01.reset()
    this.lb02.reset()
    this.lb05.reset()
    this.lb08.reset()
    this.lb09.reset()
  }

  /** Takes the first scripted answer that is for this request, if there is one. */
  #takeScript(method: string, path: string): ScriptedAnswer | undefined {
    const index = this.#scripts.findIndex(script => (script.method === undefined || script.method === method) && (script.path === undefined || script.path === path))
    const script = this.#scripts[index]
    if (!script) return undefined
    script.remaining -= 1
    if (script.remaining <= 0) this.#scripts.splice(index, 1)
    return script
  }

  /** Sends an answer: a status, a JSON body when there is one, and the headers a framework would add. */
  #send(response: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const text = typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body)
    const headers: Record<string, string> = { ...(this.#options.leakyHeaders === false ? {} : LEAKY_HEADERS), ...extra }
    if (text !== undefined && !('content-type' in headers)) headers['content-type'] = 'application/json; charset=utf-8'
    response.writeHead(status, headers)
    response.end(text)
  }

  /** Plays a scripted answer. */
  async #play(script: ScriptedAnswer, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (script.delayMs) await pause(script.delayMs)
    if (script.destroy) {
      request.socket.destroy()
      return
    }
    const body = script.text ?? (script.bytes === undefined ? script.json : 'x'.repeat(script.bytes))
    this.#send(response, script.status ?? 200, body, script.headers)
  }

  /** Reads the request's visitor token for the system the path belongs to. */
  #visitor(authorization: string | undefined, system: string): Visitor | undefined {
    let verifier = this.#verifiers.get(system)
    if (!verifier) {
      verifier = createVisitorVerifier(system, this.#options.siteKey, () => this.#now() / 1000)
      this.#verifiers.set(system, verifier)
    }
    try {
      return verifier(authorization)
    }
    catch (error) {
      if (error instanceof VisitorTokenError) return undefined
      throw error
    }
  }

  /** Handles one request. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://mock.local')
    const method = request.method ?? 'GET'
    const body = await readBody(request)
    this.requests.push({ method, path: url.pathname, query: url.search, headers: flatten(request.headers), body: body ?? '' })
    if (body === undefined) return this.#send(response, 413, errorAnswer(413, 'payload_too_large', 'The request is too big.').body)

    const script = this.#takeScript(method, url.pathname)
    if (script) return this.#play(script, request, response)

    // The one thing no real back end does: say what it is. The recorder asks, so a recording made
    // on this mock can never be labelled as one made on a real back end (apps/web/scripts/record).
    if (url.pathname === MOCK_IDENTITY_PATH && method === 'GET') return this.#send(response, 200, { mock: true })

    const spans = /^\/v1\/runs\/([^/]+)\/spans$/.exec(url.pathname)
    if (spans && method === 'GET') {
      const answer = await this.#gateway.spans(request.headers.authorization, decodeURIComponent(spans[1] ?? ''), url.searchParams)
      return this.#send(response, answer.status, answer.body)
    }
    if (url.pathname.startsWith('/__mock/lb02/')) return this.#control(url.pathname.slice('/__mock/lb02/'.length), method, request.headers['content-type'], body, response)
    if (url.pathname.startsWith('/__mock/lb09/')) return this.#controlLb09(url.pathname.slice('/__mock/lb09/'.length), method, request.headers['content-type'], body, response)
    const found = this.#documents.find(method, url.pathname)
    if (!found) return this.#send(response, 404, errorAnswer(404, 'not_found', 'There is nothing at this address.').body)
    const answer = this.#answer(found.operation, found.params, url, request.headers.authorization, body)
    this.#send(response, answer.status, answer.body)
  }

  /** Answers a documented operation: the visitor's token, the body, the handler or an example, and a check of the answer. */
  #answer(operation: MockOperation, params: Record<string, string>, url: URL, authorization: string | undefined, text: string): Answer {
    const system = /^\/api\/lb(\d{2})\//.exec(url.pathname)?.[1]
    if (system === undefined) return this.#example(operation)
    const visitor = this.#visitor(authorization, `lb-${system}`)
    if (!visitor) return errorAnswer(401, 'unauthorized', 'Send a visitor token for this system.')
    let json: unknown
    if (text !== '') {
      try {
        json = JSON.parse(text)
      }
      catch {
        return errorAnswer(400, 'invalid_request', 'The body is not JSON.')
      }
    }
    const problems = this.#documents.checkRequest(operation, json)
    if (problems.length > 0) return { status: 422, body: { error: { code: 'invalid_request', message: 'The request does not fit its schema.', fields: problems.join('; ') } } }
    const answer = this.#handler(operation, params, visitor, json, url.searchParams) ?? this.#example(operation)
    this.#check(operation, answer)
    return answer
  }

  /** Runs the handler written for an operation, if there is one: LB-01's, LB-02's, LB-05's and LB-08's. */
  #handler(operation: MockOperation, params: Record<string, string>, visitor: Visitor, json: unknown, search: URLSearchParams): Answer | undefined {
    const session = visitor.sessionKey
    switch (`${operation.method} ${operation.template}`) {
      case 'GET /api/lb01/customers': return this.lb01.customers()
      case 'POST /api/lb01/tickets': return this.lb01.file(session, json as { customer: string, language: Language, body: string })
      case 'GET /api/lb01/tickets': return this.lb01.list(session)
      case 'GET /api/lb01/tickets/{ticket_id}': return this.lb01.get(session, params.ticket_id ?? '')
      case 'POST /api/lb01/tickets/{ticket_id}/decision': return this.lb01.decide(session, params.ticket_id ?? '', json as { action: string, text?: string | null })
      case 'GET /api/lb01/stats': return this.lb01.stats(session)
      case 'GET /api/lb02/offerings': return this.lb02.offerings()
      case 'GET /api/lb02/calendar': return this.lb02.calendar(session, search)
      case 'GET /api/lb02/conversations': return this.lb02.conversations(session)
      case 'GET /api/lb02/conversations/{conversation_id}': return this.lb02.conversation(session, params.conversation_id ?? '')
      case 'POST /api/lb05/ask': return this.lb05.ask(session, (json as { question: string }).question)
      case 'GET /api/lb05/quota': return this.lb05.quota(session)
      case 'GET /api/lb05/semantic-layer': return this.lb05.semanticLayer()
      case 'GET /api/lb09/samples': return this.lb09.samples()
      case 'GET /api/lb09/limits': return this.lb09.limits(session)
      case 'POST /api/lb09/meetings': return this.lb09.start(session, json as StartMeetingRequest)
      case 'GET /api/lb09/meetings': return this.lb09.list(session)
      case 'GET /api/lb09/meetings/{meeting_id}': return this.lb09.get(session, params.meeting_id ?? '')
      case 'GET /api/lb09/meetings/{meeting_id}/transcript': return this.lb09.transcript(session, params.meeting_id ?? '')
      case 'GET /api/lb09/meetings/{meeting_id}/items': return this.lb09.items(session, params.meeting_id ?? '')
      case 'GET /api/lb09/meetings/{meeting_id}/export': return this.lb09.export(session, params.meeting_id ?? '', search.get('format'))
      default: return this.#lb08Handler(operation, params, session, json, search)
    }
  }

  /** Runs the handler written for one of LB-08's operations, if there is one. */
  #lb08Handler(operation: MockOperation, params: Record<string, string>, session: string, json: unknown, query: URLSearchParams): Answer | undefined {
    const id = params.id ?? ''
    switch (`${operation.method} ${operation.template}`) {
      case 'GET /api/lb08/catalogue': return this.lb08.catalogue()
      case 'GET /api/lb08/samples': return this.lb08.samples()
      case 'GET /api/lb08/limits': return this.lb08.limits(session)
      case 'POST /api/lb08/workflows': return this.lb08.createWorkflow(session, json as Parameters<Lb08Mock['createWorkflow']>[1])
      case 'GET /api/lb08/workflows': return this.lb08.listWorkflows(session)
      case 'GET /api/lb08/workflows/{id}': return this.lb08.getWorkflow(session, id)
      case 'PUT /api/lb08/workflows/{id}': return this.lb08.saveWorkflow(session, id, json as Parameters<Lb08Mock['saveWorkflow']>[2])
      case 'DELETE /api/lb08/workflows/{id}': return this.lb08.deleteWorkflow(session, id)
      case 'POST /api/lb08/workflows/{id}/runs': return this.lb08.startRun(session, id, json as Parameters<Lb08Mock['startRun']>[2])
      case 'GET /api/lb08/runs': return this.lb08.listRuns(session)
      case 'GET /api/lb08/runs/{id}': return this.lb08.getRun(session, id)
      case 'GET /api/lb08/runs/{id}/events': return this.lb08.runEvents(session, id, Number(query.get('after') ?? 0))
      case 'POST /api/lb08/runs/{id}/replay': return this.lb08.replayRun(session, id)
      case 'POST /api/lb08/runs/{id}/steps/{nodeId}/decision': return this.lb08.decide(session, id, params.nodeId ?? '', (json as { decision: 'approved' | 'rejected' }).decision)
      case 'GET /api/lb08/sent': return this.lb08.sent(session, query.get('rootRunId') ?? undefined)
      case 'GET /api/lb08/dead-letters': return this.lb08.deadLetters(session)
      case 'POST /api/lb08/dead-letters/{id}/replay': return this.lb08.replayDeadLetter(session, id)
      default: return undefined
    }
  }

  /**
   * The controls of a test for LB-09, at `/__mock/lb09/<action>`: `fail` makes the next meeting fail with a
   * reason (`{"reason": "too_long"}`), `drop` closes every open connection, `state` says how many are open.
   * They take JSON with POST, as LB-02's do, and the mock listens on the loopback address only.
   */
  #controlLb09(action: string, method: string, contentType: string | undefined, text: string, response: ServerResponse): void {
    if (method === 'GET' && action === 'state') return this.#send(response, 200, { openConnections: this.lb09.openConnections })
    if (method !== 'POST' || !contentType?.startsWith('application/json')) return this.#send(response, 415, errorAnswer(415, 'unsupported', 'Send JSON with POST.').body)
    let body: Record<string, unknown>
    try {
      body = text === '' ? {} : JSON.parse(text) as Record<string, unknown>
    }
    catch {
      return this.#send(response, 400, errorAnswer(400, 'invalid_request', 'The body is not JSON.').body)
    }
    if (action === 'fail') {
      try {
        this.lb09.failNext(String(body.reason))
      }
      catch {
        return this.#send(response, 400, errorAnswer(400, 'invalid_request', 'That is not a failure a meeting can have.').body)
      }
      return this.#send(response, 200, { ok: true })
    }
    if (action === 'drop') {
      // 1012 (service restart) is what a real restart sends; 1006 is never sent on the wire, and the socket library refuses it.
      this.lb09.dropAll(1012)
      return this.#send(response, 200, { ok: true })
    }
    return this.#send(response, 404, errorAnswer(404, 'not_found', 'There is no such control.').body)
  }

  /**
   * The controls of a test for LB-02, at `/__mock/lb02/<action>`: another visitor takes a slot, the clock
   * moves on, the calendar is reset, the connections drop, the turns being answered are lost (a restart), the
   * limits change. They take JSON, so a web page
   * on another origin cannot send one without a preflight the mock never answers, and the mock listens on
   * the loopback address only; the site's proxy forwards nothing outside the documents' routes.
   */
  #control(action: string, method: string, contentType: string | undefined, text: string, response: ServerResponse): void {
    const answer = this.#controlAnswer(action, method, contentType, text)
    this.#send(response, answer.status, answer.body)
  }

  /** Works out what a control answers. */
  #controlAnswer(action: string, method: string, contentType: string | undefined, text: string): Answer {
    const lb02 = this.lb02
    if (method === 'GET' && action === 'state') return { status: 200, body: { openConnections: lb02.hub.openConnections, conversations: lb02.hub.conversations.size, now: lb02.now() } }
    if (method !== 'POST' || !contentType?.startsWith('application/json')) return errorAnswer(415, 'unsupported', 'Send JSON with POST.')
    let body: Record<string, unknown>
    try {
      body = text === '' ? {} : JSON.parse(text) as Record<string, unknown>
    }
    catch {
      return errorAnswer(400, 'invalid_request', 'The body is not JSON.')
    }
    const done: Answer = { status: 200, body: { ok: true } }
    switch (action) {
      case 'other-visitor':
        return { status: 200, body: { ok: lb02.otherVisitor(body.action === 'holds' ? 'holds' : 'books', String(body.offering), Number(body.day), String(body.time)) } }
      case 'advance':
        lb02.advance(Number(body.minutes))
        return done
      case 'sweep':
        lb02.hub.sweep()
        return done
      case 'reset-calendar':
        lb02.hub.resetCalendar()
        return done
      case 'drop':
        lb02.hub.dropAll(typeof body.code === 'number' ? body.code : 1001)
        return done
      case 'lose-turns':
        lb02.hub.loseTurns()
        return done
      case 'limits':
        lb02.hub.configure(body)
        return done
      case 'reset':
        lb02.reset()
        return done
      default:
        return errorAnswer(404, 'not_found', 'There is no such control.')
    }
  }

  /** Makes the answer of an operation nobody wrote a handler for: an example of its first success status. */
  #example(operation: MockOperation): Answer {
    const status = this.#documents.successStatus(operation)
    return { status, body: this.#documents.exampleResponse(operation, status) }
  }

  /** Notes an answer that doesn't fit what its document says for that status. */
  #check(operation: MockOperation, answer: Answer): void {
    // A status the document doesn't describe (the mock's own 422 for a bad body) has nothing to be checked against.
    if (operation.operation.responses?.[String(answer.status)] === undefined) return
    const problems = this.#documents.checkResponse(operation, answer.status, answer.body)
    for (const problem of problems) this.violations.push(`${operation.method} ${operation.template} ${answer.status}: ${problem}`)
  }
}

/** Starts a mock back end on the loopback address. */
export async function startMockBackend(options: MockBackendOptions): Promise<MockBackend> {
  const site = new MockSite(options)
  const server: Server = createServer((request, response) => {
    site.handle(request, response).catch(() => {
      // A bug in the mock is a failed request for the test that hit it, never a crash.
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'mock_failure', message: 'The mock back end failed.' } }))
    })
  })
  const detachSockets = attachSockets(server, [
    { path: '/ws/lb02/', hub: site.lb02.hub, maxFrameBytes: LB02_MAX_FRAME_BYTES },
    { path: '/ws/lb09/', hub: site.lb09, maxFrameBytes: LB09_MAX_FRAME_BYTES },
  ])
  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests: site.requests,
    violations: site.violations,
    lb01: site.lb01,
    lb02: site.lb02,
    lb05: site.lb05,
    lb08: site.lb08,
    lb09: site.lb09,
    script: answer => site.script(answer),
    reset: () => site.reset(),
    close: () => new Promise<void>((resolve) => {
      detachSockets()
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
