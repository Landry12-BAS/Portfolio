// LB-07's schema on a real Postgres: the migration makes its tables in the lb07 schema and nowhere else,
// the closed lists the code uses are the ones the checks enforce, and what belongs to a run goes with it.
import { randomUUID } from 'node:crypto'

import { LB07_STATES } from '@lb/contracts'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import type { Lb07Database } from '../../src/modules/lb07/db/connection.ts'
import { findings, runs } from '../../src/modules/lb07/db/schema.ts'
import { createLb07TestDatabase } from '../support/lb07-database.ts'
import type { Lb07TestDatabase } from '../support/lb07-database.ts'

/** Runs a statement that must be refused, and returns the name of the constraint that refused it (Drizzle wraps Postgres's error as the cause). */
async function refusedBy(statement: Promise<unknown>): Promise<string> {
  try {
    await statement
  }
  catch (error) {
    const cause = (error as { cause?: { constraint?: string, message?: string } }).cause
    return cause?.constraint ?? cause?.message ?? (error as Error).message
  }
  return 'nothing refused it'
}

let testDatabase: Lb07TestDatabase
let database: Lb07Database

beforeAll(async () => {
  testDatabase = await createLb07TestDatabase(inject('databaseUrl'))
  database = await testDatabase.open()
})

afterAll(() => testDatabase.drop())

describe('the lb07 schema', () => {
  it('holds every table of the system inside lb07, and nothing in public', async () => {
    const tables = await database.db.execute<{ table_schema: string, table_name: string }>(sql`select table_schema, table_name from information_schema.tables where table_schema in ('lb07', 'public') order by table_name`)
    expect(tables.rows.filter(row => row.table_schema === 'public')).toEqual([])
    expect(tables.rows.map(row => row.table_name).sort()).toEqual(['__drizzle_migrations', 'evidence', 'findings', 'reports', 'run_steps', 'runs', 'usage_counters'])
  })

  it('accepts every state of the closed list and refuses any other', async () => {
    for (const state of LB07_STATES) {
      const values = { sessionKey: 's', origin: 'custom', goal: 'g', bugs: [], state, failureCode: state === 'failed' ? 'internal' : null, expiresAt: new Date(Date.now() + 60_000) }
      await expect(database.db.insert(runs).values(values)).resolves.toBeDefined()
    }
    await expect(refusedBy(database.db.insert(runs).values({ sessionKey: 's', origin: 'custom', goal: 'g', bugs: [], state: 'thinking', expiresAt: new Date() }))).resolves.toContain('runs_state_check')
    await expect(refusedBy(database.db.insert(runs).values({ sessionKey: 's', origin: 'sample', sampleId: null, goal: 'g', bugs: [], expiresAt: new Date() }))).resolves.toContain('runs_sample_check')
    await expect(refusedBy(database.db.insert(runs).values({ sessionKey: 's', origin: 'custom', goal: 'x'.repeat(301), bugs: [], expiresAt: new Date() }))).resolves.toContain('runs_goal_check')
  })

  it('deletes a run\'s findings with the run', async () => {
    const [run] = await database.db.insert(runs).values({ sessionKey: 's', origin: 'custom', goal: 'g', bugs: [], expiresAt: new Date(Date.now() + 60_000) }).returning({ id: runs.id })
    await database.db.insert(findings).values({ runId: run!.id, id: 'f1', kind: 'console_error', engine: 'chromium', stepIndex: 0, title: 't', detail: 'd', rule: null, path: '/', evidenceIds: [] })
    await expect(database.db.insert(findings).values({ runId: randomUUID(), id: 'f1', kind: 'console_error', engine: 'chromium', stepIndex: 0, title: 't', detail: 'd', rule: null, path: '/', evidenceIds: [] })).rejects.toThrow()
    await database.db.delete(runs).where(sql`${runs.id} = ${run!.id}`)
    const left = await database.db.select().from(findings).where(sql`${findings.runId} = ${run!.id}`)
    expect(left).toEqual([])
  })
})
