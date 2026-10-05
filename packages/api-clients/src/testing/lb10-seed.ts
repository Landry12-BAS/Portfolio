// What the mock's LB-10 reads from the repository instead of writing out a second time: the eval
// packs (evals/packs/*.yaml), each with the production prompt, its variables, its tools and its
// cases. So the targets a visitor picks from and the prompts they edit are the real ones, and the
// mock cannot drift from them. Only the shapes the mock needs are read; the strict reader is
// services/flask-systems/lb10/packs.py.
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'

/** One case of a pack, as the mock shows it. */
export interface Lb10CaseSeed {
  id: string
  difficulty: 'easy' | 'medium' | 'hard'
  inputs: Record<string, string>
  expected: Record<string, unknown>
  graderKinds: string[]
}

/** One pack: what the mock lists as a target. */
export interface Lb10PackSeed {
  pack: string
  system: string
  name: string
  description: string
  source: string
  alias: string
  modelClass: 'fast' | 'tools' | 'reason'
  output: 'json' | 'text' | 'tool_calls'
  systemPrompt: string
  userTemplate: string
  variables: string[]
  toolNames: string[]
  commonGraderKinds: string[]
  cases: Lb10CaseSeed[]
}

/** Everything the mock's LB-10 reads. */
export interface Lb10Seed {
  packs: Lb10PackSeed[]
}

// The repository root: this file is packages/api-clients/src/testing/lb10-seed.ts.
const REPOSITORY_ROOT = `${resolve(import.meta.dirname, '../../../..')}/`
const PACKS_DIRECTORY = `${REPOSITORY_ROOT}evals/packs`

/** A loosely typed YAML document, before the fields the mock needs are picked out. */
type Loose = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** Reads the kinds of a list of graders. */
function kinds(graders: unknown): string[] {
  return Array.isArray(graders) ? graders.map(grader => String((grader as Loose).kind)) : []
}

/** Reads one pack file into the shape the mock needs. */
function readPack(path: string): Lb10PackSeed {
  const document = parse(readFileSync(path, 'utf8')) as Loose
  return {
    pack: String(document.pack),
    system: String(document.system),
    name: String(document.target.name),
    description: String(document.target.description),
    source: String(document.target.source),
    alias: String(document.target.alias),
    modelClass: document.target.model_class,
    output: document.target.output,
    systemPrompt: String(document.prompt.system),
    userTemplate: String(document.prompt.user),
    variables: (document.variables ?? []).map(String),
    toolNames: ((document.tools ?? []) as Loose[]).map(tool => String(tool.name)),
    commonGraderKinds: kinds(document.common_graders),
    cases: (document.cases as Loose[]).map(entry => ({
      id: String(entry.id),
      difficulty: entry.difficulty,
      inputs: entry.inputs,
      expected: entry.expected ?? {},
      graderKinds: [...kinds(document.common_graders), ...kinds(entry.graders)],
    })),
  }
}

/** Reads every pack in evals/packs, by file name. */
export function readLb10Seed(): Lb10Seed {
  const files = readdirSync(PACKS_DIRECTORY).filter(name => name.endsWith('.yaml')).sort()
  return { packs: files.map(name => readPack(`${PACKS_DIRECTORY}/${name}`)) }
}
