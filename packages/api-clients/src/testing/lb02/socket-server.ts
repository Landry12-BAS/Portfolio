// LB-02's WebSocket on a real port: the transport for the mock's hub (hub.ts). It accepts the upgrade
// at `/ws/lb02/` and nowhere else, refuses a frame over 4 KB with 1009 as the real service does
// (the `ws` library closes with that code by itself), refuses a binary frame with 1003, and hands every
// text frame to the connection, which decides what it means. Like the rest of the mock it is a test
// fixture, and the server it is attached to listens on the loopback address only.
import type { Server } from 'node:http'

import { WebSocketServer } from 'ws'

import { CLOSE, MAX_FRAME_BYTES } from './hub.ts'
import type { Lb02Hub } from './hub.ts'
import { LB06_SOCKET_PATH } from '../lb06-socket.ts'
import type { Lb06Hub } from '../lb06-socket.ts'

/** The path the real service listens on (services/django-systems/lb02/routing.py). */
export const SOCKET_PATH = '/ws/lb02/'

/** Starts accepting WebSocket upgrades on a server for LB-02's hub, and LB-06's when given. Returns a function that closes every socket and stops accepting. */
export function attachSockets(server: Server, hub: Lb02Hub, lb06?: Lb06Hub): () => void {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
  server.on('upgrade', (request, socket, head) => {
    const path = new URL(request.url ?? '/', 'http://mock.local').pathname
    if (path !== SOCKET_PATH && !(path === LB06_SOCKET_PATH && lb06)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const connection = (path === LB06_SOCKET_PATH && lb06 ? lb06 : hub).open({
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
    for (const client of sockets.clients) client.terminate()
    sockets.close()
  }
}
