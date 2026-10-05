// POST /api/tokens/lb-06: the five-minute grant for LB-06's WebSocket, made the way LB-02's is
// (handlers/token.ts): a Vercel function can't hold a WebSocket, so the incident's feed connects
// straight to the API's address with a visitor token of its own, for LB-06 only, which goes in
// the connection's first frame and never in the address. Starting an incident spends quota, so
// the session must have passed Turnstile.
import { LB06_SOCKET_PATH } from '../../shared/lb06-app.ts'
import { socketGrantHandler } from './token.ts'

/** Mints a token for LB-06's WebSocket, and says where to open it. */
export default socketGrantHandler('lb-06', LB06_SOCKET_PATH)
