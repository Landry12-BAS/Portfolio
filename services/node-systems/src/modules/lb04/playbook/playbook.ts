// LB-04's playbook as the service reads it: data/seed/lb04/playbook.yaml, read strictly (an
// unknown field is an error, and so is a topic, a rule or a reference that doesn't hold together).
// The playbook is data kept outside every prompt. The prompts are built from the rules that are
// read here, by rule id, so the owner edits a rule in the YAML and no code or prompt changes; and a
// model never invents a rule, because every id it names is looked up here.
import { LB04_SEVERITIES, LB04_TOPICS } from '@lb/contracts'
import type { Lb04PlaybookView, Lb04Severity, Lb04Topic } from '@lb/contracts'
import { z } from 'zod'

import { readDataFile } from '../../../core/data-files.ts'

const ruleId = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/)
/** A trimmed, non-empty text of at most `max` characters. */
const text = (max: number) => z.string().trim().min(1).max(max)
// What a rule has whatever its kind.
const ruleBase = {
  id: ruleId,
  title: text(80),
  severity: z.enum(LB04_SEVERITIES),
  acceptable: text(600),
  red_flag: text(600),
  summary: text(400),
  fallback: text(1_400),
}

const riskRuleSchema = z.strictObject({ ...ruleBase, kind: z.literal('risk') })
const requiredRuleSchema = z.strictObject({
  ...ruleBase,
  kind: z.literal('required'),
  detect: z.strictObject({ phrases: z.array(z.string().trim().min(3).max(60)).min(1).max(24) }),
  suppressed_by: z.array(ruleId).max(6).default([]),
})

const topicSchema = z.strictObject({
  id: z.enum(LB04_TOPICS),
  title: text(60),
  summary: text(300),
  rules: z.array(z.discriminatedUnion('kind', [riskRuleSchema, requiredRuleSchema])).min(1).max(8),
})

/** The playbook file as it is written. */
export const playbookFileSchema = z.strictObject({
  version: z.int().min(1),
  perspective: text(500),
  topics: z.array(topicSchema).length(LB04_TOPICS.length),
})

/** One rule of the playbook. */
export interface PlaybookRule {
  id: string
  topic: Lb04Topic
  // `risk` rules flag a passage that is there; `required` rules flag a clause that is missing.
  kind: 'risk' | 'required'
  title: string
  // The base severity: what a finding on this rule counts for, give or take one step.
  severity: Lb04Severity
  acceptable: string
  redFlag: string
  // The sentence a finding carries when the model gives none.
  summary: string
  // The wording a redline proposes.
  fallback: string
  // For a `required` rule: the phrases whose presence anywhere in the text means the clause is there.
  phrases: readonly string[]
  // For a `required` rule: the risk rules that already report the gap when they have a finding.
  suppressedBy: readonly string[]
}

/** One topic and its rules. */
export interface PlaybookTopic {
  id: Lb04Topic
  title: string
  summary: string
  rules: readonly PlaybookRule[]
}

/** The playbook: its topics in the radar's order, and every rule by its id. */
export interface Playbook {
  version: number
  perspective: string
  topics: readonly PlaybookTopic[]
  rules: ReadonlyMap<string, PlaybookRule>
}

/** Turns one rule as the file writes it into a rule as the service uses it. */
function toRule(topic: Lb04Topic, rule: z.infer<typeof riskRuleSchema> | z.infer<typeof requiredRuleSchema>): PlaybookRule {
  return {
    id: rule.id,
    topic,
    kind: rule.kind,
    title: rule.title,
    severity: rule.severity,
    acceptable: rule.acceptable,
    redFlag: rule.red_flag,
    summary: rule.summary,
    fallback: rule.fallback,
    phrases: rule.kind === 'required' ? rule.detect.phrases : [],
    suppressedBy: rule.kind === 'required' ? rule.suppressed_by : [],
  }
}

/** Collects what is wrong with the playbook beyond its fields: topics out of order, repeated ids, references that lead nowhere. */
function problemsIn(topics: readonly PlaybookTopic[]): string[] {
  const problems: string[] = []
  const order = topics.map(topic => topic.id)
  if (order.join() !== LB04_TOPICS.join()) problems.push(`the topics must be, in this order: ${LB04_TOPICS.join(', ')}`)
  const rules = topics.flatMap(topic => topic.rules)
  const ids = rules.map(rule => rule.id)
  for (const id of new Set(ids.filter((candidate, index) => ids.indexOf(candidate) !== index))) problems.push(`the rule id ${id} is used twice`)
  const byId = new Map(rules.map(rule => [rule.id, rule]))
  for (const rule of rules) {
    for (const other of rule.suppressedBy) {
      const target = byId.get(other)
      if (target?.kind !== 'risk' || target.topic !== rule.topic) problems.push(`${rule.id}: suppressed_by must name a risk rule of the same topic, and ${other} is not one`)
    }
  }
  return problems
}

/** Reads the playbook in a seed directory, strictly, and says what is wrong with it if anything is. */
export function readPlaybook(seedDirectory: string): Playbook {
  const path = `${seedDirectory}/lb04/playbook.yaml`
  const file = readDataFile(path, playbookFileSchema)
  const topics: PlaybookTopic[] = file.topics.map(topic => ({ id: topic.id, title: topic.title, summary: topic.summary, rules: topic.rules.map(rule => toRule(topic.id, rule)) }))
  const problems = problemsIn(topics)
  if (problems.length > 0) throw new Error(`${path} has problems:\n- ${problems.join('\n- ')}`)
  const rules = new Map(topics.flatMap(topic => topic.rules).map(rule => [rule.id, rule] as const))
  return { version: file.version, perspective: file.perspective, topics, rules }
}

/** The playbook as the board shows it: what is acceptable and what is a red flag, for each rule. The wording of a redline and the phrases a detector searches for stay on the server. */
export function playbookView(playbook: Playbook): Lb04PlaybookView {
  return {
    version: playbook.version,
    topics: playbook.topics.map(topic => ({
      id: topic.id,
      title: topic.title,
      summary: topic.summary,
      rules: topic.rules.map(rule => ({ id: rule.id, title: rule.title, kind: rule.kind, severity: rule.severity, acceptable: rule.acceptable, redFlag: rule.redFlag })),
    })),
  }
}
