// LB-04's golden set: the seed contracts and what a correct review of each finds, written before
// any prompt (docs/PLAYBOOK.md, step 3). It lives in evals/lb04/golden.yaml, is read strictly (an
// unknown field is an error) and is graded by rules alone, never by a model (evaluate.ts).
//
// Two kinds of case:
// - `report`: a contract the system reads. It lists the problems planted in it (the playbook rule,
//   the topic, the clause number, the severity and the words), the problems a careful reviewer may
//   also report (`tolerated`), the clauses that are missing, whether the contract talks to its
//   reviewer and the words it says.
// - `refused`: a file the system must refuse, with the reason, before any model is asked.
//
// The reader also checks the set against the playbook and the seed contracts: every rule exists and
// is of the right kind and topic, and every seed contract has exactly one case. What the cases say
// about the PDFs themselves is checked by an offline test against the real files.
import { LB04_FAILURE_CODES, LB04_FILE_FAILURES, LB04_LIMITS, LB04_SEVERITIES, LB04_TOPICS, foldQuote } from '@lb/contracts'
import type { Lb04FailureCode, Lb04Severity, Lb04Topic } from '@lb/contracts'
import { z } from 'zod'

import { readDataFile } from '../../../core/data-files.ts'
import type { Playbook } from '../playbook/playbook.ts'

// Stable names such as `wholesale-supply`.
const key = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60)
// A clause number as printed: "3", "3.2" or "3.2.1".
const clauseNumber = z.string().regex(/^\d{1,2}(?:\.\d{1,3}){0,2}$/)
const severity = z.enum(LB04_SEVERITIES)
const topic = z.enum(LB04_TOPICS)

/** A problem planted in a contract. */
const plantedSchema = z.strictObject({
  id: key,
  rule: key,
  topic,
  clause: clauseNumber,
  severity,
  // The contract's own words that make the problem, as printed, at most one sentence.
  passage: z.string().trim().min(20).max(LB04_LIMITS.maxQuoteChars),
})

/** A clause the contract is missing. */
const absenceSchema = z.strictObject({ rule: key, topic, severity })

/** A contract the system reads. */
const reportCaseSchema = z.strictObject({
  id: key,
  contract: key,
  sample: z.boolean().default(false),
  outcome: z.literal('report'),
  planted: z.array(plantedSchema).max(12),
  tolerated: z.array(key).max(12).default([]),
  absent: z.array(absenceSchema).max(12),
  screen: z.enum(['clean', 'flagged']),
  instructions: z.array(z.string().trim().min(20).max(600)).max(8).default([]),
  maxUnplanted: z.int().min(0).max(5).default(0),
})

/** A file the system must refuse. */
const refusedCaseSchema = z.strictObject({
  id: key,
  contract: key,
  sample: z.boolean().default(false),
  outcome: z.literal('refused'),
  refusal: z.enum(LB04_FAILURE_CODES),
})

/** The whole golden.yaml. */
export const goldenFileSchema = z.strictObject({
  gates: z.strictObject({ recall: z.number().min(0.5).max(1) }),
  cases: z.array(z.discriminatedUnion('outcome', [reportCaseSchema, refusedCaseSchema])).min(4).max(20),
})

/** One problem planted in a contract. */
export interface PlantedFinding {
  id: string
  rule: string
  topic: Lb04Topic
  clause: string
  severity: Lb04Severity
  passage: string
}

/** One clause a contract is missing. */
export interface ExpectedAbsence {
  rule: string
  topic: Lb04Topic
  severity: Lb04Severity
}

/** A contract the system reads, with everything a grade needs. */
export interface ReportCase {
  kind: 'report'
  id: string
  contract: string
  sample: boolean
  planted: PlantedFinding[]
  tolerated: string[]
  absent: ExpectedAbsence[]
  screen: 'clean' | 'flagged'
  instructions: string[]
  maxUnplanted: number
}

/** A file the system must refuse. */
export interface RefusedCase {
  kind: 'refused'
  id: string
  contract: string
  sample: boolean
  refusal: Lb04FailureCode
}

/** One golden case. */
export type GoldenCase = ReportCase | RefusedCase

/** The golden set: the gates a live run must meet and the cases. */
export interface GoldenSet {
  gates: { recall: number }
  cases: GoldenCase[]
}

/** What the reader checks the file against: the playbook, and the ids of the seed contracts. */
export interface GoldenContext {
  playbook: Playbook
  contracts: readonly string[]
}

/** Lists what is wrong with the rules a report case names: each must exist, be of the right kind and belong to the topic given. */
function problemsInRules(entry: z.infer<typeof reportCaseSchema>, playbook: Playbook): string[] {
  const problems: string[] = []
  const check = (rule: string, kind: 'risk' | 'required', expectedTopic: Lb04Topic | undefined, what: string): void => {
    const found = playbook.rules.get(rule)
    if (!found) problems.push(`${entry.id}: ${what} ${rule} is not a rule of the playbook`)
    else if (found.kind !== kind) problems.push(`${entry.id}: ${what} ${rule} is a ${found.kind} rule, and must be a ${kind} rule`)
    else if (expectedTopic !== undefined && found.topic !== expectedTopic) problems.push(`${entry.id}: ${what} ${rule} belongs to ${found.topic}, not ${expectedTopic}`)
  }
  for (const planted of entry.planted) check(planted.rule, 'risk', planted.topic, 'the planted rule')
  for (const rule of entry.tolerated) check(rule, 'risk', undefined, 'the tolerated rule')
  for (const absence of entry.absent) check(absence.rule, 'required', absence.topic, 'the absent rule')
  return problems
}

/** Lists what is wrong inside one report case: repeated ids, a planted rule that is also tolerated, a screen and instructions that disagree. */
function problemsInCase(entry: z.infer<typeof reportCaseSchema>): string[] {
  const problems: string[] = []
  const plantedIds = entry.planted.map(planted => planted.id)
  if (new Set(plantedIds).size !== plantedIds.length) problems.push(`${entry.id}: a planted id appears twice`)
  const places = entry.planted.map(planted => `${planted.rule}@${planted.clause}`)
  if (new Set(places).size !== places.length) problems.push(`${entry.id}: a rule is planted twice in one clause`)
  for (const planted of entry.planted) {
    if (entry.tolerated.includes(planted.rule)) problems.push(`${entry.id}: ${planted.rule} is both planted and tolerated`)
    if (foldQuote(planted.passage).length < LB04_LIMITS.minQuoteChars) problems.push(`${entry.id}: the passage of ${planted.id} is too short to be found by a quote check`)
  }
  const absentRules = entry.absent.map(absence => absence.rule)
  if (new Set(absentRules).size !== absentRules.length) problems.push(`${entry.id}: a missing clause is listed twice`)
  if (entry.screen === 'flagged' && entry.instructions.length === 0) problems.push(`${entry.id}: a flagged contract must list the instructions it carries`)
  if (entry.screen === 'clean' && entry.instructions.length > 0) problems.push(`${entry.id}: a clean contract carries no instructions`)
  return problems
}

/** Reads golden.yaml and checks the set against the playbook and the seed contracts. */
export function readGoldenSet(path: string, context: GoldenContext): GoldenSet {
  const file = readDataFile(path, goldenFileSchema)
  const problems: string[] = []
  const cases: GoldenCase[] = []
  for (const entry of file.cases) {
    if (!context.contracts.includes(entry.contract)) problems.push(`${entry.id}: there is no seed contract called ${entry.contract}`)
    if (entry.outcome === 'refused') {
      if (!LB04_FILE_FAILURES.includes(entry.refusal)) problems.push(`${entry.id}: ${entry.refusal} is not a reason for refusing a file`)
      cases.push({ kind: 'refused', id: entry.id, contract: entry.contract, sample: entry.sample, refusal: entry.refusal })
      continue
    }
    problems.push(...problemsInRules(entry, context.playbook), ...problemsInCase(entry))
    cases.push({ kind: 'report', id: entry.id, contract: entry.contract, sample: entry.sample, planted: entry.planted, tolerated: entry.tolerated, absent: entry.absent, screen: entry.screen, instructions: entry.instructions, maxUnplanted: entry.maxUnplanted })
  }
  const ids = cases.map(entry => entry.id)
  if (new Set(ids).size !== ids.length) problems.push('a case id appears twice')
  for (const contract of context.contracts) {
    if (cases.filter(entry => entry.contract === contract).length !== 1) problems.push(`the seed contract ${contract} must have exactly one case`)
  }
  if (!cases.some(entry => entry.kind === 'report' && entry.screen === 'flagged')) problems.push('the set needs a contract that talks to its reviewer')
  if (!cases.some(entry => entry.kind === 'report' && entry.planted.length === 0 && entry.absent.length === 0)) problems.push('the set needs a clean contract')
  if (!cases.some(entry => entry.kind === 'refused')) problems.push('the set needs a file that must be refused')
  if (problems.length > 0) throw new Error(`${path} has problems:\n- ${problems.join('\n- ')}`)
  return { gates: file.gates, cases }
}
