// Records a curated sample's run for the board's replay (`just record-sample <system> <sample>`).
// It runs the sample on a back end, with the real model behind it, reads the run's trace from the
// gateway and writes `recordings/<system>/<sample>.json`, which the site bundles and the board
// replays instead of spending a visitor's quota. It needs a live back end, the gateway and the
// site's keys (docs/DEPLOY.md, parts 6 and 10):
//
//   LB_API_URL                    the origin of the API, such as https://api.example.com
//   LB_GATEWAY_URL                the origin of the gateway's trace route (usually the same)
//   LB_WEB_SIGNING_KEY_FILE       the `site` key file (`just gateway-token keygen site <file>`)
//   LB_GATEWAY_SERVICE_KEY_FILE   the `web` key file (`just gateway-token keygen web <file>`)
//
// It spends one run of the sample (the model calls the pipeline makes, about six for LB-01) and makes
// one anonymous visitor's ticket, which the back end deletes after 24 hours. The recording says
// where it was made: against the test mock it is written under e2e/fixtures/recordings and labelled
// `mock`; against a real back end it is written here and labelled `live`. Nothing in this file can
// make one pass for the other. Pass `--out <folder>` to write somewhere else.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ServiceTokens } from '@lb/common/tokens'

import { isServiceOrigin, readPrivateKey } from '../server/lib/config.ts'
import { Backend } from './record/backend.ts'
import type { BackendTarget } from './record/backend.ts'
import { recordableSystems, recordSample, writeRecording } from './record/record.ts'

const SYSTEM_NAME = /^lb-\d{2}$/
const SAMPLE_NAME = /^[a-z0-9-]{1,60}$/

/** Reads a private key file and checks it is an Ed25519 key in JWK form. */
function readKeyFile(variable: string, path: string | undefined) {
  if (!path) throw new Error(`${variable} is not set: it names the key file to read.`)
  const key = readPrivateKey(readFileSync(path, 'utf8'))
  if (!key) throw new Error(`${variable} must name an Ed25519 private key in JWK form.`)
  return key
}

/** Reads and checks the origin of a service. */
function readOrigin(variable: string, text: string | undefined): URL {
  if (!text || !isServiceOrigin(text)) throw new Error(`${variable} must be the service's origin: https://host (http only for localhost), with no path.`)
  return new URL(text)
}

/** Builds the recorder's target from the environment. */
function targetFromEnvironment(env: NodeJS.ProcessEnv): BackendTarget {
  const clock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)) }
  return {
    apiUrl: readOrigin('LB_API_URL', env.LB_API_URL),
    gatewayUrl: readOrigin('LB_GATEWAY_URL', env.LB_GATEWAY_URL),
    signingKey: readKeyFile('LB_WEB_SIGNING_KEY_FILE', env.LB_WEB_SIGNING_KEY_FILE),
    gatewayTokens: new ServiceTokens('web', readKeyFile('LB_GATEWAY_SERVICE_KEY_FILE', env.LB_GATEWAY_SERVICE_KEY_FILE), () => clock.now() / 1_000),
    fetch,
    clock,
  }
}

/** Reads the arguments: `<system> <sample>` and an optional `--out <folder>`. */
function readArguments(args: readonly string[]): { system: string, sample: string, out: string | undefined } {
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined
  const positional = args.filter((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--out')
  const [system, sample] = positional
  if (!system || !sample || !SYSTEM_NAME.test(system) || !SAMPLE_NAME.test(sample) || positional.length !== 2) {
    throw new Error(`Usage: record-sample <system> <sample> [--out <folder>]. Systems that can be recorded: ${recordableSystems().join(', ')}.`)
  }
  return { system, sample, out }
}

try {
  const { system, sample, out } = readArguments(process.argv.slice(2))
  const backend = new Backend(targetFromEnvironment(process.env))
  console.log(`Running ${system} ${sample} on ${process.env.LB_API_URL}. This makes the system's real model calls once.`)
  const recording = await recordSample(backend, system, sample)
  const folder = out ?? join(import.meta.dirname, '..', recording.origin === 'live' ? 'recordings' : 'e2e/fixtures/recordings')
  const file = writeRecording(folder, recording)
  console.log(`Wrote ${file}`)
  console.log(`  ${recording.stats.steps} steps, ${recording.stats.modelCalls} model calls, ${recording.stats.durationMs} ms, ${recording.exchanges.length} recorded answers.`)
  console.log(recording.origin === 'live'
    ? '  Made on a live back end: commit it with the change that shipped the system.'
    : '  Made on the test mock: a fixture for the end-to-end tests only, never shown to a visitor of the real site.')
}
catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
