// Runs the mock back end as a process, for the end-to-end tests and for developing the site
// without a back end:
//
//   node src/testing/serve.ts --port 8120 --site-key <base64url> --web-key <base64url>
//
// `--site-key` is the public key the site signs visitor tokens with (what LB_WEB_TOKEN_KEY holds)
// and `--web-key` the public key of its `web` service token (an entry of LB_SERVICE_KEYS). Both
// can come from MOCK_SITE_KEY and MOCK_WEB_KEY instead. It prints one JSON line with its URL
// when it is ready, and stops on SIGTERM or SIGINT. It also answers a small control surface
// for tests under /__mock/ (see handleControl), which only the loopback address can reach.
import { parseArgs } from 'node:util'

import { startMockBackend } from './server.ts'

const { values } = parseArgs({
  options: {
    'port': { type: 'string', default: '8120' },
    'site-key': { type: 'string', default: process.env.MOCK_SITE_KEY },
    'web-key': { type: 'string', default: process.env.MOCK_WEB_KEY },
    'polls': { type: 'string', default: '2' },
  },
})

if (!values['site-key'] || !values['web-key']) {
  console.error('Give the site\'s and the web service\'s public keys: --site-key and --web-key (or MOCK_SITE_KEY and MOCK_WEB_KEY).')
  process.exit(1)
}

const mock = await startMockBackend({ siteKey: values['site-key'], webKey: values['web-key'], port: Number(values.port), pollsToFinish: Number(values.polls) })
console.log(JSON.stringify({ url: mock.url }))

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void mock.close().then(() => process.exit(0))
  })
}
