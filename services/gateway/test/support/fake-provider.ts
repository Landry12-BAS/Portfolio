// A scripted OpenAI-compatible provider on a local port, for the integration tests.
// Each request takes the next queued script, or the default one, and is recorded so
// tests can check exactly what the gateway sent.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One step of a scripted stream: an event's data, an SSE comment, or a pause. */
export type StreamStep = string | { comment: string } | { pauseMs: number }

/**
 * How the fake answers one request: a JSON response, a stream of events that can end
 * cleanly, drop the connection or hang, or no answer at all.
 */
export type Script
  = | { kind: 'json', status?: number, body: unknown, headers?: Record<string, string>, delayMs?: number }
    | { kind: 'stream', steps: StreamStep[], end?: 'finish' | 'drop' | 'hang', delayMs?: number }
    | { kind: 'hang' }

/** The parts of a multipart request: its text fields, and what the one file was (its bytes are summarised, never kept). */
export interface RecordedForm {
  fields: Record<string, string>
  file?: { name: string, type: string, size: number, sha256: string }
}

/** A request the fake received: its path, headers and JSON body, or, for a multipart request, its form. */
export interface Recorded {
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
  form?: RecordedForm
}

/** Reads a multipart body into its fields and a summary of its file. */
async function readForm(raw: Buffer, contentType: string): Promise<RecordedForm> {
  const data = await new Response(raw, { headers: { 'content-type': contentType } }).formData()
  const form: RecordedForm = { fields: {} }
  for (const [name, value] of data.entries()) {
    if (typeof value === 'string') {
      form.fields[name] = value
    }
    else {
      const bytes = Buffer.from(await value.arrayBuffer())
      form.file = { name: value.name, type: value.type, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
  }
  return form
}

/** Reads a request's whole body. */
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** Waits for the given number of milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A fake provider: a local HTTP server that answers from scripts and records every request. */
export class FakeProvider {
  readonly requests: Recorded[] = []
  // Responses the gateway walked away from before they finished.
  abandoned = 0
  readonly #queue: Script[] = []
  readonly #server: Server
  #fallback: Script
  // The base URL to put in the routing table, such as http://127.0.0.1:43215/v1.
  url = ''

  private constructor(fallback: Script) {
    this.#fallback = fallback
    this.#server = createServer((request, response) => {
      void this.#receive(request, response)
    })
  }

  /** Starts a fake provider on a free local port, answering with `fallback` unless told otherwise. */
  static async start(fallback: Script): Promise<FakeProvider> {
    const provider = new FakeProvider(fallback)
    await new Promise<void>(resolve => provider.#server.listen(0, '127.0.0.1', resolve))
    provider.url = `http://127.0.0.1:${(provider.#server.address() as AddressInfo).port}/v1`
    return provider
  }

  /** Queues scripts for the next requests, in order; later requests get the default again. */
  enqueue(...scripts: Script[]): void {
    this.#queue.push(...scripts)
  }

  /** Changes the answer given when the queue is empty. */
  setDefault(script: Script): void {
    this.#fallback = script
  }

  /** Forgets queued scripts and recorded requests, so the next test starts clean. */
  reset(): void {
    this.#queue.length = 0
    this.requests.length = 0
    this.abandoned = 0
  }

  /** Records one request, JSON or multipart, and answers it from the next script. */
  async #receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const raw = await readBody(request)
    const type = request.headers['content-type'] ?? ''
    const recorded: Recorded = { path: request.url ?? '', headers: request.headers, body: {} }
    if (type.startsWith('multipart/form-data')) recorded.form = await readForm(raw, type)
    else recorded.body = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>
    this.requests.push(recorded)
    response.on('close', () => {
      if (!response.writableFinished) this.abandoned += 1
    })
    await this.#respond(this.#queue.shift() ?? this.#fallback, response)
  }

  /** Plays one script on one response. */
  async #respond(script: Script, response: ServerResponse): Promise<void> {
    if (script.kind === 'hang') return
    if (script.delayMs) await pause(script.delayMs)
    if (response.destroyed) return
    if (script.kind === 'json') {
      response.writeHead(script.status ?? 200, { 'content-type': 'application/json', ...script.headers })
      response.end(JSON.stringify(script.body))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const step of script.steps) {
      if (response.destroyed) return
      if (typeof step === 'string') response.write(`data: ${step}\n\n`)
      else if ('comment' in step) response.write(`: ${step.comment}\n\n`)
      else await pause(step.pauseMs)
    }
    if (script.end === 'drop') response.destroy()
    else if (script.end !== 'hang') response.end()
  }

  /** Stops the server, closing any connection still open. */
  async close(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>(resolve => this.#server.close(() => resolve()))
  }
}

/** Builds a non-streamed chat completion with the given text and token usage. */
export function completion(content: string, usage = { prompt_tokens: 20, completion_tokens: 8 }): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_790_000_000,
    model: 'upstream-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  }
}

/** Builds one streamed chunk (as JSON text) carrying a piece of the answer. */
export function chunk(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1_790_000_000,
    model: 'upstream-model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
    ...extra,
  })
}

/** Builds an embeddings answer with one small vector per input. */
export function embeddings(count: number, usage = { prompt_tokens: 12 }): Record<string, unknown> {
  return {
    object: 'list',
    model: 'upstream-embedder',
    data: Array.from({ length: count }, (_, index) => ({ object: 'embedding', index, embedding: [0.1, 0.2, 0.3] })),
    usage: { ...usage, total_tokens: usage.prompt_tokens },
  }
}

/** A script that answers with a successful chat completion. */
export const answer = (content = 'Your order ships Monday.'): Script => ({ kind: 'json', body: completion(content) })

/**
 * Builds a Workers AI rerank answer: raw scores for the contexts, listed in the order
 * given as [index, score] pairs, inside Cloudflare's success envelope.
 */
export function reranked(scores: [number, number][]): Record<string, unknown> {
  return {
    result: { response: scores.map(([id, score]) => ({ id, score })) },
    success: true,
    errors: [],
    messages: [],
  }
}

/** A script that answers a guard request with the classifier's text, such as `0.0002` or `MALICIOUS`. */
export const guardAnswer = (content: string, promptTokens = 40): Script => ({
  kind: 'json',
  body: completion(content, { prompt_tokens: promptTokens, completion_tokens: 2 }),
})

/** A segment as Groq's `verbose_json` reports it, with the fields the gateway ignores. */
export function groqSegment(id: number, start: number, end: number, text: string): Record<string, unknown> {
  return { id, seek: 0, start, end, text: ` ${text}`, tokens: [1, 2, 3], temperature: 0, avg_logprob: -0.2, compression_ratio: 1.2, no_speech_prob: 0.01 }
}

/** Builds a Groq-style `verbose_json` transcription of the given segments. */
export function groqTranscription(segments: [number, number, string][], language = 'English'): Record<string, unknown> {
  return {
    task: 'transcribe',
    language,
    duration: 5,
    text: segments.map(([, , text]) => ` ${text}`).join(''),
    segments: segments.map(([start, end, text], id) => groqSegment(id, start, end, text)),
    x_groq: { id: 'req_test' },
  }
}

/** Builds Workers AI's answer to a Whisper request: the same speech, inside Cloudflare's envelope. */
export function workersTranscription(segments: [number, number, string][], language = 'en'): Record<string, unknown> {
  return {
    result: {
      text: segments.map(([, , text]) => text).join(' '),
      word_count: 3,
      segments: segments.map(([start, end, text]) => ({ start, end, text, temperature: 0, avg_logprob: -0.3, compression_ratio: 1.1, no_speech_prob: 0.02, words: [] })),
      transcription_info: { language, language_probability: 0.99, duration: 5, duration_after_vad: 5 },
      vtt: 'WEBVTT',
    },
    success: true,
    errors: [],
    messages: [],
  }
}
