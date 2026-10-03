// LB-07's staging shop as a process: the synthetic Basalt & Bean web shop the QA agent tests, started
// on its own in a container of its own on the sandbox network (infra/docker-compose.yml, lb07-shop).
//
//   just lb07-shop            (development)
//   node src/shop.ts          (production)
//
// It reads two settings and nothing else: where to listen, and the key that verifies the signed bug
// tokens the service makes (LB07_SHOP_TOKEN_KEY, 64 hex digits or more). It has no database, no
// Redis, no gateway and no visitor tokens: the only thing that reaches it is the sandbox's browser.
import { createShopServer } from './modules/lb07/shop/server.ts'
import { tokenKeyFromHex } from './modules/lb07/shop/token.ts'

const host = process.env.LB07_SHOP_HOST?.trim() || '0.0.0.0'
const port = Number(process.env.LB07_SHOP_PORT?.trim() || '8007')
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('LB07_SHOP_PORT must be a port number.')
const keyHex = process.env.LB07_SHOP_TOKEN_KEY?.trim()
if (!keyHex) throw new Error('LB07_SHOP_TOKEN_KEY is required: the key the bug tokens are signed with, as hex.')
const key = tokenKeyFromHex(keyHex)
// The key is read once; nothing else in the process should find it in the environment.
delete process.env.LB07_SHOP_TOKEN_KEY

const server = createShopServer({ tokenKey: key })
server.listen(port, host, () => {
  console.log(`lb07 shop listening on ${host}:${port}`)
})

/** Stops taking requests and exits. */
function shutDown(): void {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 5_000).unref()
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, shutDown)
