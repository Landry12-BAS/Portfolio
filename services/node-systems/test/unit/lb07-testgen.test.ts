// The generated test is written by a template from the validated plan, with every string as a JSON literal:
// a hostile step (quotes, backticks, `${}`, line breaks, a closing script tag, a comment closer) stays inert
// text inside a literal, never code. The template is also checked for the shape a reader expects.
import { describe, expect, it } from 'vitest'

import type { Lb07Step } from '@lb/contracts'

import { generateTest, testFilename } from '../../src/modules/lb07/agent/testgen.ts'
import { loadGolden } from '../support/lb07.ts'

const HOSTILE = ['"); process.exit(1); //', '`${process.env.SECRET}`', 'line one\nline two', '</script><script>alert(1)</script>', '*/ await evil() /*', '  separator', 'it\'s "quoted"']

describe('the generated test', () => {
  it('writes every golden reference plan as a test with one line per step and the three code checks', () => {
    for (const entry of loadGolden()) {
      const source = generateTest({ goal: entry.goal, steps: entry.plan, shopOrigin: 'http://127.0.0.1:8007' })
      expect(source).toContain('import { expect, test } from \'@playwright/test\'')
      expect(source).toContain('new AxeBuilder({ page })')
      expect(source).toContain('expect(consoleErrors).toEqual([])')
      expect(source).toContain('expect(failedRequests).toEqual([])')
      expect(source.match(/^ {2}\/\/ step \d+:/gm)).toHaveLength(entry.plan.length)
      expect(source.match(/^ {2}await /gm)).toHaveLength(entry.plan.length)
    }
  })

  it('keeps hostile strings inside JSON literals: no line of the file is added or broken by them', () => {
    const steps: Lb07Step[] = HOSTILE.flatMap((text): Lb07Step[] => [
      { action: 'click', role: 'button', name: text.slice(0, 120) },
      { action: 'fill', label: text.slice(0, 120), value: text.slice(0, 200) },
      { action: 'expectText', text: text.slice(0, 120) },
      { action: 'expectCount', role: 'heading', name: text.slice(0, 120), count: 3 },
    ])
    const plan: Lb07Step[] = [{ action: 'goto', path: '/' }, ...steps]
    const goal = HOSTILE.join(' ')
    const source = generateTest({ goal, steps: plan, shopOrigin: 'http://127.0.0.1:8007' })
    // Two lines per step (a comment and the call), the fixed lines around them, and nothing more: a line break in a string did not make a line.
    const fixedLines = generateTest({ goal: 'x', steps: [{ action: 'goto', path: '/' }], shopOrigin: 'http://127.0.0.1:8007' }).split('\n').length - 2
    expect(source.split('\n')).toHaveLength(fixedLines + plan.length * 2)
    for (const text of HOSTILE) {
      // The string appears only as its JSON form, whose quotes and backslashes keep it a literal.
      expect(source).toContain(JSON.stringify(text.slice(0, 120)))
      expect(source).not.toContain(`${text}\n`)
    }
    expect(source).not.toMatch(/^\s*process\.exit/m)
    expect(source).not.toContain('</script>\n')
  })

  it('names the file from the goal, bounded and plain', () => {
    expect(testFilename('Buy two bags of Ethiopia Guji with WELCOME10!')).toBe('buy-two-bags-of-ethiopia-guji-with-welco.spec.ts')
    expect(testFilename('???')).toBe('qa-run.spec.ts')
    expect(testFilename('Café "quoted"')).toBe('cafe-quoted.spec.ts')
  })
})
