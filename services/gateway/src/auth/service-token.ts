// Service tokens (docs/SECURITY.md, section 5): each service signs short-lived JWTs with
// its own Ed25519 key, and the gateway holds only the public halves. A leaked gateway
// config can't mint tokens, and a leaked token expires within minutes.
import { randomUUID } from 'node:crypto'

import { importJWK, jwtVerify, SignJWT } from 'jose'
import type { CryptoKey } from 'jose'

import { GatewayError } from '../errors.ts'

/** The audience every service token must name, so a token for another system is refused. */
export const GATEWAY_AUDIENCE = 'lb-gateway'
/**
 * The oldest token accepted, in seconds, whatever its `exp` says, so a service can't
 * hand out long-lived tokens by mistake.
 */
export const MAX_TOKEN_AGE_SECONDS = 600
// Allowed clock drift between a service and the gateway.
const CLOCK_TOLERANCE_SECONDS = 30

/** The public key of each service allowed to call, keyed by service name. */
export type ServiceKeys = ReadonlyMap<string, CryptoKey>

/**
 * Turns the LB_SERVICE_KEYS entries (service name to the base64url `x` of an Ed25519
 * public key) into keys the verifier can use.
 */
export async function importServiceKeys(publicKeys: Readonly<Record<string, string>>): Promise<ServiceKeys> {
  const keys = new Map<string, CryptoKey>()
  for (const [service, x] of Object.entries(publicKeys)) {
    keys.set(service, await importJWK({ kty: 'OKP', crv: 'Ed25519', x }, 'EdDSA') as CryptoKey)
  }
  return keys
}

// "Bearer" followed by exactly three base64url segments, the shape of a compact JWT.
const bearer = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/

/**
 * Checks the Authorization header and returns the name of the service that signed the
 * token. Throws a 401 for a missing, malformed, expired or foreign token. Every failure
 * gets the same message, so a caller can't probe which check failed.
 */
export async function verifyServiceToken(authorization: string | undefined, keys: ServiceKeys, now: Date): Promise<string> {
  const token = bearer.exec(authorization ?? '')?.[1]
  if (!token) throw new GatewayError(401, 'invalid_service_token', 'Send a service token in the Authorization header as a Bearer token.')

  try {
    const { payload, protectedHeader } = await jwtVerify(token, (header) => {
      // The key ID names the service; an unknown service has no key to check against.
      const key = header.kid === undefined ? undefined : keys.get(header.kid)
      if (!key) throw new Error('unknown key id')
      return key
    }, {
      // Only Ed25519 signatures: no `none`, and no shared-secret HMAC a leak could forge.
      algorithms: ['EdDSA'],
      audience: GATEWAY_AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      currentDate: now,
      maxTokenAge: MAX_TOKEN_AGE_SECONDS,
      requiredClaims: ['iss', 'iat', 'exp'],
    })
    // The key ID picks the public key; the issuer must name the same service, so one
    // service's key can't vouch for another.
    const service = payload.iss
    if (service === undefined || service !== protectedHeader.kid) throw new Error('issuer does not match the key id')
    return service
  }
  catch {
    throw new GatewayError(401, 'invalid_service_token', 'The service token is invalid or expired.')
  }
}

/**
 * Mints a service token the way every calling service must: EdDSA, the service's name
 * as key ID and issuer, the gateway as audience, and a short lifetime. Used by Node
 * services, the local CLI and the tests.
 */
export async function signServiceToken(service: string, privateKey: CryptoKey, now: Date, ttlSeconds = 300): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', kid: service, typ: 'JWT' })
    .setIssuer(service)
    .setAudience(GATEWAY_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttlSeconds)
    .setJti(randomUUID())
    .sign(privateKey)
}
