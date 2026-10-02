// Proves that the production build holds no trace of the end-to-end test build's stand-in for a
// Turnstile token (`pnpm --filter @lb/web check:build`, which CI runs after `pnpm build`). The
// stand-in is read only behind the build flag `__LB_TEST_BUILD__`, which a production build
// replaces with `false`, so the bundle must contain neither the token nor the flag's name. If it
// does, a visitor's browser could pass the gate with a string anyone can read here.
//
//   node scripts/check-production-build.ts [folder]    the folder defaults to .output
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

// What a production build must not contain: the stand-in token, and the flag that guards it.
const FORBIDDEN = ['lb-test-turnstile-stand-in', '__LB_TEST_BUILD__']
// The kinds of file that hold code or text. Images and fonts are skipped.
const TEXT_FILE = /\.(?:mjs|js|cjs|json|html|css|map|txt)$/

/** Lists every text file under a folder. */
function textFiles(folder: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(folder)) {
    const path = join(folder, name)
    if (statSync(path).isDirectory()) files.push(...textFiles(path))
    else if (TEXT_FILE.test(name)) files.push(path)
  }
  return files
}

const root = resolve(process.argv[2] ?? '.output')
if (!existsSync(root)) {
  console.error(`There is no build at ${root}. Run \`pnpm --filter @lb/web build\` first.`)
  process.exit(1)
}

const found: string[] = []
for (const file of textFiles(root)) {
  const text = readFileSync(file, 'utf8')
  for (const word of FORBIDDEN) {
    if (text.includes(word)) found.push(`${relative(root, file)} contains ${word}`)
  }
}

if (found.length > 0) {
  console.error('The production build holds code that is only for the test build:')
  for (const line of found) console.error(`- ${line}`)
  process.exit(1)
}
console.log(`${relative(process.cwd(), root) || root}: no trace of the test build's Turnstile stand-in`)
