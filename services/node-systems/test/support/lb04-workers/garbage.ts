// A worker that answers in a form the service does not accept: pages that are not a list of pages. The
// answer comes from outside the service's control, so the service checks it with a schema.
import { parentPort } from 'node:worker_threads'

parentPort?.postMessage({ ok: true, pages: 'these are not pages' })
