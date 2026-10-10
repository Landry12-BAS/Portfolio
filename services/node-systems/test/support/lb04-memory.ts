// A program for the test of the memory limit on the extraction thread: it gives the extraction a script that
// asks for all the memory it can get, with a small limit, and prints how the file was refused. The test runs it
// in a process of its own, with and without a V8 memory flag in NODE_OPTIONS, because that flag outranks the
// limit a thread is given (see the README's threat model).
import { ExtractionRefused, extractPdf } from '../../src/modules/lb04/pdf/extract.ts'

const timeoutMs = Number(process.argv[2] ?? '20000')
const started = performance.now()
const outcome = await extractPdf(
  new Uint8Array(10),
  { timeoutMs, maxOldGenerationMb: 24, maxYoungGenerationMb: 16, stackMb: 4 },
  { script: new URL('./lb04-workers/hog.ts', import.meta.url) },
).then(() => 'read', (error: unknown) => (error instanceof ExtractionRefused ? error.code : 'other'))
console.log(JSON.stringify({ outcome, milliseconds: Math.round(performance.now() - started) }))
