// Regenerates the sprite and the typed registry from svg/*.svg.
// `--check` writes nothing and fails when a generated file is stale (CI drift check).
import { readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'

import { loadIcons, PACKAGE_DIR, REGISTRY_PATH, renderRegistry, renderSprite, SPRITE_PATH } from './icons.ts'

const check = process.argv.includes('--check')
const icons = loadIcons()
const outputs: [string, string][] = [
  [REGISTRY_PATH, renderRegistry(icons)],
  [SPRITE_PATH, renderSprite(icons)],
]

let stale = 0
for (const [path, text] of outputs) {
  const name = relative(PACKAGE_DIR, path)
  if (!check) {
    writeFileSync(path, text)
    continue
  }
  let current = ''
  try {
    current = readFileSync(path, 'utf8')
  }
  catch {
    // A missing file is as stale as an outdated one.
  }
  if (current !== text) {
    console.error(`stale: ${name}`)
    stale++
  }
}

if (stale > 0) {
  console.error('Run `pnpm --filter @lb/icons build` and commit the result.')
  process.exit(1)
}
console.log(`${icons.length} icons: ${check ? 'generated files are up to date' : 'sprite and registry written'}`)
