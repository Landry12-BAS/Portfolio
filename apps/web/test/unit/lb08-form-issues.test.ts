// Tests of the inspector's generated form, the test-order form and the placing of the validator's
// problems: every connector has a form made from its own schema, a limit in the contracts is the
// limit of the input, and each kind of problem lands on the step, the connection or the workflow it
// concerns, with the words and the numbers that fill its message.
import { CONNECTORS, connectorIds, connectorParams, GRAPH_LIMITS, TRIGGER_EVENTS, triggerEventIds, validateWorkflow } from '@lb/contracts'
import type { ActionNode, IssueCode, WorkflowGraph } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { connect, newAction, newStep, replaceStep } from '~/boards/lb-08/graph/edit'
import { entriesOf, fieldsFor, fieldsOfSchema, textOf, valueOf, withValue } from '~/boards/lb-08/graph/form'
import { indexIssues, locate, ownerOf, wordsFor } from '~/boards/lb-08/graph/issues'
import { entriesFromValues, exampleEntries, orderFields, orderProblems, valuesOf } from '~/boards/lb-08/graph/order'

import { sampleGraph, sampleInput } from '../support/lb08-graphs'

const TEXTS = { label: 'New step', message: 'Something happened.', subject: 'An update', body: 'Hello,', title: 'Look into it', question: 'Is this fine?' }

describe('the form of a step', () => {
  it('has one input for each parameter of a connector, made from the connector\'s own schema', () => {
    const slack = fieldsFor(newAction('slack_alert', 'tell', TEXTS))

    expect(slack).toEqual([
      { kind: 'choice', name: 'channel', required: true, options: ['#roastery', '#purchasing', '#support', '#wholesale', '#alerts'] },
      { kind: 'text', name: 'message', required: true, maxLength: 400, multiline: true, templated: true },
    ])
    const email = fieldsFor(newAction('email', 'mail', TEXTS))
    expect(email.map(field => `${field.name}:${field.kind}`)).toEqual(['to:choice', 'subject:text', 'body:text'])
    expect(email.find(field => field.name === 'subject')).toMatchObject({ maxLength: 120, multiline: false })
  })

  it('reads a fixed form of text as not holding values, and a record as rows with the limit of the contracts', () => {
    const webhook = fieldsFor(newAction('webhook', 'call', TEXTS))

    expect(webhook.find(field => field.name === 'event')).toMatchObject({ kind: 'text', templated: false })
    expect(webhook.find(field => field.name === 'fields')).toMatchObject({ kind: 'entries', valueMaxLength: 200, maxEntries: GRAPH_LIMITS.maxWebhookFields })
    expect(fieldsFor(newAction('stock_check', 'look', TEXTS)).find(field => field.name === 'quantityKg')).toMatchObject({ required: false })
    expect(fieldsFor(newAction('create_task', 'job', TEXTS)).find(field => field.name === 'priority')).toMatchObject({ kind: 'choice', required: false, options: ['normal', 'high'] })
  })

  it('has a form for every connector, the trigger and the approval, and none for a condition', () => {
    const graph = sampleGraph('refund-approval')

    for (const connector of connectorIds) {
      expect(fieldsOfSchema(connectorParams[connector]).length, connector).toBeGreaterThan(0)
      expect(CONNECTORS[connector].label).toBeTruthy()
    }
    expect(fieldsFor(graph.nodes[0]!).map(field => field.name)).toEqual(['event'])
    expect(fieldsFor(graph.nodes[0]!)[0]).toMatchObject({ kind: 'choice', options: [...triggerEventIds] })
    expect(fieldsFor(graph.nodes.find(node => node.type === 'approval')!).map(field => field.name)).toEqual(['approver', 'message'])
    expect(fieldsFor(graph.nodes.find(node => node.type === 'condition')!)).toEqual([])
  })

  it('reads and changes one setting of a step, and takes a cleared optional setting off the step', () => {
    const stock = newAction('stock_check', 'look', TEXTS)
    const quantity = fieldsFor(stock).find(field => field.name === 'quantityKg')!
    const sku = fieldsFor(stock).find(field => field.name === 'sku')!

    const withQuantity = withValue(stock, quantity, '{{trigger.quantityKg}}')
    expect(valueOf(withQuantity, 'quantityKg')).toBe('{{trigger.quantityKg}}')
    expect(textOf(withValue(withQuantity, quantity, ''), 'quantityKg')).toBe('')
    expect(Object.keys((withValue(withQuantity, quantity, '') as { params: object }).params)).toEqual(['sku'])
    expect(valueOf(withValue(stock, sku, ''), 'sku')).toBe('')

    const trigger = sampleGraph('low-stock-reorder').nodes[0]!
    const event = fieldsFor(trigger)[0]!
    expect(withValue(trigger, event, 'manual')).toMatchObject({ id: 'stock_alert', event: 'manual' })
  })

  it('reads a record\'s rows and writes them back', () => {
    const webhook: ActionNode = { id: 'call', type: 'action', label: 'Call', connector: 'webhook', params: { endpoint: 'erp', event: 'order.updated', fields: { orderId: '{{trigger.orderId}}' } } }
    const field = fieldsFor(webhook).find(candidate => candidate.name === 'fields')!

    expect(entriesOf(webhook, 'fields')).toEqual([{ name: 'orderId', value: '{{trigger.orderId}}' }])
    expect(valueOf(withValue(webhook, field, { orderId: 'x', sku: 'y' }), 'fields')).toEqual({ orderId: 'x', sku: 'y' })
    expect(entriesOf(newAction('slack_alert', 'tell', TEXTS), 'fields')).toEqual([])
  })
})

describe('the test order', () => {
  it('has a field for each value the event carries, with the catalogue\'s limits', () => {
    const fields = orderFields('wholesale_order')

    expect(fields.map(field => `${field.name}:${field.kind}`)).toEqual(['orderId:text', 'cafe:text', 'contactEmail:email', 'totalEur:number', 'sku:text', 'quantityKg:number'])
    expect(fields.find(field => field.name === 'totalEur')).toMatchObject({ min: 0, max: 100_000, example: '640' })
    expect(orderFields('customer_review').find(field => field.name === 'rating')).toMatchObject({ min: 1, max: 5 })
  })

  it('starts from the examples, which the check accepts, for every event', () => {
    for (const event of triggerEventIds) {
      const fields = orderFields(event)
      expect(orderProblems(event, fields, exampleEntries(event)).size, event).toBe(0)
      expect(Object.keys(TRIGGER_EVENTS[event].fields)).toEqual(fields.map(field => field.name))
    }
  })

  it('holds numbers as text and a sample\'s values as they were, and reads them back as the API takes them', () => {
    const fields = orderFields('wholesale_order')
    const entries = entriesFromValues(sampleInput('wholesale-order'))

    expect(entries.totalEur).toBe('640')
    expect(valuesOf(fields, { ...entries, cafe: '  Café Lumen ' })).toEqual({ ...sampleInput('wholesale-order') })
  })

  it('names the fields that do not fit and why, without repeating what was typed', () => {
    const fields = orderFields('wholesale_order')
    const entries = { ...exampleEntries('wholesale_order'), totalEur: 'a lot', orderId: '   ', contactEmail: 'someone@example.com', quantityKg: '-4', sku: '' }
    const problems = orderProblems('wholesale_order', fields, entries)

    expect([...problems.entries()].sort()).toEqual([['contactEmail', 'sandboxAddress'], ['orderId', 'required'], ['quantityKg', 'range'], ['sku', 'required'], ['totalEur', 'number']])
    expect(orderProblems('customer_review', orderFields('customer_review'), { ...exampleEntries('customer_review'), rating: '9' }).get('rating')).toBe('range')
    expect(orderProblems('customer_review', orderFields('customer_review'), { ...exampleEntries('customer_review'), comment: 'x'.repeat(401) }).get('comment')).toBe('tooLong')
  })
})

describe('where a problem belongs', () => {
  /** Validates a changed graph and returns the problems with their places. */
  function problemsOf(graph: WorkflowGraph) {
    const verdict = validateWorkflow(graph)
    expect(verdict.ok).toBe(false)
    return indexIssues(graph, verdict.ok ? [] : verdict.issues)
  }

  it('puts a problem about a value on the step and the field it names', () => {
    const graph = replaceStep(sampleGraph('low-stock-reorder'), { id: 'tell_purchasing', type: 'action', label: 'Tell purchasing', connector: 'slack_alert', params: { channel: '#alerts', message: '' } })
    const index = problemsOf(graph)
    const located = index.byNode.get('tell_purchasing')!

    expect(located.map(item => item.issue.code)).toEqual(['invalid_param'])
    expect(located[0]?.target).toEqual({ kind: 'node', nodeId: 'tell_purchasing', field: 'params.message' })
    expect(index.byEdge.size).toBe(0)
    expect(index.graph).toEqual([])
  })

  it('puts a problem about a loop on the connection that closes it, and one about a missing branch on its connection', () => {
    const loop = problemsOf(connect(sampleGraph('wholesale-order'), 'email_cafe', 'check_stock'))
    const closing = [...loop.byEdge.values()].flat()
    expect(closing.map(item => item.issue.code)).toContain('cycle')

    const branchless = problemsOf({ ...sampleGraph('wholesale-order'), edges: [{ from: 'order_received', to: 'big_order' }, { from: 'big_order', to: 'check_stock' }, { from: 'check_stock', to: 'alert_roastery' }, { from: 'check_stock', to: 'email_cafe' }] })
    expect([...branchless.byEdge.values()].flat().map(item => item.issue.code)).toEqual(['missing_branch'])
  })

  it('puts a problem about the whole workflow on the workflow, and a problem about a step with no way in on the step', () => {
    const noTrigger = problemsOf({ ...sampleGraph('low-stock-reorder'), nodes: sampleGraph('low-stock-reorder').nodes.slice(1), edges: [{ from: 'tell_purchasing', to: 'reorder_task' }] })
    expect(noTrigger.graph.map(item => item.issue.code)).toContain('no_trigger')

    const orphan = problemsOf({ ...sampleGraph('low-stock-reorder'), edges: [sampleGraph('low-stock-reorder').edges[0]!] })
    expect(orphan.byNode.get('reorder_task')?.map(item => item.issue.code)).toEqual(['unreachable_node'])
  })

  it('treats a path it does not understand as a problem with the workflow', () => {
    const graph = sampleGraph('low-stock-reorder')

    expect(locate(graph, { code: 'invalid_value', path: 'name', message: 'x' }).target).toEqual({ kind: 'graph', field: 'name' })
    expect(locate(graph, { code: 'invalid_value', path: 'nodes.99.label', message: 'x' }).target).toEqual({ kind: 'graph', field: undefined })
    expect(locate(graph, { code: 'dangling_edge', path: 'edges.99', message: 'x' }).target).toEqual({ kind: 'graph', field: undefined })
    expect(locate(graph, { code: 'no_trigger', path: 'nodes', message: 'x' }).target).toEqual({ kind: 'graph', field: undefined })
  })

  it('writes the words for a problem from the step, the connection and the limits it concerns', () => {
    const graph = connect(sampleGraph('wholesale-order'), 'email_cafe', 'check_stock')
    const label = (owner: string, name: string) => `${owner}/${name}`
    const cycle = problemsOf(graph).all.find(item => item.issue.code === 'cycle')!

    expect(wordsFor(graph, cycle, label)).toEqual({ key: 'lb08.issues.cycle', params: { from: 'Email the café', to: 'Check stock', branch: '', max: GRAPH_LIMITS.maxFanOut } })

    const emptyMessage = replaceStep(sampleGraph('low-stock-reorder'), { id: 'tell_purchasing', type: 'action', label: 'Tell purchasing', connector: 'slack_alert', params: { channel: '#alerts', message: '' } })
    const param = problemsOf(emptyMessage).all[0]!
    expect(wordsFor(emptyMessage, param, label)).toEqual({ key: 'lb08.issues.invalid_param', params: { step: 'Tell purchasing', id: 'tell_purchasing', field: 'slack_alert/message', max: GRAPH_LIMITS.maxFanOut, count: 0 } })

    const wide: WorkflowGraph = { ...sampleGraph('low-stock-reorder'), edges: Array.from({ length: 5 }, () => ({ from: 'stock_alert', to: 'tell_purchasing' })) }
    const fanOut = problemsOf(wide).all.find(item => item.issue.code === 'fan_out')!
    expect(wordsFor(wide, fanOut, label)).toEqual({ key: 'lb08.issues.fan_out', params: { step: 'Stock runs low', id: 'stock_alert', max: GRAPH_LIMITS.maxFanOut, count: 5 } })
    expect(ownerOf(newStep(sampleGraph('low-stock-reorder'), 'email', TEXTS))).toBe('email')
    expect(ownerOf(sampleGraph('low-stock-reorder').nodes[0]!)).toBe('trigger')
  })

  it('has words for every code the validator can give, in the key the locale files must hold', () => {
    const codes: IssueCode[] = ['unknown_connector', 'cycle', 'dangling_edge', 'missing_branch', 'unreachable_node', 'invalid_param', 'unknown_trigger', 'unknown_reference']
    const graph = sampleGraph('low-stock-reorder')

    for (const code of codes) {
      expect(wordsFor(graph, { issue: { code, path: 'graph', message: '' }, target: { kind: 'graph', field: undefined } }, () => '').key).toBe(`lb08.issues.${code}`)
    }
    expect(wordsFor(graph, { issue: { code: 'unknown_field', path: 'nodes.0', message: '' }, target: { kind: 'graph', field: undefined } }, () => '').key).toBe('lb08.issues.invalid_value')
  })
})
