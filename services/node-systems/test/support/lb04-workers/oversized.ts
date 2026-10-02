// A worker that answers with more pages than any contract may have. A thread that has been taken over
// could say anything, so the service refuses an answer that is larger than an honest one.
import { parentPort } from 'node:worker_threads'

const pages = Array.from({ length: 31 }, (_, index) => ({ page: index + 1, text: 'text' }))
parentPort?.postMessage({ ok: true, pages })
