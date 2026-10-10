// Unit tests for service tokens: what is signed, when it is replaced, and which key files
// are refused. The gateway's own verifier checks the tokens, so the two sides are proven
// to agree, not just to resemble each other.
import { generateKeyPairSync } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { importServiceKeys, verifyServiceToken } from '../../../../services/gateway/src/auth/service-token.ts'
import { loadServiceKey, mintServiceToken, privateKeyFromJwk, publicKeyOf, ServiceKeyError, ServiceTokens } from '../../src/tokens.ts'

const NOW = 1_790_000_000
let directory: string
let key: KeyObject
let jwk: Record<string, unknown>

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'lb-common-tokens-'))
  key = generateKeyPairSync('ed25519').privateKey
  jwk = { ...key.export({ format: 'jwk' }), kid: 'node-systems' }
})

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** Writes a key file with the given contents and permissions, and returns its path. */
function keyFile(name: string, contents: string, mode: number): string {
  const path = join(directory, name)
  writeFileSync(path, contents)
  chmodSync(path, mode)
  return path
}

/** Decodes the claims of a token. */
function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
}

describe('a minted token', () => {
  it('is accepted by the gateway\'s own verifier, as the service that signed it', async () => {
    const keys = await importServiceKeys({ 'node-systems': publicKeyOf(key) })
    const token = mintServiceToken('node-systems', key, NOW)

    await expect(verifyServiceToken(`Bearer ${token}`, keys, new Date(NOW * 1000))).resolves.toBe('node-systems')
  })

  it('names the service as key ID and issuer, the gateway as audience, and lives five minutes', () => {
    const token = mintServiceToken('node-systems', key, NOW)
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>

    expect(header).toEqual({ alg: 'EdDSA', kid: 'node-systems', typ: 'JWT' })
    expect(claimsOf(token)).toMatchObject({ iss: 'node-systems', aud: 'lb-gateway', iat: NOW, exp: NOW + 300 })
  })

  it('is refused by the gateway when signed with another key, or once it is too old', async () => {
    const keys = await importServiceKeys({ 'node-systems': publicKeyOf(key) })
    const impostor = mintServiceToken('node-systems', generateKeyPairSync('ed25519').privateKey, NOW)
    const stale = mintServiceToken('node-systems', key, NOW - 3_600, 600)

    await expect(verifyServiceToken(`Bearer ${impostor}`, keys, new Date(NOW * 1000))).rejects.toMatchObject({ code: 'invalid_service_token' })
    await expect(verifyServiceToken(`Bearer ${stale}`, keys, new Date(NOW * 1000))).rejects.toMatchObject({ code: 'invalid_service_token' })
  })

  it('has a unique ID each time', () => {
    expect(claimsOf(mintServiceToken('node-systems', key, NOW)).jti).not.toBe(claimsOf(mintServiceToken('node-systems', key, NOW)).jti)
  })

  it('lives from 1 to 600 seconds, and the service name is checked first', () => {
    expect(() => mintServiceToken('node-systems', key, NOW, 0)).toThrow(RangeError)
    expect(() => mintServiceToken('node-systems', key, NOW, 601)).toThrow(RangeError)
    expect(() => mintServiceToken('node-systems', key, NOW, 2.5)).toThrow(RangeError)
    expect(() => mintServiceToken('Node Systems', key, NOW)).toThrow('not a service name')
  })
})

describe('the token cache', () => {
  it('reuses a token until a minute before it expires, then mints a new one', () => {
    let now = NOW
    const tokens = new ServiceTokens('node-systems', key, () => now)

    const first = tokens.current()
    now = NOW + 239
    expect(tokens.current()).toBe(first)
    now = NOW + 240
    const second = tokens.current()

    expect(second).not.toBe(first)
    expect(claimsOf(second).iat).toBe(NOW + 240)
    expect(tokens.current()).toBe(second)
  })

  it('refuses a lifetime too short to refresh, or too long for the gateway', () => {
    expect(() => new ServiceTokens('node-systems', key, () => NOW, 60)).toThrow(RangeError)
    expect(() => new ServiceTokens('node-systems', key, () => NOW, 601)).toThrow(RangeError)
    expect(() => new ServiceTokens('NODE', key)).toThrow('not a service name')
  })
})

describe('the key file', () => {
  it('loads a key only its owner can read', () => {
    const loaded = loadServiceKey(keyFile('good.jwk.json', JSON.stringify(jwk), 0o600))

    expect(publicKeyOf(loaded)).toBe(publicKeyOf(key))
  })

  it.each([0o644, 0o640, 0o604, 0o660, 0o666, 0o620])('refuses a key with mode %o, which other users could read or change', (mode) => {
    const path = keyFile(`loose-${mode.toString(8)}.jwk.json`, JSON.stringify(jwk), mode)

    expect(() => loadServiceKey(path)).toThrow(ServiceKeyError)
    expect(() => loadServiceKey(path)).toThrow('chmod 600')
  })

  it('refuses a file that is missing, or is not a JSON key, and names the file, not its contents', () => {
    expect(() => loadServiceKey(join(directory, 'missing.jwk.json'))).toThrow('There is no service key')
    const garbage = keyFile('garbage.jwk.json', 'definitely-not-json-secret', 0o600)
    expect(() => loadServiceKey(garbage)).toThrow('not a readable JSON key file')
    expect(() => loadServiceKey(garbage)).not.toThrow('definitely-not-json-secret')
  })

  it('refuses a key that is not an Ed25519 private key, or whose halves do not match', () => {
    const d = String(jwk.d)
    const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })

    for (const bad of [null, 'text', [], {}, { ...jwk, kty: 'RSA' }, { ...jwk, crv: 'P-256' }, { ...jwk, d: undefined }, { ...jwk, x: undefined }, { ...jwk, d: 'AAAA' }, { ...jwk, x: other.x }]) {
      let message = ''
      try {
        privateKeyFromJwk(bad)
      }
      catch (error) {
        expect(error).toBeInstanceOf(ServiceKeyError)
        message = (error as Error).message
      }
      expect(message, JSON.stringify(bad)).not.toBe('')
      expect(message).not.toContain(d)
    }
  })
})
