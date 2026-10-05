// A check that every message the LB-07 board asks for exists, in English and in Czech, and that the closed
// lists the service speaks in (its states, the steps' actions, roles, statuses and outcomes, the kinds of
// finding, the engines, the severities, the verdicts, the failure codes and the bugs) all have words in
// both languages. The board's code asks for messages by key (`t('lb07.start.title')`), and a key that is not
// in the locale files shows the visitor the key itself. This reads the board's own source for every key it
// writes down, and for the group a key built at run time starts from, and looks each one up in both
// languages. It also checks that the two languages have the same keys and the same parameters, and that no
// message holds markup, so a message cannot carry anything but text.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LB07_BUG_IDS, LB07_CLICK_ROLES, LB07_COUNT_ROLES, LB07_ENGINES, LB07_FAILURE_CODES, LB07_FINDING_KINDS, LB07_SEVERITIES, LB07_STATES, LB07_STEP_STATUSES, LB07_VERDICTS, lb07StepViewSchema } from '@lb/contracts'
import { LB07_SAMPLES } from '#shared/data/samples/lb07'
import { describe, expect, it } from 'vitest'
import { STAGES } from '~/boards/lb-07/run'
import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

const BOARD = join(import.meta.dirname, '../../app/boards/lb-07')
// A key written between quotes or backticks, up to the closing one.
const KEY = /(['"`])(lb07\.[\w.${}-]+)\1/g

/** Lists the source files under a folder, as paths. */
function sourcesUnder(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name)
    if (statSync(path).isDirectory()) return sourcesUnder(path)
    return /\.(?:vue|ts)$/.test(name) ? [path] : []
  })
}

/** Follows a dotted key through a language's messages. */
function follow(messages: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((place, part) => (typeof place === 'object' && place !== null ? (place as Record<string, unknown>)[part] : undefined), messages)
}

/** Lists every key the board's source writes down: whole keys, and the group a built key starts from. */
function keysUsed(): { whole: Map<string, string>, groups: Map<string, string> } {
  const whole = new Map<string, string>()
  const groups = new Map<string, string>()
  for (const file of sourcesUnder(BOARD)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(KEY)) {
      const key = match[2] ?? ''
      const at = key.indexOf('${')
      if (at === -1) whole.set(key, file)
      else groups.set(key.slice(0, at).replace(/\.$/, ''), file)
    }
  }
  return { whole, groups }
}

/** Lists every dotted path to a message in a language's LB-07 messages. */
function pathsOf(value: unknown, prefix: string): string[] {
  if (typeof value === 'string') return [prefix]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([name, inner]) => pathsOf(inner, `${prefix}.${name}`))
}

/** The names of a message's parameters, sorted. */
function parametersOf(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '').sort()
}

describe('the messages the board asks for', () => {
  const { whole, groups } = keysUsed()

  it('finds the keys the board uses, so the check below is not looking at nothing', () => {
    expect(whole.size).toBeGreaterThan(60)
    expect(groups.size).toBeGreaterThan(5)
  })

  for (const [language, messages] of [['English', en], ['Czech', cs]] as const) {
    it(`are all in ${language}: every written key is a message, and every built key starts from a group of them`, () => {
      const missing = [...whole.keys()].filter(key => typeof follow(messages, key) !== 'string')
      const notGroups = [...groups.keys()].filter((key) => {
        const group = follow(messages, key)
        return typeof group !== 'object' || group === null || Object.keys(group).length === 0
      })
      expect(missing, `keys with no ${language} message`).toEqual([])
      expect(notGroups, `built keys whose group is not in ${language}`).toEqual([])
    })
  }

  it('are the same in both languages, key for key, with the same parameters', () => {
    const english = pathsOf((en as { lb07: unknown }).lb07, 'lb07').sort()
    const czech = pathsOf((cs as { lb07: unknown }).lb07, 'lb07').sort()
    expect(czech).toEqual(english)
    for (const path of english) {
      expect(parametersOf(follow(cs, path) as string), path).toEqual(parametersOf(follow(en, path) as string))
    }
  })

  it('hold text and nothing else: no markup, no script, no braces but around a parameter\'s name', () => {
    const messages = pathsOf((en as { lb07: unknown }).lb07, 'lb07').flatMap(path => [follow(en, path), follow(cs, path)]) as string[]
    for (const message of messages) {
      expect(message).not.toMatch(/[<>]/)
      expect(message.replace(/\{\w+\}/g, '')).not.toMatch(/[{}|@]/)
    }
  })
})

describe('the closed lists the service speaks in', () => {
  /** Says what a list needs in both languages: a message at each of its names, under a group. */
  function needsWords(group: string, names: readonly string[], nested?: string): void {
    for (const [language, messages] of [['English', en], ['Czech', cs]] as const) {
      const missing = names.filter(name => typeof follow(messages, `lb07.${group}.${name}${nested ? `.${nested}` : ''}`) !== 'string')
      expect(missing, `${group} with no ${language} words`).toEqual([])
    }
  }

  it('have words for every state of a run and every stage and stage status of the stepper', () => {
    needsWords('states', LB07_STATES)
    needsWords('stepper.stages', STAGES)
    needsWords('stepper.status', ['done', 'current', 'waiting', 'failed', 'skipped'])
  })

  it('have words for every action, role, status and outcome a step can have', () => {
    needsWords('steps.actions', ['goto', 'click', 'fill', 'select', 'expectText', 'expectCount', 'expectCountNamed'])
    needsWords('steps.clickRoles', LB07_CLICK_ROLES)
    needsWords('steps.roles', LB07_COUNT_ROLES)
    needsWords('steps.status', LB07_STEP_STATUSES)
    needsWords('steps.outcomes', lb07StepViewSchema.shape.outcome.unwrap().options)
  })

  it('have words for every kind of finding, engine, severity, verdict and failure', () => {
    needsWords('findings.kinds', LB07_FINDING_KINDS)
    needsWords('findings.engines', LB07_ENGINES)
    needsWords('reports.severities', LB07_SEVERITIES)
    needsWords('verification.verdicts', LB07_VERDICTS)
    needsWords('verification.verdictNotes', LB07_VERDICTS)
    needsWords('failures.codes', LB07_FAILURE_CODES)
  })

  it('have a title and a summary for every bug, and a title and a note for every curated sample', () => {
    needsWords('bugs', LB07_BUG_IDS, 'title')
    needsWords('bugs', LB07_BUG_IDS, 'summary')
    needsWords('samples', LB07_SAMPLES.map(sample => sample.id), 'title')
    needsWords('samples', LB07_SAMPLES.map(sample => sample.id), 'note')
  })

  it('keep the Czech typeset: no line of the board ends on a single-letter word', () => {
    const czech = pathsOf((cs as { lb07: unknown }).lb07, 'lb07').map(path => follow(cs, path) as string)
    expect(czech.filter(message => /(?:^|\s)[aiksouvz] /i.test(message))).toEqual([])
  })
})
