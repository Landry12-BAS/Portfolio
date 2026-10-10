// Tests for references, templates and conditions: the small language steps use to read
// data. It has no expressions, so the tests check that nothing in it can do more than
// substitute a value or compare two.
import { describe, expect, it } from 'vitest'

import { evaluateCondition, parseReference, renderTemplate, scanTemplate } from '../src/index.ts'

describe('references', () => {
  it('splits a source and a field', () => {
    expect(parseReference('trigger.totalEur')).toEqual({ source: 'trigger', field: 'totalEur' })
    expect(parseReference('check_stock.etaDays')).toEqual({ source: 'check_stock', field: 'etaDays' })
  })

  it.each(['', 'trigger', 'trigger.', '.field', 'a.b.c', 'Trigger.x', 'trigger.1x', 'process.env.SECRET', 'trigger.x y', 'a-b.c'])('refuses %j', (text) => {
    expect(parseReference(text)).toBeUndefined()
  })
})

describe('templates', () => {
  it('lists the placeholders in order, trimmed, with repeats', () => {
    expect(scanTemplate('Order {{ trigger.orderId }} for {{trigger.cafe}}, again {{trigger.orderId}}')).toEqual({
      placeholders: ['trigger.orderId', 'trigger.cafe', 'trigger.orderId'],
      stray: false,
    })
  })

  it('notices braces that are not a placeholder', () => {
    expect(scanTemplate('Order {{trigger.orderId').stray).toBe(true)
    expect(scanTemplate('Order trigger.orderId}}').stray).toBe(true)
    expect(scanTemplate('{{}} and {{{{x}}').stray).toBe(true)
    expect(scanTemplate('A single { brace } is only text').stray).toBe(false)
  })

  it('fills each placeholder once, and never reads inside the value it inserted', () => {
    const values: Record<string, string | number> = { 'trigger.cafe': '{{trigger.orderId}}', 'trigger.orderId': 'WO-1', 'check_stock.etaDays': 2 }

    const rendered = renderTemplate('{{trigger.cafe}} gets it in {{check_stock.etaDays}} days', reference => values[reference])

    expect(rendered).toEqual({ text: '{{trigger.orderId}} gets it in 2 days', missing: [] })
  })

  it('renders a missing value as nothing and lists it', () => {
    const rendered = renderTemplate('Hello {{trigger.name}}!', () => undefined)

    expect(rendered).toEqual({ text: 'Hello !', missing: ['trigger.name'] })
  })

  it('stays fast on text built to make a careless pattern backtrack', () => {
    const hostile = `${'{{ '.repeat(5_000)}x`
    const started = performance.now()

    scanTemplate(hostile)
    renderTemplate(hostile, () => undefined)

    expect(performance.now() - started).toBeLessThan(250)
  })
})

describe('conditions', () => {
  it('compares numbers', () => {
    expect(evaluateCondition('gt', 640, 500)).toBe(true)
    expect(evaluateCondition('gt', 500, 500)).toBe(false)
    expect(evaluateCondition('gte', 500, 500)).toBe(true)
    expect(evaluateCondition('lt', 22, 30)).toBe(true)
    expect(evaluateCondition('lte', 30, 30)).toBe(true)
  })

  it('compares text without regard to case', () => {
    expect(evaluateCondition('eq', 'Wrong Grind', 'wrong grind')).toBe(true)
    expect(evaluateCondition('neq', 'Wrong Grind', 'wrong grind')).toBe(false)
    expect(evaluateCondition('contains', 'The bag arrived TORN', 'torn')).toBe(true)
  })

  it('compares flags', () => {
    expect(evaluateCondition('eq', true, true)).toBe(true)
    expect(evaluateCondition('neq', false, true)).toBe(true)
  })

  it('is false for a comparison that makes no sense', () => {
    expect(evaluateCondition('gt', 'abc', 1)).toBe(false)
    expect(evaluateCondition('lt', 1, 'abc')).toBe(false)
    expect(evaluateCondition('contains', 5, 5)).toBe(false)
    expect(evaluateCondition('eq', 1, '1')).toBe(false)
  })
})
