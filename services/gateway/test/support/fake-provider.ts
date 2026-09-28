import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// A scripted OpenAI-compatible provider on a local port. Each request takes the next
// queued script, or the default one, and is recorded for assertions.

export type StreamStep = string | { comment: string } | { pauseMs: number }

export type Script
  = | { kind: 'json', status?: number, body: unknown, headers?: Record<string, string>, delayMs?: number }
    | { kind: 'stream', steps: StreamStep[], end?: 'finish' | 'drop' | 'hang', delayMs?: number }
    | { kind: 'hang' }

export interface Recorded {
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class FakeProvider {
  readonly requests: Recorded[] = []
  // Responses the gateway walked away from before they finished.
  abandoned = 0
  readonly #queue: Script[] = []
  readonly #server: Server
  #fallback: Script
  url = ''

  private constructor(fallback: Script) {
    this.#fallback = fallback
    this.#server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        this.requests.push({
          path: request.url ?? '',
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
        })
        response.on('close', () => {
          if (!response.writableFinished) this.abandoned += 1
        })
        void this.#respond(this.#queue.shift() ?? this.#fallback, response)
      })
    })
  }

  static async start(fallback: Script): Promise<FakeProvider> {
    const provider = new FakeProvider(fallback)
    await new Promise<void>(resolve => provider.#server.listen(0, '127.0.0.1', resolve))
    provider.url = `http://127.0.0.1:${(provider.#server.address() as AddressInfo).port}/v1`
    return provider
  }

  enqueue(...scripts: Script[]): void {
    this.#queue.push(...scripts)
  }

  setDefault(script: Script): void {
    this.#fallback = script
  }

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

  async close(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>(resolve => this.#server.close(() => resolve()))
  }
}

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

export function embeddings(count: number, usage = { prompt_tokens: 12 }): Record<string, unknown> {
  return {
    object: 'list',
    model: 'upstream-embedder',
    data: Array.from({ length: count }, (_, index) => ({ object: 'embedding', index, embedding: [0.1, 0.2, 0.3] })),
    usage: { ...usage, total_tokens: usage.prompt_tokens },
  }
}

export const answer = (content = 'Your order ships Monday.'): Script => ({ kind: 'json', body: completion(content) })
