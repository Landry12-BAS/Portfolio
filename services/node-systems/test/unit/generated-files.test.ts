// Tests that the files generated from code are up to date: the OpenAPI document the site's
// typed client is built from, and LB-08's and LB-04's migrations. Each is written by a command and
// committed, so a change to a route or to a schema that forgets the command fails here,
// and again in `pnpm check` and CI. None needs a database or a network.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { OPENAPI_FILE, renderOpenApi } from '../../src/documentation.ts'
import { pendingSchemaChanges as pendingLb04SchemaChanges } from '../../src/modules/lb04/db/drift.ts'
import { pendingSchemaChanges as pendingLb07SchemaChanges } from '../../src/modules/lb07/db/drift.ts'
import { pendingSchemaChanges } from '../../src/modules/lb08/db/drift.ts'
import { MODULES } from '../../src/modules/registry.ts'

describe('openapi.json', () => {
  it('is what the routes\' schemas generate; run `just node-openapi` when this fails', async () => {
    expect(readFileSync(OPENAPI_FILE, 'utf8')).toBe(await renderOpenApi(MODULES))
  })

  it('is generated without a database, a queue or a model: documenting touches none of them', async () => {
    const document = JSON.parse(await renderOpenApi(MODULES))

    expect(Object.keys(document.paths)).toContain('/api/lb08/workflows')
    expect(Object.keys(document.paths)).toContain('/api/lb04/contracts')
    expect(Object.keys(document.paths)).toContain('/api/lb07/runs')
    expect(Object.keys(document.paths)).toContain('/api/healthz')
  })

  it('names the visitor token as the way in, and every LB-08 route as needing it', async () => {
    const document = JSON.parse(await renderOpenApi(MODULES))

    expect(document.components.securitySchemes.visitorToken.scheme).toBe('bearer')
    for (const prefix of ['/api/lb08', '/api/lb04', '/api/lb07']) {
      const responses = Object.entries(document.paths).filter(([path]) => path.startsWith(prefix)).flatMap(([, methods]) => Object.values(methods as Record<string, { responses: Record<string, unknown> }>))
      expect(responses.length).toBeGreaterThan(0)
      expect(responses.every(operation => '401' in operation.responses)).toBe(true)
    }
  })
})

describe('LB-08\'s migrations', () => {
  it('hold every change in schema.ts: run drizzle-kit generate when this fails', async () => {
    expect(await pendingSchemaChanges()).toEqual([])
  })
})

describe('LB-07\'s migrations', () => {
  it('hold every change in its schema.ts: run drizzle-kit generate with drizzle.lb07.config.ts when this fails', async () => {
    expect(await pendingLb07SchemaChanges()).toEqual([])
  })
})

describe('LB-04\'s migrations', () => {
  it('hold every change in its schema.ts: run drizzle-kit generate with drizzle.lb04.config.ts when this fails', async () => {
    expect(await pendingLb04SchemaChanges()).toEqual([])
  })
})

describe('the registry', () => {
  it('hosts LB-08 under /api/lb08, LB-04 under /api/lb04 and LB-07 under /api/lb07, each in its own schema, with schema names for the OpenAPI document', () => {
    expect(MODULES.map(module => [module.part, module.apiPrefix, module.schema])).toEqual([['lb-08', '/api/lb08', 'lb08'], ['lb-04', '/api/lb04', 'lb04'], ['lb-07', '/api/lb07', 'lb07']])
    expect(Object.keys(MODULES[0]?.schemaNames ?? {})).toContain('WorkflowView')
    expect(Object.keys(MODULES[1]?.schemaNames ?? {})).toContain('Lb04ContractView')
    expect(Object.keys(MODULES[2]?.schemaNames ?? {})).toContain('Lb07RunView')
  })

  it('gives every module its own part number, prefix and schema, so a system added later can\'t collide', () => {
    for (const key of ['part', 'apiPrefix', 'schema'] as const) expect(new Set(MODULES.map(module => module[key])).size).toBe(MODULES.length)
  })
})
