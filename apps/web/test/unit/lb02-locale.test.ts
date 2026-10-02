// Tests of LB-02's text: the English and the Czech have exactly the same keys, every key the board's
// code asks for exists, and no key is left that nothing asks for (a text nobody reads is a text
// nobody translated well). The keys are found in the board's own source, so a component that
// builds a key from a prefix, such as `lb02.chat.receipts.${kind}`, claims every key under it.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

/** Where the board's code is. */
const BOARD_FOLDER = fileURLToPath(new URL('../../app/boards/lb-02/', import.meta.url))

/** The keys that are used by something other than the board's code: the build script that writes the app's manifests. */
const USED_BY_SCRIPTS = ['lb02.pwa.name', 'lb02.pwa.shortName', 'lb02.pwa.description']

/** Lists the paths of every text in a nested object of messages, such as `lb02.chat.working`. */
function leafPaths(value: unknown, prefix: string): string[] {
  if (typeof value === 'string') return [prefix]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => leafPaths(child, `${prefix}.${key}`))
}

/** Reads the source of every file of the board. */
function boardSources(): string[] {
  return readdirSync(BOARD_FOLDER, { recursive: true, encoding: 'utf8' })
    .filter(name => /\.(?:ts|vue)$/.test(name))
    .map(name => readFileSync(`${BOARD_FOLDER}${name}`, 'utf8'))
}

/** Finds every `lb02.…` key written in the board's code: whole keys, and prefixes of keys built at run time (which end in a dot). */
function usedKeys(): { whole: Set<string>, prefixes: Set<string> } {
  const whole = new Set<string>()
  const prefixes = new Set<string>()
  for (const source of boardSources()) {
    for (const match of source.matchAll(/lb02(?:\.\w+)+\.?/g)) {
      const key = match[0]
      // `lb02.ts` and the tab's storage key `lb02.conversation` are not messages: a message is under one of the text's sections.
      if (!SECTIONS.has(key.split('.')[1] ?? '')) continue
      if (key.endsWith('.')) prefixes.add(key)
      else whole.add(key)
    }
  }
  return { whole, prefixes }
}

/** The sections of the text, such as `chat` and `calendar`. */
const SECTIONS: ReadonlySet<string> = new Set(Object.keys(en.lb02))

const english = leafPaths(en.lb02, 'lb02')
const czech = leafPaths(cs.lb02, 'lb02')

describe('LB-02\'s text', () => {
  it('has the same keys in English and in Czech', () => {
    expect([...czech].sort()).toEqual([...english].sort())
  })

  it('has a text for every key the board asks for', () => {
    const { whole } = usedKeys()
    const missing = [...whole].filter(key => !english.includes(key) && !english.some(known => known.startsWith(`${key}.`)))
    expect(missing).toEqual([])
  })

  it('has no text that nothing asks for', () => {
    const { whole, prefixes } = usedKeys()
    const unused = english.filter(key => !whole.has(key) && !USED_BY_SCRIPTS.includes(key) && ![...prefixes].some(prefix => key.startsWith(prefix)))
    expect(unused).toEqual([])
  })

  it('has no text that is the same in both languages, other than the names and numbers that are', () => {
    const same = english.filter((key) => {
      const read = (messages: unknown): string => key.split('.').slice(1).reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages) as string
      return read(en.lb02) === read(cs.lb02) && /[a-z]{4}/i.test(read(en.lb02))
    })
    expect(same).toEqual([])
  })
})
