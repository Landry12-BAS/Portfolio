// A contract between LB-04 and the gateway's routing table (services/gateway/routing.yaml). The service
// decides how many model calls a contract may take and how big each request can get; the gateway
// enforces its own numbers for the same things. If the two disagree, a visitor would meet a gateway
// refusal halfway through a review, or a quota the datasheet doesn't promise. These tests load the real
// routing.yaml with the gateway's own loader and the gateway's own token estimate, and build the largest
// request each step can make, so a change on either side fails here.
import { readFileSync } from 'node:fs'

import { LB04_LIMITS } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { estimateChatInput } from '../../../gateway/src/budget/estimate.ts'
import { loadRouting } from '../../../gateway/src/routing/load.ts'
import type { ChatRequest } from '../../../gateway/src/schemas/chat.ts'
import { splitClauses } from '../../src/modules/lb04/analysis/clauses.ts'
import type { PageInput } from '../../src/modules/lb04/analysis/clauses.ts'
import { ALIASES, MAX_OUTPUT_TOKENS } from '../../src/modules/lb04/analysis/model.ts'
import type { PromptMessage } from '../../src/modules/lb04/analysis/model.ts'
import { analysisMessages, MAX_ECHO_CHARS, redlineMessages, reportMessages, repairMessages } from '../../src/modules/lb04/analysis/prompts.ts'
import type { VerifiedNote } from '../../src/modules/lb04/analysis/verify.ts'
import { loadPlaybook } from '../support/lb04.ts'

const routing = loadRouting(readFileSync(new URL('../../../gateway/routing.yaml', import.meta.url), 'utf8'), {
  GROQ_API_KEY: 'k',
  CLOUDFLARE_API_TOKEN: 'k',
  CLOUDFLARE_ACCOUNT_ID: 'acc123',
  OPENROUTER_API_KEY: 'k',
  NVIDIA_API_KEY: 'k',
})
const system = routing.systems.get('lb-04')
const playbook = loadPlaybook()

/** The tokens the gateway would count for a conversation sent to an alias. */
function tokensOf(alias: string, messages: readonly PromptMessage[]): number {
  return estimateChatInput({ model: alias, messages } as unknown as ChatRequest)
}

/** The most input an alias takes, from routing.yaml. */
function limitOf(alias: string): number {
  return routing.aliases.get(alias)?.maxInputTokens ?? 0
}

/** A contract of `pageCount` pages and about `characters` characters in all, made of numbered clauses of about `clauseChars` characters each. */
function contractOf(pageCount: number, characters: number, clauseChars: number): PageInput[] {
  const pages: string[][] = Array.from({ length: pageCount }, () => [])
  let used = 0
  let article = 0
  let clause = 0
  while (used < characters) {
    if (clause === 0 || clause >= 30) {
      article += 1
      clause = 0
      const heading = `${article}. ARTICLE NUMBER ${article}`
      pages[Math.min(pageCount - 1, Math.floor(used / (characters / pageCount)))]?.push(heading)
      used += heading.length + 1
    }
    clause += 1
    const line = `${article}.${clause} ${'w'.repeat(Math.max(1, clauseChars - `${article}.${clause} `.length))}`
    pages[Math.min(pageCount - 1, Math.floor(used / (characters / pageCount)))]?.push(line)
    used += line.length + 1
  }
  return pages.map((lines, index) => ({ page: index + 1, text: lines.join('\n') }))
}

/** A verified note of a rule, with the longest quote a finding may have. */
function longNote(ruleId: string, position: number): VerifiedNote {
  const rule = playbook.rules.get(ruleId)
  if (!rule) throw new Error(`There is no rule called ${ruleId}.`)
  return { position, rule, clause: '12.34.56', citation: { page: 1, start: position * 2_000, end: position * 2_000 + LB04_LIMITS.maxQuoteChars }, quote: 'q'.repeat(LB04_LIMITS.maxQuoteChars) }
}

describe('LB-04\'s entry in routing.yaml', () => {
  it('exists, for the Node service, and lets it use the four aliases the pipeline asks for and no other', () => {
    expect(system?.service).toBe('node-systems')
    expect([...(system?.aliases ?? [])].sort()).toEqual([ALIASES.long, ALIASES.reason, ALIASES.fast, 'lb-guard'].sort())
  })

  it('allows a contract eight calls: the guard, the analysis and the rating with one repair each, and three redlines of one call', () => {
    const review = 1 + 2 + 2
    const redlines = LB04_LIMITS.redlinesPerContract * 1

    expect(system?.maxCallsPerRun).toBe(review + redlines)
    expect(system?.maxCallsPerRun).toBe(8)
  })

  it('lets a visitor review as many contracts a day as the service allows, at the cap of calls each', () => {
    expect(system?.sessionDailyCalls).toBeGreaterThanOrEqual(LB04_LIMITS.contractsPerVisitorPerDay * (system?.maxCallsPerRun ?? 0))
  })

  it('leaves the day\'s budget room for a full pass of the golden set at its worst, and for a visitor besides', () => {
    // Four contracts are reviewed (the others are refused before any model is asked): five calls and one redline each.
    const worstEvalCalls = 4 * (5 + 1)

    expect(system?.dailyCalls).toBeGreaterThanOrEqual(worstEvalCalls + (system?.sessionDailyCalls ?? 0))
  })

  it('lists the site\'s server as a reader of lb-04\'s traces, which is how the Scope shows a run', () => {
    expect(routing.traceReaders.get('web')?.systems.has('lb-04')).toBe(true)
  })
})

describe('the aliases LB-04 uses', () => {
  it.each([ALIASES.long, ALIASES.reason, ALIASES.fast])('%s lets the model write as long an answer as the service asks for', (alias) => {
    const key = (Object.entries(ALIASES).find(([, value]) => value === alias)?.[0] ?? 'long') as keyof typeof MAX_OUTPUT_TOKENS

    expect(routing.aliases.get(alias)?.maxOutputTokens).toBeGreaterThanOrEqual(MAX_OUTPUT_TOKENS[key])
  })

  it('has the long-document alias served by a model that may be given a visitor\'s own words', () => {
    expect(routing.aliases.get(ALIASES.long)?.chain.some(model => !model.provider.trainsOnInputs)).toBe(true)
  })
})

describe('the first request, the cited analysis (lb-long)', () => {
  const limit = limitOf(ALIASES.long)

  it('fits for a contract of the longest the service reads, whether it is made of many tiny clauses or of a few huge ones', () => {
    const tiny = contractOf(30, LB04_LIMITS.maxTextChars, 100)
    const huge = contractOf(30, LB04_LIMITS.maxTextChars, 3_000)

    for (const pages of [tiny, huge]) {
      const messages = analysisMessages(playbook, splitClauses(pages))

      expect(tokensOf(ALIASES.long, messages)).toBeLessThanOrEqual(limit)
    }
  })

  it('fits for a contract made of the most numbered clauses the splitter believes, and for one with more, which is cut into pieces', () => {
    const atCap = contractOf(30, LB04_LIMITS.maxTextChars, 100)
    const beyond = contractOf(30, LB04_LIMITS.maxTextChars, 20)

    expect(splitClauses(atCap).length).toBeLessThanOrEqual(1_700)
    for (const pages of [atCap, beyond]) {
      expect(tokensOf(ALIASES.long, analysisMessages(playbook, splitClauses(pages)))).toBeLessThanOrEqual(limit)
    }
  })

  it('fits with its one repair, whatever the first answer was', () => {
    const base = analysisMessages(playbook, splitClauses(contractOf(30, LB04_LIMITS.maxTextChars, 100)))
    const problems = Array.from({ length: 30 }, () => `notes.17.quote: ${'e'.repeat(400)}`)

    const repair = repairMessages(base, { kind: 'text', text: 'y'.repeat(50_000) }, problems, MAX_ECHO_CHARS.long)

    expect(tokensOf(ALIASES.long, repair)).toBeLessThanOrEqual(limit)
  })
})

describe('the second request, the rating of what was verified (lb-reason)', () => {
  const limit = limitOf(ALIASES.reason)
  const ruleIds = [...playbook.rules.values()].filter(rule => rule.kind === 'risk').map(rule => rule.id)
  const required = [...playbook.rules.values()].filter(rule => rule.kind === 'required')

  it('fits for a report with the most findings, each on a different rule and each with the longest quote', () => {
    const notes = Array.from({ length: LB04_LIMITS.maxFindings }, (_, index) => longNote(ruleIds[index % ruleIds.length] as string, index))

    const messages = reportMessages(notes, required)

    expect(tokensOf(ALIASES.reason, messages)).toBeLessThanOrEqual(limit)
  })

  it('fits with its one repair, whatever the first answer was', () => {
    const notes = Array.from({ length: LB04_LIMITS.maxFindings }, (_, index) => longNote(ruleIds[index % ruleIds.length] as string, index))
    const base = reportMessages(notes, required)

    const repair = repairMessages(base, { kind: 'text', text: 'y'.repeat(50_000) }, Array.from({ length: 30 }, () => `findings.3.summary: ${'e'.repeat(400)}`), MAX_ECHO_CHARS.reason)

    expect(tokensOf(ALIASES.reason, repair)).toBeLessThanOrEqual(limit)
  })
})

describe('the third request, the wording of a redline (lb-fast)', () => {
  it('fits for the longest passage a finding may quote, on the rule with the longest text', () => {
    const longest = [...playbook.rules.values()].sort((a, b) => (b.acceptable + b.redFlag + b.fallback).length - (a.acceptable + a.redFlag + a.fallback).length)[0]
    if (!longest) throw new Error('The playbook has no rules.')

    const messages = redlineMessages(longest, 'q'.repeat(LB04_LIMITS.maxQuoteChars))

    expect(tokensOf(ALIASES.fast, messages)).toBeLessThanOrEqual(limitOf(ALIASES.fast))
  })
})

describe('the datasheet', () => {
  const sheet = readFileSync(new URL('../../../../apps/web/shared/data/systems.ts', import.meta.url), 'utf8')
  const entry = sheet.slice(sheet.indexOf('slug: \'lb-04\''), sheet.indexOf('slug: \'lb-05\''))

  it('promises the contracts a visitor may review in a day, and the length, that the service enforces', () => {
    expect(entry).toContain(`{ label: 'Contracts per visitor per day', value: '${LB04_LIMITS.contractsPerVisitorPerDay}' }`)
    expect(entry).toContain(`{ label: 'Length', value: '${LB04_LIMITS.maxPages} pages' }`)
  })

  it('carries the label every answer carries', () => {
    expect(entry).toContain('Not legal advice')
  })

  it('estimates the model calls for a contract in a range the pipeline stays inside', () => {
    const range = /Model calls per contract \(est\.\)', value: '(\d)–(\d)'/.exec(entry)

    expect(Number(range?.[1])).toBe(2)
    expect(Number(range?.[2])).toBe(system?.maxCallsPerRun)
  })
})
