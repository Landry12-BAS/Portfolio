// LB-06's connection to its own schema, and the types the rest of the module uses for it.
import { fileURLToPath } from 'node:url'

import { applyMigrations, openDatabase } from '../../../core/database.ts'
import type { Database, DatabaseErrorHandler } from '../../../core/database.ts'
import { LB06_SCHEMA, tables } from './schema.ts'

/** LB-06's database: a pool whose search_path holds only the lb06 schema, with the system's tables for typed queries. */
export type Lb06Database = Database<typeof tables>
/** The Drizzle client of LB-06's database. */
export type Lb06Db = Lb06Database['db']
/** A transaction of LB-06's database. */
export type Lb06Tx = Parameters<Parameters<Lb06Db['transaction']>[0]>[0]
/** What a query needs to run on: the database itself, or a transaction of it. */
export type Executor = Pick<Lb06Db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>

// The folder drizzle-kit writes LB-06's migrations to (drizzle.lb06.config.ts).
const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url))

/** Opens LB-06's database from a postgres:// URL; the pool connects when first used. */
export function openLb06Database(url: string, onError?: DatabaseErrorHandler): Lb06Database {
  return openDatabase(url, LB06_SCHEMA, tables, onError)
}

/** Creates the lb06 schema when it is missing and applies LB-06's pending migrations, returning how many it applied. */
export function migrateLb06(database: Lb06Database): Promise<number> {
  return applyMigrations(database, MIGRATIONS_FOLDER)
}
