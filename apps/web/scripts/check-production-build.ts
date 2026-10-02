// Proves that the production build holds no trace of the end-to-end test build's stand-in for a
// Turnstile token (`pnpm --filter @lb/web check:build`, which CI runs after `pnpm build`). The
// stand-in is read only behind the build flag `__LB_TEST_BUILD__`, which a production build
// replaces with `false`, so the bundle must contain neither the token nor the flag's name. If it
// does, a visitor's browser could pass the gate with a string anyone can read here.
//
//   node scripts/check-production-build.ts [folder]                     the folder defaults to .output
//   node scripts/check-production-build.ts <folder> --expect-test-code  the opposite check
//
// The opposite check is for the test build: it passes only if the test-only code IS there. CI runs it
// so that the first check is known to look at something that would show a trace if there were one.
// Exit status: 0 the check passed, 1 it failed, 2 there was nothing to look at (no folder, or an
// empty one), which is never a pass in either direction.
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

/** Lists where the test-only words are, as "file contains word" lines. */
function traces(root: string, files: readonly string[]): string[] {
  const found: string[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const word of FORBIDDEN) {
      if (text.includes(word)) found.push(`${relative(root, file)} contains ${word}`)
    }
  }
  return found
}

const args = process.argv.slice(2)
const expectTestCode = args.includes('--expect-test-code')
const root = resolve(args.find(argument => !argument.startsWith('--')) ?? '.output')
const label = relative(process.cwd(), root) || root

if (!existsSync(root)) {
  console.error(`There is no build at ${root}. Run \`pnpm --filter @lb/web build\` first (\`build:e2e\` for the test build).`)
  process.exit(2)
}

const files = textFiles(root)
if (files.length === 0) {
  console.error(`There is nothing to check in ${root}: the folder holds no files. A build was not made, or was emptied since.`)
  process.exit(2)
}

const found = traces(root, files)

if (expectTestCode) {
  if (found.length === 0) {
    console.error(`${label} holds no trace of the test build's stand-in, so the check would not see one in a build that has it.`)
    process.exit(1)
  }
  console.log(`${label}: the test build's stand-in is there, and the check finds it (${found.length} places)`)
}
else if (found.length > 0) {
  console.error('The production build holds code that is only for the test build:')
  for (const line of found) console.error(`- ${line}`)
  process.exit(1)
}
else {
  console.log(`${label}: no trace of the test build's Turnstile stand-in`)
}
