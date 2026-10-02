// Tests for LB-04's database: the migrations make exactly its own schema and nothing else, a connection
// can only see that schema, the migrations run as a role that owns nothing but that schema, the tables
// refuse the states the engine must never reach, and everything that belongs to a contract goes when
// the contract goes. All of it runs on a real Postgres, because schemas, search paths, roles, check
// constraints and cascades are what a fake would get wrong.
import { randomBytes } from 'node:crypto'

import { LB04_STATES } from '@lb/contracts'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { migrateLb04, openLb04Database } from '../../src/modules/lb04/db/connection.ts'
import type { Lb04Database } from '../../src/modules/lb04/db/connection.ts'
import { withDatabaseName } from '../support/database.ts'
import { createLb04TestDatabase } from '../support/lb04-database.ts'
import type { Lb04TestDatabase } from '../support/lb04-database.ts'

const serverUrl = inject('databaseUrl')

let testDatabase: Lb04TestDatabase
let database: Lb04Database
let admin: Client

/** Runs a query as the test server's own user, who may do anything in the test database. */
async function asAdmin(text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
  return admin.query(text, values)
}

beforeAll(async () => {
  testDatabase = await createLb04TestDatabase(serverUrl)
  database = await testDatabase.open()
  admin = new Client({ connectionString: testDatabase.url })
  await admin.connect()
})

afterAll(async () => {
  await admin.end()
  await testDatabase.drop()
})

describe('the migrations', () => {
  it('create LB-04\'s tables in the lb04 schema, and nothing anywhere else', async () => {
    const { rows } = await asAdmin(`
      SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY c.relname`)

    expect(rows.every(row => row.schema === 'lb04')).toBe(true)
    expect(rows.map(row => row.name)).toEqual([
      '__drizzle_migrations',
      'contract_files',
      'contract_pages',
      'contracts',
      'redlines',
      'reports',
      'usage_counters',
    ])
  })

  it('apply once: running them again changes nothing', async () => {
    expect(await migrateLb04(database)).toBe(0)

    const { rows } = await asAdmin('SELECT count(*)::int AS applied FROM lb04.__drizzle_migrations')
    expect(rows[0]?.applied).toBe(1)
  })

  it('leave LB-08\'s schema alone, and are not seen by it: the two share a database without sharing a table', async () => {
    const { rows } = await asAdmin(`SELECT count(*)::int AS found FROM pg_namespace WHERE nspname = 'lb08'`)

    expect(rows[0]?.found).toBe(0)
  })

  it('make a schema that two processes starting together can migrate without harm', async () => {
    const other = await createLb04TestDatabase(serverUrl)
    const first = openLb04Database(other.url)
    const second = openLb04Database(other.url)

    const applied = await Promise.all([migrateLb04(first), migrateLb04(second)])

    expect(applied.sort()).toEqual([0, 1])
    await Promise.all([first.close(), second.close()])
    await other.drop()
  })
})

describe('the connection', () => {
  it('sees only the lb04 schema: its search path holds nothing else', async () => {
    const { rows } = await database.pool.query('SHOW search_path')

    expect(rows[0]?.search_path).toBe('lb04')
  })

  it('cannot reach a table in another schema by its bare name', async () => {
    await asAdmin('CREATE SCHEMA other_system')
    await asAdmin('CREATE TABLE other_system.secrets (value text)')
    await asAdmin('CREATE TABLE public.public_things (value text)')

    await expect(database.pool.query('SELECT * FROM secrets')).rejects.toMatchObject({ code: '42P01' })
    await expect(database.pool.query('SELECT * FROM public_things')).rejects.toMatchObject({ code: '42P01' })
    // And its own tables answer to bare names.
    await expect(database.pool.query('SELECT count(*) FROM contracts')).resolves.toBeDefined()
  })
})

describe('a production role that owns only its schema', () => {
  const role = `lbtest_role_${randomBytes(4).toString('hex')}`
  let restricted: Lb04TestDatabase

  beforeAll(async () => {
    restricted = await createLb04TestDatabase(serverUrl)
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
    await owner.query(`CREATE SCHEMA lb04 AUTHORIZATION ${role}`)
    await owner.query(`CREATE SCHEMA other_system`)
    await owner.query(`CREATE TABLE other_system.secrets (value text)`)
    await owner.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`)
    await owner.end()

    const asRole = openLb04Database(withDatabaseName(serverUrl.replace(/\/\/[^@]*@/, `//${role}:role-test-only@`), new URL(restricted.url).pathname.slice(1)))

    await expect(migrateLb04(asRole)).resolves.toBe(1)
    await expect(asRole.pool.query('SELECT count(*) FROM contracts')).resolves.toBeDefined()
    await expect(asRole.pool.query('SELECT * FROM other_system.secrets')).rejects.toMatchObject({ code: '42501' })
    await expect(asRole.pool.query('CREATE TABLE public.sneaky (id int)')).rejects.toMatchObject({ code: '42501' })
    await expect(asRole.pool.query('CREATE SCHEMA another')).rejects.toMatchObject({ code: '42501' })
    await asRole.close()
  })
})

describe('the tables\' own rules', () => {
  const contractId = '11111111-1111-4111-8111-111111111111'
  const insertContract = (id: string, columns: string, values: string): Promise<unknown> => asAdmin(`INSERT INTO lb04.contracts (id, session_key, title, expires_at, ${columns}) VALUES ('${id}', 'session-anna-0123456789ab', 'A contract', now() + interval '1 hour', ${values})`)

  beforeAll(async () => {
    await insertContract(contractId, 'origin', `'upload'`)
  })

  it('knows the same states as the contracts package: one list, whichever side changes it', async () => {
    const { rows } = await asAdmin(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'contracts_state_check'`)
    const definition = String(rows[0]?.definition)
    const named = [...definition.matchAll(/'([a-z]+)'::text/g)].map(match => match[1])

    expect([...named].sort()).toEqual([...LB04_STATES].sort())
  })

  it.each([
    ['a contract in a state the engine does not know', 'origin, state', `'upload', 'paused'`],
    ['a contract of an origin that came from nowhere known', 'origin', `'telepathy'`],
    ['a sample with no sample id', 'origin', `'sample'`],
    ['an upload that names a sample', 'origin, sample_id', `'upload', 'wholesale-supply'`],
    ['a failed contract that says no reason', 'origin, state', `'upload', 'failed'`],
    ['a contract with a reason to fail that did not fail', 'origin, failure_code', `'upload', 'internal'`],
    ['a contract with more redlines than the limit', 'origin, redlines_used', `'upload', 4`],
  ])('refuse %s', async (_what, columns, values) => {
    await expect(insertContract('22222222-2222-4222-8222-222222222222', columns, values)).rejects.toMatchObject({ code: expect.stringMatching(/^23/) })
  })

  it('refuse a usage counter of a kind that doesn\'t exist, and a page outside the thirty', async () => {
    await expect(asAdmin(`INSERT INTO lb04.usage_counters (session_key, day, kind, used) VALUES ('s', '2026-10-01', 'dancing', 1)`)).rejects.toMatchObject({ code: '23514' })
    await expect(asAdmin(`INSERT INTO lb04.contract_pages (contract_id, page, text) VALUES ($1, 31, 'x')`, [contractId])).rejects.toMatchObject({ code: '23514' })
    await expect(asAdmin(`INSERT INTO lb04.contract_pages (contract_id, page, text) VALUES ($1, 0, 'x')`, [contractId])).rejects.toMatchObject({ code: '23514' })
  })

  it('refuse a page, a file, a report or a redline of a contract that does not exist', async () => {
    const ghost = '33333333-3333-4333-8333-333333333333'

    await expect(asAdmin(`INSERT INTO lb04.contract_pages (contract_id, page, text) VALUES ($1, 1, 'x')`, [ghost])).rejects.toMatchObject({ code: '23503' })
    await expect(asAdmin(`INSERT INTO lb04.contract_files (contract_id, content, size, sha256) VALUES ($1, '\\x25', 1, 'h')`, [ghost])).rejects.toMatchObject({ code: '23503' })
    await expect(asAdmin(`INSERT INTO lb04.reports (contract_id, report) VALUES ($1, '{}')`, [ghost])).rejects.toMatchObject({ code: '23503' })
    await expect(asAdmin(`INSERT INTO lb04.redlines (contract_id, finding_id, redline) VALUES ($1, 'f1', '{}')`, [ghost])).rejects.toMatchObject({ code: '23503' })
  })

  it('give one redline to a finding, whoever asks for it', async () => {
    const insert = `INSERT INTO lb04.redlines (contract_id, finding_id, redline) VALUES ('${contractId}', 'f1', '{}')`
    await asAdmin(insert)

    await expect(asAdmin(insert)).rejects.toMatchObject({ code: '23505' })
  })

  it('give one page number once to a contract', async () => {
    await asAdmin(`INSERT INTO lb04.contract_pages (contract_id, page, text) VALUES ($1, 1, 'first')`, [contractId])

    await expect(asAdmin(`INSERT INTO lb04.contract_pages (contract_id, page, text) VALUES ($1, 1, 'again')`, [contractId])).rejects.toMatchObject({ code: '23505' })
  })

  it('delete everything a contract owns when the contract goes, and keep the usage counters, which are not its own', async () => {
    await asAdmin(`INSERT INTO lb04.contract_files (contract_id, content, size, sha256) VALUES ($1, '\\x25504446', 4, 'h')`, [contractId])
    await asAdmin(`INSERT INTO lb04.reports (contract_id, report) VALUES ($1, '{}')`, [contractId])
    await asAdmin(`INSERT INTO lb04.usage_counters (session_key, day, kind, used) VALUES ('session-anna-0123456789ab', '2026-10-02', 'contract', 1)`)

    await asAdmin('DELETE FROM lb04.contracts WHERE id = $1', [contractId])

    for (const table of ['contract_files', 'contract_pages', 'reports', 'redlines']) {
      const { rows } = await asAdmin(`SELECT count(*)::int AS left FROM lb04.${table}`)
      expect(rows[0]?.left, table).toBe(0)
    }
    const { rows } = await asAdmin('SELECT count(*)::int AS kept FROM lb04.usage_counters')
    expect(rows[0]?.kept).toBe(1)
  })
})
