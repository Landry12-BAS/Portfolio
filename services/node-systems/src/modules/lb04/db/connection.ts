// LB-04's connection to its own schema, and the types the rest of the module uses for it.
import { fileURLToPath } from 'node:url'

import { applyMigrations, openDatabase } from '../../../core/database.ts'
import type { Database, DatabaseErrorHandler } from '../../../core/database.ts'
import { LB04_SCHEMA, tables } from './schema.ts'

/** LB-04's database: a pool whose search_path holds only the lb04 schema, with the system's tables for typed queries. */
export type Lb04Database = Database<typeof tables>
/** The Drizzle client of LB-04's database. */
export type Lb04Db = Lb04Database['db']
/** A transaction of LB-04's database. */
export type Lb04Tx = Parameters<Parameters<Lb04Db['transaction']>[0]>[0]
/** What a query needs to run on: the database itself, or a transaction of it. */
export type Executor = Pick<Lb04Db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>

// The folder drizzle-kit writes LB-04's migrations to (drizzle.lb04.config.ts).
const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url))

/** Opens LB-04's database from a postgres:// URL; the pool connects when first used. */
export function openLb04Database(url: string, onError?: DatabaseErrorHandler): Lb04Database {
  return openDatabase(url, LB04_SCHEMA, tables, onError)
}

/** Creates the lb04 schema when it is missing and applies LB-04's pending migrations, returning how many it applied. */
export function migrateLb04(database: Lb04Database): Promise<number> {
  return applyMigrations(database, MIGRATIONS_FOLDER)
}
