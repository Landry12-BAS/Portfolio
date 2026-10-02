// Makes the recordings the end-to-end tests replay (`pnpm --filter @lb/web record:fixtures`), by
// running a few of LB-01's samples on the test mock with the same recorder `just record-sample` uses
// on a real back end. They are written under e2e/fixtures/recordings, labelled `mock`, and bundled
// into the end-to-end build alone: the site never shows a mock recording outside that build.
// They are fixtures, not measurements: the mock's timings and token counts are made up.
import { generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'

import { startMockBackend } from '@lb/api-clients/testing'
import { ServiceTokens } from '@lb/common/tokens'

import { Backend } from './record/backend.ts'
import { recordSample, writeRecording } from './record/record.ts'

// One sample that drafts a cited reply in English, one handed to a person, one in Czech.
const SAMPLES = ['torn-bag', 'injection-admin-mode', 'stale-decaf']

const siteKeys = generateKeyPairSync('ed25519')
const webKeys = generateKeyPairSync('ed25519')
const mock = await startMockBackend({
  siteKey: siteKeys.publicKey.export({ format: 'jwk' }).x ?? '',
  webKey: webKeys.publicKey.export({ format: 'jwk' }).x ?? '',
})

try {
  const clock = { now: () => Date.now(), sleep: () => Promise.resolve() }
  const backend = new Backend({
    apiUrl: new URL(mock.url),
    gatewayUrl: new URL(mock.url),
    signingKey: siteKeys.privateKey,
    gatewayTokens: new ServiceTokens('web', webKeys.privateKey, () => clock.now() / 1_000),
    fetch,
    clock,
  })
  const folder = join(import.meta.dirname, '..', 'e2e/fixtures/recordings')
  for (const sample of SAMPLES) {
    console.log(`Wrote ${writeRecording(folder, await recordSample(backend, 'lb-01', sample))}`)
  }
}
finally {
  await mock.close()
}
