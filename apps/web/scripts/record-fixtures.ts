// Makes the recordings the end-to-end tests replay (`pnpm --filter @lb/web record:fixtures`), by
// running some of each board's samples on the test mock with the same recorder `just record-sample`
// uses on a real back end. They are written under e2e/fixtures/recordings, labelled `mock`, and
// bundled into the end-to-end build alone: the site never shows a mock recording outside that build.
// They are fixtures, not measurements: the mock's timings and token counts are made up.
//
// With no arguments every system is recorded again; with system names (`record:fixtures lb-08`)
// only those are, so a board's fixtures can be made without touching another board's files.
import { generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'

import { startMockBackend } from '@lb/api-clients/testing'
import { ServiceTokens } from '@lb/common/tokens'

import { Backend } from './record/backend.ts'
import type { Clock } from './record/backend.ts'
import { recordSample, writeRecording } from './record/record.ts'

// The samples recorded for each system.
const SAMPLES: Readonly<Record<string, readonly string[]>> = {
  // One sample that drafts a cited reply in English, one handed to a person, one in Czech.
  'lb-01': ['torn-bag', 'injection-admin-mode', 'stale-decaf'],
  // One run with a step that fails once and then works, one whose step uses all its attempts and goes
  // to the dead-letter queue and is replayed, and one that waits for an approval. The Czech sample is
  // left without a recording on purpose, so the tests can see a sample that has none.
  'lb-08': ['wholesale-order', 'low-stock-reorder', 'refund-approval'],
}

// The systems whose mock moves on with time (a retry waits for its backoff) need a clock that the
// recorder moves by waiting; the others move on as they are read and never wait.
const TIMED = new Set(['lb-08'])

/** A clock that moves only when the recorder waits, shared by the recorder, its tokens and the mock. */
function virtualClock(): Clock {
  let now = Date.now()
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms
      return Promise.resolve()
    },
  }
}

/** A clock that never waits: the mock's pipeline moves on as it is read. */
function instantClock(): Clock {
  return { now: () => Date.now(), sleep: () => Promise.resolve() }
}

/** Records a system's samples on a mock of its own and writes them under the folder. */
async function recordSystem(system: string, samples: readonly string[], folder: string): Promise<void> {
  const clock = TIMED.has(system) ? virtualClock() : instantClock()
  const siteKeys = generateKeyPairSync('ed25519')
  const webKeys = generateKeyPairSync('ed25519')
  const mock = await startMockBackend({
    siteKey: siteKeys.publicKey.export({ format: 'jwk' }).x ?? '',
    webKey: webKeys.publicKey.export({ format: 'jwk' }).x ?? '',
    now: clock.now,
  })
  try {
    const backend = new Backend({
      apiUrl: new URL(mock.url),
      gatewayUrl: new URL(mock.url),
      signingKey: siteKeys.privateKey,
      gatewayTokens: new ServiceTokens('web', webKeys.privateKey, () => clock.now() / 1_000),
      fetch,
      clock,
    })
    for (const sample of samples) {
      console.log(`Wrote ${writeRecording(folder, await recordSample(backend, system, sample))}`)
    }
  }
  finally {
    await mock.close()
  }
}

const asked = process.argv.slice(2)
const unknown = asked.filter(system => !Object.hasOwn(SAMPLES, system))
if (unknown.length > 0) {
  console.error(`No fixtures are made for ${unknown.join(', ')}. Systems that have them: ${Object.keys(SAMPLES).join(', ')}.`)
  process.exit(1)
}
const folder = join(import.meta.dirname, '..', 'e2e/fixtures/recordings')
for (const [system, samples] of Object.entries(SAMPLES)) {
  if (asked.length === 0 || asked.includes(system)) await recordSystem(system, samples, folder)
}
