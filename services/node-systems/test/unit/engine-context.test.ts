// Tests for what a step can read and how its settings become a request to a connector
// (engine/context.ts), and for the small pure pieces around it: idempotency keys, the retry
// delay and the allowance day. These are the places a visitor's own words meet the engine,
// so most of the cases are ways text could try to do something other than be text.
import type { ActionNode } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { retryDelayMs } from '../../src/modules/lb08/config.ts'
import { buildCall, lookup, readValue, renderQuestion, TEAM_MAILBOX_DOMAIN } from '../../src/modules/lb08/engine/context.ts'
import type { RunContext } from '../../src/modules/lb08/engine/context.ts'
import { PermanentStepError } from '../../src/modules/lb08/engine/errors.ts'
import { idempotencyKey, payloadHash } from '../../src/modules/lb08/engine/keys.ts'
import { dayOf, limitFor, nextReset } from '../../src/modules/lb08/engine/usage.ts'
import { TEST_CONFIG } from '../support/engine.ts'

const context: RunContext = {
  trigger: { orderId: 'WO-2041', cafe: 'Café Lumen', contactEmail: 'orders@lumen.test', totalEur: 640, sku: 'basalt-blend-1kg', quantityKg: 20 },
  outputs: new Map([['check_stock', { inStock: true, availableKg: 180, etaDays: 2, productName: 'Basalt Blend 1 kg' }]]),
}

/** Builds an email step with the given settings. */
function email(to: 'customer' | 'roastery' | 'purchasing', subject: string, body: string): ActionNode {
  return { id: 'send', type: 'action', label: 'Send', connector: 'email', params: { to, subject, body } }
}

/** Builds a Slack step with a message. */
function slack(message: string): ActionNode {
  return { id: 'tell', type: 'action', label: 'Tell', connector: 'slack_alert', params: { channel: '#roastery', message } }
}

describe('lookup', () => {
  it('reads a field of the payload, and a field of an earlier step\'s output', () => {
    expect(lookup(context, 'trigger.totalEur')).toBe(640)
    expect(lookup(context, 'trigger.cafe')).toBe('Café Lumen')
    expect(lookup(context, 'check_stock.etaDays')).toBe(2)
    expect(lookup(context, 'check_stock.inStock')).toBe(true)
  })

  it('finds nothing for a field, a step or a reference that isn\'t there', () => {
    for (const reference of ['trigger.nothing', 'ghost.etaDays', 'check_stock.nothing', 'trigger', 'not a reference', '']) {
      expect(lookup(context, reference), reference).toBeUndefined()
    }
  })

  it('never finds what every object inherits: a field called constructor is not a function', () => {
    for (const reference of ['trigger.constructor', 'trigger.toString', 'trigger.hasOwnProperty', 'check_stock.constructor', 'trigger.valueOf']) {
      expect(lookup(context, reference), reference).toBeUndefined()
    }
  })

  it('makes a condition with nothing to compare fail the step for good', () => {
    expect(readValue(context, 'trigger.totalEur')).toBe(640)
    expect(() => readValue(context, 'trigger.nothing')).toThrow(PermanentStepError)
  })
})

describe('building a request', () => {
  it('fills in every placeholder from the payload and the earlier steps', () => {
    const call = buildCall(slack('Order {{trigger.orderId}} from {{trigger.cafe}}: {{trigger.quantityKg}} kg of {{check_stock.productName}} (€{{trigger.totalEur}}).'), context)

    expect(call).toEqual({ connector: 'slack_alert', payload: { channel: '#roastery', message: 'Order WO-2041 from Café Lumen: 20 kg of Basalt Blend 1 kg (€640).' } })
  })

  it('never reads a placeholder out of a value it inserted', () => {
    const sneaky: RunContext = { ...context, trigger: { ...context.trigger, cafe: '{{trigger.contactEmail}} {{check_stock.etaDays}} {{' } }

    const call = buildCall(slack('From {{trigger.cafe}}.'), sneaky)

    expect(call.payload.message).toBe('From {{trigger.contactEmail}} {{check_stock.etaDays}} {{.')
  })

  it('fails the step for good, not quietly with half a message, when a value is missing', () => {
    expect(() => buildCall(slack('Total {{trigger.nothing}}'), context)).toThrow(PermanentStepError)
    expect(() => buildCall(slack('Total {{trigger.nothing}}'), context)).toThrow(/needs isn't available/)
  })

  it('cuts text that grew past the limits of the sandbox\'s table, without splitting an emoji', () => {
    const long: RunContext = { ...context, trigger: { ...context.trigger, cafe: 'x'.repeat(590) + '\u{1F600}'.repeat(30) } }

    const message = String(buildCall(slack('{{trigger.cafe}}'), long).payload.message)

    expect(message.length).toBeLessThanOrEqual(600)
    expect(message.isWellFormed()).toBe(true)
  })

  it('sends an email to the customer\'s sandbox address from the payload', () => {
    const call = buildCall(email('customer', 'Order {{trigger.orderId}}', 'ETA {{check_stock.etaDays}} days'), context)

    expect(call.payload).toEqual({ to: 'orders@lumen.test', subject: 'Order WO-2041', body: 'ETA 2 days' })
  })

  it('sends an email to a team mailbox on the reserved .test domain, which no one can receive', () => {
    const call = buildCall(email('purchasing', 'Hello', 'Hi'), context)

    expect(call.payload.to).toBe(`purchasing@${TEAM_MAILBOX_DOMAIN}`)
    expect(TEAM_MAILBOX_DOMAIN.endsWith('.test')).toBe(true)
  })

  it('refuses to email a customer whose address is not a sandbox address', () => {
    for (const address of ['someone@gmail.com', 'a@b.test.evil.com', '', 42]) {
      const real: RunContext = { ...context, trigger: { contactEmail: address } as RunContext['trigger'] }
      expect(() => buildCall(email('customer', 'Hello', 'Hi'), real), String(address)).toThrow(/no sandbox address/)
    }
  })

  it('reads the quantity of a stock check as kilograms above zero', () => {
    const check = (quantity: string): ActionNode => ({ id: 'stock', type: 'action', label: 'Stock', connector: 'stock_check', params: { sku: '{{trigger.sku}}', quantityKg: quantity } })

    expect(buildCall(check('{{trigger.quantityKg}}'), context).payload).toEqual({ sku: 'basalt-blend-1kg', quantityKg: 20 })
    for (const bad of ['0', '-5', 'many', '1e9', '{{trigger.cafe}}']) {
      expect(() => buildCall(check(bad), context), bad).toThrow(/number of kilograms/)
    }
  })

  it('asks a stock check with no quantity only whether anything is on the shelf', () => {
    const node: ActionNode = { id: 'stock', type: 'action', label: 'Stock', connector: 'stock_check', params: { sku: 'guji-filter-1kg' } }

    expect(buildCall(node, context).payload).toEqual({ sku: 'guji-filter-1kg' })
  })

  it('prefixes a webhook call\'s fields so none can collide with its endpoint or its event', () => {
    const node: ActionNode = { id: 'call', type: 'action', label: 'Call', connector: 'webhook', params: { endpoint: 'erp', event: 'order.confirmed', fields: { endpoint: '{{trigger.orderId}}', event: 'x' } } }

    expect(buildCall(node, context).payload).toEqual({ 'endpoint': 'erp', 'event': 'order.confirmed', 'field.endpoint': 'WO-2041', 'field.event': 'x' })
  })

  it('gives a task normal priority unless the step says otherwise', () => {
    const task = (priority?: 'normal' | 'high'): ActionNode => ({ id: 'task', type: 'action', label: 'Task', connector: 'create_task', params: { board: 'packing', title: 'Pack {{trigger.orderId}}', ...(priority ? { priority } : {}) } })

    expect(buildCall(task(), context).payload).toEqual({ board: 'packing', title: 'Pack WO-2041', priority: 'normal' })
    expect(buildCall(task('high'), context).payload.priority).toBe('high')
  })

  it('writes out an approval\'s question for the person who is asked', () => {
    expect(renderQuestion('Approve €{{trigger.totalEur}} for {{trigger.orderId}}?', context)).toBe('Approve €640 for WO-2041?')
  })
})

describe('idempotency keys', () => {
  it('name the chain\'s root run and the step, so a replay of a run shares its original\'s keys', () => {
    const root = '5b8d1f1e-0c1a-4d33-9a5b-6f0f9d2d7a11'

    expect(idempotencyKey(root, 'alert_roastery')).toBe(`${root}:alert_roastery`)
    expect(idempotencyKey(root, 'alert_roastery')).not.toBe(idempotencyKey(root, 'email_cafe'))
  })

  it('hash what is sent in a stable order, and tell different content apart', () => {
    const one = payloadHash('email', { to: 'a@b.test', subject: 's', body: 'b' })
    const sameInAnotherOrder = payloadHash('email', { body: 'b', to: 'a@b.test', subject: 's' })

    expect(one).toBe(sameInAnotherOrder)
    expect(one).not.toBe(payloadHash('email', { to: 'a@b.test', subject: 's', body: 'other' }))
    expect(one).not.toBe(payloadHash('slack_alert', { to: 'a@b.test', subject: 's', body: 'b' }))
    expect(one).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('the retry delay', () => {
  it('doubles with each attempt, as BullMQ\'s exponential backoff does', () => {
    expect([1, 2, 3].map(attempt => retryDelayMs({ ...TEST_CONFIG, backoffMs: 1_000 }, attempt))).toEqual([1_000, 2_000, 4_000])
  })
})

describe('the allowance day', () => {
  it('is the UTC day, and resets at the next 00:00 UTC', () => {
    const lateEvening = new Date('2026-10-01T23:59:59.999Z')

    expect(dayOf(lateEvening)).toBe('2026-10-01')
    expect(nextReset(lateEvening).toISOString()).toBe('2026-10-02T00:00:00.000Z')
    expect(dayOf(new Date('2026-10-02T00:00:00.000Z'))).toBe('2026-10-02')
    expect(nextReset(new Date('2026-12-31T12:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('allows ten runs and ten descriptions a day, the datasheet\'s numbers', () => {
    expect(limitFor('run')).toBe(10)
    expect(limitFor('generation')).toBe(10)
  })
})
