// The closed vocabulary under attack: what a hostile model (or a model a goal talked round) could answer instead of
// a plan, and what the agent makes of it. Every step is a strict object of six actions with bounded plain strings,
// so an unknown action, an extra key, a prototype key, a selector or a script, a huge or broken number, a deep or
// enormous answer is refused by the schema, cheaply, before any browser session opens; a re-plan gets no repair;
// and the one repair a plan gets carries back only the problems' paths and a bounded echo, never more.
import { createRun, runScope, Tracer } from '@lb/common'
import { lb07ReplanAnswerSchema, lb07StepSchema } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { MAX_ECHO_CHARS, readReply, repairMessages } from '../../src/modules/lb07/agent/ask.ts'
import { planAnswerSchema, runAgent } from '../../src/modules/lb07/agent/machine.ts'
import type { MachineHooks } from '../../src/modules/lb07/agent/machine.ts'
import { freshWorking } from '../../src/modules/lb07/agent/working.ts'
import { ScriptedModel } from '../support/fake-model.ts'
import { Recorder } from '../support/lb04.ts'
import { FakeRunner } from '../support/lb07-fake-runner.ts'

const quiet: MachineHooks = { onState: async () => {}, onSteps: async () => {}, onFinding: async () => {}, onEvidence: async () => {}, save: async () => {} }

/** Builds a value nested `depth` objects deep, as JSON text. */
function nested(depth: number): string {
  return `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`
}

// Answers a plan must not be, each written as the JSON a model would send.
const NOT_PLANS: [string, string][] = [
  ['an unknown action', '{"reading":"r","steps":[{"action":"goto","path":"/"},{"action":"evaluate","code":"fetch(\'http://evil.test\')"}]}'],
  ['a selector', '{"reading":"r","steps":[{"action":"goto","path":"/"},{"action":"click","role":"button","name":"x","selector":"#buy"}]}'],
  ['a URL as a goto path', '{"reading":"r","steps":[{"action":"goto","path":"http://169.254.169.254/latest/meta-data/"}]}'],
  ['a protocol-relative path', '{"reading":"r","steps":[{"action":"goto","path":"//evil.test/x"}]}'],
  ['a prototype key in a step', '{"reading":"r","steps":[{"action":"goto","path":"/","__proto__":{"polluted":true}}]}'],
  ['a constructor key in a step', '{"reading":"r","steps":[{"action":"goto","path":"/","constructor":{"prototype":{"polluted":true}}}]}'],
  ['a prototype key at the top', '{"reading":"r","steps":[{"action":"goto","path":"/"}],"__proto__":{"polluted":true}}'],
  ['an extra key at the top', '{"reading":"r","steps":[{"action":"goto","path":"/"}],"tools":["browser"]}'],
  ['a role outside the list', '{"reading":"r","steps":[{"action":"goto","path":"/"},{"action":"click","role":"iframe","name":"x"}]}'],
  ['a huge count', '{"reading":"r","steps":[{"action":"goto","path":"/"},{"action":"expectCount","role":"heading","count":1e308}]}'],
  ['a negative count', '{"reading":"r","steps":[{"action":"goto","path":"/"},{"action":"expectCount","role":"heading","count":-1}]}'],
  ['a fractional count', '{"reading":"r","steps":[{"action":"goto","path":"/"},{"action":"expectCount","role":"heading","count":1.5}]}'],
  ['a count written as text', '{"reading":"r","steps":[{"action":"goto","path":"/"},{"action":"expectCount","role":"heading","count":"7"}]}'],
  ['a name with a line break', '{"reading":"r","steps":[{"action":"goto","path":"/"},{"action":"click","role":"button","name":"Buy\\nnow"}]}'],
  ['a name with a bidirectional override', '{"reading":"r","steps":[{"action":"goto","path":"/"},{"action":"click","role":"button","name":"Buy\\u202enow"}]}'],
  ['a name that is too long', `{"reading":"r","steps":[{"action":"goto","path":"/"},{"action":"click","role":"button","name":"${'x'.repeat(121)}"}]}`],
  ['a fill value that is too long', `{"reading":"r","steps":[{"action":"goto","path":"/"},{"action":"fill","label":"Coupon code","value":"${'x'.repeat(201)}"}]}`],
  ['a fill value with a control character', '{"reading":"r","steps":[{"action":"goto","path":"/"},{"action":"fill","label":"Coupon code","value":"a\\u0000b"}]}'],
  ['seventeen steps', `{"reading":"r","steps":[${Array.from({ length: 17 }, () => '{"action":"goto","path":"/"}').join(',')}]}`],
  ['no steps', '{"reading":"r","steps":[]}'],
  ['a plan that does not start on a page', '{"reading":"r","steps":[{"action":"click","role":"button","name":"Buy"}]}'],
  ['a reading of ten megabytes', `{"reading":"${'r'.repeat(10 * 1_048_576)}","steps":[{"action":"goto","path":"/"}]}`],
  ['a step nested a hundred thousand deep', `{"reading":"r","steps":[{"action":"goto","path":"/","x":${nested(100_000)}}]}`],
  ['steps as an object with numbered keys', '{"reading":"r","steps":{"0":{"action":"goto","path":"/"}}}'],
]

describe('the vocabulary', () => {
  it.each(NOT_PLANS)('refuses %s, quickly', (_name, text) => {
    const started = performance.now()
    const parsed = planAnswerSchema.safeParse(JSON.parse(text))
    expect(parsed.success).toBe(false)
    expect(performance.now() - started).toBeLessThan(250)
    // Whatever was refused polluted nothing on the way.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('refuses the same in a re-plan, whose steps are the same strict steps', () => {
    // Every case whose fault is in the steps themselves (a re-plan may be empty, may start anywhere, and has no reading or top-level keys of a plan).
    for (const [, text] of NOT_PLANS.filter(([name]) => !['no steps', 'a plan that does not start on a page', 'a reading of ten megabytes', 'a prototype key at the top', 'an extra key at the top'].includes(name))) {
      const answer = JSON.parse(text) as { steps: unknown, reading: unknown }
      expect(lb07ReplanAnswerSchema.safeParse({ reason: 'the page said so', steps: answer.steps }).success).toBe(false)
    }
  })

  it('takes a role and a name as plain words, never as a selector or code', () => {
    // A name is matched as the accessible name it is; nothing in it is read as a selector by the executor.
    for (const name of ['#buy', 'button >> nth=0', 'xpath=//a', 'text=Buy', '"><img src=x onerror=alert(1)>', '${process.env.KEY}']) {
      expect(lb07StepSchema.safeParse({ action: 'click', role: 'button', name }).success).toBe(true)
    }
  })
})

describe('the agent given what is not a plan', () => {
  it('refuses a ten-megabyte answer and a deeply nested one after the one repair, with no session opened, and its repair carries back only a bounded echo and the problems\' paths', async () => {
    for (const text of [NOT_PLANS.find(([name]) => name === 'a reading of ten megabytes')?.[1] ?? '', NOT_PLANS.find(([name]) => name === 'a step nested a hundred thousand deep')?.[1] ?? '']) {
      const value = JSON.parse(text) as unknown
      const model = new ScriptedModel(() => ({ kind: 'json', value }))
      const runner = new FakeRunner()
      const started = performance.now()
      await expect(runScope(createRun({ system: 'lb-07', runId: 'run-not-a-plan-1', dataClass: 'synthetic' }), () => runAgent(
        { runner, model, guard: undefined, tracer: new Tracer(new Recorder()), log: { warn: () => {} }, runTimeMs: 180_000, busyWaitMs: 1, busyWaits: 1, shopOrigin: 'http://127.0.0.1:8007', now: () => Date.now() },
        { runId: 'run-not-a-plan-1', goal: 'Buy a bag.', bugs: [], bugToken: 'token', origin: 'sample' },
        freshWorking(),
        quiet,
      ))).rejects.toMatchObject({ name: 'ModelOutputInvalid' })
      expect(performance.now() - started).toBeLessThan(2_000)
      expect(model.conversations).toHaveLength(2)
      expect(runner.sessions).toHaveLength(0)
      const repair = model.conversations[1] ?? []
      const echoed = repair.find(message => message.role === 'assistant')?.content ?? ''
      expect(echoed.length).toBeLessThanOrEqual(MAX_ECHO_CHARS + 1)
      const asked = repair.at(-1)?.content ?? ''
      expect(asked.length).toBeLessThan(2_000)
      expect(asked).not.toContain('rrrrrrrrrr')
    }
  })

  it('lists problems in a repair without the values that caused them, and never more than six of them, each bounded', () => {
    const value = JSON.parse(`{"reading":"r","steps":[{"action":"goto","path":"/"},${Array.from({ length: 30 }, () => `{"action":"click","role":"iframe","name":"${'n'.repeat(500)}","${'k'.repeat(300)}":1}`).join(',')}]}`) as unknown
    const read = readReply({ kind: 'json', value }, planAnswerSchema)
    expect('problems' in read).toBe(true)
    const problems = 'problems' in read ? read.problems : []
    const asked = repairMessages([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], { kind: 'json', value }, problems).at(-1)?.content ?? ''
    expect(asked.split('\n').filter(line => line.startsWith('- '))).toHaveLength(6)
    for (const line of asked.split('\n').filter(entry => entry.startsWith('- '))) expect(line.length).toBeLessThanOrEqual(145)
    expect(asked).not.toContain('nnnnnnnnnn')
  })
})
