// Tests of LB-02's service worker (public/lb02-sw.js), run as the browser would run it: the script is
// evaluated in an empty sandbox that holds only what a worker has (a `self`, `caches`, `fetch` and the
// web's request, response and address types), and the fetch events it listens for are fired by hand.
// What matters most is what it must never do: answer or keep an API call, a token, a conversation, a
// non-GET request, another site's file, or a page other than the board's. The last test plays a whole
// visit of mixed traffic and then lists everything the worker kept.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import { beforeEach, describe, expect, it } from 'vitest'

const SOURCE = readFileSync(fileURLToPath(new URL('../../public/lb02-sw.js', import.meta.url)), 'utf8')
const ORIGIN = 'https://site.test'

/** The part of a request the worker looks at. A real navigation cannot be built by hand, so the test builds what the worker reads. */
interface FakeRequest {
  method: string
  url: string
  mode: 'navigate' | 'cors' | 'no-cors'
}

/** Makes a response of a given type. A response made by hand is of type `default`; one fetched from the site's own origin is `basic`. */
function response(body: string, init: ResponseInit = {}, type: 'basic' | 'cors' | 'opaque' = 'basic'): Response {
  const made = new Response(body, init)
  Object.defineProperty(made, 'type', { value: type })
  return made
}

/** Makes a request for a path on the site (or a full address). */
function request(path: string, init: Partial<FakeRequest> = {}): FakeRequest {
  return { method: 'GET', url: path.startsWith('http') ? path : `${ORIGIN}${path}`, mode: 'cors', ...init }
}

/** A cache of responses by address, like the browser's. */
class FakeCache {
  readonly entries = new Map<string, Response>()

  /** Keeps a response. */
  put(key: FakeRequest | string, response: Response): Promise<void> {
    this.entries.set(FakeCache.address(key), response)
    return Promise.resolve()
  }

  /** Fetches an address from the site's network and keeps the answer. */
  async add(key: string): Promise<void> {
    this.entries.set(FakeCache.address(key), response(`kept ${key}`))
  }

  /** Finds a copy of a response. */
  match(key: FakeRequest | string): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(FakeCache.address(key))?.clone())
  }

  /** Lists the requests kept, oldest first. */
  keys(): Promise<{ url: string }[]> {
    return Promise.resolve([...this.entries.keys()].map(url => ({ url })))
  }

  /** Removes a response. */
  delete(key: { url: string } | string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(FakeCache.address(key)))
  }

  /** Writes the full address of a request or a path. */
  static address(key: { url: string } | string): string {
    const text = typeof key === 'string' ? key : key.url
    return new URL(text, ORIGIN).toString()
  }
}

/** The browser's cache storage: named caches. */
class FakeCaches {
  readonly stores = new Map<string, FakeCache>()

  /** Opens a cache, making it when it is new. */
  open(name: string): Promise<FakeCache> {
    let store = this.stores.get(name)
    if (!store) {
      store = new FakeCache()
      this.stores.set(name, store)
    }
    return Promise.resolve(store)
  }

  /** Finds a response in one cache, or in any. */
  async match(key: FakeRequest | string, options: { cacheName?: string } = {}): Promise<Response | undefined> {
    const stores = options.cacheName ? [this.stores.get(options.cacheName)] : [...this.stores.values()]
    for (const store of stores) {
      const found = await store?.match(key)
      if (found) return found
    }
    return undefined
  }

  /** Lists the names of the caches. */
  keys(): Promise<string[]> {
    return Promise.resolve([...this.stores.keys()])
  }

  /** Removes a cache. */
  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.delete(name))
  }
}

/** A fetch event, which remembers what the worker answered with. */
class FakeFetchEvent {
  readonly request: FakeRequest
  answer: Promise<Response> | undefined

  constructor(request: FakeRequest) {
    this.request = request
  }

  /** The worker takes the request over. */
  respondWith(answer: Promise<Response>): void {
    this.answer = answer
  }
}

/** A worker running in a sandbox, with the network under the test's control. */
class Worker {
  readonly caches = new FakeCaches()
  readonly listeners = new Map<string, (event: never) => void>()
  readonly requested: string[] = []
  online = true
  skipped = false
  // The answers the network gives, by address; any other address answers 404.
  readonly network = new Map<string, () => Response>()

  constructor(scope = `${ORIGIN}/systems/lb-02/`) {
    const self = {
      location: new URL(`${ORIGIN}/lb02-sw.js`),
      registration: { scope },
      addEventListener: (type: string, listener: (event: never) => void) => this.listeners.set(type, listener),
      skipWaiting: () => {
        this.skipped = true
        return Promise.resolve()
      },
    }
    runInNewContext(SOURCE, {
      self,
      caches: this.caches,
      URL,
      Response,
      fetch: (input: FakeRequest) => this.fetch(input),
    })
  }

  /** The network: answers from the table, fails when offline, and notes what was asked. */
  fetch(input: FakeRequest): Promise<Response> {
    this.requested.push(input.url)
    if (!this.online) return Promise.reject(new TypeError('Failed to fetch'))
    const answer = this.network.get(new URL(input.url).pathname + new URL(input.url).search)
    return Promise.resolve(answer ? answer() : response('not found', { status: 404 }))
  }

  /** Fires an install event and waits for the worker to finish. */
  async install(): Promise<void> {
    await this.#dispatch('install')
  }

  /** Fires an activate event and waits for the worker to finish. */
  async activate(): Promise<void> {
    await this.#dispatch('activate')
  }

  /** Fires an event that carries `waitUntil`. */
  async #dispatch(type: string): Promise<void> {
    const waits: Promise<unknown>[] = []
    this.listeners.get(type)?.({ waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as never)
    await Promise.all(waits)
  }

  /** Fires a fetch event; returns the answer if the worker took the request over, or undefined if it left it to the network. */
  async fetchEvent(input: FakeRequest): Promise<Response | undefined> {
    const event = new FakeFetchEvent(input)
    this.listeners.get('fetch')?.(event as never)
    return event.answer
  }
}

/** A plain successful answer. */
const ok = (body: string, headers: Record<string, string> = {}) => () => response(body, { status: 200, headers })

describe('LB-02\'s service worker', () => {
  let worker: Worker

  beforeEach(() => {
    worker = new Worker()
  })

  describe('what it leaves alone', () => {
    it.each([
      ['an API call', '/api/lb02/calendar'],
      ['the visitor\'s conversations', '/api/lb02/conversations'],
      ['the token route', '/api/tokens/lb-02'],
      ['a recording', '/api/recordings/lb-02/book-cupping-en'],
      ['the session', '/api/session'],
      ['a page that is not the board', '/systems/lb-02'],
      ['the home page', '/'],
      ['a file nobody listed', '/robots.txt'],
      ['the build\'s pointer to its latest version', '/_nuxt/builds/latest.json'],
    ])('does not answer %s', async (_name, path) => {
      worker.network.set(path, ok('{}'))
      expect(await worker.fetchEvent(request(path))).toBeUndefined()
      expect(await worker.fetchEvent(request(path, { mode: 'navigate' }))).toBeUndefined()
      expect(worker.caches.stores.size).toBe(0)
    })

    it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('does not answer a %s request, even to a file it keeps', async (method) => {
      expect(await worker.fetchEvent(request('/_nuxt/entry.abc123.js', { method }))).toBeUndefined()
      expect(await worker.fetchEvent(request('/systems/lb-02/board', { method, mode: 'navigate' }))).toBeUndefined()
      expect(worker.caches.stores.size).toBe(0)
    })

    it('does not answer another site\'s files, the API\'s host or a WebSocket address', async () => {
      for (const address of ['https://challenges.cloudflare.com/turnstile/v0/api.js', 'https://api.site.test/api/lb02/calendar', 'https://other.test/_nuxt/entry.abc123.js', 'wss://api.site.test/ws/lb02/']) {
        expect(await worker.fetchEvent(request(address))).toBeUndefined()
      }
      expect(worker.caches.stores.size).toBe(0)
    })

    it('does not keep a board page that has a query', async () => {
      worker.network.set('/systems/lb-02/board?token=secret', ok('page'))
      const answer = await worker.fetchEvent(request('/systems/lb-02/board?token=secret', { mode: 'navigate' }))
      expect(answer).toBeUndefined()
      expect(worker.caches.stores.size).toBe(0)
    })

    it('refuses a path under /api/ even when its name looks like a file it keeps', async () => {
      for (const path of ['/api/_nuxt/entry.js', '/api/lb02-icon.svg', '/api/lb02.en.webmanifest']) {
        worker.network.set(path, ok('x'))
        expect(await worker.fetchEvent(request(path))).toBeUndefined()
      }
      expect(worker.caches.stores.size).toBe(0)
    })
  })

  describe('the board\'s page', () => {
    it('takes it from the network when there is one, and keeps a copy', async () => {
      worker.network.set('/systems/lb-02/board', ok('fresh page'))
      const answer = await worker.fetchEvent(request('/systems/lb-02/board', { mode: 'navigate' }))
      expect(await answer?.text()).toBe('fresh page')
      const kept = await worker.caches.match('/systems/lb-02/board', { cacheName: 'lb02-shell-v1' })
      expect(await kept?.text()).toBe('fresh page')
    })

    it('serves the copy it kept when the network fails', async () => {
      worker.network.set('/systems/lb-02/board', ok('old page'))
      await worker.fetchEvent(request('/systems/lb-02/board', { mode: 'navigate' }))
      worker.online = false
      const answer = await worker.fetchEvent(request('/systems/lb-02/board', { mode: 'navigate' }))
      expect(await answer?.text()).toBe('old page')
    })

    it('prefers the network to its copy, so a visitor online sees the current page', async () => {
      worker.network.set('/systems/lb-02/board', ok('first'))
      await worker.fetchEvent(request('/systems/lb-02/board', { mode: 'navigate' }))
      worker.network.set('/systems/lb-02/board', ok('second'))
      const answer = await worker.fetchEvent(request('/systems/lb-02/board', { mode: 'navigate' }))
      expect(await answer?.text()).toBe('second')
      const kept = await worker.caches.match('/systems/lb-02/board', { cacheName: 'lb02-shell-v1' })
      expect(await kept?.text()).toBe('second')
    })

    it('keeps the Czech page too, as a page of its own', async () => {
      worker.network.set('/cs/systems/lb-02/board', ok('cesky'))
      await worker.fetchEvent(request('/cs/systems/lb-02/board', { mode: 'navigate' }))
      expect((await worker.caches.stores.get('lb02-shell-v1')?.keys())?.map(key => new URL(key.url).pathname)).toEqual(['/cs/systems/lb-02/board'])
    })

    it('does not keep an error, an answer that asks not to be stored, or an answer that is not a plain one', async () => {
      worker.network.set('/systems/lb-02/board', () => response('down', { status: 503 }))
      const failed = await worker.fetchEvent(request('/systems/lb-02/board', { mode: 'navigate' }))
      expect(failed?.status).toBe(503)
      worker.network.set('/systems/lb-02/board', ok('private', { 'cache-control': 'private, no-store' }))
      await worker.fetchEvent(request('/systems/lb-02/board', { mode: 'navigate' }))
      worker.network.set('/systems/lb-02/board', () => response('other', { status: 200 }, 'opaque'))
      await worker.fetchEvent(request('/systems/lb-02/board', { mode: 'navigate' }))
      worker.network.set('/systems/lb-02/board', () => response('relayed', { status: 200 }, 'cors'))
      await worker.fetchEvent(request('/systems/lb-02/board', { mode: 'navigate' }))
      expect((await worker.caches.stores.get('lb02-shell-v1')?.keys())?.length ?? 0).toBe(0)
    })

    it('shows the offline page, in the language of its part of the site, when there is no connection and no copy', async () => {
      await worker.install()
      worker.online = false
      const answer = await worker.fetchEvent(request('/systems/lb-02/board', { mode: 'navigate' }))
      expect(await answer?.text()).toBe('kept /lb02-offline.en.html')
      const czech = new Worker(`${ORIGIN}/cs/systems/lb-02/`)
      await czech.install()
      czech.online = false
      const odpoved = await czech.fetchEvent(request('/cs/systems/lb-02/board', { mode: 'navigate' }))
      expect(await odpoved?.text()).toBe('kept /lb02-offline.cs.html')
    })

    it('fails like the network when there is no copy and no offline page either', async () => {
      worker.online = false
      const answer = await worker.fetchEvent(request('/systems/lb-02/board', { mode: 'navigate' }))
      expect(answer?.type).toBe('error')
    })
  })

  describe('static files', () => {
    it('takes a file from the network once and from the device after that', async () => {
      worker.network.set('/_nuxt/entry.abc123.js', ok('script'))
      expect(await (await worker.fetchEvent(request('/_nuxt/entry.abc123.js')))?.text()).toBe('script')
      worker.online = false
      expect(await (await worker.fetchEvent(request('/_nuxt/entry.abc123.js')))?.text()).toBe('script')
      expect(worker.requested).toHaveLength(1)
    })

    it('keeps the record of one build, which that build names, but not the pointer to the latest', async () => {
      worker.network.set('/_nuxt/builds/meta/abc-123.json', ok('{}'))
      expect(await (await worker.fetchEvent(request('/_nuxt/builds/meta/abc-123.json')))?.text()).toBe('{}')
      expect(worker.caches.stores.get('lb02-shell-v1')?.entries.size).toBe(1)
    })

    it('keeps the app\'s icon and both manifests', async () => {
      for (const path of ['/lb02-icon.svg', '/lb02.en.webmanifest', '/lb02.cs.webmanifest']) {
        worker.network.set(path, ok(path))
        expect(await (await worker.fetchEvent(request(path)))?.text()).toBe(path)
      }
      expect(worker.caches.stores.get('lb02-shell-v1')?.entries.size).toBe(3)
    })

    it('does not keep a file that failed to load', async () => {
      const answer = await worker.fetchEvent(request('/_nuxt/missing.js'))
      expect(answer?.status).toBe(404)
      expect(worker.caches.stores.get('lb02-shell-v1')?.entries.size ?? 0).toBe(0)
    })

    it('keeps at most 80 files, dropping the oldest first, and never the offline page', async () => {
      await worker.install()
      for (let index = 0; index < 100; index += 1) {
        worker.network.set(`/_nuxt/chunk.${index}.js`, ok(`chunk ${index}`))
        await worker.fetchEvent(request(`/_nuxt/chunk.${index}.js`))
      }
      const names = (await worker.caches.stores.get('lb02-shell-v1')?.keys())?.map(key => new URL(key.url).pathname) ?? []
      expect(names).toHaveLength(80)
      expect(names[0]).toBe('/_nuxt/chunk.20.js')
      expect(names.at(-1)).toBe('/_nuxt/chunk.99.js')
      expect(await worker.caches.match('/lb02-offline.en.html', { cacheName: 'lb02-offline-v1' })).toBeDefined()
    })
  })

  describe('its life', () => {
    it('keeps the offline page when it is installed, and starts working at once without taking over open pages', async () => {
      await worker.install()
      expect(worker.skipped).toBe(true)
      expect(await worker.caches.match('/lb02-offline.en.html', { cacheName: 'lb02-offline-v1' })).toBeDefined()
      expect(worker.listeners.has('message')).toBe(false)
    })

    it('removes the caches of older versions of itself and leaves other caches alone', async () => {
      await worker.caches.open('lb02-shell-v0')
      await worker.caches.open('lb02-offline-v0')
      await worker.caches.open('something-else')
      await worker.caches.open('lb02-shell-v1')
      await worker.activate()
      expect([...worker.caches.stores.keys()].sort()).toEqual(['lb02-shell-v1', 'something-else'])
    })
  })

  it('keeps nothing but the board\'s pages and static files after a whole visit of mixed traffic', async () => {
    const files = ['/_nuxt/entry.a1.js', '/_nuxt/Lb02Board.b2.js', '/_nuxt/archivo.c3.woff2', '/lb02-icon.svg']
    for (const path of [...files, '/systems/lb-02/board', '/api/session', '/api/lb02/calendar', '/api/lb02/conversations/abc', '/api/tokens/lb-02', '/api/recordings/lb-02/x']) worker.network.set(path, ok(`body of ${path}`, { 'set-cookie': 'a=b' }))
    await worker.install()
    const traffic: FakeRequest[] = [
      request('/systems/lb-02/board', { mode: 'navigate' }),
      ...files.map(path => request(path)),
      request('/api/session'),
      request('/api/lb02/calendar?conversation=abc'),
      request('/api/lb02/conversations/abc'),
      request('/api/lb02/conversations', { method: 'POST' }),
      request('/api/tokens/lb-02', { method: 'POST' }),
      request('/api/recordings/lb-02/x'),
      request('https://api.site.test/api/lb02/calendar'),
      request('wss://api.site.test/ws/lb02/'),
    ]
    for (const item of traffic) await worker.fetchEvent(item)
    const kept: string[] = []
    for (const store of worker.caches.stores.values()) {
      for (const key of await store.keys()) kept.push(new URL(key.url).pathname)
    }
    expect(kept.sort()).toEqual(['/_nuxt/Lb02Board.b2.js', '/_nuxt/archivo.c3.woff2', '/_nuxt/entry.a1.js', '/lb02-icon.svg', '/lb02-offline.en.html', '/systems/lb-02/board'].sort())
    expect(kept.some(path => path.startsWith('/api/'))).toBe(false)
  })
})
