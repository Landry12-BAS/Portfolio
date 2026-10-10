// Tests of the two ways the editor reads a graph without changing it: the canvas's layout (where each
// step sits when nobody has placed it) and the outline (the steps in the order a run reaches them),
// and of the values a step may read, which must agree with what the validator accepts.
import { validateWorkflow } from '@lb/contracts'
import type { WorkflowGraph, WorkflowNode } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { addStep, connect, moveStep } from '~/boards/lb-08/graph/edit'
import { COLUMN_WIDTH, depths, layout, ROW_HEIGHT } from '~/boards/lb-08/graph/layout'
import { outlineOf } from '~/boards/lb-08/graph/outline'
import { alwaysRunsBefore, findReference, referencesAt } from '~/boards/lb-08/graph/references'

import { sampleGraph } from '../support/lb08-graphs'

describe('the layout', () => {
  it('puts each step in a column by how many steps come before it, and stacks a column from the top', () => {
    const graph = sampleGraph('wholesale-order')
    const places = layout(graph)

    expect(places.get('order_received')).toEqual({ x: 0, y: 0 })
    expect(places.get('big_order')).toEqual({ x: COLUMN_WIDTH, y: 0 })
    expect(places.get('check_stock')).toEqual({ x: 2 * COLUMN_WIDTH, y: 0 })
    expect(places.get('alert_roastery')).toEqual({ x: 3 * COLUMN_WIDTH, y: 0 })
    expect(places.get('email_cafe')).toEqual({ x: 3 * COLUMN_WIDTH, y: ROW_HEIGHT })
  })

  it('keeps the place a visitor gave a step, and still draws a graph that has a loop', () => {
    const moved = moveStep(sampleGraph('wholesale-order'), 'check_stock', { x: 40, y: 500 })
    expect(layout(moved).get('check_stock')).toEqual({ x: 40, y: 500 })

    const loop = connect(sampleGraph('wholesale-order'), 'email_cafe', 'check_stock')
    expect(depths(loop).size).toBe(loop.nodes.length)
    expect(layout(loop).size).toBe(loop.nodes.length)
  })
})

describe('the outline', () => {
  it('lists the steps in the order a run reaches them, each with where it comes from and where it goes', () => {
    const graph = sampleGraph('refund-approval')
    const items = outlineOf(graph)

    expect(items.map(item => item.node.id)).toEqual(['refund_asked', 'over_100', 'finance_ok', 'email_small', 'tell_accounting', 'email_refunded', 'email_declined'])
    expect(items.map(item => item.number)).toEqual([1, 2, 3, 4, 5, 6, 7])
    const finance = items.find(item => item.node.id === 'finance_ok')!
    expect(finance.incoming.map(connection => connection.source?.id)).toEqual(['over_100'])
    expect(finance.outgoing.map(connection => `${connection.edge.branch}>${connection.target?.id}`)).toEqual(['approved>tell_accounting', 'approved>email_refunded', 'rejected>email_declined'])
    expect(finance.outgoing.map(connection => connection.index)).toEqual([3, 4, 5])
  })

  it('shows a step with nothing leading to it, and a connection to a step that is not there', () => {
    const graph: WorkflowGraph = { ...sampleGraph('low-stock-reorder'), edges: [{ from: 'stock_alert', to: 'nothing_here' }] }
    const items = outlineOf(graph)

    expect(items).toHaveLength(3)
    expect(items.find(item => item.node.id === 'stock_alert')?.outgoing[0]?.target).toBeUndefined()
    expect(items.find(item => item.node.id === 'reorder_task')?.incoming).toEqual([])
  })

  it('puts a step no run can reach after the steps that run, so one just added does not push the others out of their places', () => {
    const graph = addStep(sampleGraph('wholesale-order'), { type: 'action', id: 'webhook', label: 'Tell the ERP', connector: 'webhook', params: { endpoint: 'erp', event: 'order.large', fields: {} } })
    const items = outlineOf(graph)

    expect(items.map(item => item.node.id)).toEqual(['order_received', 'big_order', 'check_stock', 'alert_roastery', 'email_cafe', 'webhook'])
    expect(items.at(-1)?.number).toBe(6)
  })

  it('keeps a step that is cut off after the ones that run, wherever the graph lists it', () => {
    const graph = sampleGraph('wholesale-order')
    const [trigger, condition, stock, alert, email] = graph.nodes as [WorkflowNode, WorkflowNode, WorkflowNode, WorkflowNode, WorkflowNode]
    // The e-mail is listed second and nothing leads to it, so it has the same column as the trigger.
    const cut: WorkflowGraph = { ...graph, nodes: [trigger, email, condition, stock, alert], edges: graph.edges.filter(edge => edge.to !== 'email_cafe') }

    expect(outlineOf(cut).map(item => item.node.id)).toEqual(['order_received', 'big_order', 'check_stock', 'alert_roastery', 'email_cafe'])
  })
})

describe('the values a step may read', () => {
  it('offers the event\'s fields first and then the outputs of the action steps that always run before the step', () => {
    const graph = sampleGraph('wholesale-order')
    const references = referencesAt(graph, 'alert_roastery').map(option => option.reference)

    expect(references.slice(0, 6)).toEqual(['trigger.orderId', 'trigger.cafe', 'trigger.contactEmail', 'trigger.totalEur', 'trigger.sku', 'trigger.quantityKg'])
    expect(references.slice(6)).toEqual(['check_stock.inStock', 'check_stock.availableKg', 'check_stock.etaDays', 'check_stock.productName'])
    expect(referencesAt(graph, 'check_stock').map(option => option.reference).filter(reference => !reference.startsWith('trigger.'))).toEqual([])
    expect(findReference(referencesAt(graph, 'alert_roastery'), 'check_stock.etaDays')).toMatchObject({ source: 'check_stock', field: 'etaDays', kind: 'number' })
  })

  it('does not offer the output of a step that only some paths pass through', () => {
    const graph = sampleGraph('refund-approval')

    expect(alwaysRunsBefore(graph, 'tell_accounting', 'email_declined')).toBe(false)
    expect(referencesAt(graph, 'email_declined').some(option => option.source === 'tell_accounting')).toBe(false)
  })

  it('agrees with the validator: a value is offered at a step exactly when the validator accepts it there', () => {
    const graphs = ['wholesale-order', 'low-stock-reorder', 'refund-approval'].map(id => sampleGraph(id))
    const stock: WorkflowGraph = addStep(sampleGraph('wholesale-order'), { id: 'late_note', type: 'action', label: 'Late note', connector: 'slack_alert', params: { channel: '#alerts', message: 'x' } }, 'email_cafe')
    for (const graph of [...graphs, stock]) {
      for (const reader of graph.nodes.filter(node => node.type === 'action')) {
        for (const writer of graph.nodes.filter(node => node.type === 'action' && node.id !== reader.id)) {
          if (reader.type !== 'action' || reader.connector !== 'slack_alert') continue
          const probe: WorkflowGraph = { ...graph, nodes: graph.nodes.map(node => (node.id === reader.id && node.type === 'action' && node.connector === 'slack_alert' ? { ...node, params: { ...node.params, message: `Value {{${writer.id}.messageId}}` } } : node)) }
          const verdict = validateWorkflow(probe)
          const refused = !verdict.ok && verdict.issues.some(issue => issue.code === 'unavailable_reference' || issue.code === 'unknown_reference')
          const writes = writer.type === 'action' && writer.connector !== 'stock_check'
          if (!writes) continue
          expect(!refused, `${writer.id} at ${reader.id}`).toBe(alwaysRunsBefore(graph, writer.id, reader.id))
        }
      }
    }
  })
})
