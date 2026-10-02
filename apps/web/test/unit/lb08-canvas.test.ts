// Tests of what the canvas is drawn from: a node for each step and an edge for each connection,
// worked out from the draft and the validator's answer, in the visitor's language. They do not need
// Vue Flow or a browser: the mapping is plain data. They check that every step has a place, a number
// that matches the outline, the dots a connection can start from (one for each branch), the
// problem at the step or the connection in a few words, and, after a run, the state of each step;
// and that a connection to a step that is not there is left out rather than breaking the canvas.
import { validateWorkflow } from '@lb/contracts'
import type { WorkflowGraph } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import { branchOfHandle, canvasEdges, canvasNodes, edgeIdOf, edgeIndexOf, handleFor, PLAIN_HANDLE } from '~/boards/lb-08/graph/canvas'
import type { CanvasInput } from '~/boards/lb-08/graph/canvas'
import { connect, moveStep } from '~/boards/lb-08/graph/edit'
import { indexIssues } from '~/boards/lb-08/graph/issues'
import { COLUMN_WIDTH } from '~/boards/lb-08/graph/layout'
import { outlineOf } from '~/boards/lb-08/graph/outline'
import type { Words } from '~/boards/lb-08/graph/words'
import { modelFromView } from '~/boards/lb-08/run/model'
import en from '../../i18n/locales/en'

import { sampleGraph } from '../support/lb08-graphs'

const MESSAGES = (en as { lb08: Record<string, unknown> }).lb08

/** Looks a dotted key up in the English messages. */
function lookup(key: string): string | undefined {
  const found = key.split('.').slice(1).reduce<unknown>((place, part) => (typeof place === 'object' && place !== null ? (place as Record<string, unknown>)[part] : undefined), MESSAGES)
  return typeof found === 'string' ? found : undefined
}

/** The English words the canvas would be given, with parameters filled in. */
const words: Words = {
  say: (key, params = {}) => (lookup(key) ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? '')),
  has: key => lookup(key) !== undefined,
}

/** Builds the canvas's input for a graph, with the validator's problems indexed. */
function inputFor(graph: WorkflowGraph, overrides: Partial<CanvasInput> = {}): CanvasInput {
  const checked = validateWorkflow(graph)
  return { graph, issues: indexIssues(graph, checked.ok ? [] : checked.issues), selection: undefined, editable: true, run: undefined, helpId: 'keys', words, ...overrides }
}

describe('the canvas nodes', () => {
  it('draws a node for every step, numbered as the outline numbers them, each in the place the layout gives', () => {
    const graph = sampleGraph('wholesale-order')
    const nodes = canvasNodes(inputFor(graph))

    expect(nodes.map(node => node.id)).toEqual(graph.nodes.map(node => node.id))
    const numbers = new Map(outlineOf(graph).map(item => [item.node.id, item.number]))
    for (const node of nodes) expect(node.data.number).toBe(numbers.get(node.id))
    expect(nodes.find(node => node.id === 'check_stock')?.position).toEqual({ x: 2 * COLUMN_WIDTH, y: 0 })
  })

  it('keeps the place a visitor gave a step', () => {
    const moved = moveStep(sampleGraph('wholesale-order'), 'check_stock', { x: 40, y: 500 })

    expect(canvasNodes(inputFor(moved)).find(node => node.id === 'check_stock')?.position).toEqual({ x: 40, y: 500 })
  })

  it('names the kind of each step and gives it the icon of its kind', () => {
    const nodes = canvasNodes(inputFor(sampleGraph('wholesale-order')))

    const byId = Object.fromEntries(nodes.map(node => [node.id, node.data]))
    expect(byId.order_received).toMatchObject({ kind: 'trigger', kindLabel: 'Trigger', icon: 'play' })
    expect(byId.big_order).toMatchObject({ kind: 'condition', kindLabel: 'Condition', icon: 'filter' })
    expect(byId.alert_roastery).toMatchObject({ kind: 'slack_alert', kindLabel: 'Slack alert', icon: 'support' })
  })

  it('gives a step that branches one dot for each branch, and any other step one plain dot', () => {
    const nodes = canvasNodes(inputFor(sampleGraph('refund-approval')))
    const handles = Object.fromEntries(nodes.map(node => [node.id, node.data.handles.map(handle => handle.id)]))

    expect(handles.finance_ok).toEqual(['approved', 'rejected'])
    expect(nodes.find(node => node.data.kind === 'condition')?.data.handles.map(handle => handle.id)).toEqual(['true', 'false'])
    expect(nodes.find(node => node.data.kind === 'email')?.data.handles).toEqual([{ id: PLAIN_HANDLE, branch: undefined, top: '50%', label: '' }])
    expect(nodes.find(node => node.data.kind === 'condition')?.data.handles.map(handle => handle.label)).toEqual(['True', 'False'])
  })

  it('leaves the dot that takes connections in off the trigger, since nothing may lead into it', () => {
    const nodes = canvasNodes(inputFor(sampleGraph('wholesale-order')))

    expect(nodes.find(node => node.data.kind === 'trigger')?.data.acceptsInput).toBe(false)
    expect(nodes.filter(node => node.data.kind !== 'trigger').every(node => node.data.acceptsInput)).toBe(true)
  })

  it('marks the picked step, and only that one', () => {
    const nodes = canvasNodes(inputFor(sampleGraph('wholesale-order'), { selection: { kind: 'node', id: 'big_order' } }))

    expect(nodes.filter(node => node.selected).map(node => node.id)).toEqual(['big_order'])
    expect(canvasNodes(inputFor(sampleGraph('wholesale-order'), { selection: { kind: 'edge', index: 0 } })).some(node => node.selected)).toBe(false)
  })

  it('does not let a step be dragged, connected or removed while a recording is shown, and never removes the trigger with the keyboard', () => {
    const nodes = canvasNodes(inputFor(sampleGraph('wholesale-order'), { editable: false }))

    expect(nodes.every(node => !node.draggable && !node.connectable && node.data.editable === false)).toBe(true)
    expect(canvasNodes(inputFor(sampleGraph('wholesale-order'))).every(node => node.deletable === false)).toBe(true)
  })

  it('says what the step is in a label for assistive technology, in the visitor\'s language, and points at the help for the keys', () => {
    const [first] = canvasNodes(inputFor(sampleGraph('wholesale-order')))

    expect(first?.ariaLabel).toBe('Step 1, Trigger: Wholesale order arrives.')
    expect(first?.domAttributes).toEqual({ 'aria-describedby': 'keys', 'aria-roledescription': 'step' })
  })

  it('shows the first problem of a step in a few words, how many more there are, and the whole of them in its label', () => {
    // Two steps nobody leads to: each has the one problem, which the canvas says by its code.
    const graph = sampleGraph('wholesale-order')
    const broken: WorkflowGraph = { ...graph, edges: graph.edges.filter(edge => edge.to !== 'check_stock') }
    const nodes = canvasNodes(inputFor(broken))

    const stock = nodes.find(node => node.id === 'check_stock')
    expect(stock?.data.reason).toBe('A step cannot be reached from the trigger.')
    expect(stock?.data.moreProblems).toBe(0)
    expect(stock?.ariaLabel).toContain('Step Check stock cannot be reached from the trigger.')
    expect(nodes.find(node => node.id === 'order_received')?.data.reason).toBeUndefined()
  })

  it('shows what a run did with each step, with the attempts it used and its place in the dead-letter queue', () => {
    const graph = sampleGraph('low-stock-reorder')
    const run = modelFromView({
      id: '11111111-1111-4111-8111-111111111111',
      workflowId: '22222222-2222-4222-8222-222222222222',
      workflowName: 'x',
      version: 1,
      rootRunId: '11111111-1111-4111-8111-111111111111',
      replayOf: null,
      status: 'failed',
      createdAt: '2026-10-02T09:30:00.000Z',
      finishedAt: '2026-10-02T09:30:05.000Z',
      input: {},
      replayedBy: null,
      steps: [
        { nodeId: 'stock_alert', status: 'succeeded', attempts: 0, output: {}, error: null, startedAt: null, finishedAt: null },
        { nodeId: 'tell_purchasing', status: 'failed', attempts: 3, output: null, error: { code: 'connector_unavailable', message: 'x' }, startedAt: null, finishedAt: null },
        { nodeId: 'reorder_task', status: 'succeeded', attempts: 1, output: {}, error: null, startedAt: null, finishedAt: null },
      ],
      events: [
        { seq: 1, at: '2026-10-02T09:30:00.000Z', runId: '11111111-1111-4111-8111-111111111111', type: 'step.dead_lettered', nodeId: 'tell_purchasing', attempts: 3 },
      ],
    }, 0)
    const nodes = canvasNodes(inputFor(graph, { run }))

    const slack = nodes.find(node => node.id === 'tell_purchasing')?.data.badge
    expect(slack).toMatchObject({ status: 'failed', icon: 'error', text: 'Failed', attempt: 'Attempt 3 of 3', deadLetter: 'In the dead-letter queue' })
    expect(nodes.find(node => node.id === 'reorder_task')?.data.badge).toMatchObject({ status: 'succeeded', attempt: 'Attempt 1 of 3', deadLetter: undefined })
    expect(nodes.find(node => node.id === 'stock_alert')?.data.badge?.attempt).toBeUndefined()
  })

  it('draws a step once even if the graph names two steps by one id', () => {
    const graph = sampleGraph('wholesale-order')
    const twice: WorkflowGraph = { ...graph, nodes: [...graph.nodes, { ...graph.nodes[1]! }] }

    expect(canvasNodes(inputFor(twice))).toHaveLength(graph.nodes.length)
  })
})

describe('the canvas edges', () => {
  it('draws an edge for each connection, with an id that gives back its place in the graph', () => {
    const graph = sampleGraph('wholesale-order')
    const edges = canvasEdges(inputFor(graph))

    expect(edges).toHaveLength(graph.edges.length)
    edges.forEach((edge, index) => {
      expect(edge.id).toBe(edgeIdOf(index))
      expect(edgeIndexOf(edge.id)).toBe(index)
      expect(edge.source).toBe(graph.edges[index]?.from)
      expect(edge.target).toBe(graph.edges[index]?.to)
    })
    expect(edgeIndexOf('edge-x')).toBeUndefined()
    expect(edgeIndexOf('node-3')).toBeUndefined()
  })

  it('names the branch a connection takes, in words, and leaves it off a connection that has none', () => {
    const edges = canvasEdges(inputFor(sampleGraph('wholesale-order')))

    expect(edges.map(edge => edge.data.branch)).toEqual([undefined, 'True', undefined, undefined])
    expect(edges[1]?.sourceHandle).toBe('true')
    expect(edges[0]?.sourceHandle).toBe(PLAIN_HANDLE)
    expect(edges[1]?.ariaLabel).toContain('Branch: True.')
  })

  it('leaves a connection out when a step it joins is not there, instead of failing to draw it', () => {
    const graph = sampleGraph('wholesale-order')
    const dangling: WorkflowGraph = { ...graph, edges: [...graph.edges, { from: 'check_stock', to: 'nowhere' }] }

    expect(canvasEdges(inputFor(dangling))).toHaveLength(graph.edges.length)
  })

  it('draws a connection that leaves from a dot its step does not have at the first dot, so the reason can still be shown', () => {
    const graph = sampleGraph('wholesale-order')
    const wrong = connect(graph, 'email_cafe', 'alert_roastery', 'true')
    const edge = canvasEdges(inputFor(wrong)).at(-1)

    expect(edge?.sourceHandle).toBe(PLAIN_HANDLE)
    expect(edge?.data.branch).toBe('True')
    expect(edge?.data.reason).toBe('A connection has a branch its step does not have.')
  })

  it('shows the reason on a connection the validator refuses, in a few words and whole in its label', () => {
    const looped = connect(sampleGraph('wholesale-order'), 'alert_roastery', 'big_order')
    const edge = canvasEdges(inputFor(looped)).at(-1)

    expect(edge?.data.reason).toBe('The workflow loops back on itself.')
    expect(edge?.ariaLabel).toContain('closes a loop')
  })

  it('marks the picked connection, and leaves the edges out of the tab order since the outline does the same with the keyboard', () => {
    const edges = canvasEdges(inputFor(sampleGraph('wholesale-order'), { selection: { kind: 'edge', index: 2 } }))

    expect(edges.filter(edge => edge.selected).map(edge => edge.id)).toEqual([edgeIdOf(2)])
    expect(edges.every(edge => edge.focusable === false && edge.deletable === false)).toBe(true)
  })
})

describe('the dots', () => {
  it('names the branch a dot stands for, and nothing for the plain dot or an unknown one', () => {
    expect(branchOfHandle('true')).toBe('true')
    expect(branchOfHandle('false')).toBe('false')
    expect(branchOfHandle('approved')).toBe('approved')
    expect(branchOfHandle('rejected')).toBe('rejected')
    expect(branchOfHandle(PLAIN_HANDLE)).toBeUndefined()
    expect(branchOfHandle(null)).toBeUndefined()
    expect(branchOfHandle('<script>')).toBeUndefined()
  })

  it('picks the dot a connection leaves from: its branch, or the first one', () => {
    expect(handleFor('condition', 'false')).toBe('false')
    expect(handleFor('condition', undefined)).toBe('true')
    expect(handleFor('approval', 'rejected')).toBe('rejected')
    expect(handleFor('action', 'true')).toBe(PLAIN_HANDLE)
    expect(handleFor('trigger', undefined)).toBe(PLAIN_HANDLE)
  })
})
