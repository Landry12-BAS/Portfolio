// Mints visitor tokens with the site's real signer, for the contract test in Python
// (python/lb-common/tests/integration/test_visitor_contract.py), which then checks them
// with the real Python verifier.
//
//   echo '{"jwk": {...}, "requests": [...]}' | node test/support/mint-visitor-tokens.ts
//
// It reads one JSON object from stdin: the site's private key in the JWK form `just
// gateway-token keygen` writes, and a list of requests. It prints one JSON array with an
// answer for each request, in order: `{"token": "..."}`, or `{"error": "..."}` when the
// signer refused (which the Python test expects for a lifetime or a subject the verifiers
// would refuse). A request is one of:
//
//   {"kind": "mint", "system": "lb-01", "sessionKey": "...", "now": 1790000000, "ttl": 300}
//       what the site does: `mintVisitorToken`, with the lifetime left out when `ttl` is absent
//   {"kind": "raw", "claims": {...}, "header": {...}}
//       a token the signer would never make (a lifetime that is too long, a wrong audience),
//       signed with the same key by the test helper, so the verifier can be shown refusing it
import { privateKeyFromJwk } from '../../src/tokens.ts'
import { mintVisitorToken as mintRawToken } from '../../src/testing.ts'
import { mintVisitorToken } from '../../src/visitors.ts'

/** A request to mint a token the way the site does. */
interface MintRequest {
  kind: 'mint'
  system: string
  sessionKey: string
  now: number
  ttl?: number
}

/** A request to sign arbitrary claims with the site's key. */
interface RawRequest {
  kind: 'raw'
  claims: Record<string, unknown>
  header?: Record<string, unknown>
}

/** What the script reads from stdin. */
interface Input {
  jwk: unknown
  requests: (MintRequest | RawRequest)[]
}

/** Reads all of stdin as text. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Answers one request: the token, or the reason the signer refused. */
function answer(request: MintRequest | RawRequest, key: ReturnType<typeof privateKeyFromJwk>): { token: string } | { error: string } {
  try {
    if (request.kind === 'raw') return { token: mintRawToken(key, request.claims, request.header) }
    const visitor = { system: request.system, sessionKey: request.sessionKey }
    return { token: request.ttl === undefined ? mintVisitorToken(key, visitor, request.now) : mintVisitorToken(key, visitor, request.now, request.ttl) }
  }
  catch (error) {
    return { error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error' }
  }
}

const input = JSON.parse(await readStdin()) as Input
const key = privateKeyFromJwk(input.jwk)
process.stdout.write(`${JSON.stringify(input.requests.map(request => answer(request, key)))}\n`)
