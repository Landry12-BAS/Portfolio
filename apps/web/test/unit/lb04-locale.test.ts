// A check that every message the LB-04 board asks for exists, in English and in Czech. The board's code
// asks for messages by key (`t('lb04.finding.show')`), and a key that is not in the locale files shows the
// visitor the key itself. This reads the board's own source for every key it writes down, and for the group
// a key built at run time starts from (`lb04.topics.${topic}`), and looks each one up in both languages. It
// also checks that the two languages have the same keys, that every sample, topic, severity, state, failure
// code and drop reason the service can name has its words, and that no message holds markup.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { LB04_DROP_REASONS, LB04_FAILURE_CODES, LB04_SEVERITIES, LB04_STATES, LB04_TOPICS } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { LB04_SAMPLES } from '#shared/data/samples/lb04'

import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

const BOARD = join(import.meta.dirname, '../../app/boards/lb-04')
// A key written between quotes or backticks, up to the closing one.
const KEY = /(['"`])(lb04\.[\w.${}-]+)\1/g

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

/** Lists every dotted path to a message in a language's LB-04 messages. */
function pathsOf(value: unknown, prefix: string): string[] {
  if (typeof value === 'string') return [prefix]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([name, inner]) => pathsOf(inner, `${prefix}.${name}`))
}

describe('the messages the board asks for', () => {
  const { whole, groups } = keysUsed()

  it('finds the keys the board uses, so the check below is not looking at nothing', () => {
    expect(whole.size).toBeGreaterThan(80)
    expect(groups.size).toBeGreaterThan(8)
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

  it('are the same in both languages, key for key', () => {
    const english = pathsOf((en as { lb04: unknown }).lb04, 'lb04').sort()
    const czech = pathsOf((cs as { lb04: unknown }).lb04, 'lb04').sort()

    expect(czech).toEqual(english)
  })

  it('have every group a built key reads from complete: one message for each name the service can give', () => {
    const expected: Record<string, readonly string[]> = {
      'lb04.topics': LB04_TOPICS,
      'lb04.severities': LB04_SEVERITIES,
      'lb04.failure.codes': LB04_FAILURE_CODES,
      'lb04.drops': LB04_DROP_REASONS,
      'lb04.mine.states': LB04_STATES,
      'lb04.sample': LB04_SAMPLES.map(sample => sample.id),
      'lb04.screen': ['clean', 'flagged', 'unchecked'],
      'lb04.playbook.kinds': ['risk', 'required'],
      'lb04.upload.problems': ['empty', 'tooLarge', 'notPdf'],
    }
    for (const [group, names] of Object.entries(expected)) {
      for (const messages of [en, cs]) {
        const found = follow(messages, group)
        expect(Object.keys(found as object).sort(), group).toEqual([...names].sort())
      }
    }
  })

  it('give each sample a title and a note, in both languages', () => {
    for (const sample of LB04_SAMPLES) {
      for (const messages of [en, cs]) {
        expect(typeof follow(messages, `lb04.sample.${sample.id}.title`)).toBe('string')
        expect(typeof follow(messages, `lb04.sample.${sample.id}.note`)).toBe('string')
      }
    }
  })

  it('say the label every answer carries, in English as the contracts package writes it', () => {
    expect((en as { lb04: { notLegalAdvice: string } }).lb04.notLegalAdvice).toBe('Not legal advice')
  })
})
