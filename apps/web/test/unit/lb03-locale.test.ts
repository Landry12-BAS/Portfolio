// Tests of LB-03's text: the English and the Czech have exactly the same keys, every key the board's code
// asks for exists, and no key is left that nothing asks for (a text nobody reads is a text nobody
// translated well). The keys are found in the board's own source, so a component that builds a key from a
// prefix, such as `lb03.failure.codes.${code}`, claims every key under it. The sample files, the page
// pictures and the datasheet's promises that the board repeats are checked here too.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { findSystemIn } from '#shared/data/datasheets'
import { LB03_SAMPLES } from '#shared/data/samples/lb03'
import { LB03_SITE_FILE_BYTES } from '#shared/lb03-limits'

import { FAILURE_CODES } from '~/boards/lb-03/schemas'

import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

/** Where the board's code is. */
const BOARD_FOLDER = fileURLToPath(new URL('../../app/boards/lb-03/', import.meta.url))
/** Where the site's static files are. */
const PUBLIC_FOLDER = fileURLToPath(new URL('../../public/lb03/', import.meta.url))

/** The sections of the text, such as `compose` and `checks`. */
const SECTIONS: ReadonlySet<string> = new Set(Object.keys(en.lb03))

/** Lists the paths of every text in a nested object of messages, such as `lb03.checks.names.line_math`. */
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

/** Finds every `lb03.…` key written in the board's code: whole keys, and prefixes of keys built at run time (which end in a dot). */
function usedKeys(): { whole: Set<string>, prefixes: Set<string> } {
  const whole = new Set<string>()
  const prefixes = new Set<string>()
  for (const source of boardSources()) {
    for (const match of source.matchAll(/lb03(?:\.\w+)+\.?/g)) {
      const key = match[0]
      // `lb03.ts` and the store's own name `lb03` are not messages: a message is under one of the text's sections.
      if (!SECTIONS.has(key.split('.')[1] ?? '')) continue
      if (key.endsWith('.')) prefixes.add(key)
      else whole.add(key)
    }
  }
  return { whole, prefixes }
}

const english = leafPaths(en.lb03, 'lb03')
const czech = leafPaths(cs.lb03, 'lb03')

describe('LB-03\'s text', () => {
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
    const unused = english.filter(key => !whole.has(key) && ![...prefixes].some(prefix => key.startsWith(prefix)))
    expect(unused).toEqual([])
  })

  it('has no text that is the same in both languages, other than the names and numbers that are', () => {
    const same = english.filter((key) => {
      const read = (messages: unknown): string => key.split('.').slice(1).reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages) as string
      return read(en.lb03) === read(cs.lb03) && /[a-z]{4}/i.test(read(en.lb03))
    })
    expect(same).toEqual([])
  })

  it('has a sentence for every failure code the service can write', () => {
    expect(Object.keys(en.lb03.failure.codes).sort()).toEqual([...FAILURE_CODES].sort())
    expect(Object.keys(cs.lb03.failure.codes).sort()).toEqual([...FAILURE_CODES].sort())
  })

  it('has a name and a note for every curated sample', () => {
    expect(Object.keys(en.lb03.samples).sort()).toEqual(LB03_SAMPLES.map(sample => sample.id).sort())
    expect(Object.keys(cs.lb03.samples).sort()).toEqual(LB03_SAMPLES.map(sample => sample.id).sort())
  })
})

describe('what the board shows beside its text', () => {
  it('has each sample\'s file and the picture of each of its pages among the site\'s static files, as the golden set describes them', () => {
    for (const sample of LB03_SAMPLES) {
      expect(existsSync(`${PUBLIC_FOLDER}samples/${sample.file}`), sample.file).toBe(true)
      for (let page = 1; page <= sample.pages; page += 1) expect(existsSync(`${PUBLIC_FOLDER}pages/${sample.id}-${page}.jpg`), `${sample.id}-${page}`).toBe(true)
      expect(sample.bytes).toBeLessThan(LB03_SITE_FILE_BYTES)
    }
  })

  it('says the file limit the datasheet says: 4 MB, which is what the site passes on', () => {
    const limit = findSystemIn('lb-03', 'en')?.limits.find(row => row.label === 'File limit')?.value
    expect(limit).toBe('4 MB, 5 pages')
    expect(LB03_SITE_FILE_BYTES / 1_048_576).toBe(4)
    expect(en.lb03.compose.fileHint).toContain('{size} MB')
    expect(en.lb03.compose.fileHint).toContain('{pages} pages')
  })

  it('names the five model calls and the hour the datasheet promises', () => {
    const limits = findSystemIn('lb-03', 'en')?.limits ?? []
    expect(limits.find(row => row.label.startsWith('Model calls'))?.value).toBe('2–5')
    expect(limits.find(row => row.label === 'Files kept')?.value).toBe('1 h')
    expect(en.lb03.failure.codes.call_limit).toContain('five')
    expect(en.lb03.compose.privacy).toContain('an hour')
  })
})
