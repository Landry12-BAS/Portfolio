// Tests for the shapes the site and the service share: trigger payloads, run events, API
// requests, and the rule that keeps this package loadable from the browser.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  buildCatalogue,
  catalogueViewSchema,
  CONNECTORS,
  connectorIds,
  createWorkflowRequestSchema,
  decisionRequestSchema,
  errorBodySchema,
  examplePayload,
  runEventSchema,
  runViewSchema,
  startRunRequestSchema,
  TRIGGER_EVENTS,
  triggerEventIds,
  triggerPayloadSchema,
  updateWorkflowRequestSchema,
  workflowGraphSchema,
  workflowViewSchema,
} from '../src/index.ts'
import { wholesaleGraph } from './support/graphs.ts'

const RUN = '3f1c1f5e-7c3a-4e4e-9d49-0c6a3a5a1b01'

describe('trigger payloads', () => {
  it.each(triggerEventIds)('accepts the example payload of %s', (event) => {
    expect(triggerPayloadSchema(event).safeParse(examplePayload(event)).success).toBe(true)
  })

  it('refuses a missing field, an extra field and the wrong kind of value', () => {
    const schema = triggerPayloadSchema('wholesale_order')
    const good = examplePayload('wholesale_order')

    expect(schema.safeParse({ ...good, totalEur: undefined }).success).toBe(false)
    expect(schema.safeParse({ ...good, discount: 10 }).success).toBe(false)
    expect(schema.safeParse({ ...good, totalEur: '640' }).success).toBe(false)
    expect(schema.safeParse({ ...good, totalEur: -1 }).success).toBe(false)
    expect(schema.safeParse({ ...good, totalEur: Number.POSITIVE_INFINITY }).success).toBe(false)
  })

  it('accepts only sandbox addresses, so no real person\'s address enters the engine', () => {
    const schema = triggerPayloadSchema('wholesale_order')
    const good = examplePayload('wholesale_order')

    expect(schema.safeParse({ ...good, contactEmail: 'orders@lumen.test' }).success).toBe(true)
    for (const address of ['me@gmail.com', 'orders@lumen.example', 'orders@lumen.test.evil.com', 'a b@lumen.test', '@lumen.test']) {
      expect(schema.safeParse({ ...good, contactEmail: address }).success, address).toBe(false)
    }
  })

  it('keeps ratings from 1 to 5', () => {
    const schema = triggerPayloadSchema('customer_review')
    const good = examplePayload('customer_review')

    expect(schema.safeParse({ ...good, rating: 0 }).success).toBe(false)
    expect(schema.safeParse({ ...good, rating: 6 }).success).toBe(false)
    expect(schema.safeParse({ ...good, rating: 5 }).success).toBe(true)
  })
})

describe('run events', () => {
  const base = { seq: 1, at: '2026-10-01T09:00:00.000Z', runId: RUN }

  it('accepts one event of every kind', () => {
    const events = [
      { ...base, type: 'run.queued', version: 1, replayOf: null },
      { ...base, type: 'run.started' },
      { ...base, type: 'run.awaiting_approval', nodeId: 'manager_ok' },
      { ...base, type: 'run.succeeded' },
      { ...base, type: 'run.failed', nodeId: 'email_cafe' },
      { ...base, type: 'step.started', nodeId: 'check_stock', attempt: 1 },
      { ...base, type: 'step.succeeded', nodeId: 'check_stock', attempt: 1, output: { inStock: true, etaDays: 2 } },
      { ...base, type: 'step.failed', nodeId: 'email_cafe', attempt: 1, maxAttempts: 3, code: 'connector_unavailable', message: 'The sandbox is unavailable.', retryInMs: 1000 },
      { ...base, type: 'step.dead_lettered', nodeId: 'email_cafe', attempts: 3 },
      { ...base, type: 'step.skipped', nodeId: 'check_stock', reason: 'branch_not_taken' },
      { ...base, type: 'step.awaiting_approval', nodeId: 'manager_ok', approver: 'finance' },
      { ...base, type: 'step.decided', nodeId: 'manager_ok', decision: 'approved' },
      { ...base, type: 'effect.sent', nodeId: 'alert_roastery', connector: 'slack_alert', messageId: 'msg-1' },
      { ...base, type: 'effect.duplicate_suppressed', nodeId: 'alert_roastery', connector: 'slack_alert', messageId: 'msg-1', originalRunId: RUN },
    ]

    for (const event of events) expect(runEventSchema.safeParse(event).success, event.type).toBe(true)
  })

  it('refuses an unknown kind, a missing field and an extra field', () => {
    expect(runEventSchema.safeParse({ ...base, type: 'run.exploded' }).success).toBe(false)
    expect(runEventSchema.safeParse({ ...base, type: 'step.started', nodeId: 'a' }).success).toBe(false)
    expect(runEventSchema.safeParse({ ...base, type: 'run.started', visitorText: 'hello' }).success).toBe(false)
    expect(runEventSchema.safeParse({ ...base, type: 'run.started', at: 'yesterday' }).success).toBe(false)
  })
})

describe('API shapes', () => {
  it('takes a description of at least ten characters, or a sample', () => {
    expect(createWorkflowRequestSchema.safeParse({ from: 'description', description: 'When an order arrives, tell the roastery.' }).success).toBe(true)
    expect(createWorkflowRequestSchema.safeParse({ from: 'description', description: 'too short' }).success).toBe(false)
    expect(createWorkflowRequestSchema.safeParse({ from: 'description', description: 'x'.repeat(1_001) }).success).toBe(false)
    expect(createWorkflowRequestSchema.safeParse({ from: 'sample', sampleId: 'wholesale-order' }).success).toBe(true)
    expect(createWorkflowRequestSchema.safeParse({ from: 'sample', sampleId: '../etc/passwd' }).success).toBe(false)
    expect(createWorkflowRequestSchema.safeParse({ from: 'description', description: 'When an order arrives, tell the roastery.', sampleId: 'x' }).success).toBe(false)
  })

  it('bounds the failures a visitor may inject', () => {
    const input = examplePayload('wholesale_order')

    expect(startRunRequestSchema.safeParse({ input, failures: [{ nodeId: 'email_cafe', times: 3 }] }).success).toBe(true)
    expect(startRunRequestSchema.safeParse({ input, failures: [{ nodeId: 'email_cafe', times: 6 }] }).success).toBe(false)
    expect(startRunRequestSchema.safeParse({ input, failures: [{ nodeId: 'email_cafe', times: 0 }] }).success).toBe(false)
  })

  it('describes a workflow and a run the way the service builds them', () => {
    const now = '2026-10-01T09:00:00.000Z'
    const workflow = { id: RUN, name: 'Wholesale', version: 1, createdAt: now, updatedAt: now, expiresAt: now, description: null, graph: wholesaleGraph, versions: [{ version: 1, origin: 'sample', createdAt: now, modelCalls: 0 }] }
    const run = { id: RUN, workflowId: RUN, workflowName: 'Wholesale', version: 1, rootRunId: RUN, replayOf: null, status: 'queued', createdAt: now, finishedAt: null, input: {}, replayedBy: null, steps: [], events: [] }

    expect(workflowViewSchema.safeParse(workflow).success).toBe(true)
    expect(runViewSchema.safeParse(run).success).toBe(true)
  })

  it('builds a catalogue from the same lists the validator uses', () => {
    const catalogue = buildCatalogue()

    expect(catalogueViewSchema.safeParse(catalogue).success).toBe(true)
    expect(catalogue.triggers.map(trigger => trigger.id)).toEqual([...triggerEventIds])
    expect(catalogue.connectors.map(connector => connector.id)).toEqual([...connectorIds])
    expect(catalogue.triggers[0]?.fields.map(field => field.name)).toEqual(Object.keys(TRIGGER_EVENTS.wholesale_order.fields))
    expect(catalogue.connectors.find(connector => connector.id === 'stock_check')?.outputs.map(field => field.name)).toEqual(Object.keys(CONNECTORS.stock_check.outputs))
  })
})

describe('JSON Schema', () => {
  it('can be written for every schema the API serves, so the OpenAPI file can describe them', () => {
    const schemas = { workflowGraphSchema, runEventSchema, runViewSchema, workflowViewSchema, createWorkflowRequestSchema, updateWorkflowRequestSchema, startRunRequestSchema, decisionRequestSchema, errorBodySchema, catalogueViewSchema }

    for (const [name, schema] of Object.entries(schemas)) {
      expect(() => z.toJSONSchema(schema), name).not.toThrow()
    }
  })

  it('lists every connector as a choice in the graph\'s schema', () => {
    const text = JSON.stringify(z.toJSONSchema(workflowGraphSchema))

    for (const connector of connectorIds) expect(text).toContain(`"${connector}"`)
  })
})

describe('portability', () => {
  it('imports nothing from Node, so the site can load it', () => {
    const folder = fileURLToPath(new URL('../src', import.meta.url))
    const files = readdirSync(folder, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.ts'))

    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const source = readFileSync(`${folder}/${file}`, 'utf8')
      expect(source, file).not.toMatch(/from\s+['"]node:/)
      expect(source, file).not.toMatch(/\brequire\(/)
      expect(source, file).not.toMatch(/\bprocess\./)
    }
  })

  it('names the .ts file in every relative import, so Node can run it without a build', () => {
    const folder = fileURLToPath(new URL('../src', import.meta.url))
    const files = readdirSync(folder, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.ts'))

    for (const file of files) {
      const imports = [...readFileSync(`${folder}/${file}`, 'utf8').matchAll(/from\s+'(\.[^']*)'/g)].map(match => match[1] ?? '')
      for (const path of imports) expect(path.endsWith('.ts'), `${file}: ${path}`).toBe(true)
    }
  })
})
