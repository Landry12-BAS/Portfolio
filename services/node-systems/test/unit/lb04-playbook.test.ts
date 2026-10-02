// Tests for LB-04's playbook (data/seed/lb04/playbook.yaml) and the strict reader that loads it: the file
// holds the nine topics in the radar's order with their rules, a rule that is read is a rule the models
// can name by id, the board's view of it leaves out the redline wording and the detector's phrases, and
// a file that doesn't hold together (an unknown field, a repeated id, a reference that leads nowhere) is
// refused by name.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { lb04PlaybookViewSchema, LB04_SEVERITIES, LB04_TOPICS } from '@lb/contracts'
import { parse, stringify } from 'yaml'
import { afterAll, describe, expect, it } from 'vitest'

import { seedDirectory } from '../../src/core/data-files.ts'
import { playbookView, readPlaybook } from '../../src/modules/lb04/playbook/playbook.ts'
import { loadPlaybook } from '../support/lb04.ts'

const playbook = loadPlaybook()

const scratch = mkdtempSync(join(tmpdir(), 'lb04-playbook-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let written = 0

/** The playbook file as plain data, so a test can change one thing in it. */
type PlaybookFile = { topics: { id: string, rules: Record<string, unknown>[] }[] } & Record<string, unknown>

/** Writes a changed copy of the playbook in a seed directory of its own and returns what the reader says: nothing, or the error's message. */
function readChanged(change: (file: PlaybookFile) => unknown): string {
  const file = parse(readFileSync(`${seedDirectory()}/lb04/playbook.yaml`, 'utf8')) as PlaybookFile
  change(file)
  written += 1
  const directory = join(scratch, `seed-${written}`)
  cpSync(`${seedDirectory()}/lb04`, `${directory}/lb04`, { recursive: true, filter: source => !source.includes('contracts') })
  writeFileSync(`${directory}/lb04/playbook.yaml`, stringify(file))
  try {
    readPlaybook(directory)
    return ''
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** A rule of a topic, by its id. */
function ruleOf(file: PlaybookFile, id: string): Record<string, unknown> {
  const found = file.topics.flatMap(topic => topic.rules).find(rule => rule.id === id)
  if (!found) throw new Error(`There is no rule called ${id}.`)
  return found
}

describe('the playbook file', () => {
  it('has the nine topics in the radar\'s order, each with at least one rule', () => {
    expect(playbook.topics.map(topic => topic.id)).toEqual([...LB04_TOPICS])
    expect(playbook.topics.every(topic => topic.rules.length >= 1 && topic.rules.length <= 8)).toBe(true)
    expect(playbook.version).toBe(1)
  })

  it('gives every rule a unique id, a topic of the closed list and a severity of the four', () => {
    const ids = [...playbook.rules.keys()]

    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThanOrEqual(18)
    for (const rule of playbook.rules.values()) {
      expect(LB04_TOPICS).toContain(rule.topic)
      expect(LB04_SEVERITIES).toContain(rule.severity)
      expect(rule.redFlag.length).toBeGreaterThan(10)
      expect(rule.fallback.length).toBeGreaterThan(20)
    }
  })

  it('covers each topic the datasheet names with a rule a contract can break, and expects the clauses a contract must have', () => {
    const risks = [...playbook.rules.values()].filter(rule => rule.kind === 'risk')
    const required = [...playbook.rules.values()].filter(rule => rule.kind === 'required')

    expect(new Set(risks.map(rule => rule.topic))).toEqual(new Set(['liability', 'indemnity', 'termination', 'renewal', 'payment', 'ip', 'confidentiality', 'governing_law', 'exclusivity']))
    expect(required.map(rule => rule.topic)).toEqual(['liability', 'indemnity', 'termination', 'payment', 'confidentiality', 'governing_law'])
    expect(required.every(rule => rule.phrases.length >= 4)).toBe(true)
  })

  it('lets a missing cap be reported by an uncapped liability that is already a finding, and only by a risk rule of its own topic', () => {
    const cap = playbook.rules.get('liability-cap-present')

    expect(cap?.suppressedBy).toEqual(['liability-uncapped'])
    for (const rule of playbook.rules.values()) {
      for (const other of rule.suppressedBy) {
        expect(playbook.rules.get(other)?.kind).toBe('risk')
        expect(playbook.rules.get(other)?.topic).toBe(rule.topic)
      }
    }
  })
})

describe('the playbook as the board sees it', () => {
  it('is what the API\'s schema describes, with every rule and nothing else', () => {
    const view = playbookView(playbook)

    expect(lb04PlaybookViewSchema.safeParse(view).success).toBe(true)
    expect(view.topics.flatMap(topic => topic.rules).map(rule => rule.id)).toEqual([...playbook.rules.keys()])
  })

  it('leaves out the redline wording, the sentence a finding carries and the detector\'s phrases, which stay on the server', () => {
    const view = playbookView(playbook)
    const text = JSON.stringify(view)

    for (const rule of playbook.rules.values()) {
      expect(text).not.toContain(rule.fallback)
      expect(text).not.toContain(rule.summary)
    }
    for (const rule of view.topics.flatMap(topic => topic.rules)) {
      expect(Object.keys(rule)).toEqual(['id', 'title', 'kind', 'severity', 'acceptable', 'redFlag'])
    }
  })
})

describe('the strict reader', () => {
  it('reads the real file', () => {
    expect(readChanged(() => undefined)).toBe('')
  })

  it('refuses a field it does not know, in the file, a topic or a rule', () => {
    expect(readChanged(file => Object.assign(file, { owner: 'nobody' }))).toContain('schema')
    expect(readChanged(file => Object.assign(file.topics[0] as object, { colour: 'blue' }))).toContain('schema')
    expect(readChanged(file => Object.assign(ruleOf(file, 'payment-slow'), { weight: 3 }))).toContain('schema')
  })

  it('refuses a risk rule that carries detector phrases, and a required rule that has none', () => {
    expect(readChanged(file => Object.assign(ruleOf(file, 'payment-slow'), { detect: { phrases: ['net 90'] } }))).toContain('schema')
    expect(readChanged(file => Object.assign(ruleOf(file, 'indemnity-present'), { detect: { phrases: [] } }))).toContain('schema')
    expect(readChanged(file => Reflect.deleteProperty(ruleOf(file, 'indemnity-present'), 'detect'))).toContain('schema')
  })

  it('refuses an unknown severity, a missing field and text that is empty', () => {
    expect(readChanged(file => Object.assign(ruleOf(file, 'payment-slow'), { severity: 'urgent' }))).toContain('schema')
    expect(readChanged(file => Reflect.deleteProperty(ruleOf(file, 'payment-slow'), 'fallback'))).toContain('schema')
    expect(readChanged(file => Object.assign(ruleOf(file, 'payment-slow'), { red_flag: '   ' }))).toContain('schema')
  })

  it('refuses topics that are missing, repeated or out of order', () => {
    expect(readChanged(file => file.topics.pop())).toContain('schema')
    expect(readChanged(file => file.topics.reverse())).toContain('the topics must be, in this order')
    expect(readChanged(file => file.topics.splice(1, 1, file.topics[0] as PlaybookFile['topics'][number]))).toContain('the topics must be, in this order')
  })

  it('refuses a rule id used twice', () => {
    expect(readChanged(file => Object.assign(ruleOf(file, 'payment-set-off'), { id: 'payment-slow' }))).toContain('the rule id payment-slow is used twice')
  })

  it('refuses a suppression that names a rule that does not exist, a required rule, or a rule of another topic', () => {
    expect(readChanged(file => Object.assign(ruleOf(file, 'liability-cap-present'), { suppressed_by: ['liability-forever'] }))).toContain('suppressed_by must name a risk rule of the same topic')
    expect(readChanged(file => Object.assign(ruleOf(file, 'liability-cap-present'), { suppressed_by: ['indemnity-present'] }))).toContain('suppressed_by must name a risk rule of the same topic')
    expect(readChanged(file => Object.assign(ruleOf(file, 'liability-cap-present'), { suppressed_by: ['payment-slow'] }))).toContain('suppressed_by must name a risk rule of the same topic')
  })

  it('names the file and the field that is wrong, and never the value', () => {
    const message = readChanged(file => Object.assign(ruleOf(file, 'payment-slow'), { severity: 'a secret-looking-value' }))

    expect(message).toContain('playbook.yaml')
    expect(message).toContain('severity')
    expect(message).not.toContain('secret-looking-value')
  })

  it('says so when the file is not there', () => {
    expect(() => readPlaybook(join(scratch, 'nowhere'))).toThrow(/can't be read/)
  })
})
