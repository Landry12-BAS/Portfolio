// Makes the recordings the end-to-end tests replay (`pnpm --filter @lb/web record:fixtures [system]`),
// by running a few of each system's samples on the test mock with the same recorder `just
// record-sample` uses on a real back end. They are written under e2e/fixtures/recordings, labelled
// `mock`, and bundled into the end-to-end build alone: the site never shows a mock recording outside
// that build. They are fixtures, not measurements: the mock's timings and token counts are made up.
// Name a system (`lb-01`, `lb-02`, `lb-05`) to make only its recordings; with none, every system's are made.
//
// LB-02's are made on a mock whose clock stands still at one moment (2 October 2026, 11:30 in Prague),
// so the days and times a replay shows do not depend on the day the fixtures were made.
import { generateKeyPairSync } from 'node:crypto'
import { join } from 'node:path'

import { startMockBackend } from '@lb/api-clients/testing'
import { ServiceTokens } from '@lb/common/tokens'

import { Backend } from './record/backend.ts'
import type { Clock } from './record/backend.ts'
import { recordSample, writeRecording } from './record/record.ts'

// What each system records: LB-01 one sample that drafts a cited reply in English, one handed to a
// person and one in Czech; LB-02 the booking in English, the double-booking attempt and the
// Czech conversation in which another visitor's hold runs out. Its other two samples (the Czech
// booking and the injection attempt) have no recording, so the tests can run them live.
const SAMPLES: Readonly<Record<string, readonly string[]>> = {
  'lb-01': ['torn-bag', 'injection-admin-mode', 'stale-decaf'],
  'lb-02': ['book-cupping-en', 'double-book-taken-slot-en', 'two-tabs-held-by-other-cs'],
  // LB-05: three curated questions (a bar, a line and a point chart), and three attacks that end in
  // different ways: stopped by the first layer, stopped by the second, and declined by the model after
  // a stop. The dump of every order is left out on purpose: its thousand rows make a large file, and
  // the end-to-end journeys run that one live on the mock.
  'lb-05': [
    'revenue-by-product-last-quarter',
    'monthly-revenue-last-year',
    'active-subscriptions-by-frequency',
    'drop-orders-table',
    'information-schema-tables',
    'missing-salary',
  ],
}

// The moment LB-02's mock stands still at.
const LB02_NOW = Date.parse('2026-10-02T09:30:00.000Z')

const only = process.argv[2]
if (only !== undefined && !Object.hasOwn(SAMPLES, only)) {
  console.error(`There are no fixtures to make for "${only}". Systems that have some: ${Object.keys(SAMPLES).join(', ')}.`)
  process.exit(1)
}

/** Lays the mock's LB-02 out afresh: no conversations, a calendar nobody has booked. */
async function resetLb02(origin: string): Promise<void> {
  const answer = await fetch(new URL('/__mock/lb02/reset', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  if (!answer.ok) throw new Error(`The mock would not reset LB-02 (status ${answer.status}).`)
}

/** Records a system's samples on a mock of its own, whose clock is the given one. */
async function recordSystem(system: string, clock: Clock, mockNow: (() => number) | undefined): Promise<void> {
  const siteKeys = generateKeyPairSync('ed25519')
  const webKeys = generateKeyPairSync('ed25519')
  const mock = await startMockBackend({
    siteKey: siteKeys.publicKey.export({ format: 'jwk' }).x ?? '',
    webKey: webKeys.publicKey.export({ format: 'jwk' }).x ?? '',
    now: mockNow,
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
    const folder = join(import.meta.dirname, '..', 'e2e/fixtures/recordings')
    for (const sample of SAMPLES[system] ?? []) {
      // Each sample starts on a calendar nobody has touched, as the golden set's cases do.
      if (system === 'lb-02') await resetLb02(mock.url)
      console.log(`Wrote ${writeRecording(folder, await recordSample(backend, system, sample))}`)
    }
  }
  finally {
    await mock.close()
  }
}

if (only === undefined || only === 'lb-01') {
  await recordSystem('lb-01', { now: () => Date.now(), sleep: () => Promise.resolve() }, undefined)
}
if (only === undefined || only === 'lb-02') {
  await recordSystem('lb-02', { now: () => LB02_NOW, sleep: () => Promise.resolve() }, () => LB02_NOW)
}
if (only === undefined || only === 'lb-05') {
  await recordSystem('lb-05', { now: () => Date.now(), sleep: () => Promise.resolve() }, undefined)
}
