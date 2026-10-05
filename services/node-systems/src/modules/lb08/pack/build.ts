// LB-08's eval pack: the workflow generator's production prompt and golden set, in the form Eval Lab
// (LB-10) runs. The pack format and its strict reader live in services/flask-systems/lb10/packs.py;
// this module writes that format from this service's own prompt module and golden set, so the lab
// runs the very prompt production runs and never a copy of it.
//
// The system prompt is the one `describeSystemPrompt` builds from the catalogue, and the user
// message is the description between its markers, as `describeUserMessage` writes it: the pack's
// template holds the markers, and the case's input is the description with marker-like text already
// removed, so the template filled in is exactly production's message. The build and resist cases of
// the golden set are in the pack (a reject case's correct answer is a refusal by validation, which
// the lab cannot run). Each is graded by rules over the JSON the model writes: the workflow schema,
// the trigger event, the connectors a correct workflow uses, and, for a resist case, the words the
// injection asked for that must appear nowhere.
import { workflowGraphSchema } from '@lb/contracts'
import { z } from 'zod'

import { readSamples } from '../data/samples.ts'
import { DESCRIBE_ALIAS } from '../generate/model.ts'
import { DESCRIBE_MAX_OUTPUT_TOKENS, describeSystemPrompt, describeUserMessage, withoutMarkers } from '../generate/prompts.ts'
import { readGoldenSet } from '../golden/cases.ts'
import type { BuildCase, ResistCase } from '../golden/cases.ts'
import type { Expectation } from '../golden/expectations.ts'

/** The pack's name, and the command that writes it. */
export const PACK_NAME = 'lb08-generator'
export const MADE_BY = 'just export-pack-lb08'
export const SOURCE = 'services/node-systems/src/modules/lb08/generate/prompts.ts and evals/lb08/golden.yaml'
// The user message as a template: the markers, around the description (`describeUserMessage`).
const USER_TEMPLATE = '<process>\n{{description}}\n</process>'
// A placeholder: `{{description}}`. Fixed here, never built from a string.
const PLACEHOLDER = /\{\{([a-z][a-z0-9_]*)\}\}/g

/** One rule a case is graded by, in the pack's YAML form. */
export type GraderSpec = Record<string, unknown>

/** One materialised case of the pack. */
export interface PackCase {
  id: string
  difficulty: 'easy' | 'medium' | 'hard'
  inputs: Record<string, string>
  expected: Record<string, unknown>
  graders: GraderSpec[]
}

/** The whole pack, in the order the file writes it. */
export interface EvalPack {
  pack: string
  system: string
  target: Record<string, unknown>
  prompt: { system: string, user: string }
  variables: string[]
  common_graders: GraderSpec[]
  cases: PackCase[]
}

/** Rates a case: a description with an injection is hard, a Czech one medium, the rest easy. */
function difficultyOf(entry: BuildCase | ResistCase): PackCase['difficulty'] {
  if (entry.kind === 'resist') return 'hard'
  return entry.language === 'cs' ? 'medium' : 'easy'
}

/** Writes the rules for one case from what the golden set expects of the workflow. */
function gradersOf(expect: Expectation): GraderSpec[] {
  const graders: GraderSpec[] = []
  if (expect.trigger !== undefined) {
    graders.push({ kind: 'json_path_contains_all', path: 'nodes.*.event', values: [expect.trigger] })
  }
  if (expect.connectors !== undefined && expect.connectors.length > 0) {
    graders.push({ kind: 'json_path_contains_all', path: 'nodes.*.connector', values: [...new Set(expect.connectors)] })
  }
  if (expect.forbidText !== undefined && expect.forbidText.length > 0) {
    graders.push({ kind: 'contains_none', values: [...expect.forbidText] })
  }
  return graders
}

/** Writes one golden case as a pack case. */
function packCase(entry: BuildCase | ResistCase): PackCase {
  return {
    id: entry.id,
    difficulty: difficultyOf(entry),
    inputs: { description: withoutMarkers(entry.description.trim()) },
    expected: { trigger: entry.expect.trigger ?? null, connectors: entry.expect.connectors ?? [], forbidText: entry.expect.forbidText ?? [] },
    graders: gradersOf(entry.expect),
  }
}

/** Fills a pack template from a case's inputs, the way the lab does. */
export function render(template: string, inputs: Readonly<Record<string, string>>): string {
  return template.replaceAll(PLACEHOLDER, (_match, name: string) => {
    const value = inputs[name]
    if (value === undefined) throw new Error(`the template needs an input it was not given: ${name}`)
    return value
  })
}

/** Refuses a pack whose filled-in templates differ, for any case, from the messages the pipeline sends. */
export function checkMatchesProduction(pack: EvalPack, cases: readonly (BuildCase | ResistCase)[]): void {
  const byId = new Map(pack.cases.map(entry => [entry.id, entry]))
  for (const entry of cases) {
    const packed = byId.get(entry.id)
    if (!packed) throw new Error(`case ${entry.id} is missing from the pack`)
    const rendered = [render(pack.prompt.system, packed.inputs), render(pack.prompt.user, packed.inputs)]
    const expected = [describeSystemPrompt(), describeUserMessage(entry.description)]
    if (rendered[0] !== expected[0] || rendered[1] !== expected[1]) throw new Error(`case ${entry.id} renders differently from production`)
  }
}

/** Returns the golden cases the pack holds: the ones whose correct answer is a workflow. */
export function packableCases(seedDirectory: string, goldenPath: string): (BuildCase | ResistCase)[] {
  const golden = readGoldenSet(goldenPath, readSamples(seedDirectory))
  return golden.filter((entry): entry is BuildCase | ResistCase => entry.kind !== 'reject')
}

/** Builds the pack from the golden set and the samples, proven to match production. */
export function buildPack(seedDirectory: string, goldenPath: string): EvalPack {
  const cases = packableCases(seedDirectory, goldenPath)
  const pack: EvalPack = {
    pack: PACK_NAME,
    system: 'lb-08',
    target: {
      name: 'LB-08 workflow generator',
      description: 'Turns a plain-language description of a business process into a workflow graph of the automation studio, checked by one schema.',
      source: 'services/node-systems/src/modules/lb08/generate/prompts.ts',
      alias: DESCRIBE_ALIAS,
      model_class: 'tools',
      max_output_tokens: DESCRIBE_MAX_OUTPUT_TOKENS,
      output: 'json',
    },
    prompt: { system: describeSystemPrompt(), user: USER_TEMPLATE },
    variables: [],
    common_graders: [{ kind: 'json_schema', schema: z.toJSONSchema(workflowGraphSchema) }],
    cases: cases.map(packCase),
  }
  checkMatchesProduction(pack, cases)
  return pack
}
