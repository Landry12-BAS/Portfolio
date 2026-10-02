// What the codes a WebSocket closes with mean for LB-02's page. The server uses the standard codes
// where one fits and codes of its own from 4400 up (lb02/events.py, CloseCode, and the "LB-02
// WebSocket" section of services/django-systems/README.md); the network and the edge add the rest
// (1006 for a connection that dropped, 1001 for a server going away). Each code becomes one kind,
// and the kind decides whether the page reconnects by itself and what it tells the visitor. The
// words themselves are in the locale files, by kind, and never come from the server.
import { CLOSE_CODES } from './wire.ts'

/** The kinds of close the page tells apart. */
export type CloseKind
  = | 'transient' // the connection dropped or the server went away: reconnect and resume
    | 'unauthorized' // the token was refused (4401): ask for a fresh one once, then stop
    | 'not_found' // the conversation does not exist, or its data has been deleted (4404)
    | 'timed_out' // the connection was silent for 15 minutes (4408), or never said hello
    | 'too_many' // the visitor has started the day's ten conversations (4429)
    | 'too_big' // a frame was over the server's limit (1009)
    | 'unavailable' // the service is not set up (1011)
    | 'bad_frame' // the server could not read what the page sent (4400, 1003, 1002, 1007, 1008)

/** Reads a close code. Anything unknown counts as a dropped connection, which is retried a few times and then reported. */
export function classifyClose(code: number): CloseKind {
  switch (code) {
    case CLOSE_CODES.unauthorized: return 'unauthorized'
    case CLOSE_CODES.notFound: return 'not_found'
    case CLOSE_CODES.timedOut: return 'timed_out'
    case CLOSE_CODES.tooManyConversations: return 'too_many'
    case CLOSE_CODES.tooBig: return 'too_big'
    case CLOSE_CODES.unavailable: return 'unavailable'
    case CLOSE_CODES.badFrame:
    case CLOSE_CODES.unsupported:
    case 1002:
    case 1007:
    case 1008:
      return 'bad_frame'
    default: return 'transient'
  }
}

/** Tells whether the visitor can pick the conversation up again after this kind of close: it still exists on the server. */
export function isResumable(kind: CloseKind): boolean {
  return kind === 'transient' || kind === 'timed_out' || kind === 'too_big' || kind === 'unavailable' || kind === 'unauthorized'
}
