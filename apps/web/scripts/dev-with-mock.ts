// Runs the site with hot reload against the mock back end, so every demo can be tried with no
// back end, no model and no keys (`just dev-mock`). It makes throwaway keys, starts the mock on
// http://127.0.0.1:8120, and starts `nuxt dev` on http://localhost:3000 with the settings that
// point at it (set LB_MOCK_PORT and PORT to use other ports). The dev server is a test build: it
// accepts the fixed stand-in for a Turnstile token (the browser sends it by itself), so nothing
// here needs Cloudflare. The keys exist only in this process and its child's environment.
import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'

import { startMockBackend } from '@lb/api-clients/testing'

const siteKeys = generateKeyPairSync('ed25519')
const webKeys = generateKeyPairSync('ed25519')

const mock = await startMockBackend({
  siteKey: siteKeys.publicKey.export({ format: 'jwk' }).x ?? '',
  webKey: webKeys.publicKey.export({ format: 'jwk' }).x ?? '',
  port: Number(process.env.LB_MOCK_PORT ?? 8120),
})
console.log(`Mock back end on ${mock.url}: LB-01 plays like the real one, the other systems answer examples that fit their OpenAPI documents.`)
const sitePort = process.env.PORT ?? '3000'

// `nuxt dev` runs in this folder, and takes its settings from the environment like the real site.

const site = spawn('pnpm', ['exec', 'nuxt', 'dev', '--port', sitePort], {
  stdio: 'inherit',
  env: {
    ...process.env,
    LB_TEST_BUILD: '1',
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
