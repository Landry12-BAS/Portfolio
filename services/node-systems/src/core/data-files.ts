// Strict reading of the repository's YAML data files: the seed data and the golden sets.
//
// Every file is parsed by a safe YAML parser, which never builds objects from tags, with
// a low limit on aliases so a file can't expand into something enormous, and then checked
// against a Zod schema in which an unknown field is an error. A problem stops the reader
// with a message naming the file and the path of each bad field inside it, never the
// value that was wrong.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'
import type { z } from 'zod'

/** A data file is missing or unreadable, or it doesn't follow its schema. */
export class DataFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DataFileError'
  }
}

// The repository root: this file is services/node-systems/src/core/data-files.ts. The folder's own path is
// used, not a URL made from `import.meta.url`: the site's component tests run this file under a DOM
// stand-in whose `URL` is not Node's, and Node's `fileURLToPath` refuses it.
const REPOSITORY_ROOT = `${resolve(import.meta.dirname, '../../../..')}/`

/** Returns where the synthetic seed data lives: `LB_SEED_DIR` when set, otherwise the repository's data/seed. */
export function seedDirectory(environment: Readonly<Record<string, string | undefined>> = process.env): string {
  return environment.LB_SEED_DIR?.trim() || `${REPOSITORY_ROOT}data/seed`
}

/** Returns where the golden sets live: `LB_EVALS_DIR` when set, otherwise the repository's evals. */
export function evalsDirectory(environment: Readonly<Record<string, string | undefined>> = process.env): string {
  return environment.LB_EVALS_DIR?.trim() || `${REPOSITORY_ROOT}evals`
}

/** Reads one YAML data file and checks it against its schema, naming the file in any error. */
export function readDataFile<Schema extends z.ZodType>(path: string, schema: Schema): z.infer<Schema> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  }
  catch (error) {
    throw new DataFileError(`${path} can't be read: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`)
  }
  let content: unknown
  try {
    content = parse(text, { maxAliasCount: 20, uniqueKeys: true })
  }
  catch {
    throw new DataFileError(`${path} isn't valid YAML.`)
  }
  const parsed = schema.safeParse(content)
  if (!parsed.success) {
    const problems = parsed.error.issues.map(issue => `${issue.path.join('.') || '(file)'}: ${issue.message}`)
    throw new DataFileError(`${path} doesn't follow its schema:\n- ${problems.join('\n- ')}`)
  }
  return parsed.data as z.infer<Schema>
}
