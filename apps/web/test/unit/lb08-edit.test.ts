// Tests of the operations an editor does to a workflow graph: every step the editor can add starts
// valid, connecting a step that branches takes the next free branch, removing a step takes its
// connections with it, and no operation changes the graph it was given.
import { connectorIds, validateWorkflow } from '@lb/contracts'
import type { WorkflowGraph } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { addStep, changeConnector, connect, disconnect, moveStep, nextBranch, newAction, newStep, relabel, removeStep, rename, replaceStep, sameGraph, STEP_KINDS, uniqueId } from '~/boards/lb-08/graph/edit'
import type { DefaultTexts } from '~/boards/lb-08/graph/edit'

import { sampleGraph } from '../support/lb08-graphs'

const TEXTS: DefaultTexts = { label: 'New step', message: 'Something happened.', subject: 'An update', body: 'Hello,', title: 'Look into it', question: 'Is this fine?' }

/** The smallest graph the validator accepts: a manual trigger and one Slack step. */
function smallest(): WorkflowGraph {
  return {
    name: 'Small workflow',
    nodes: [
      { id: 'started', type: 'trigger', label: 'Started', event: 'manual' },
      { id: 'tell', type: 'action', label: 'Tell', connector: 'slack_alert', params: { channel: '#alerts', message: 'Hello.' } },
    ],
    edges: [{ from: 'started', to: 'tell' }],
  }
}

describe('the steps the editor adds', () => {
  it('knows every kind of step: the trigger, a condition, an approval and one action for each connector', () => {
    expect(STEP_KINDS).toEqual(['trigger', 'condition', 'approval', ...connectorIds])
  })

  it.each(STEP_KINDS.filter(kind => kind !== 'trigger'))('adds a %s step that passes the validator', (kind) => {
    const base = smallest()
    const grown = addStep(base, newStep(base, kind, TEXTS), 'started')

    expect(validateWorkflow(grown).ok, JSON.stringify(validateWorkflow(grown))).toBe(true)
    expect(grown.nodes).toHaveLength(3)
    expect(grown.edges).toHaveLength(2)
  })

  it('reads a new condition from the first value of the trigger\'s event, with a comparison that suits it', () => {
    const order: WorkflowGraph = { ...smallest(), nodes: [{ id: 'order', type: 'trigger', label: 'Order', event: 'wholesale_order' }, ...smallest().nodes.slice(1)], edges: [{ from: 'order', to: 'tell' }] }
    const condition = newStep(order, 'condition', TEXTS)

    expect(condition).toMatchObject({ type: 'condition', field: 'trigger.orderId', op: 'eq', value: '' })
    const review: WorkflowGraph = { ...order, nodes: [{ id: 'review', type: 'trigger', label: 'Review', event: 'customer_review' }, ...order.nodes.slice(1)], edges: [{ from: 'review', to: 'tell' }] }
    expect(newStep(review, 'condition', TEXTS)).toMatchObject({ field: 'trigger.customerName' })
  })

  it('gives each step an id nobody has, and never the reserved word', () => {
    const graph = smallest()

    expect(uniqueId(graph, 'email')).toBe('email')
    expect(uniqueId(graph, 'tell')).toBe('tell_2')
    expect(uniqueId(addStep(graph, newAction('slack_alert', 'slack_alert', TEXTS)), 'slack_alert')).toBe('slack_alert_2')
    expect(uniqueId(graph, 'trigger')).toBe('trigger_2')
    expect(uniqueId(graph, 'x'.repeat(40))).toHaveLength(28)
    expect(uniqueId({ ...graph, nodes: [...graph.nodes, newAction('email', 'x'.repeat(28), TEXTS)] }, 'x'.repeat(40))).toBe(`${'x'.repeat(28)}_2`)
  })
})

describe('connecting steps', () => {
  it('takes the next free branch out of a step that branches, and none out of one that does not', () => {
    const graph = sampleGraph('refund-approval')

    expect(nextBranch(graph, 'finance_ok')).toBeUndefined()
    expect(nextBranch(graph, 'over_100')).toBeUndefined()
    const lonely = removeStep(graph, 'finance_ok')
    expect(nextBranch(lonely, 'over_100')).toBe('true')
    expect(nextBranch(graph, 'refund_asked')).toBeUndefined()

    const added = addStep(lonely, newAction('email', 'extra', TEXTS), 'over_100')
    expect(added.edges.at(-1)).toEqual({ from: 'over_100', to: 'extra', branch: 'true' })
    expect(nextBranch(added, 'over_100')).toBeUndefined()
  })

  it('connects with a branch label when the step branches, and changes nothing when the same connection is made twice', () => {
    const graph = sampleGraph('wholesale-order')
    const once = connect(graph, 'big_order', 'email_cafe', 'false')

    expect(once.edges.at(-1)).toEqual({ from: 'big_order', to: 'email_cafe', branch: 'false' })
    expect(connect(once, 'big_order', 'email_cafe', 'false')).toBe(once)
    expect(connect(graph, 'check_stock', 'big_order').edges.at(-1)).toEqual({ from: 'check_stock', to: 'big_order' })
  })

  it('cuts a connection, and changes its branch label or takes it off', () => {
    const graph = sampleGraph('wholesale-order')

    expect(disconnect(graph, 1).edges).toHaveLength(graph.edges.length - 1)
    expect(relabel(graph, 1, 'false').edges[1]).toEqual({ from: 'big_order', to: 'check_stock', branch: 'false' })
    expect(relabel(graph, 1, undefined).edges[1]).toEqual({ from: 'big_order', to: 'check_stock' })
  })
})

describe('changing a graph', () => {
  it('removes a step with every connection that touches it', () => {
    const graph = sampleGraph('wholesale-order')
    const smaller = removeStep(graph, 'check_stock')

    expect(smaller.nodes.map(node => node.id)).not.toContain('check_stock')
    expect(smaller.edges.every(edge => edge.from !== 'check_stock' && edge.to !== 'check_stock')).toBe(true)
    expect(smaller.edges).toHaveLength(1)
  })

  it('changes an action\'s connector to the new connector\'s defaults but keeps its id, its label and its place', () => {
    const graph = moveStep(sampleGraph('wholesale-order'), 'alert_roastery', { x: 10.4, y: 99.6 })
    const changed = changeConnector(graph, 'alert_roastery', 'create_task', TEXTS)
    const node = changed.nodes.find(candidate => candidate.id === 'alert_roastery')

    expect(node).toMatchObject({ type: 'action', connector: 'create_task', label: 'Alert the roastery', position: { x: 10, y: 100 } })
    expect(node).toHaveProperty('params.title', 'Look into it')
    expect(changeConnector(graph, 'order_received', 'email', TEXTS)).toBe(graph)
  })

  it('renames the workflow and replaces a step', () => {
    const graph = sampleGraph('low-stock-reorder')

    expect(rename(graph, 'Better name').name).toBe('Better name')
    const first = graph.nodes[0]!
    expect(replaceStep(graph, { ...first, label: 'Changed' }).nodes[0]).toMatchObject({ label: 'Changed' })
  })

  it('never changes the graph it was given', () => {
    const graph = sampleGraph('refund-approval')
    const before = JSON.stringify(graph)

    removeStep(graph, 'finance_ok')
    addStep(graph, newStep(graph, 'email', TEXTS), 'over_100')
    connect(graph, 'refund_asked', 'finance_ok')
    disconnect(graph, 0)
    relabel(graph, 0, 'true')
    moveStep(graph, 'finance_ok', { x: 1, y: 2 })
    rename(graph, 'Other')

    expect(JSON.stringify(graph)).toBe(before)
  })

  it('knows two graphs are the same whatever order their keys were written in, and that a moved step is not', () => {
    const graph = sampleGraph('low-stock-reorder')
    const shuffled: WorkflowGraph = JSON.parse(JSON.stringify({ edges: graph.edges, nodes: graph.nodes.map(node => Object.fromEntries(Object.entries(node).reverse())), name: graph.name }))

    expect(sameGraph(graph, shuffled)).toBe(true)
    expect(sameGraph(graph, moveStep(graph, 'stock_alert', { x: 5, y: 5 }))).toBe(false)
    expect(sameGraph(graph, rename(graph, 'x'))).toBe(false)
  })
})
