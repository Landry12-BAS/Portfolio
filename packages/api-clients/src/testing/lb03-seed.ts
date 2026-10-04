// What the mock's LB-03 reads from the repository instead of writing out a second time: the golden set
// (evals/lb03/golden.yaml: what each synthetic document prints, and how the service must end it), the
// manifest of the seed files (data/seed/lb03/manifest.json: each file's hash and the box of every printed
// field), the chart of accounts, and the page pictures of the samples. So the documents a visitor
// uploads are recognised by their hash, read as the golden set says, and lit up where the generator
// drew each field, and the mock cannot drift from the real documents.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'

import { invoiceFromTruth } from './lb03-engine.ts'
import type { Chart, Invoice } from './lb03-engine.ts'

/** How the service must end a document of the golden set. */
export interface Lb03Expectation {
  outcome: 'valid' | 'needs_review' | 'held' | 'failed'
  failingChecks: string[]
  failure: string | undefined
  guardFlags: boolean
}

/** Where one field is printed. */
export interface Lb03FieldBox {
  path: string
  page: number
  quad: number[]
}

/** One document of the golden set, with what the manifest holds of its file. */
export interface Lb03Case {
  id: string
  title: string
  kind: string
  sample: string | undefined
  file: string
  invoice: Invoice | undefined
  expect: Lb03Expectation
  sha256: string
  bytes: number
  mime: string
  pages: number
  boxes: Lb03FieldBox[]
}

/** Everything the mock's LB-03 reads. */
export interface Lb03Seed {
  // The day the checks are judged on.
  today: string
  cases: Lb03Case[]
  chart: Chart
  // The picture of a sample's page, or undefined for a document that is not a sample.
  picture: (sample: string, page: number) => Buffer | undefined
  // The bytes of a seed file, as the generator drew it.
  file: (name: string) => Buffer
}

// The repository's root, from this file: packages/api-clients/src/testing/.
const REPOSITORY_ROOT = `${resolve(import.meta.dirname, '../../../..')}/`
const SEED = 'data/seed/lb03'

/** A parsed YAML or JSON document, before it is looked at. */
type Loose = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** Reads a text file of the repository. */
function readText(path: string): string {
  return readFileSync(`${REPOSITORY_ROOT}${path}`, 'utf8')
}

/** Reads the chart of accounts. */
function readChart(): Chart {
  const document = parse(readText(`${SEED}/chart_of_accounts.yaml`)) as Loose
  return {
    accounts: (document.accounts as Loose[]).map(account => ({ code: String(account.code), name: String(account.name), kind: String(account.kind) })),
    payable: String(document.payable),
    cash: String(document.cash),
    inputVat: String(document.input_vat),
    rounding: String(document.rounding),
    defaultExpense: String(document.default_expense),
    rules: (document.rules as Loose[]).map(rule => ({ account: String(rule.account), keywords: (rule.keywords as unknown[]).map(String) })),
  }
}

/** Reads the golden set and the manifest together, one case for each document. */
function readCases(): { today: string, cases: Lb03Case[] } {
  const golden = parse(readText('evals/lb03/golden.yaml')) as Loose
  const manifest = JSON.parse(readText(`${SEED}/manifest.json`)) as { files: Loose[] }
  const files = new Map(manifest.files.map(entry => [String(entry.id), entry]))
  const cases = (golden.cases as Loose[]).map((item): Lb03Case => {
    const entry = files.get(String(item.id))
    if (entry === undefined) throw new Error(`The manifest has no file for the golden case ${String(item.id)}.`)
    const expect = item.expect as Loose
    return {
      id: String(item.id),
      title: String(item.title),
      kind: String(item.kind),
      sample: item.sample === undefined ? undefined : String(item.sample),
      file: String(item.file),
      invoice: item.printed === undefined ? undefined : invoiceFromTruth(item.printed as Record<string, unknown>),
      expect: {
        outcome: expect.outcome,
        failingChecks: (expect.failing_checks ?? []) as string[],
        failure: expect.failure === undefined ? undefined : String(expect.failure),
        guardFlags: expect.guard_flags === true,
      },
      sha256: String(entry.sha256),
      bytes: Number(entry.bytes),
      mime: String(entry.mime),
      pages: Number(entry.pages),
      boxes: (entry.fields as Loose[]).map(box => ({ path: String(box.path), page: Number(box.page), quad: (box.quad as unknown[]).map(Number) })),
    }
  })
  return { today: String(golden.today), cases }
}

/** Reads LB-03's seed, the golden set and the chart from the repository. */
export function readLb03Seed(): Lb03Seed {
  const { today, cases } = readCases()
  return {
    today,
    cases,
    chart: readChart(),
    picture: (sample, page) => {
      try {
        return readFileSync(`${REPOSITORY_ROOT}${SEED}/pages/${sample}-${page}.jpg`)
      }
      catch {
        return undefined
      }
    },
    file: name => readFileSync(`${REPOSITORY_ROOT}${SEED}/${name}`),
  }
}
