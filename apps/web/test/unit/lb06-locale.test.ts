// A check that every message the LB-06 board asks for exists, in English and in Czech, and that the
// closed lists the service speaks in (its services, metrics, states, faults, agents, causes, actions,
// kinds of event and the reasons an incident ends) all have words in both languages. The board's code
// asks for messages by key (`t('lb06.start.title')`), and a key that is not in the locale files shows
// the visitor the key itself. This reads the board's own source for every key it writes down, and for
// the group a key built at run time starts from, and looks each one up in both languages. It also
// checks that the two languages have the same keys and the same parameters, and that no message holds
// markup, so a message cannot carry anything but text.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { LB06_ACTIONS, LB06_AGENTS, LB06_END_REASONS, LB06_EVENT_KINDS, LB06_FAULTS, LB06_METRICS, LB06_SERVICES, LB06_STATES } from '@lb/contracts'
import { LB06_SAMPLES } from '#shared/data/samples/lb06'
import { describe, expect, it } from 'vitest'
import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

const BOARD = join(import.meta.dirname, '../../app/boards/lb-06')
// A key written between quotes or backticks, up to the closing one.
const KEY = /(['"`])(lb06\.[\w.${}-]+)\1/g

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

/** Lists every dotted path to a message in a language's LB-06 messages. */
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

  it('are the same in both languages, key for key, with the same parameters', () => {
    const english = pathsOf((en as { lb06: unknown }).lb06, 'lb06').sort()
    const czech = pathsOf((cs as { lb06: unknown }).lb06, 'lb06').sort()
    expect(czech).toEqual(english)
    for (const path of english) {
      expect(parametersOf(follow(cs, path) as string), path).toEqual(parametersOf(follow(en, path) as string))
    }
  })

  it('hold text and nothing else: no markup, no script, no braces but around a parameter\'s name', () => {
    const messages = pathsOf((en as { lb06: unknown }).lb06, 'lb06').flatMap(path => [follow(en, path), follow(cs, path)]) as string[]
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
      const missing = names.filter(name => typeof follow(messages, `lb06.${group}.${name}${nested ? `.${nested}` : ''}`) !== 'string')
      expect(missing, `${group} with no ${language} words`).toEqual([])
    }
  }

  it('have words for every service, metric, state, agent and reason an incident ends', () => {
    needsWords('services', LB06_SERVICES)
    needsWords('metrics', LB06_METRICS)
    needsWords('states', LB06_STATES)
    needsWords('agents.names', LB06_AGENTS)
    needsWords('endReasons', LB06_END_REASONS)
  })

  it('have words for every fault, with a title and a note', () => {
    needsWords('faults', LB06_FAULTS, 'title')
    needsWords('faults', LB06_FAULTS, 'note')
  })

  it('have words for every action and what it touches', () => {
    needsWords('actions', LB06_ACTIONS)
    needsWords('blast', LB06_ACTIONS)
  })

  it('have a sentence for every kind of event the timeline lists', () => {
    const listed = LB06_EVENT_KINDS.filter(kind => kind !== 'tick' && kind !== 'agent.step').map(kind => kind.replace('.', '_'))
    needsWords('events', listed)
  })

  it('have a title and a note for every curated sample, in both languages', () => {
    needsWords('samples', LB06_SAMPLES.map(sample => sample.id), 'title')
    needsWords('samples', LB06_SAMPLES.map(sample => sample.id), 'note')
  })
})
