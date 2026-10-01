// Entrypoint of the Node systems' image: the Node counterpart of python-entrypoint.sh. It
// hands the service its private key as a file, keeps a heartbeat when asked, and then runs
// the script it was given (`node-entrypoint.mjs src/main.ts`), in this same process.
//
// The image is distroless, with no shell to do this in, and the files it works on are the
// ones the platform keeps off the image and off the disk:
//
//   LB_SERVICE_KEY_JWK_B64  the service's private key as a JWK file's contents in base64,
//                           handed over by the deploy (infra/secrets). @lb/common's gateway
//                           client reads the key from a file and refuses one other users can
//                           read, so this writes it, mode 0600, to a tmpfs, tells the service
//                           where with LB_SERVICE_KEY_FILE, and drops the variable so the
//                           service never holds the key twice. A process that is given no key
//                           (the worker, a migration) starts as it is.
//   LB_HEARTBEAT_FILE       when set, a file whose modification time is renewed every ten
//                           seconds for as long as the event loop turns. The worker has no
//                           port to ask, so its health check reads this file's age: a worker
//                           whose loop is stuck stops renewing it.
//
// Everything here is Node's own standard library: nothing to install, nothing to trust.

import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const KEY_FILE = '/run/lb/service-key.jwk.json'
const HEARTBEAT_EVERY_MILLISECONDS = 10_000
// Standard base64 with its padding: what `base64 -w0` prints, and nothing else.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** Stops the container with a message, because a service that starts without its key would only fail later. */
function stop(message) {
  console.error(`lb-entrypoint: ${message}`)
  process.exit(1)
}

/** Writes the private key from its variable to the tmpfs, and points the service at the file. */
function handOverKey() {
  const encoded = process.env.LB_SERVICE_KEY_JWK_B64
  if (!encoded) return
  if (!BASE64.test(encoded)) stop('LB_SERVICE_KEY_JWK_B64 is not valid base64.')
  const folder = dirname(KEY_FILE)
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    stop(`${folder} must be a writable tmpfs (see the tmpfs entry in docker-compose.yml).`)
  }
  writeFileSync(KEY_FILE, Buffer.from(encoded, 'base64'), { mode: 0o600 })
  // The mode above only applies to a new file; this makes sure of an old one.
  chmodSync(KEY_FILE, 0o600)
  process.env.LB_SERVICE_KEY_FILE = KEY_FILE
  delete process.env.LB_SERVICE_KEY_JWK_B64
}

/** Starts renewing the heartbeat file, if one is asked for. The timer never keeps the process alive on its own. */
function startHeartbeat() {
  const file = process.env.LB_HEARTBEAT_FILE
  if (!file) return
  const beat = () => writeFileSync(file, String(Date.now()), { mode: 0o600 })
  beat()
  setInterval(beat, HEARTBEAT_EVERY_MILLISECONDS).unref()
}

const target = process.argv[2]
if (!target) stop('usage: node-entrypoint.mjs <script> [arguments]')
const script = resolve(target)
if (!existsSync(script)) stop(`${script} does not exist.`)

handOverKey()
startHeartbeat()
// The script sees the arguments as if Node had been started on it directly.
process.argv = [process.argv[0], script, ...process.argv.slice(3)]
await import(pathToFileURL(script).href)
