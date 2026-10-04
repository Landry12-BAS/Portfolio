// Makes the recordings the end-to-end tests replay (`pnpm --filter @lb/web record:fixtures [system...]`),
// by running a few of each system's samples on the test mock with the same recorder `just
// record-sample` uses on a real back end. They are written under e2e/fixtures/recordings, labelled
// `mock`, and bundled into the end-to-end build alone: the site never shows a mock recording outside
// that build. They are fixtures, not measurements: the mock's timings and token counts are made up.
//
// With no arguments every system is recorded again; with system names (`record:fixtures lb-08`)
// only those are, so a board's fixtures can be made without touching another board's files.
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

// The samples recorded for each system.
const SAMPLES: Readonly<Record<string, readonly string[]>> = {
  // One sample that drafts a cited reply in English, one handed to a person, one in Czech.
  'lb-01': ['torn-bag', 'injection-admin-mode', 'stale-decaf'],
  // The booking in English, the double-booking attempt and the Czech conversation in which another
  // visitor's hold runs out. Its other two samples (the Czech booking and the injection attempt) have
  // no recording, so the tests can run them live.
  'lb-02': ['book-cupping-en', 'double-book-taken-slot-en', 'two-tabs-held-by-other-cs'],
  // Three curated questions (a bar, a line and a point chart), and three attacks that end in different
  // ways: stopped by the first layer, stopped by the second, and declined by the model after a stop.
  // The dump of every order is left out on purpose: its thousand rows make a large file, and the
  // end-to-end journeys run that one live on the mock.
  'lb-05': [
    'revenue-by-product-last-quarter',
    'monthly-revenue-last-year',
    'active-subscriptions-by-frequency',
    'drop-orders-table',
    'information-schema-tables',
    'missing-salary',
  ],
  // One run with a step that fails once and then works, one whose step uses all its attempts and goes
  // to the dead-letter queue and is replayed, and one that waits for an approval. The Czech sample is
  // left without a recording on purpose, so the tests can see a sample that has none.
  'lb-08': ['wholesale-order', 'low-stock-reorder', 'refund-approval'],
  // The roasting plan (four speakers, five items) and the staffing meeting (a joke that must not become
  // a task). The newsletter draft is left without a recording on purpose, so the tests can see a sample
  // that has none and run it live.
  'lb-09': ['monday-roasting-plan', 'weekend-staffing'],
}

// The moment LB-02's mock stands still at.
const LB02_NOW = Date.parse('2026-10-02T09:30:00.000Z')

// The systems whose mock moves on with time (a retry waits for its backoff; a meeting's stages take
// their time) need a clock that the recorder moves by waiting; the others move on as they are read and never wait.
const TIMED = new Set(['lb-08', 'lb-09'])

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

/** A clock that stands still at one moment, so what a replay shows does not depend on the day it was made. */
function stillClock(at: number): Clock {
  return { now: () => at, sleep: () => Promise.resolve() }
}

/** Picks the clock a system's recording runs on. */
function clockFor(system: string): Clock {
  if (system === 'lb-02') return stillClock(LB02_NOW)
  return TIMED.has(system) ? virtualClock() : instantClock()
}

/** Lays the mock's LB-02 out afresh: no conversations, a calendar nobody has booked. */
async function resetLb02(origin: string): Promise<void> {
  const answer = await fetch(new URL('/__mock/lb02/reset', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  if (!answer.ok) throw new Error(`The mock would not reset LB-02 (status ${answer.status}).`)
}

/** Records a system's samples on a mock of its own and writes them under the folder. */
async function recordSystem(system: string, samples: readonly string[], folder: string): Promise<void> {
  const clock = clockFor(system)
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
      // Each LB-02 sample starts on a calendar nobody has touched, as the golden set's cases do.
      if (system === 'lb-02') await resetLb02(mock.url)
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
