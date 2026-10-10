// Tests for opening a visitor's PDF (pdf/extract.ts and its worker thread): a stranger's file is the
// riskiest input LB-04 takes, so it is opened in a thread with a time limit and a memory limit and an
// empty environment, it is refused before any text is read when it is too long, encrypted, an XFA
// form or carries embedded files, and it is refused with a plain reason when it has no text layer.
// The limits are proven with scripts that misbehave in each way a thread can.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LB04_LIMITS } from '@lb/contracts'
import type { Lb04FailureCode } from '@lb/contracts'
import { afterAll, describe, expect, it } from 'vitest'

import { ExtractionRefused, extractPdf } from '../../src/modules/lb04/pdf/extract.ts'
import type { ExtractionLimits, ExtractionOptions } from '../../src/modules/lb04/pdf/extract.ts'
import { seedBytes, TEST_LIMITS } from '../support/lb04.ts'
import { makePdf } from '../support/lb04-pdfs.ts'

/** The reason a file is refused for, or the pages when it is not. */
async function outcomeOf(bytes: Uint8Array, limits: ExtractionLimits = TEST_LIMITS, options: ExtractionOptions = {}): Promise<Lb04FailureCode | 'read'> {
  try {
    await extractPdf(bytes, limits, options)
    return 'read'
  }
  catch (error) {
    if (error instanceof ExtractionRefused) return error.code
    throw error
  }
}

/** The address of a misbehaving worker script. */
function script(name: string): URL {
  return new URL(`../support/lb04-workers/${name}.ts`, import.meta.url)
}

describe('reading the text of a PDF', () => {
  it('returns the text of every page, counted from one, in a worker thread', async () => {
    const pages = await extractPdf(await makePdf(3), TEST_LIMITS)

    expect(pages.map(page => page.page)).toEqual([1, 2, 3])
    expect(pages[1]?.text).toContain('Agreement page 2')
    expect(pages[1]?.text).toContain('The Supplier shall deliver the Products')
    expect(pages[0]?.text.split('\n')).toHaveLength(4)
  })

  it('takes a contract of exactly thirty pages, the longest the system reads', async () => {
    expect(await outcomeOf(await makePdf(LB04_LIMITS.maxPages))).toBe('read')
  })

  it('leaves the caller\'s bytes as they were, since the thread works on a copy', async () => {
    const bytes = await makePdf(2)
    const before = Buffer.from(bytes).toString('base64')

    await extractPdf(bytes, TEST_LIMITS)

    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(Buffer.from(bytes).toString('base64')).toBe(before)
  })

  it('opens several files at once, each in a thread of its own', async () => {
    const files = await Promise.all([makePdf(1), makePdf(2), makePdf(3)])

    const results = await Promise.all(files.map(file => extractPdf(file, TEST_LIMITS)))

    expect(results.map(pages => pages.length)).toEqual([1, 2, 3])
  })

  it('reads the real sample the way the shared page text function does: the same characters on every run', async () => {
    const first = await extractPdf(seedBytes('wholesale-supply'), TEST_LIMITS)
    const second = await extractPdf(seedBytes('wholesale-supply'), TEST_LIMITS)

    expect(second).toEqual(first)
    expect(first).toHaveLength(11)
  })
})

describe('refusing a file for what it is', () => {
  it('refuses what is not a readable PDF, naming the kind of error and never its message', async () => {
    const refusal = await extractPdf(new TextEncoder().encode('%PDF-1.7\nthis is not a pdf at all\n%%EOF'), TEST_LIMITS).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(ExtractionRefused)
    expect((refusal as ExtractionRefused).code).toBe('pdf_unreadable')
    expect((refusal as ExtractionRefused).detail).toMatch(/^[a-z]{3,40}$/i)
    expect((refusal as ExtractionRefused).message).toBe('The file was refused: pdf_unreadable.')
  })

  it('refuses a PDF cut short, an empty file and a file of zeros', async () => {
    const sample = seedBytes('wholesale-supply')

    expect(await outcomeOf(sample.subarray(0, 800))).toBe('pdf_unreadable')
    expect(await outcomeOf(new Uint8Array())).toBe('pdf_unreadable')
    expect(await outcomeOf(new Uint8Array(5_000))).toBe('pdf_unreadable')
  })

  it('refuses a contract of thirty-one pages, from its page count, before any text is read', async () => {
    expect(await outcomeOf(await makePdf(LB04_LIMITS.maxPages + 1))).toBe('too_many_pages')
    expect(await outcomeOf(seedBytes('master-supply-31'))).toBe('too_many_pages')
    expect(await outcomeOf(await makePdf(3), TEST_LIMITS, { maxPages: 2 })).toBe('too_many_pages')
  })

  it('refuses an encrypted PDF, whether it asks for a password or opens with an empty one and holds restrictions', async () => {
    expect(await outcomeOf(await makePdf(2, { encrypt: 'password' }))).toBe('pdf_encrypted')
    expect(await outcomeOf(await makePdf(2, { encrypt: 'restricted' }))).toBe('pdf_encrypted')
  })

  it('refuses a PDF with an XFA form, which can hold content the page text does not show', async () => {
    expect(await outcomeOf(await makePdf(2, { xfa: true }))).toBe('pdf_xfa')
  })

  it('refuses a PDF with an embedded file, and one with a file attached to a page', async () => {
    expect(await outcomeOf(await makePdf(2, { attachment: true }))).toBe('pdf_embedded_files')
    expect(await outcomeOf(await makePdf(2, { attachedToPage: true }))).toBe('pdf_embedded_files')
  })

  it('refuses a scan: pages with no text, and pages with a few words that are no contract', async () => {
    expect(await outcomeOf(await makePdf(3, {}, () => []))).toBe('no_text_layer')
    expect(await outcomeOf(await makePdf(1, {}, () => ['Page 1']))).toBe('no_text_layer')
    expect(await outcomeOf(seedBytes('scanned-supply'))).toBe('no_text_layer')
  })

  it('refuses a contract with more text than the limit, however few its pages', async () => {
    expect(await outcomeOf(await makePdf(2), TEST_LIMITS, { maxChars: 100 })).toBe('too_much_text')
  })

  it('does not refuse a contract for a limit it is under', async () => {
    expect(await outcomeOf(await makePdf(2), TEST_LIMITS, { maxChars: 100_000, maxPages: 2 })).toBe('read')
  })
})

describe('the limits on the thread', () => {
  const quick: ExtractionLimits = { ...TEST_LIMITS, timeoutMs: 400 }

  it('ends a thread that never answers, at the deadline, and refuses the file as a timeout', async () => {
    const started = performance.now()

    expect(await outcomeOf(new Uint8Array(10), quick, { script: script('spin') })).toBe('extraction_timeout')
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  /** Runs the memory-hungry script in a process of its own, with the Node options given, and returns how the file was refused and how long it took. */
  function hogIn(nodeOptions: string, timeoutMs: number): { outcome: string, milliseconds: number } {
    const output = execFileSync(process.execPath, [new URL('../support/lb04-memory.ts', import.meta.url).pathname, String(timeoutMs)], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: nodeOptions } })
    return JSON.parse(output) as { outcome: string, milliseconds: number }
  }

  it('ends a thread that asks for more memory than it may have, long before the deadline', () => {
    const { outcome, milliseconds } = hogIn('', 20_000)

    expect(outcome).toBe('extraction_failed')
    expect(milliseconds).toBeLessThan(10_000)
  })

  it('is held by the deadline when the process was started with a V8 memory flag, which outranks the thread\'s limit', () => {
    const { outcome } = hogIn('--max-old-space-size=8192', 1_500)

    expect(['extraction_timeout', 'extraction_failed']).toContain(outcome)
  })

  it('goes on after a thread was ended: the next file is read', async () => {
    expect(await outcomeOf(new Uint8Array(10), quick, { script: script('spin') })).toBe('extraction_timeout')
    expect(await outcomeOf(await makePdf(1))).toBe('read')
  })

  it('refuses a thread that throws, one that ends without a word, and answers of the wrong shape or the wrong size', async () => {
    expect(await outcomeOf(new Uint8Array(10), TEST_LIMITS, { script: script('crash') })).toBe('extraction_failed')
    expect(await outcomeOf(new Uint8Array(10), TEST_LIMITS, { script: script('quiet') })).toBe('extraction_failed')
    expect(await outcomeOf(new Uint8Array(10), TEST_LIMITS, { script: script('garbage') })).toBe('extraction_failed')
    expect(await outcomeOf(new Uint8Array(10), TEST_LIMITS, { script: script('oversized') })).toBe('extraction_failed')
  })

  it('does not let a thread\'s error text reach the caller', async () => {
    const refusal = await extractPdf(new Uint8Array(10), TEST_LIMITS, { script: script('crash') }).catch((error: unknown) => error)

    expect((refusal as ExtractionRefused).message).toBe('The file was refused: extraction_failed.')
    expect(JSON.stringify(refusal)).not.toContain('told to crash')
  })

  it('gives the thread an empty environment, no execution arguments, and the bytes of the file', async () => {
    const pages = await extractPdf(new Uint8Array(1_234), TEST_LIMITS, { script: script('environment') })

    expect(JSON.parse(pages[0]?.text ?? '{}')).toEqual({ env: [], argv: [], bytes: 1_234 })
  })
})

describe('reading a PDF with no code made from strings', () => {
  const folder = mkdtempSync(join(tmpdir(), 'lb04-no-eval-'))
  afterAll(() => rmSync(folder, { recursive: true, force: true }))
  const flag = '--disallow-code-generation-from-strings'

  it('is a flag that makes eval throw in this Node, and the extraction still reads every page of the sample with it', async () => {
    const probe = execFileSync(process.execPath, [flag, '-e', 'try { eval("1"); console.log("allowed") } catch { console.log("refused") }'], { encoding: 'utf8' }).trim()
    const path = join(folder, 'sample.pdf')
    writeFileSync(path, seedBytes('wholesale-supply'))

    const output = execFileSync(process.execPath, [flag, new URL('../support/lb04-no-eval.ts', import.meta.url).pathname, path], { encoding: 'utf8' })

    expect(probe).toBe('refused')
    expect(JSON.parse(output)).toEqual({ pages: 11, characters: 23_922 })
  })
})
