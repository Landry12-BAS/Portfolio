// What the mock's LB-05 reads from the repository instead of writing out a second time: the
// semantic layer (data/seed/lb05/semantic_layer.yaml), the golden set's questions, and the adversarial
// set's attempts (evals/lb05/*.yaml), each with the query a model that obeyed would write and the
// layer and rule that stop it. So the layer a visitor browses, the curated questions and the attacks
// are the real ones, and the mock cannot drift from them.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'

/** A column of the semantic layer. */
export interface LayerColumnSeed {
  name: string
  type: string
  description: string
  values: (string | number)[]
  nullable: boolean
}

/** A table of the semantic layer. */
export interface LayerTableSeed {
  name: string
  description: string
  columns: LayerColumnSeed[]
}

/** A metric of the semantic layer: an expression, or a worked example. */
export interface LayerMetricSeed {
  name: string
  label: string
  description: string
  kind: 'expression' | 'worked_example'
  definition: string
  needs: string[]
  synonyms: string[]
}

/** A way to slice a metric. */
export interface LayerDimensionSeed {
  name: string
  description: string
  expression: string
  needs: string[]
  synonyms: string[]
}

/** The semantic layer as the mock serves it, without the date phrases, which depend on the day. */
export interface LayerSeed {
  version: number
  tables: LayerTableSeed[]
  joins: { left: string, right: string }[]
  metrics: LayerMetricSeed[]
  dimensions: LayerDimensionSeed[]
}

/** One golden-set question. */
export interface QuestionSeed {
  id: string
  question: string
  sample: boolean
}

/** One attempt of the adversarial set. */
export interface AttackSeed {
  id: string
  category: string
  question: string
  sql: string
  stoppedBy: string
  rule: string
  mustRefuse: boolean
}

/** Everything the mock's LB-05 reads. */
export interface Lb05Seed {
  layer: LayerSeed
  questions: QuestionSeed[]
  attacks: AttackSeed[]
}

// The repository's root, from this file: packages/api-clients/src/testing/.
const REPOSITORY_ROOT = `${resolve(import.meta.dirname, '../../../..')}/`

/** A parsed YAML document, before it is looked at. */
type Loose = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

/** Reads and parses one YAML file of the repository. */
function readYaml(path: string): Loose {
  return parse(readFileSync(`${REPOSITORY_ROOT}${path}`, 'utf8')) as Loose
}

/** Collapses the white space of a folded YAML text into single spaces. */
function oneLine(text: unknown): string {
  return String(text).replace(/\s+/g, ' ').trim()
}

/** Reads the semantic layer the way the back end serves it. */
function readLayer(): LayerSeed {
  const document = readYaml('data/seed/lb05/semantic_layer.yaml')
  return {
    version: Number(document.version),
    tables: (document.tables as Loose[]).map(table => ({
      name: table.name,
      description: table.description,
      columns: (table.columns as Loose[]).map(column => ({
        name: column.name,
        type: column.type,
        description: column.description,
        values: column.values ?? [],
        nullable: column.nullable === true,
      })),
    })),
    joins: (document.joins as Loose[]).map(join => ({ left: join.left, right: join.right })),
    metrics: (document.metrics as Loose[]).map(metric => ({
      name: metric.name,
      label: metric.label,
      description: metric.description,
      kind: metric.expression === undefined ? 'worked_example' : 'expression',
      definition: oneLine(metric.expression ?? metric.pattern),
      needs: metric.needs,
      synonyms: metric.synonyms,
    })),
    dimensions: (document.dimensions as Loose[]).map(dimension => ({
      name: dimension.name,
      description: dimension.description,
      expression: dimension.expression,
      needs: dimension.needs,
      synonyms: dimension.synonyms,
    })),
  }
}

/** Reads the golden set's questions. */
function readQuestions(): QuestionSeed[] {
  return (readYaml('evals/lb05/golden.yaml').cases as Loose[]).map(item => ({ id: item.id, question: oneLine(item.question), sample: item.sample === true }))
}

/** Reads the adversarial set's attempts. */
function readAttacks(): AttackSeed[] {
  return (readYaml('evals/lb05/adversarial.yaml').attempts as Loose[]).map(item => ({
    id: item.id,
    category: item.category,
    question: oneLine(item.question),
    sql: String(item.sql).trim(),
    stoppedBy: item.stopped_by,
    rule: item.rule,
    mustRefuse: item.must_refuse !== false,
  }))
}

/** Reads LB-05's seed, the golden set and the adversarial set from the repository. */
export function readLb05Seed(): Lb05Seed {
  return { layer: readLayer(), questions: readQuestions(), attacks: readAttacks() }
}
