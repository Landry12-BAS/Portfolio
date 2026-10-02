// Starts what the end-to-end tests run against: the mock back end and the test build of the site
// (`.output-e2e`, from `pnpm --filter @lb/web build:e2e`), wired together with throwaway keys that
// exist only in these two processes. Playwright starts this as its web server. Nothing here needs a
// network, a model or Cloudflare: the test build passes the Turnstile check with a fixed stand-in,
// and the mock plays LB-01 and the gateway's trace route.
import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'

import { startMockBackend } from '@lb/api-clients/testing'

const sitePort = process.env.E2E_PORT ?? '3100'
const mockPort = Number(process.env.E2E_MOCK_PORT ?? 8121)

const siteKeys = generateKeyPairSync('ed25519')
const webKeys = generateKeyPairSync('ed25519')
const mock = await startMockBackend({
  siteKey: siteKeys.publicKey.export({ format: 'jwk' }).x ?? '',
  webKey: webKeys.publicKey.export({ format: 'jwk' }).x ?? '',
  port: mockPort,
})

const site = spawn('node', ['.output-e2e/server/index.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: sitePort,
    HOST: '127.0.0.1',
    NUXT_LB_API_URL: mock.url,
    NUXT_LB_GATEWAY_URL: mock.url,
    NUXT_LB_WEB_SIGNING_KEY: JSON.stringify(siteKeys.privateKey.export({ format: 'jwk' })),
    NUXT_LB_GATEWAY_SERVICE_KEY: JSON.stringify(webKeys.privateKey.export({ format: 'jwk' })),
    NUXT_LB_SESSION_SECRET: randomBytes(32).toString('hex'),
  },
})

site.on('exit', (code) => {
  void mock.close().then(() => process.exit(code ?? 0))
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => site.kill(signal))
}
