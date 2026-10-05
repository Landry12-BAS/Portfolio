// The health check of LB-07's sandbox (the image's HEALTHCHECK, and lb07-sandbox in
// docker-compose.yml): both of the sandbox's servers answer, asked from inside the container.
//
//   - the runner's API, on the container's own network address, where the worker calls it: it must
//     say it is ok (GET /healthz);
//   - the staging shop, on the loopback interface, the one place the browser may go: its front page
//     must load.
//
// It says nothing about the browser, which starts with the first run and is the runner's to look
// after. The ports and the runner's address are read the way src/sandbox.ts reads them, from the
// container's own environment. The image has no shell, so this is Node and its standard library.
import { lookup } from 'node:dns/promises'
import { hostname } from 'node:os'

const TIMEOUT_MILLISECONDS = 4_000

/** Reads a port setting, or its default. */
function portSetting(name, fallback) {
  return process.env[name]?.trim() || String(fallback)
}

/** The address the runner listens on: the setting, or the container's own address, as the sandbox finds it. */
async function runnerHost() {
  const setting = process.env.LB07_SANDBOX_HOST?.trim()
  if (setting) return setting
  const { address } = await lookup(hostname(), { family: 4 })
  return address
}

/** Fetches a URL with a deadline, and returns the response. */
function get(url) {
  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MILLISECONDS), redirect: 'manual' })
}

/** Says whether the runner's API answers that it is ok. */
async function runnerIsHealthy() {
  const response = await get(`http://${await runnerHost()}:${portSetting('LB07_SANDBOX_PORT', 8008)}/healthz`)
  if (!response.ok) return false
  const body = await response.json()
  return body?.ok === true
}

/** Says whether the shop's front page loads on the loopback interface. */
async function shopIsHealthy() {
  const response = await get(`http://127.0.0.1:${portSetting('LB07_SHOP_PORT', 8007)}/`)
  return response.status === 200
}

try {
  const [runner, shop] = await Promise.all([runnerIsHealthy(), shopIsHealthy()])
  if (!runner) console.error('lb07-sandbox-healthcheck: the runner did not say it is ok.')
  if (!shop) console.error('lb07-sandbox-healthcheck: the shop did not serve its front page.')
  process.exit(runner && shop ? 0 : 1)
}
catch (error) {
  console.error(`lb07-sandbox-healthcheck: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
