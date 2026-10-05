// Makes `shared/data/samples/lb10.ts`, the curated starting points LB-10's demo opens on: each a target with a
// prepared edit of its production prompt (data/seed/lb10/samples.yaml), applied here to the production prompt
// the target's pack carries (evals/packs), and checked by the service's own rules (services/flask-systems/lb10/
// prompt_check.py, which the board's prompt.ts mirrors): not empty, within the limit, plain text, and exactly
// the pack's variables. The generated file holds the prompt each edit makes, so the board sends exactly what
// was checked. One source means a sample cannot drift from production: when a pack's prompt changes under an
// edit, the edit stops applying or its prompt changes, and the check below fails until the file is made again.
//
//   node scripts/samples-lb10.ts            write the file (`pnpm --filter @lb/web samples`)
//   node scripts/samples-lb10.ts --check    fail when the file is stale (`pnpm check`, which CI runs)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'
import { z } from 'zod'

import { checkPrompt } from '../app/boards/lb-10/prompt.ts'
import type { EvalSample, EvalSampleEdit } from '../shared/data/samples/lb10-types.ts'

/** Resolves a path relative to this script's folder. */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

const SAMPLES_FILE = here('../../../data/seed/lb10/samples.yaml')
const PACKS_DIRECTORY = here('../../../evals/packs')
const OUTPUT_FILE = here('../shared/data/samples/lb10.ts')
// The most characters a visitor's prompt may have: MAX_PROMPT_CHARS in services/flask-systems/lb10/limits.py.
const MAX_PROMPT_CHARS = 8_000

const key = z.string().regex(/^[a-z0-9-]{1,60}$/)
const line = z.string().min(1).max(4_000)

// One sample as the list writes it.
const sampleSchema = z.strictObject({
  id: key,
  pack: key,
  providers: z.array(z.enum(['groq', 'workers-ai'])).min(1).max(2),
  edit: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('insert'), after: line, line }),
    z.strictObject({ kind: z.literal('replace'), text: line, with: line }),
    z.strictObject({ kind: z.literal('remove-lines'), prefixes: z.array(line).min(1).max(10) }),
    z.strictObject({ kind: z.literal('unchanged') }),
  ]),
})
const listSchema = z.strictObject({ samples: z.array(sampleSchema).min(1).max(12) })
// The part of a pack the samples need: its name, its production prompt and its variables.
const packSchema = z.object({
  pack: key,
  prompt: z.object({ system: z.string().min(1) }),
  variables: z.array(z.string()).default([]),
})

/** One sample as the list writes it. */
type ListedSample = z.infer<typeof sampleSchema>
/** The part of a pack the samples need. */
type Pack = z.infer<typeof packSchema>

/** Reads a pack by its name from evals/packs. */
function readPack(name: string): Pack {
  const path = `${PACKS_DIRECTORY}/${name}.yaml`
  if (!existsSync(path)) throw new Error(`There is no pack called ${name} in evals/packs.`)
  return packSchema.parse(parse(readFileSync(path, 'utf8')))
}

/** Counts how many times a passage appears in a text. */
function occurrences(text: string, passage: string): number {
  return text.split(passage).length - 1
}

/** Applies a sample's edit to production's prompt, and returns the prompt with the edit as the board describes it. */
function applyEdit(sample: ListedSample, production: string): { prompt: string, edit: EvalSampleEdit } {
  const edit = sample.edit
  switch (edit.kind) {
    case 'unchanged':
      return { prompt: production, edit: { kind: 'unchanged' } }
    case 'insert': {
      const lines = production.split('\n')
      const at = lines.indexOf(edit.after)
      if (at < 0 || lines.lastIndexOf(edit.after) !== at) throw new Error(`${sample.id}: the line to insert after is not exactly one line of ${sample.pack}'s production prompt.`)
      lines.splice(at + 1, 0, edit.line)
      return { prompt: lines.join('\n'), edit: { kind: 'insert', after: edit.after, line: edit.line } }
    }
    case 'replace':
      if (occurrences(production, edit.text) !== 1) throw new Error(`${sample.id}: the passage to replace is not in ${sample.pack}'s production prompt exactly once.`)
      return { prompt: production.replace(edit.text, () => edit.with), edit: { kind: 'replace', text: edit.text, with: edit.with } }
    case 'remove-lines': {
      const lines = production.split('\n')
      const removed = edit.prefixes.map((prefix) => {
        const matching = lines.filter(candidate => candidate.startsWith(prefix))
        if (matching.length !== 1) throw new Error(`${sample.id}: "${prefix}" starts ${matching.length} lines of ${sample.pack}'s production prompt, not one.`)
        return matching[0] ?? ''
      })
      return { prompt: lines.filter(candidate => !removed.includes(candidate)).join('\n'), edit: { kind: 'remove-lines', lines: removed } }
    }
  }
}

/** Reads the list, applies each edit, and checks each prompt by the service's rules. */
function readSamples(): EvalSample[] {
  const list = listSchema.parse(parse(readFileSync(SAMPLES_FILE, 'utf8')))
  const ids = list.samples.map(sample => sample.id)
  if (new Set(ids).size !== ids.length) throw new Error('Two samples share an ID.')
  return list.samples.map((sample) => {
    const pack = readPack(sample.pack)
    const { prompt, edit } = applyEdit(sample, pack.prompt.system)
    const issues = checkPrompt(prompt, pack.variables, MAX_PROMPT_CHARS)
    if (issues.length > 0) throw new Error(`${sample.id}: the edited prompt would be refused (${issues.map(issue => issue.code).join(', ')}).`)
    if (edit.kind !== 'unchanged' && prompt === pack.prompt.system) throw new Error(`${sample.id}: the edit changes nothing.`)
    return { id: sample.id, pack: sample.pack, providers: sample.providers, edit, prompt }
  })
}

/** Writes text as a TypeScript string literal in the project's style: single quotes, line breaks and tabs escaped. */
function quote(text: string): string {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')
  return `'${escaped}'`
}

/** Writes a sample's edit as an object literal. */
function renderEdit(edit: EvalSampleEdit): string {
  switch (edit.kind) {
    case 'unchanged': return `{ kind: 'unchanged' }`
    case 'insert': return `{ kind: 'insert', after: ${quote(edit.after)}, line: ${quote(edit.line)} }`
    case 'replace': return `{ kind: 'replace', text: ${quote(edit.text)}, with: ${quote(edit.with)} }`
    case 'remove-lines': return `{ kind: 'remove-lines', lines: [${edit.lines.map(quote).join(', ')}] }`
  }
}

/** Writes one sample as an object literal, one field to a line. */
function renderSample(sample: EvalSample): string {
  return [
    '  {',
    `    id: ${quote(sample.id)},`,
    `    pack: ${quote(sample.pack)},`,
    `    providers: [${sample.providers.map(quote).join(', ')}],`,
    `    edit: ${renderEdit(sample.edit)},`,
    `    prompt: ${quote(sample.prompt)},`,
    '  },',
  ].join('\n')
}

/** Writes the whole file: its header, the samples and the type of their IDs. */
function renderFile(samples: readonly EvalSample[]): string {
  return [
    '// GENERATED by scripts/samples-lb10.ts from data/seed/lb10/samples.yaml and the production prompts in evals/packs.',
    '// Do not edit it by hand: change those files and run `pnpm --filter @lb/web samples`.',
    '// `pnpm check` fails when this file is out of date.',
    'import type { EvalSample } from \'./lb10-types\'',
    '',
    '/** The curated starting points LB-10\'s demo opens on: a target, its prepared edit and the prompt it makes, in the list\'s order. */',
    'export const LB10_SAMPLES = [',
    ...samples.map(renderSample),
    '] as const satisfies readonly EvalSample[]',
    '',
    '/** The ID of one of LB-10\'s samples, such as `drafter-word-limit`. */',
    'export type Lb10SampleId = (typeof LB10_SAMPLES)[number][\'id\']',
    '',
  ].join('\n')
}

const expected = renderFile(readSamples())

if (process.argv.includes('--check')) {
  const current = existsSync(OUTPUT_FILE) ? readFileSync(OUTPUT_FILE, 'utf8') : ''
  if (current !== expected) {
    console.error('apps/web/shared/data/samples/lb10.ts is out of date with data/seed/lb10/samples.yaml and evals/packs. Run `pnpm --filter @lb/web samples` and commit the result.')
    process.exit(1)
  }
  console.log('LB-10\'s samples are up to date.')
}
else {
  writeFileSync(OUTPUT_FILE, expected)
  console.log(`Wrote ${OUTPUT_FILE}.`)
}
