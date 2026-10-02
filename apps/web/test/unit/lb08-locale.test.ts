// A check that every message the LB-08 board asks for exists, in English and in Czech. The board's
// code asks for messages by key (`t('lb08.run.start')`), and a key that is not in the locale files
// shows the visitor the key itself. This reads the board's own source for every key it writes down,
// and for the group a key built at run time starts from (`lb08.kinds.${kind}`), and looks each one
// up in both languages. It also checks that the two languages have the same keys and that no
// message holds markup, so a message cannot carry anything but text.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

const BOARD = join(import.meta.dirname, '../../app/boards/lb-08')
// A key written between quotes or backticks, up to the closing one.
const KEY = /(['"`])(lb08\.[\w.${}-]+)\1/g

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

/** Lists every dotted path to a message in a language's LB-08 messages. */
function pathsOf(value: unknown, prefix: string): string[] {
  if (typeof value === 'string') return [prefix]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([name, inner]) => pathsOf(inner, `${prefix}.${name}`))
}

describe('the messages the board asks for', () => {
  const { whole, groups } = keysUsed()

  it('finds the keys the board uses, so the check below is not looking at nothing', () => {
    expect(whole.size).toBeGreaterThan(40)
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

  it('are the same in both languages, key for key', () => {
    const english = pathsOf((en as { lb08: unknown }).lb08, 'lb08').sort()
    const czech = pathsOf((cs as { lb08: unknown }).lb08, 'lb08').sort()

    expect(czech).toEqual(english)
  })

  it('hold text and nothing else: no markup, no script, no braces but around a parameter\'s name', () => {
    const messages = pathsOf((en as { lb08: unknown }).lb08, 'lb08').flatMap(path => [follow(en, path), follow(cs, path)]) as string[]

    for (const message of messages) {
      expect(message).not.toMatch(/[<>]/)
      expect(message.replace(/\{\w+\}/g, '')).not.toMatch(/[{}|@]/)
    }
  })
})
