// POST /api/tokens/lb-09: the five-minute grant for LB-09's WebSocket, made the way LB-02's and
// LB-06's are (handlers/token.ts): a Vercel function can't hold a WebSocket, so a meeting's progress
// is followed over a connection straight to the API's address, with a visitor token of its own, for
// LB-09 only, which goes in the connection's first frame and never in the address. Starting a
// meeting spends quota and takes a recording, so the session must have passed Turnstile.
import { LB09_SOCKET_PATH } from '../../shared/lb09-app.ts'
import { socketGrantHandler } from './token.ts'

/** Mints a token for LB-09's WebSocket, and says where to open it. */
export default socketGrantHandler('lb-09', LB09_SOCKET_PATH)
