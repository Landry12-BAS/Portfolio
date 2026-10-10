// Sends a request over a plain socket, exactly as written: a path a fetch would tidy up
// (`/api/lb01/%2e%2e/x` is normalised away by any client's URL parser), a body with no length, or
// two length headers at once. The proxy tests use it for the requests an attacker would send,
// which a well-behaved client never does.
import { request } from 'node:http'

/** What a raw request came back with. */
export interface RawReply {
  status: number
  text: string
  headers: Record<string, string | string[] | undefined>
}

/** Options for a raw request. */
export interface RawOptions {
  method?: string
  // Header lines exactly as given, name to value.
  headers?: Record<string, string>
  // The body, written in the chunks given, with no length header unless `headers` has one.
  chunks?: string[]
}

/** Sends one request to a local server and reads the whole answer. Rejects when the server closes the connection without one. */
export function rawRequest(url: string, path: string, options: RawOptions = {}): Promise<RawReply> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: target.hostname, port: target.port, path, method: options.method ?? 'GET', headers: options.headers, setHost: true }, (response) => {
      const parts: Buffer[] = []
      response.on('data', (part: Buffer) => parts.push(part))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8'), headers: response.headers }))
    })
    outgoing.on('error', reject)
    for (const chunk of options.chunks ?? []) outgoing.write(chunk)
    outgoing.end()
  })
}
