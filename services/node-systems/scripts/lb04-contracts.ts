// Makes LB-04's synthetic contracts, and checks that the committed ones are the ones this code makes.
//
//   node scripts/lb04-contracts.ts            write data/seed/lb04/contracts/*.pdf and data/seed/lb04/samples.yaml
//   node scripts/lb04-contracts.ts --check    write nothing, and fail when a committed PDF or the list of them
//                                             differs from what the code makes, is missing, or has no code behind it (`pnpm check`)
//
// The contracts are made with pdf-lib, a development dependency that the service's image doesn't
// carry: the PDFs are committed, and the service only reads them. The same code always makes the
// same bytes, so a difference means someone changed the text, the layout or pdf-lib without
// making the files again.
//
// The list (samples.yaml) says, for each contract, its title, its page count, its size and a hash of
// its bytes. The service reads the list, offers exactly the contracts on it, and refuses a file whose
// bytes don't match: a contract it serves is the one that was made here.
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PDFDocument } from 'pdf-lib'

import { SEED_CONTRACTS } from './lb04/contracts.ts'

// The repository's data/seed/lb04/contracts folder: this file is services/node-systems/scripts/lb04-contracts.ts.
const FOLDER = fileURLToPath(new URL('../../../data/seed/lb04/contracts/', import.meta.url))
// The list of the contracts, beside the folder.
const LIST = fileURLToPath(new URL('../../../data/seed/lb04/samples.yaml', import.meta.url))

/** What the list says about one contract. */
interface ListEntry {
  id: string
  title: string
  pages: number
  bytes: number
  sha256: string
}

/** Describes a made contract for the list: its page count, size and hash. */
async function describe(id: string, title: string, made: Buffer): Promise<ListEntry> {
  const document = await PDFDocument.load(made, { updateMetadata: false })
  return { id, title, pages: document.getPageCount(), bytes: made.length, sha256: createHash('sha256').update(made).digest('hex') }
}

/** Writes the list as YAML, in the order of the seed contracts. Titles are quoted, so no title can be read as anything else. */
function listText(entries: readonly ListEntry[]): string {
  const lines = [
    '# Made by services/node-systems/scripts/lb04-contracts.ts: do not edit by hand.',
    '# The synthetic contracts LB-04 offers as samples, with what each file must be: the service',
    '# reads the list, offers exactly these contracts and refuses a file whose bytes differ.',
    'contracts:',
  ]
  for (const entry of entries) {
    lines.push(`  - id: ${entry.id}`, `    title: ${JSON.stringify(entry.title)}`, `    pages: ${entry.pages}`, `    bytes: ${entry.bytes}`, `    sha256: ${entry.sha256}`)
  }
  return `${lines.join('\n')}\n`
}

/** Reads a committed file, or undefined when it isn't there. */
function committed(name: string): Buffer | undefined {
  try {
    return readFileSync(`${FOLDER}${name}`)
  }
  catch {
    return undefined
  }
}

/** Lists the PDFs in the folder that no seed contract makes. */
function strays(): string[] {
  const expected = new Set(SEED_CONTRACTS.map(contract => `${contract.id}.pdf`))
  try {
    return readdirSync(FOLDER).filter(name => !expected.has(name))
  }
  catch {
    return []
  }
}

const check = process.argv.includes('--check')
const problems: string[] = []
const entries: ListEntry[] = []
if (!check) mkdirSync(FOLDER, { recursive: true })
for (const contract of SEED_CONTRACTS) {
  const name = `${contract.id}.pdf`
  const made = Buffer.from(await contract.build())
  entries.push(await describe(contract.id, contract.title, made))
  if (check) {
    const existing = committed(name)
    if (existing === undefined) problems.push(`data/seed/lb04/contracts/${name} is missing`)
    else if (!existing.equals(made)) problems.push(`data/seed/lb04/contracts/${name} is stale`)
  }
  else {
    writeFileSync(`${FOLDER}${name}`, made)
    console.log(`${name}: ${made.length} bytes`)
  }
}
if (check) {
  for (const name of strays()) problems.push(`data/seed/lb04/contracts/${name} is made by no code`)
  const existing = committed('../samples.yaml')
  if (existing === undefined) problems.push('data/seed/lb04/samples.yaml is missing')
  else if (existing.toString('utf8') !== listText(entries)) problems.push('data/seed/lb04/samples.yaml is stale')
}
else {
  writeFileSync(LIST, listText(entries))
  console.log(`samples.yaml: ${entries.length} contracts`)
}

if (problems.length > 0) {
  console.error(`${problems.join('\n')}\nRun \`pnpm --filter @lb/node-systems contracts:lb04\` and commit the result.`)
  process.exitCode = 1
}
else if (check) {
  console.log(`LB-04's ${SEED_CONTRACTS.length} seed contracts are up to date`)
}
