// The mock's WebSockets on a real port: the transport for LB-02's conversation hub (hub.ts) at
// `/ws/lb02/` and for LB-09's meeting progress (../lb09.ts) at `/ws/lb09/`, and nowhere else. Each
// refuses a frame over the service's limit with 1009 as the real service does (the `ws` library closes
// with that code by itself), refuses a binary frame with 1003, and hands every text frame to the
// connection, which decides what it means. Like the rest of the mock it is a test fixture, and the
// server it is attached to listens on the loopback address only.
import type { Server } from 'node:http'

import { WebSocketServer } from 'ws'

import { CLOSE } from './hub.ts'

/** The path the real service listens on for LB-02 (services/django-systems/config/routing.py). */
export const SOCKET_PATH = '/ws/lb02/'

/** What a hub needs to be, to be served on a path: it opens a connection over a transport. */
export interface SocketHub {
  open: (transport: { send: (text: string) => void, close: (code: number, reason?: string) => void }) => { receive: (text: string) => void, dispose: () => void }
}

/** One path and the hub that answers it, with the longest frame it takes. */
export interface SocketRoute {
  path: string
  hub: SocketHub
  maxFrameBytes: number
}

/** Starts accepting WebSocket upgrades on a server, one hub a path. Returns a function that closes every socket and stops accepting. */
export function attachSockets(server: Server, routes: readonly SocketRoute[]): () => void {
  const servers = routes.map(route => ({ route, sockets: new WebSocketServer({ noServer: true, maxPayload: route.maxFrameBytes }) }))
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://mock.local').pathname
    const found = servers.find(candidate => candidate.route.path === path)
    if (!found) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    found.sockets.handleUpgrade(request, socket, head, (ws) => {
      const connection = found.route.hub.open({
        send: text => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
      })
      ws.on('message', (data, isBinary) => {
        if (isBinary) ws.close(CLOSE.unsupported)
        else connection.receive(data.toString('utf8'))
      })
      ws.on('close', () => connection.dispose())
      ws.on('error', () => connection.dispose())
    })
  })
  return () => {
    for (const { sockets } of servers) {
      for (const client of sockets.clients) client.terminate()
      sockets.close()
    }
  }
}
