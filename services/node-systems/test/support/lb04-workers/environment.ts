// A worker that tells what it was given: the names of the environment variables it can see, its
// execution arguments and how many bytes of the file it holds. The test checks that the thread sees none of
// the process's environment (where a secret could be) and none of its arguments.
import { parentPort, workerData } from 'node:worker_threads'

const given = workerData as { data: Uint8Array }
const text = JSON.stringify({ env: Object.keys(process.env), argv: process.execArgv, bytes: given.data.length })
parentPort?.postMessage({ ok: true, pages: [{ page: 1, text }] })
