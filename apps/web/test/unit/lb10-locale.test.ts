// A check that every message the LB-10 board asks for exists, in English and in Czech, and that the closed lists the
// service speaks in (a run's states and stages, its failures, the verdicts, the difficulties, the kinds of answer,
// the graders, the gateway's codes, the packs, the providers and the board's own notices) all have words in both
// languages. The board's code asks for messages by key (`t('lb10.editor.title')`), and a key that is not in the
// locale files shows the visitor the key itself. This reads the board's own source for every key it writes down, and
// for the group a key built at run time starts from, and looks each one up in both languages. It also checks that the
// two languages have the same keys and the same parameters, that no message holds markup, and that the Czech is
// typeset (no line ends on a one-letter word).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Lb10Mock, readLb10Seed } from '@lb/api-clients/testing'
import { gatewayCodes } from '@lb/common'
import { describe, expect, it } from 'vitest'
import { DIFFICULTIES, RUN_STATES, VERDICTS } from '~/boards/lb-10/schemas'
import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

const BOARD = join(import.meta.dirname, '../../app/boards/lb-10')
// A key written between quotes or backticks, up to the closing one.
const KEY = /(['"`])(lb10\.[\w.${}-]+)\1/g
const SEED = readLb10Seed()

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

/** Lists every dotted path to a message under a value. */
function pathsOf(value: unknown, prefix: string): string[] {
  if (typeof value === 'string') return [prefix]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([name, inner]) => pathsOf(inner, `${prefix}.${name}`))
}

/** Lists the parameters a message names, sorted. */
function parametersOf(message: string): string[] {
  return [...message.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? '').sort()
}

describe('the messages LB-10\'s board asks for', () => {
  const { whole, groups } = keysUsed()

  it('finds the keys the board uses, so the check below is not looking at nothing', () => {
    expect(whole.size).toBeGreaterThan(100)
    expect(groups.size).toBeGreaterThan(5)
  })

  for (const [language, messages] of [['English', en], ['Czech', cs]] as const) {
    it(`are all in ${language}: every written key is a message, and every built key starts from a group of them`, () => {
      // A counted phrase is written as its group (lb10.editor.addedLines) and picked by plural form in words.ts.
      const missing = [...whole.keys()].filter((key) => {
        const found = follow(messages, key)
        return typeof found !== 'string' && !(typeof found === 'object' && found !== null && 'other' in found)
      })
      const notGroups = [...groups.keys()].filter((key) => {
        const group = follow(messages, key)
        return typeof group !== 'object' || group === null || Object.keys(group).length === 0
      })
      expect(missing, `keys with no ${language} message`).toEqual([])
      expect(notGroups, `built keys whose group is not in ${language}`).toEqual([])
    })
  }

  it('are the same in both languages, key for key, with the same parameters', () => {
    const english = pathsOf((en as { lb10: unknown }).lb10, 'lb10').sort()
    const czech = pathsOf((cs as { lb10: unknown }).lb10, 'lb10').sort()
    expect(czech).toEqual(english)
    for (const path of english) {
      expect(parametersOf(follow(cs, path) as string), path).toEqual(parametersOf(follow(en, path) as string))
    }
  })

  it('hold text and nothing else: no markup, no script, no braces but around a parameter\'s name', () => {
    const messages = pathsOf((en as { lb10: unknown }).lb10, 'lb10').flatMap(path => [follow(en, path), follow(cs, path)]) as string[]
    for (const message of messages) {
      expect(message).not.toMatch(/[<>]/)
      expect(message.replace(/\{\w+\}/g, '')).not.toMatch(/[{}|@]/)
    }
  })

  it('give every counted phrase the plural forms its words pick from', () => {
    for (const group of ['lb10.targets.casesNote', 'lb10.editor.removedLines', 'lb10.editor.addedLines']) {
      for (const messages of [en, cs]) expect(Object.keys(follow(messages, group) as object).sort(), group).toEqual(['few', 'one', 'other'])
    }
  })
})

describe('the closed lists LB-10 speaks in', () => {
  /** Says what a list needs in both languages: a message at each of its names, under a group. */
  function needsWords(group: string, names: readonly string[], nested?: string): void {
    for (const [language, messages] of [['English', en], ['Czech', cs]] as const) {
      const missing = names.filter(name => typeof follow(messages, `lb10.${group}.${name}${nested ? `.${nested}` : ''}`) !== 'string')
      expect(missing, `${group} with no ${language} words`).toEqual([])
    }
  }

  it('have words for every state and stage of a run, and every failure the service ends one with', () => {
    needsWords('run.states', RUN_STATES)
    needsWords('run.stage', ['starting', 'calling', 'writing', 'done', 'failed'])
    needsWords('failures.codes', ['model_budget', 'no_answers', 'time_limit', 'interrupted', 'call_limit', 'busy'])
  })

  it('have words for every verdict, difficulty and kind of answer', () => {
    needsWords('report.difference.verdicts', VERDICTS)
    needsWords('report.difference.verdictWords', VERDICTS)
    needsWords('targets.difficulty', DIFFICULTIES)
    needsWords('targets.outputs', ['json', 'text', 'tool_calls'])
  })

  it('have words for every grader the service has, and every code a call can fail with', () => {
    const limits = (new Lb10Mock(SEED, () => Date.now()).targets().body as { limits: { grader_kinds: string[] } }).limits
    needsWords('report.graders', limits.grader_kinds)
    needsWords('report.graders', [...new Set(SEED.packs.flatMap(pack => pack.cases.flatMap(entry => entry.graderKinds)))])
    needsWords('report.gateway', [...gatewayCodes, 'model_failed'])
  })

  it('have a title, what it grades and what it cannot for every pack, and a note for every provider', () => {
    const packs = SEED.packs.map(pack => pack.pack)
    expect(packs).toHaveLength(5)
    for (const part of ['title', 'grades', 'cannot']) needsWords('targets.packs', packs, part)
    needsWords('providers.notes', ['groq', 'workers-ai'])
  })

  it('have a title and a sentence for each of the board\'s own notices', () => {
    const notices = ['lab_busy', 'run_running', 'daily_limit', 'unavailable', 'invalid_providers', 'unknown_target']
    needsWords('notices', notices, 'title')
    needsWords('notices', notices, 'text')
    needsWords('notices', ['gone'])
  })

  it('keep the Czech typeset: no line of the board ends on a single-letter word', () => {
    const czech = pathsOf((cs as { lb10: unknown }).lb10, 'lb10').map(path => follow(cs, path) as string)
    expect(czech.filter(message => /(?:^|\s)[aiksouvz] /i.test(message))).toEqual([])
  })
})
