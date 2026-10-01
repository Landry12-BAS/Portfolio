// One Postgres database, one schema per system (AGENTS.md, Architecture rules).
//
// Each system opens a connection pool of its own, whose search_path holds only that
// system's schema, so a query can't name, or even see, another system's tables. In
// production each pool also logs in as a role granted only its schema (LB08_DATABASE_URL),
// the same way services/django-systems/core/databases.py does it. Each system owns its
// migrations, written by drizzle-kit and applied here: this runner never creates anything
// outside the system's schema, and never needs a right the system's role lacks.
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { Pool } from 'pg'
import type { PoolConfig } from 'pg'

// A system's schema name, which is also its part number without the hyphen: lb08.
const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,30}$/
// The only URL parameters passed on to Postgres.
const ALLOWED_URL_OPTIONS = new Set(['sslmode', 'connect_timeout'])
// The table drizzle-kit's own migrator keeps, so either tool can pick up where the other stopped.
const MIGRATIONS_TABLE = '__drizzle_migrations'

/**
 * Builds a pool's settings from a postgres:// URL, working inside `schema`. Only
 * `sslmode` and `connect_timeout` may appear in the URL, so a stray option can't change
 * how the connection behaves.
 */
export function poolConfigFromUrl(url: string, schema: string): PoolConfig {
  if (!SCHEMA_NAME.test(schema)) throw new RangeError('A schema name is lowercase letters, digits and underscores, starting with a letter.')
  let parts: URL
  try {
    parts = new URL(url)
  }
  catch {
    throw new RangeError('The database URL must start with postgres:// or postgresql://.')
  }
  if (parts.protocol !== 'postgres:' && parts.protocol !== 'postgresql:') throw new RangeError('The database URL must start with postgres:// or postgresql://.')
  const database = decodeURIComponent(parts.pathname.replace(/^\//, ''))
  if (!parts.hostname || !database) throw new RangeError('The database URL needs a host and a database name.')

  const config: PoolConfig = {
    host: parts.hostname.replace(/^\[|\]$/g, ''),
    port: parts.port ? Number(parts.port) : 5432,
    user: decodeURIComponent(parts.username),
    password: decodeURIComponent(parts.password),
    database,
    // Only the system's own schema: nothing from `public`, nothing from another system.
    options: `-c search_path=${schema}`,
    application_name: `lb-${schema}`,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  }
  for (const [key, value] of parts.searchParams) {
    if (!ALLOWED_URL_OPTIONS.has(key)) throw new RangeError(`The database URL option ${JSON.stringify(key)} isn't supported.`)
    if (key === 'connect_timeout') config.connectionTimeoutMillis = Number(value) * 1_000
    if (key === 'sslmode') {
      if (value === 'disable') config.ssl = false
      else if (value === 'require' || value === 'verify-full') config.ssl = { rejectUnauthorized: true }
      else throw new RangeError('The database URL\'s sslmode must be disable, require or verify-full.')
    }
  }
  return config
}

/** A system's connection to its own schema: the Drizzle client, the pool behind it and the schema's name. */
export interface Database<Tables extends Record<string, unknown>> {
  readonly db: NodePgDatabase<Tables>
  readonly pool: Pool
  readonly schema: string
  close: () => Promise<void>
}

/** Where a database reports an error on an idle connection, which would otherwise crash the process. */
export type DatabaseErrorHandler = (error: Error) => void

/** Opens a connection pool for one system's schema, with the system's tables for typed queries. The pool connects when first used. */
export function openDatabase<Tables extends Record<string, unknown>>(url: string, schema: string, tables: Tables, onError: DatabaseErrorHandler = () => {}): Database<Tables> {
  const pool = new Pool(poolConfigFromUrl(url, schema))
  pool.on('error', onError)
  return {
    db: drizzle(pool, { schema: tables }),
    pool,
    schema,
    close: () => pool.end(),
  }
}

/**
 * Creates a system's schema when it is missing. It looks first: in production the schema
 * exists and the system's role has no right to create one, so a blind CREATE SCHEMA would
 * fail even though nothing needs creating.
 */
export async function ensureSchema<Tables extends Record<string, unknown>>(database: Database<Tables>): Promise<void> {
  const found = await database.pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [database.schema])
  if (found.rowCount === 0) await database.db.execute(sql`CREATE SCHEMA ${sql.identifier(database.schema)}`)
}

/**
 * Applies the system's pending migrations, in order, each batch in one transaction, and
 * returns how many it applied. The migrations are the SQL files drizzle-kit wrote in
 * `migrationsFolder`. An advisory lock makes two processes starting together take turns.
 */
export async function applyMigrations<Tables extends Record<string, unknown>>(database: Database<Tables>, migrationsFolder: string): Promise<number> {
  const migrations = readMigrationFiles({ migrationsFolder })
  const table = sql`${sql.identifier(database.schema)}.${sql.identifier(MIGRATIONS_TABLE)}`
  await ensureSchema(database)
  const client = await database.pool.connect()
  try {
    const db = drizzle(client)
    await db.execute(sql`SELECT pg_advisory_lock(hashtextextended(${`${database.schema}.migrations`}, 0))`)
    await db.execute(sql`CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`)
    const last = await db.execute<{ created_at: string }>(sql`SELECT created_at FROM ${table} ORDER BY created_at DESC LIMIT 1`)
    const lastMillis = Number(last.rows[0]?.created_at ?? 0)
    const pending = migrations.filter(migration => migration.folderMillis > lastMillis)
    await db.transaction(async (transaction) => {
      for (const migration of pending) {
        // These statements are the files drizzle-kit generated from the schema in this repository.
        for (const statement of migration.sql) await transaction.execute(sql.raw(statement))
        await transaction.execute(sql`INSERT INTO ${table} (hash, created_at) VALUES (${migration.hash}, ${migration.folderMillis})`)
      }
    })
    return pending.length
  }
  finally {
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`${database.schema}.migrations`]).catch(() => undefined)
    client.release()
  }
}
