// Tests that LB-10's curated samples are prompts the service would take: each names a pack the lab offers and only
// the providers a visitor may choose, its prompt passes the board's check (the service's rules) against that pack's
// own variables, its edit is what its prompt holds (a sample that says it changes nothing sends production's prompt
// exactly, and every other one sends something else), and each has its words in both languages.
import { readLb10Seed } from '@lb/api-clients/testing'
import { LB10_SAMPLES } from '#shared/data/samples/lb10'
import { describe, expect, it } from 'vitest'
import { checkPrompt } from '~/boards/lb-10/prompt'
import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

const PACKS = new Map(readLb10Seed().packs.map(pack => [pack.pack, pack]))
// The most characters a visitor's prompt may have (services/flask-systems/lb10/limits.py).
const MAX_PROMPT_CHARS = 8_000

/** The production prompt of a sample's pack. */
function productionOf(pack: string): string {
  const found = PACKS.get(pack)
  if (!found) throw new Error(`No pack called ${pack}.`)
  return found.systemPrompt
}

describe('LB-10\'s curated samples', () => {
  it('are a few, each named once, on a pack the lab offers and the providers a visitor may choose', () => {
    expect(LB10_SAMPLES.length).toBeGreaterThanOrEqual(3)
    expect(new Set(LB10_SAMPLES.map(sample => sample.id)).size).toBe(LB10_SAMPLES.length)
    for (const sample of LB10_SAMPLES) {
      expect(PACKS.has(sample.pack), sample.id).toBe(true)
      expect(sample.providers.length).toBeGreaterThan(0)
      expect(sample.providers.every(provider => provider === 'groq' || provider === 'workers-ai'), sample.id).toBe(true)
    }
  })

  it('send prompts the service takes: within the limit, plain text, and exactly their pack\'s variables', () => {
    for (const sample of LB10_SAMPLES) {
      const pack = PACKS.get(sample.pack)
      expect(checkPrompt(sample.prompt, pack?.variables ?? [], MAX_PROMPT_CHARS), sample.id).toEqual([])
    }
  })

  it('hold the edit they say they make, and only an unchanged one sends production\'s prompt', () => {
    for (const sample of LB10_SAMPLES) {
      const production = productionOf(sample.pack)
      const { edit, prompt } = sample
      if (edit.kind === 'unchanged') {
        expect(prompt, sample.id).toBe(production)
        continue
      }
      expect(prompt, sample.id).not.toBe(production)
      if (edit.kind === 'insert') {
        expect(production).toContain(edit.after)
        expect(prompt).toContain(`${edit.after}\n${edit.line}`)
      }
      if (edit.kind === 'replace') {
        expect(production).toContain(edit.text)
        expect(prompt).toContain(edit.with)
        expect(prompt).not.toContain(edit.text)
      }
      if (edit.kind === 'remove-lines') {
        for (const line of edit.lines) {
          expect(production).toContain(line)
          expect(prompt).not.toContain(line)
        }
      }
    }
  })

  it('have a title and a note in both languages', () => {
    for (const messages of [en, cs]) {
      const items = (messages as unknown as { lb10: { samples: { items: Record<string, { title?: string, note?: string }> } } }).lb10.samples.items
      for (const sample of LB10_SAMPLES) {
        expect(items[sample.id]?.title, sample.id).toBeTruthy()
        expect(items[sample.id]?.note, sample.id).toBeTruthy()
      }
    }
  })
})
