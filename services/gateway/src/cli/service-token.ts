// Service keys and tokens for local development.
//
//   node src/cli/service-token.ts keygen <service> <private-key-file>
//     Writes a new Ed25519 private key (JWK, mode 0600) and prints the service's
//     LB_SERVICE_KEYS entry. Keep private keys out of the repository: deployed
//     services get theirs from SOPS-encrypted secrets.
//
//   node src/cli/service-token.ts mint <service> <private-key-file> [ttl-seconds]
//     Prints a service token, for calling a local gateway with curl.
import { readFileSync, writeFileSync } from 'node:fs'

import { exportJWK, generateKeyPair, importJWK } from 'jose'
import type { CryptoKey } from 'jose'

import { MAX_TOKEN_AGE_SECONDS, signServiceToken } from '../auth/service-token.ts'

const [command, service, keyFile, ttl] = process.argv.slice(2)

/** Prints a message for the person at the terminal and exits with an error code. */
function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

if (!service || !/^[a-z][a-z0-9-]{1,39}$/.test(service) || !keyFile) {
  fail('Usage: service-token.ts keygen <service> <private-key-file> | mint <service> <private-key-file> [ttl-seconds]')
}

if (command === 'keygen') {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })
  const { x } = await exportJWK(publicKey)
  try {
    // `wx` refuses to overwrite an existing key; mode 0600 keeps it readable by its owner only.
    writeFileSync(keyFile, `${JSON.stringify({ ...(await exportJWK(privateKey)), kid: service })}\n`, { mode: 0o600, flag: 'wx' })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail(`${keyFile} already exists. Delete it first to replace the key.`)
    throw error
  }
  // Only the public half is printed; the private key never reaches the terminal.
  console.log(`Private key written to ${keyFile}. Add this entry to LB_SERVICE_KEYS:`)
  console.log(JSON.stringify({ [service]: x }))
}
else if (command === 'mint') {
  const seconds = ttl === undefined ? 300 : Number(ttl)
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TOKEN_AGE_SECONDS) {
    fail(`The TTL must be a whole number of seconds from 1 to ${MAX_TOKEN_AGE_SECONDS}.`)
  }
  const key = await importJWK(JSON.parse(readFileSync(keyFile, 'utf8')) as Record<string, unknown>, 'EdDSA') as CryptoKey
  console.log(await signServiceToken(service, key, new Date(), seconds))
}
else {
  fail(`Unknown command ${command ?? ''}. Use keygen or mint.`)
}
