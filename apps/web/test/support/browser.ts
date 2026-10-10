// A stand-in for a visitor's browser in the integration tests: it keeps the cookies the site
// sets and sends them back, sends the Origin header a browser sends with a request that changes
// something, and records every Set-Cookie the site ever sent, so a test can look at their flags.
import type { TestSite } from './site-app.ts'

/** What a request came back with. */
export interface Reply {
  status: number
  // The body as text, and as JSON when it is JSON (undefined when it is not).
  text: string
  json: any // eslint-disable-line @typescript-eslint/no-explicit-any
  // The body as the bytes it is: what to read for an answer that is a file.
  bytes: Uint8Array
  headers: Headers
}

/** A file to send, as a browser's form sends one. */
export interface UploadFile {
  filename: string
  bytes: Uint8Array
  // The type the browser guesses from the name. The service never trusts it, so a test may make it lie.
  type?: string
  // The form field's name: `file`, which is the one the service reads, unless a test sends another.
  field?: string
}

/** Options for one request. */
export interface RequestOptions {
  // A JSON body.
  body?: unknown
  // A file, sent as a multipart form: the boundary and the content type are made as a browser makes them.
  upload?: UploadFile
  // A body sent exactly as given, with the content type given: for requests that are not valid JSON.
  raw?: { text: string, type?: string }
  // Headers to add, or to replace (a header set to undefined is left out).
  headers?: Record<string, string | undefined>
  // The Origin to send: this site's by default for a request that changes something, nothing with `null`.
  origin?: string | null
}

/** A visitor's browser, with its own cookie jar. */
export class Browser {
  readonly site: TestSite
  // The cookies it holds, by name.
  readonly cookies = new Map<string, string>()
  // Every Set-Cookie line the site sent it, oldest first.
  readonly setCookies: string[] = []

  constructor(site: TestSite) {
    this.site = site
  }

  /** Sends a request to the site as a same-origin fetch from its own page would. */
  async request(method: string, path: string, options: RequestOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = { accept: 'application/json' }
    const jar = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (jar !== '') headers.cookie = jar
    const origin = options.origin === undefined ? (method === 'GET' ? null : this.site.origin) : options.origin
    if (origin !== null) headers.origin = origin
    let body: string | FormData | undefined
    if (options.body !== undefined) {
      body = JSON.stringify(options.body)
      headers['content-type'] = 'application/json'
    }
    if (options.upload) {
      // No content type is set: `fetch` writes `multipart/form-data` with the boundary it chose, as a browser does.
      body = new FormData()
      body.append(options.upload.field ?? 'file', new Blob([new Uint8Array(options.upload.bytes)], { type: options.upload.type ?? 'application/octet-stream' }), options.upload.filename)
    }
    if (options.raw) {
      body = options.raw.text
      headers['content-type'] = options.raw.type ?? 'application/json'
    }
    const overrides = Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value] as const)
    const replaced = new Set(overrides.map(([name]) => name))
    const sent = Object.fromEntries([...Object.entries(headers).filter(([name]) => !replaced.has(name)), ...overrides.filter((entry): entry is [string, string] => entry[1] !== undefined)])
    const response = await fetch(`${this.site.url}${path}`, { method, headers: sent, body, redirect: 'manual' })
    for (const line of response.headers.getSetCookie()) {
      this.setCookies.push(line)
      const [pair = ''] = line.split(';')
      const separator = pair.indexOf('=')
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    let json: unknown
    try {
      json = JSON.parse(text)
    }
    catch {
      json = undefined
    }
    return { status: response.status, text, json, bytes, headers: response.headers }
  }

  /** Reads the session cookie's value, or undefined when there is none. */
  get session(): string | undefined {
    return this.cookies.get('__Host-lb_session')
  }

  /** Passes the Turnstile check, as the browser's widget and the verify route do together. */
  async verify(token = 'a-token-from-the-widget'): Promise<Reply> {
    return this.request('POST', '/api/session/verify', { body: { token } })
  }
}
