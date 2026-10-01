// A scripted OpenAI-compatible model provider on a local port, for the contract tests. It
// answers chat completions from a queue of scripts, or with its default answer, and
// records every request, so a test can check exactly what the gateway forwarded.
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** How the fake answers one request: a JSON body with a status, or no answer at all. */
export type Script = { status?: number, body: unknown, headers?: Record<string, string> } | { hang: true }

/** A request the fake received: its path, headers and JSON body. */
export interface Recorded {
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

/** Builds a non-streamed chat completion with the given text and token usage. */
export function completion(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_790_000_000,
    model: 'upstream-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
  }
}

/** A fake provider: a local HTTP server that answers from scripts and records every request. */
export class FakeProvider {
  readonly requests: Recorded[] = []
  readonly #queue: Script[] = []
  readonly #server: Server
  readonly #fallback: Script
  // The base URL to put in the routing table, such as http://127.0.0.1:43215/v1.
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
        const script = this.#queue.shift() ?? this.#fallback
        if ('hang' in script) return
        response.writeHead(script.status ?? 200, { 'content-type': 'application/json', ...script.headers })
        response.end(JSON.stringify(script.body))
      })
    })
  }

  /** Starts a fake provider on a free local port, answering with `text` unless told otherwise. */
  static async start(text: string): Promise<FakeProvider> {
    const provider = new FakeProvider({ body: completion(text) })
    await new Promise<void>(resolve => provider.#server.listen(0, '127.0.0.1', resolve))
    provider.url = `http://127.0.0.1:${(provider.#server.address() as AddressInfo).port}/v1`
    return provider
  }

  /** Queues scripts for the next requests, in order; later requests get the default again. */
  enqueue(...scripts: Script[]): void {
    this.#queue.push(...scripts)
  }

  /** Queues a plain text answer for the next request. */
  answerNext(text: string): void {
    this.enqueue({ body: completion(text) })
  }

  /** Forgets queued scripts and recorded requests, so the next test starts clean. */
  reset(): void {
    this.#queue.length = 0
    this.requests.length = 0
  }

  /** Stops the server, closing any connection still open. */
  async close(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>(resolve => this.#server.close(() => resolve()))
  }
}
