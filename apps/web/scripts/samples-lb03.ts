// Makes what LB-03's demo opens on from the golden set (evals/lb03/golden.yaml, the cases marked with a
// `sample` name) and the seed's manifest (data/seed/lb03/manifest.json):
//
// - `shared/data/samples/lb03.ts`, the six curated documents with what each prints and how the golden set
//   expects the reading to end;
// - `public/lb03/samples/<file>`, the six files themselves, so a visitor can run a sample live (the board
//   sends the file as an upload of their own) or save it;
// - `public/lb03/pages/<sample>-<page>.jpg`, the page pictures the service draws, which a replay shows
//   under the fields it lights up (a replay has no document at the service to ask for them).
//
// One source means the demo shows exactly what the evals check, and a sample cannot be added to the demo
// without being graded.
//
//   node scripts/samples-lb03.ts            write the files (`pnpm --filter @lb/web samples`)
//   node scripts/samples-lb03.ts --check    fail when a file is stale (`pnpm check`, which CI runs)
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'
import { z } from 'zod'

/** Resolves a path relative to this script's folder. */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

const REPOSITORY_ROOT = here('../../../')
const GOLDEN_FILE = here('../../../evals/lb03/golden.yaml')
const SEED_FOLDER = here('../../../data/seed/lb03/')
const MANIFEST_FILE = here('../../../data/seed/lb03/manifest.json')
const OUTPUT_FILE = here('../shared/data/samples/lb03.ts')
const SAMPLES_FOLDER = here('../public/lb03/samples/')
const PAGES_FOLDER = here('../public/lb03/pages/')

const SAMPLE_KINDS = ['clean_pdf', 'euro_vat', 'photo', 'handwritten', 'hostile', 'planted_error'] as const
const MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const
// The most pages the service reads (services/flask-systems/lb03/limits.py): a sample over it would only be refused.
const MAX_SAMPLE_PAGES = 5

// Every case of the golden set has an ID and may name a sample; only the sample cases are read in full.
const goldenSchema = z.object({
  cases: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    sample: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
  }).loose()).min(1),
})

// A text the golden set may write as a number (an invoice number such as 4417), read as the text it is.
const printedText = z.union([z.string(), z.number()]).transform(String)

// The part of a sample's case the demo needs: what it prints, and how its reading must end.
const sampleCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,60}$/),
  kind: z.enum(SAMPLE_KINDS),
  sample: z.string().regex(/^[a-z0-9-]{1,60}$/),
  file: z.string().regex(/^documents\/[\w.-]{1,80}$/),
  printed: z.object({
    document_type: z.enum(['invoice', 'credit_note', 'receipt']),
    vendor: z.string().min(1).max(120),
    invoice_number: printedText.pipe(z.string().min(1).max(40)),
    currency: z.string().regex(/^[A-Z]{3}$/),
    total: printedText.pipe(z.string().regex(/^-?\d{1,12}\.\d{2}$/)),
  }).loose(),
  expect: z.object({
    outcome: z.enum(['valid', 'needs_review', 'held', 'failed']),
    failing_checks: z.array(z.string().regex(/^[a-z_]{1,30}$/)).optional(),
    guard_flags: z.boolean().optional(),
  }).loose(),
}).loose()

// What the manifest says of each seed file.
const manifestSchema = z.object({
  files: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    bytes: z.int().positive(),
    mime: z.enum(MIME_TYPES),
    pages: z.int().min(1).max(20),
  }).loose()).min(1),
})

/** One sample as the demo holds it. */
interface Sample {
  id: string
  goldenCase: string
  kind: (typeof SAMPLE_KINDS)[number]
  file: string
  mime: (typeof MIME_TYPES)[number]
  bytes: number
  pages: number
  documentType: 'invoice' | 'credit_note' | 'receipt'
  vendor: string
  number: string
  currency: string
  total: string
  outcome: 'valid' | 'needs_review' | 'held' | 'failed'
  failingChecks: string[]
  guardFlags: boolean
}

/** A file the script puts in the site's public folder: where it comes from, where it goes, and what it holds. */
interface Asset {
  source: string
  target: string
}

/** Reads the golden set and the manifest and returns the curated samples, in the golden set's order. */
function readSamples(): Sample[] {
  const golden = goldenSchema.parse(parse(readFileSync(GOLDEN_FILE, 'utf8')))
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')))
  const samples = golden.cases
    .filter(item => item.sample !== undefined)
    .map((item): Sample => {
      const found = sampleCaseSchema.parse(item)
      const entry = manifest.files.find(file => file.id === found.id)
      if (entry === undefined) throw new Error(`The seed manifest has no file for the golden case ${found.id}, which is the sample ${found.sample}.`)
      if (entry.pages > MAX_SAMPLE_PAGES) throw new Error(`The sample ${found.sample} has ${entry.pages} pages, and the service reads ${MAX_SAMPLE_PAGES} at most.`)
      return {
        id: found.sample,
        goldenCase: found.id,
        kind: found.kind,
        file: found.file.slice('documents/'.length),
        mime: entry.mime,
        bytes: entry.bytes,
        pages: entry.pages,
        documentType: found.printed.document_type,
        vendor: found.printed.vendor,
        number: found.printed.invoice_number,
        currency: found.printed.currency,
        total: found.printed.total,
        outcome: found.expect.outcome,
        failingChecks: found.expect.failing_checks ?? [],
        guardFlags: found.expect.guard_flags === true,
      }
    })
  if (samples.length === 0) throw new Error('The golden set marks no case as a sample, so the demo would have nothing to open on.')
  if (new Set(samples.map(sample => sample.id)).size !== samples.length) throw new Error('Two cases of the golden set name the same sample.')
  return samples
}

/** Writes text as a TypeScript string literal in the project's style: single quotes, with the text's own escaped. */
function quote(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

/** Writes one sample as an object literal, one field to a line. */
function renderSample(sample: Sample): string {
  const failing = sample.failingChecks.length === 0 ? '[]' : `[${sample.failingChecks.map(quote).join(', ')}]`
  return [
    '  {',
    `    id: ${quote(sample.id)},`,
    `    goldenCase: ${quote(sample.goldenCase)},`,
    `    kind: ${quote(sample.kind)},`,
    `    file: ${quote(sample.file)},`,
    `    mime: ${quote(sample.mime)},`,
    `    bytes: ${sample.bytes},`,
    `    pages: ${sample.pages},`,
    `    documentType: ${quote(sample.documentType)},`,
    `    vendor: ${quote(sample.vendor)},`,
    `    number: ${quote(sample.number)},`,
    `    currency: ${quote(sample.currency)},`,
    `    total: ${quote(sample.total)},`,
    `    outcome: ${quote(sample.outcome)},`,
    `    failingChecks: ${failing},`,
    `    guardFlags: ${sample.guardFlags},`,
    '  },',
  ].join('\n')
}

/** Writes the whole file: its header, the samples and the type of their IDs. */
function renderFile(samples: readonly Sample[]): string {
  return [
    '// GENERATED by scripts/samples-lb03.ts from the cases that name a sample in evals/lb03/golden.yaml and',
    '// the seed\'s manifest, data/seed/lb03/manifest.json.',
    '// Do not edit it by hand: change those files and run `pnpm --filter @lb/web samples`.',
    '// `pnpm check` fails when this file is out of date.',
    'import type { InvoiceSample } from \'./lb03-types\'',
    '',
    '/** The curated documents LB-03\'s demo opens on, in the golden set\'s order. */',
    'export const LB03_SAMPLES = [',
    ...samples.map(renderSample),
    '] as const satisfies readonly InvoiceSample[]',
    '',
    '/** The name of one of LB-03\'s samples, such as `clean-pdf`. */',
    'export type Lb03SampleId = (typeof LB03_SAMPLES)[number][\'id\']',
    '',
  ].join('\n')
}

/** Lists the files of the public folder the samples need: each sample's file, and a picture of each of its pages. */
function expectedAssets(samples: readonly Sample[]): Asset[] {
  return samples.flatMap((sample) => {
    const pictures = Array.from({ length: sample.pages }, (_, index): Asset => {
      const name = `${sample.id}-${index + 1}.jpg`
      return { source: `${SEED_FOLDER}pages/${name}`, target: `${PAGES_FOLDER}${name}` }
    })
    return [{ source: `${SEED_FOLDER}documents/${sample.file}`, target: `${SAMPLES_FOLDER}${sample.file}` }, ...pictures]
  })
}

/** Lists the names in a folder that are not in the expected list: files the golden set no longer asks for. */
function strayFiles(folder: string, wanted: ReadonlySet<string>): string[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder).filter(name => !wanted.has(`${folder}${name}`))
}

/** Writes a path as the repository's own, such as `apps/web/public/lb03/samples/x.pdf`, for a message. */
function shown(path: string): string {
  return path.startsWith(REPOSITORY_ROOT) ? path.slice(REPOSITORY_ROOT.length) : path
}

/** Says what is out of date: the generated file, a missing or changed asset, a file nobody asks for. Empty when all is current. */
function findStale(samples: readonly Sample[], assets: readonly Asset[]): string[] {
  const stale: string[] = []
  const current = existsSync(OUTPUT_FILE) ? readFileSync(OUTPUT_FILE, 'utf8') : ''
  if (current !== renderFile(samples)) stale.push(shown(OUTPUT_FILE))
  for (const asset of assets) {
    const held = existsSync(asset.target) ? readFileSync(asset.target) : undefined
    if (held === undefined || !held.equals(readFileSync(asset.source))) stale.push(shown(asset.target))
  }
  const wanted = new Set(assets.map(asset => asset.target))
  for (const folder of [SAMPLES_FOLDER, PAGES_FOLDER]) {
    for (const name of strayFiles(folder, wanted)) stale.push(`${shown(`${folder}${name}`)} (nothing asks for it)`)
  }
  return stale
}

/** Writes the generated file, copies the assets and removes the files nothing asks for. */
function write(samples: readonly Sample[], assets: readonly Asset[]): void {
  writeFileSync(OUTPUT_FILE, renderFile(samples))
  console.log(`Wrote ${OUTPUT_FILE}.`)
  mkdirSync(SAMPLES_FOLDER, { recursive: true })
  mkdirSync(PAGES_FOLDER, { recursive: true })
  for (const asset of assets) copyFileSync(asset.source, asset.target)
  const wanted = new Set(assets.map(asset => asset.target))
  for (const folder of [SAMPLES_FOLDER, PAGES_FOLDER]) {
    for (const name of strayFiles(folder, wanted)) rmSync(`${folder}${name}`)
  }
  console.log(`Copied ${assets.length} files into ${SAMPLES_FOLDER} and ${PAGES_FOLDER}.`)
}

const samples = readSamples()
const assets = expectedAssets(samples)

if (process.argv.includes('--check')) {
  const stale = findStale(samples, assets)
  if (stale.length > 0) {
    console.error(`LB-03's samples are out of date with evals/lb03/golden.yaml and data/seed/lb03: ${stale.join(', ')}. Run \`pnpm --filter @lb/web samples\` and commit the result.`)
    process.exit(1)
  }
  console.log('LB-03\'s samples are up to date.')
}
else {
  write(samples, assets)
}
