import { randomUUID } from 'node:crypto'

import { importJWK, jwtVerify, SignJWT } from 'jose'
import type { CryptoKey } from 'jose'

import { GatewayError } from '../errors.ts'

// Service tokens (docs/SECURITY.md, section 5): each service signs short-lived JWTs with
// its own Ed25519 key, and the gateway holds only the public halves. A leaked gateway
// config can't mint tokens, and a leaked token expires within minutes.

export const GATEWAY_AUDIENCE = 'lb-gateway'
// Tokens older than this are refused whatever their `exp` says, so a service can't
// hand out long-lived tokens by mistake.
export const MAX_TOKEN_AGE_SECONDS = 600
const CLOCK_TOLERANCE_SECONDS = 30

export type ServiceKeys = ReadonlyMap<string, CryptoKey>

export async function importServiceKeys(publicKeys: Readonly<Record<string, string>>): Promise<ServiceKeys> {
  const keys = new Map<string, CryptoKey>()
  for (const [service, x] of Object.entries(publicKeys)) {
    keys.set(service, await importJWK({ kty: 'OKP', crv: 'Ed25519', x }, 'EdDSA') as CryptoKey)
  }
  return keys
}

const bearer = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/

/** Returns the name of the service that signed the token, or throws a 401. */
export async function verifyServiceToken(authorization: string | undefined, keys: ServiceKeys, now: Date): Promise<string> {
  const token = bearer.exec(authorization ?? '')?.[1]
  if (!token) throw new GatewayError(401, 'invalid_service_token', 'Send a service token in the Authorization header as a Bearer token.')

  try {
    const { payload, protectedHeader } = await jwtVerify(token, (header) => {
      const key = header.kid === undefined ? undefined : keys.get(header.kid)
      if (!key) throw new Error('unknown key id')
      return key
    }, {
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

/** Mints a token the way every calling service must: used by Node services, the CLI and tests. */
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
