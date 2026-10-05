// LB-06's WebSocket as the mock plays it: the real protocol over the mock's incidents. The first frame
// is a hello with the token and the incident; the answer is `ready` with the incident and the events
// after the one the page holds, then an `event` frame for every event the mock appends. The refusals
// are the real service's: no hello in time, a bad frame, a bad token, somebody else's incident, a
// second hello, too many connections from one visitor.
import type { Lb06Event } from '../../../contracts/src/index.ts'

import type { Lb06Mock } from './lb06.ts'
import type { Transport } from './lb02/hub.ts'

/** The path the real service listens on. */
export const LB06_SOCKET_PATH = '/ws/lb06/'
/** The close codes, the real service's. */
export const LB06_CLOSE = { unsupported: 1003, tooBig: 1009, unavailable: 1011, tryAgainLater: 1013, badFrame: 4400, unauthorized: 4401, notFound: 4404, timedOut: 4408 } as const
/** Connections one visitor may hold. */
const MAX_PER_VISITOR = 4

/** A connection to the mock's LB-06. */
export interface Lb06Connection {
  receive: (text: string) => void
  dispose: () => void
}

/** The hub: the connections to the mock's incidents. */
export class Lb06Hub {
  readonly #mock: Lb06Mock
  readonly #verify: (token: string) => string | undefined
  readonly #counts = new Map<string, number>()

  /** Makes the hub over the mock, with the site's token check. */
  constructor(mock: Lb06Mock, verify: (token: string) => string | undefined) {
    this.#mock = mock
    this.#verify = verify
  }

  /** Opens a connection over a transport. */
  open(transport: Transport): Lb06Connection {
    let said = false
    let visitor: string | undefined
    let stop: (() => void) | undefined
    let idle: ReturnType<typeof setTimeout> | undefined
    const { helloTimeoutMs, idleTimeoutMs } = this.#mock.socketOptions
    const helloTimer = setTimeout(() => transport.close(LB06_CLOSE.timedOut, 'no hello'), helloTimeoutMs)
    const armIdle = () => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => transport.close(LB06_CLOSE.timedOut, 'idle'), idleTimeoutMs)
    }
    const dispose = () => {
      clearTimeout(helloTimer)
      if (idle) clearTimeout(idle)
      stop?.()
      stop = undefined
      if (visitor !== undefined) {
        const held = this.#counts.get(visitor) ?? 1
        if (held <= 1) this.#counts.delete(visitor)
        else this.#counts.set(visitor, held - 1)
        visitor = undefined
      }
    }
    const send = (frame: unknown) => transport.send(JSON.stringify(frame))
    return {
      receive: (text) => {
        armIdle()
        if (said) {
          send({ type: 'error', code: 'already_said_hello' })
          return
        }
        let frame: { type?: unknown, token?: unknown, incident?: unknown, after?: unknown }
        try {
          frame = JSON.parse(text) as typeof frame
        }
        catch {
          transport.close(LB06_CLOSE.badFrame, 'not json')
          return
        }
        if (frame.type !== 'hello' || typeof frame.token !== 'string' || typeof frame.incident !== 'string') {
          transport.close(LB06_CLOSE.badFrame, 'not a hello')
          return
        }
        const session = this.#verify(frame.token)
        if (session === undefined) {
          transport.close(LB06_CLOSE.unauthorized, 'refused')
          return
        }
        const held = this.#counts.get(session) ?? 0
        if (held >= MAX_PER_VISITOR) {
          send({ type: 'error', code: 'too_many_connections' })
          transport.close(LB06_CLOSE.tryAgainLater, 'too many')
          return
        }
        this.#counts.set(session, held + 1)
        visitor = session
        const view = this.#mock.viewOf(session, frame.incident)
        if (!view) {
          transport.close(LB06_CLOSE.notFound, 'no such incident')
          return
        }
        said = true
        clearTimeout(helloTimer)
        const after = typeof frame.after === 'number' && Number.isInteger(frame.after) && frame.after >= 0 ? frame.after : 0
        const events = this.#mock.eventsAfter(session, frame.incident, after)
        send({ type: 'ready', incident: view, events })
        let last = Math.max(events.at(-1)?.seq ?? after, view.lastSeq)
        stop = this.#mock.listen(frame.incident, { send: (event: Lb06Event) => {
          if (event.seq <= last) return
          last = event.seq
          send({ type: 'event', event })
        } })
      },
      dispose,
    }
  }
}
