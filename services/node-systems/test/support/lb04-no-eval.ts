// A program for the test of the extraction without eval: it opens a PDF with the extraction and prints the
// page count and the characters read. The test runs it with `--disallow-code-generation-from-strings`, which
// makes every `eval` and `new Function` of the process throw, so the extraction is shown to work without them.
import { readFileSync } from 'node:fs'

import { extractPdf } from '../../src/modules/lb04/pdf/extract.ts'

const path = process.argv[2]
if (path === undefined) throw new RangeError('Name a PDF to open.')
const pages = await extractPdf(new Uint8Array(readFileSync(path)), { timeoutMs: 60_000, maxOldGenerationMb: 192, maxYoungGenerationMb: 32, stackMb: 4 })
console.log(JSON.stringify({ pages: pages.length, characters: pages.reduce((total, page) => total + page.text.length, 0) }))
