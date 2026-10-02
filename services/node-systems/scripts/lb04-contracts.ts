// Makes LB-04's synthetic contracts, and checks that the committed ones are the ones this code makes.
//
//   node scripts/lb04-contracts.ts            write data/seed/lb04/contracts/*.pdf
//   node scripts/lb04-contracts.ts --check    write nothing, and fail when a committed PDF differs from what
//                                             the code makes, is missing, or has no code behind it (`pnpm check`)
//
// The contracts are made with pdf-lib, a development dependency that the service's image doesn't
// carry: the PDFs are committed, and the service only reads them. The same code always makes the
// same bytes, so a difference means someone changed the text, the layout or pdf-lib without
// making the files again.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { SEED_CONTRACTS } from './lb04/contracts.ts'

// The repository's data/seed/lb04/contracts folder: this file is services/node-systems/scripts/lb04-contracts.ts.
const FOLDER = fileURLToPath(new URL('../../../data/seed/lb04/contracts/', import.meta.url))

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
if (!check) mkdirSync(FOLDER, { recursive: true })
for (const contract of SEED_CONTRACTS) {
  const name = `${contract.id}.pdf`
  const made = Buffer.from(await contract.build())
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
if (check) for (const name of strays()) problems.push(`data/seed/lb04/contracts/${name} is made by no code`)

if (problems.length > 0) {
  console.error(`${problems.join('\n')}\nRun \`pnpm --filter @lb/node-systems contracts:lb04\` and commit the result.`)
  process.exitCode = 1
}
else if (check) {
  console.log(`LB-04's ${SEED_CONTRACTS.length} seed contracts are up to date`)
}
