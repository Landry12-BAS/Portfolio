// Tests for LB-06's database: the migrations make exactly its own schema and nothing else, apply once,
// run as a role that owns nothing but that schema, the tables refuse the states and the counts the
// engine must never reach, the states in the check are the contracts' list, and the log goes when the
// incident goes.
import { randomBytes } from 'node:crypto'

import { LB06_STATES } from '@lb/contracts'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { migrateLb06, openLb06Database } from '../../src/modules/lb06/db/connection.ts'
import type { Lb06Database } from '../../src/modules/lb06/db/connection.ts'
import { STATES_IN_SCHEMA } from '../../src/modules/lb06/db/schema.ts'
import { withDatabaseName } from '../support/database.ts'
import { createLb06TestDatabase } from '../support/lb06-database.ts'
import type { Lb06TestDatabase } from '../support/lb06-database.ts'

const serverUrl = inject('databaseUrl')
let testDatabase: Lb06TestDatabase
let database: Lb06Database
let admin: Client

beforeAll(async () => {
  testDatabase = await createLb06TestDatabase(serverUrl)
  database = await testDatabase.open()
  admin = new Client({ connectionString: testDatabase.url })
  await admin.connect()
})
afterAll(async () => {
  await admin.end()
  await testDatabase.drop()
})

describe('the migrations', () => {
  it('create LB-06\'s tables in the lb06 schema, and nothing anywhere else', async () => {
    const { rows } = await admin.query(`
      SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      ORDER BY c.relname`)
    expect(rows.every(row => row.schema === 'lb06')).toBe(true)
    expect(rows.map(row => row.name)).toEqual(['__drizzle_migrations', 'incident_events', 'incidents', 'scenario_cache', 'usage_counters'])
  })

  it('apply once, and leave the other systems\' schemas alone', async () => {
    expect(await migrateLb06(database)).toBe(0)
    const { rows } = await admin.query(`SELECT count(*)::int AS found FROM pg_namespace WHERE nspname IN ('lb08', 'lb04')`)
    expect(rows[0]?.found).toBe(0)
  })

  it('run as a role that owns only the lb06 schema and can reach nothing else', async () => {
    const role = `lb06_${randomBytes(4).toString('hex')}`
    const password = randomBytes(8).toString('hex')
    const other = await createLb06TestDatabase(serverUrl)
    const owner = new Client({ connectionString: other.url })
    await owner.connect()
    await owner.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`)
    await owner.query(`CREATE SCHEMA lb06 AUTHORIZATION ${role}`)
    await owner.query(`CREATE SCHEMA lb08`)
    await owner.query(`CREATE TABLE lb08.workflows (id int)`)
    await owner.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`)
    const asRole = new URL(other.url)
    asRole.username = role
    asRole.password = password
    const theirs = openLb06Database(asRole.toString())
    expect(await migrateLb06(theirs)).toBe(1)
    await expect(theirs.pool.query('SELECT * FROM lb08.workflows')).rejects.toThrow(/permission denied/)
    await expect(theirs.pool.query('CREATE TABLE public.x (id int)')).rejects.toThrow(/permission denied/)
    await theirs.close()
    await owner.end()
    await other.drop()
  })
})

describe('the tables', () => {
  it('name the states the contracts list, and refuse any other', async () => {
    expect([...STATES_IN_SCHEMA].sort()).toEqual([...LB06_STATES].sort())
    await expect(admin.query(`INSERT INTO lb06.incidents (session_key, origin, seed, fault, state, next_tick_at, deadline_at, expires_at) VALUES ('s', 'sample', 1, 'bad_deploy', 'exploded', now(), now(), now())`)).rejects.toThrow(/incidents_state_check|incidents_sample_check/)
    await expect(admin.query(`INSERT INTO lb06.incidents (session_key, origin, sample_id, seed, fault, model_calls, next_tick_at, deadline_at, expires_at) VALUES ('s', 'sample', 'x', 1, 'bad_deploy', 16, now(), now(), now())`)).rejects.toThrow(/incidents_calls_check/)
    await expect(admin.query(`INSERT INTO lb06.incidents (session_key, origin, sample_id, seed, fault, state, next_tick_at, deadline_at, expires_at) VALUES ('s', 'sample', 'x', 1, 'bad_deploy', 'aborted', now(), now(), now())`)).rejects.toThrow(/incidents_end_check/)
  })

  it('drop the log with the incident', async () => {
    const { rows } = await admin.query(`INSERT INTO lb06.incidents (session_key, origin, sample_id, seed, fault, next_tick_at, deadline_at, expires_at) VALUES ('s', 'sample', 'x', 1, 'bad_deploy', now(), now(), now()) RETURNING id`)
    const id = rows[0]?.id as string
    await admin.query(`INSERT INTO lb06.incident_events (incident_id, seq, kind, minute, at, data) VALUES ($1, 1, 'incident.started', 0, now(), '{}')`, [id])
    await admin.query('DELETE FROM lb06.incidents WHERE id = $1', [id])
    const { rows: left } = await admin.query('SELECT count(*)::int AS n FROM lb06.incident_events WHERE incident_id = $1', [id])
    expect(left[0]?.n).toBe(0)
  })
})

/** The name of the database the test server made, for the role test. */
export const databaseName = (url: string): string => withDatabaseName(url, 'x')
