// Tests for LB-08's database: the migrations make exactly its own schema and nothing
// else, a connection can only see that schema, the migrations run as a role that owns
// nothing but that schema, and the tables refuse the states the engine must never reach.
// All of it runs on a real Postgres, because schemas, search paths, roles and check
// constraints are what a fake would get wrong.
import { randomBytes } from 'node:crypto'

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { migrateLb08, openLb08Database } from '../../src/modules/lb08/db/connection.ts'
import type { Lb08Database } from '../../src/modules/lb08/db/connection.ts'
import { createTestDatabase, withDatabaseName } from '../support/database.ts'
import type { TestDatabase } from '../support/database.ts'

const serverUrl = inject('databaseUrl')

let testDatabase: TestDatabase
let database: Lb08Database
let admin: Client

/** Runs a query as the test server's own user, who may do anything in the test database. */
async function asAdmin(text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
  return admin.query(text, values)
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(serverUrl)
  database = await testDatabase.open()
  admin = new Client({ connectionString: testDatabase.url })
  await admin.connect()
})

afterAll(async () => {
  await admin.end()
  await testDatabase.drop()
})

describe('the migrations', () => {
  it('create LB-08\'s tables in the lb08 schema, and nothing anywhere else', async () => {
    const { rows } = await asAdmin(`
      SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY c.relname`)

    expect(rows.every(row => row.schema === 'lb08')).toBe(true)
    expect(rows.map(row => row.name)).toEqual([
      '__drizzle_migrations',
      'dead_letters',
      'faults',
      'outbox',
      'run_events',
      'run_steps',
      'runs',
      'sandbox_deliveries',
      'stock_levels',
      'usage_counters',
      'workflow_versions',
      'workflows',
    ])
  })

  it('apply once: running them again changes nothing', async () => {
    expect(await migrateLb08(database)).toBe(0)

    const { rows } = await asAdmin('SELECT count(*)::int AS applied FROM lb08.__drizzle_migrations')
    expect(rows[0]?.applied).toBe(1)
  })

  it('make a schema that two processes starting together can migrate without harm', async () => {
    const other = await createTestDatabase(serverUrl)
    const first = openLb08Database(other.url)
    const second = openLb08Database(other.url)

    const applied = await Promise.all([migrateLb08(first), migrateLb08(second)])

    expect(applied.sort()).toEqual([0, 1])
    await Promise.all([first.close(), second.close()])
    await other.drop()
  })
})

describe('the connection', () => {
  it('sees only the lb08 schema: its search path holds nothing else', async () => {
    const { rows } = await database.pool.query('SHOW search_path')

    expect(rows[0]?.search_path).toBe('lb08')
  })

  it('cannot reach a table in another schema by its bare name', async () => {
    await asAdmin('CREATE SCHEMA other_system')
    await asAdmin('CREATE TABLE other_system.secrets (value text)')
    await asAdmin('CREATE TABLE public.public_things (value text)')

    await expect(database.pool.query('SELECT * FROM secrets')).rejects.toMatchObject({ code: '42P01' })
    await expect(database.pool.query('SELECT * FROM public_things')).rejects.toMatchObject({ code: '42P01' })
    // And its own tables answer to bare names.
    await expect(database.pool.query('SELECT count(*) FROM workflows')).resolves.toBeDefined()
  })
})

describe('a production role that owns only its schema', () => {
  const role = `lbtest_role_${randomBytes(4).toString('hex')}`
  let restricted: Awaited<ReturnType<typeof createTestDatabase>>

  beforeAll(async () => {
    restricted = await createTestDatabase(serverUrl)
  })

  afterAll(async () => {
    await restricted.drop()
    const cleanup = new Client({ connectionString: serverUrl })
    await cleanup.connect()
    await cleanup.query(`DROP ROLE IF EXISTS ${role}`)
    await cleanup.end()
  })

  it('migrates inside its own schema, with no right to create schemas or to touch another one', async () => {
    const owner = new Client({ connectionString: restricted.url })
    await owner.connect()
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'role-test-only' NOCREATEDB NOCREATEROLE`)
    // What the platform's setup does: make the schema, hand it to the role, and nothing else.
    await owner.query(`CREATE SCHEMA lb08 AUTHORIZATION ${role}`)
    await owner.query(`CREATE SCHEMA other_system`)
    await owner.query(`CREATE TABLE other_system.secrets (value text)`)
    await owner.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`)
    await owner.end()

    const asRole = openLb08Database(withDatabaseName(serverUrl.replace(/\/\/[^@]*@/, `//${role}:role-test-only@`), new URL(restricted.url).pathname.slice(1)))

    await expect(migrateLb08(asRole)).resolves.toBe(1)
    await expect(asRole.pool.query('SELECT count(*) FROM workflows')).resolves.toBeDefined()
    await expect(asRole.pool.query('SELECT * FROM other_system.secrets')).rejects.toMatchObject({ code: '42501' })
    await expect(asRole.pool.query('CREATE TABLE public.sneaky (id int)')).rejects.toMatchObject({ code: '42501' })
    await expect(asRole.pool.query('CREATE SCHEMA another')).rejects.toMatchObject({ code: '42501' })
    await asRole.close()
  })
})

describe('the tables\' own rules', () => {
  const workflowId = '11111111-1111-4111-8111-111111111111'

  beforeAll(async () => {
    await asAdmin(`INSERT INTO lb08.workflows (id, session_key, name, expires_at) VALUES ($1, 'session-alice-0123456789', 'A workflow', now() + interval '1 day')`, [workflowId])
  })

  it.each([
    ['a run with a status the engine does not know', `INSERT INTO lb08.runs (id, workflow_id, version, session_key, root_run_id, status, input) VALUES (gen_random_uuid(), '${workflowId}', 1, 's', gen_random_uuid(), 'paused', '{}')`],
    ['a step with a status the engine does not know', `INSERT INTO lb08.run_steps (run_id, node_id, status) VALUES (gen_random_uuid(), 'a', 'sleeping')`],
    ['a version that came from nowhere known', `INSERT INTO lb08.workflow_versions (workflow_id, version, origin, graph) VALUES ('${workflowId}', 1, 'telepathy', '{}')`],
    ['an outbox row in a state it can\'t be in', `INSERT INTO lb08.outbox (idempotency_key, workflow_id, root_run_id, first_run_id, node_id, connector, payload, payload_hash, status) VALUES ('k', '${workflowId}', gen_random_uuid(), gen_random_uuid(), 'a', 'email', '{}', 'h', 'lost')`],
    ['a usage counter of a kind that doesn\'t exist', `INSERT INTO lb08.usage_counters (session_key, day, kind, used) VALUES ('s', '2026-10-01', 'dancing', 1)`],
  ])('refuse %s', async (_what, statement) => {
    await expect(asAdmin(statement)).rejects.toMatchObject({ code: expect.stringMatching(/^23/) })
  })

  it('give one delivery per idempotency key, whoever sends it', async () => {
    const insert = `INSERT INTO lb08.sandbox_deliveries (idempotency_key, workflow_id, session_key, root_run_id, node_id, connector, payload) VALUES ('same-key', '${workflowId}', 's', gen_random_uuid(), 'a', 'email', '{}')`
    await asAdmin(insert)

    await expect(asAdmin(insert)).rejects.toMatchObject({ code: '23505' })
  })

  it('delete everything a workflow owns when the workflow goes', async () => {
    const run = '22222222-2222-4222-8222-222222222222'
    await asAdmin(`INSERT INTO lb08.runs (id, workflow_id, version, session_key, root_run_id, input) VALUES ($1, $2, 1, 's', $1, '{}')`, [run, workflowId])
    await asAdmin(`INSERT INTO lb08.run_steps (run_id, node_id) VALUES ($1, 'a')`, [run])
    await asAdmin(`INSERT INTO lb08.run_events (run_id, seq, type, data) VALUES ($1, 1, 'run.started', '{}')`, [run])

    await asAdmin('DELETE FROM lb08.workflows WHERE id = $1', [workflowId])

    for (const table of ['runs', 'run_steps', 'run_events', 'sandbox_deliveries']) {
      const { rows } = await asAdmin(`SELECT count(*)::int AS left FROM lb08.${table}`)
      expect(rows[0]?.left, table).toBe(0)
    }
  })
})
