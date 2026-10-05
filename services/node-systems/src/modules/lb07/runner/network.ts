// The sandbox's network rules inside the browser, below the plan's own check (guard.ts), as two layers that each
// hold on their own:
//
//   - interception (the second layer): every HTTP request any page of the context makes goes on only to the shop's
//     origin, every WebSocket is refused, and each refusal is recorded as a blocked navigation. It is Playwright's
//     request routing, which sees every request a page starts, but by its own documented design not the second hop
//     of a redirect, and nothing that is not HTTP (WebRTC's UDP);
//   - the browser's own network (the third layer): Chromium is started with a proxy for everything but the shop,
//     and that proxy is a dead end in this process that closes every connection at once; it resolves no host name;
//     and WebRTC may use no UDP the proxy does not carry, which is none. So a redirect hop, a socket or a STUN packet
//     that interception does not see still goes nowhere, and the address of anything else the container could reach
//     (the runner's own API, the worker, a cloud metadata address) is never dialled.
//
// The container's network is the wall around both (docs and README, "Threat model of LB-07").
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'

import type { BrowserContext } from 'playwright-core'

import { FindingCollector } from './findings.ts'

/** The origin of an address, or undefined for one that is not a URL: a request whose origin cannot be read is refused. */
export function originOf(href: string): string | undefined {
  try {
    return new URL(href).origin
  }
  catch {
    return undefined
  }
}

/**
 * Puts the second layer on a browser context: an HTTP request goes on only when its origin is the shop's, and a
 * WebSocket never connects (the shop has none). Each refusal becomes a blocked-navigation finding that names the
 * scheme and host it was for, never its path or query.
 */
export async function interceptRequests(context: BrowserContext, shopOrigin: string, findings: FindingCollector): Promise<void> {
  await context.route('**/*', async (route) => {
    const url = route.request().url()
    if (originOf(url) === shopOrigin) {
      await route.continue()
      return
    }
    findings.blockedNavigation(FindingCollector.targetOf(url), 'request')
    await route.abort('blockedbyclient')
  })
  await context.routeWebSocket(() => true, async (socket) => {
    findings.blockedNavigation(FindingCollector.targetOf(socket.url()), 'socket')
    await socket.close({ code: 1008, reason: 'The sandbox refuses every socket.' })
  })
}

// Where the dead end listens: the loopback address, which the resolver rules must leave alone so the proxy can be reached.
const DEAD_END_HOST = '127.0.0.1'

/** A listener on the loopback interface that closes every connection the moment it arrives: the proxy that goes nowhere. */
export class DeadEnd {
  #server: Server | undefined
  #port: number | undefined

  /** Starts listening on a free loopback port, once, and returns it. */
  async start(): Promise<number> {
    if (this.#port !== undefined) return this.#port
    const server = createServer((socket: Socket) => {
      socket.destroy()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, DEAD_END_HOST, () => resolve())
    })
    server.unref()
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('The dead end has no port.')
    this.#server = server
    this.#port = address.port
    return address.port
  }

  /** Stops listening. */
  async close(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    this.#port = undefined
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

/**
 * The Chromium switches of the third layer, for a shop at `shopOrigin` and the dead end at `deadEndPort`: every
 * request but the shop's goes to the dead end (`<-loopback>` first, so even the loopback interface is no exception
 * but for the shop's own host and port), no host resolves but the shop's and the dead end's (the rules map
 * addresses written as numbers too), and WebRTC sends no UDP of its own.
 */
export function networkWallArgs(shopOrigin: string, deadEndPort: number): string[] {
  const shop = new URL(shopOrigin)
  // The port is always named, so the bypass is the shop's one port and never every port of its host.
  const port = shop.port === '' ? (shop.protocol === 'https:' ? '443' : '80') : shop.port
  const excluded = [...new Set([shop.hostname, DEAD_END_HOST])].map(host => `EXCLUDE ${host}`).join(' , ')
  const resolverRules = `MAP * ~NOTFOUND , ${excluded}`
  return [
    `--proxy-server=http://${DEAD_END_HOST}:${deadEndPort}`,
    `--proxy-bypass-list=<-loopback>;${shop.hostname}:${port}`,
    `--host-resolver-rules=${resolverRules}`,
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  ]
}
