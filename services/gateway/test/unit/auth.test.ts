// Unit tests for service tokens: what is accepted and every way a token is refused.
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { CryptoKey } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'

import { importServiceKeys, signServiceToken, verifyServiceToken } from '../../src/auth/service-token.ts'
import type { ServiceKeys } from '../../src/auth/service-token.ts'
import { GatewayError } from '../../src/errors.ts'

let keys: ServiceKeys
let django: CryptoKey
let node: CryptoKey
const now = new Date('2026-09-28T12:00:00Z')

beforeAll(async () => {
  const djangoPair = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
  const nodePair = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
  django = djangoPair.privateKey
  node = nodePair.privateKey
  keys = await importServiceKeys({
    'django-systems': (await exportJWK(djangoPair.publicKey)).x!,
    'node-systems': (await exportJWK(nodePair.publicKey)).x!,
  })
})

/** Asserts that the header is refused with the gateway's 401. */
async function rejects(authorization: string | undefined, at = now): Promise<void> {
  const error = await verifyServiceToken(authorization, keys, at).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(GatewayError)
  expect(error).toMatchObject({ status: 401, code: 'invalid_service_token' })
}

describe('service tokens', () => {
  it('names the service that signed a valid token', async () => {
    const token = await signServiceToken('django-systems', django, now)
    await expect(verifyServiceToken(`Bearer ${token}`, keys, now)).resolves.toBe('django-systems')
  })

  it('refuses a missing or malformed header', async () => {
    await rejects(undefined)
    await rejects('Basic dXNlcjpwYXNz')
    await rejects('Bearer not-a-jwt')
  })

  it('refuses one service\'s key vouching for another service', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: 'node-systems' })
      .setIssuer('django-systems')
      .setAudience('lb-gateway')
      .setIssuedAt(now)
      .setExpirationTime(new Date(now.getTime() + 60_000))
      .sign(node)
    await rejects(`Bearer ${token}`)
  })

  it('refuses a token meant for another audience', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA', kid: 'django-systems' })
      .setIssuer('django-systems')
      .setAudience('lb-web')
      .setIssuedAt(now)
      .setExpirationTime(new Date(now.getTime() + 60_000))
      .sign(django)
    await rejects(`Bearer ${token}`)
  })

  it('refuses tokens past their expiry, and any older than ten minutes', async () => {
    const shortLived = await signServiceToken('django-systems', django, now, 60)
    await rejects(`Bearer ${shortLived}`, new Date(now.getTime() + 120_000))

    const longLived = await signServiceToken('django-systems', django, now, 86_400)
    await expect(verifyServiceToken(`Bearer ${longLived}`, keys, new Date(now.getTime() + 300_000))).resolves.toBe('django-systems')
    await rejects(`Bearer ${longLived}`, new Date(now.getTime() + 11 * 60_000))
  })

  it('refuses unsigned and symmetric-key tokens', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'django-systems' })).toString('base64url')
    const claims = Buffer.from(JSON.stringify({ iss: 'django-systems', aud: 'lb-gateway', iat: now.getTime() / 1000, exp: now.getTime() / 1000 + 60 })).toString('base64url')
    await rejects(`Bearer ${header}.${claims}.`)

    const hmac = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'django-systems' })
      .setIssuer('django-systems')
      .setAudience('lb-gateway')
      .setIssuedAt(now)
      .setExpirationTime(new Date(now.getTime() + 60_000))
      .sign(new TextEncoder().encode('a shared secret that is long enough'))
    await rejects(`Bearer ${hmac}`)
  })
})
