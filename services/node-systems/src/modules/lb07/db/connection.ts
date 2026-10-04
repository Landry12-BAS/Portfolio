// LB-07's connection to its own schema, and the types the rest of the module uses for it.
import { fileURLToPath } from 'node:url'

import { applyMigrations, openDatabase } from '../../../core/database.ts'
import type { Database, DatabaseErrorHandler } from '../../../core/database.ts'
import { LB07_SCHEMA, tables } from './schema.ts'

/** LB-07's database: a pool whose search_path holds only the lb07 schema, with the system's tables for typed queries. */
export type Lb07Database = Database<typeof tables>
/** The Drizzle client of LB-07's database. */
export type Lb07Db = Lb07Database['db']
/** What a query needs to run on: the database itself, or a transaction of it. */
export type Executor = Pick<Lb07Db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>

// The folder drizzle-kit writes LB-07's migrations to (drizzle.lb07.config.ts).
const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url))

/** Opens LB-07's database from a postgres:// URL; the pool connects when first used. */
export function openLb07Database(url: string, onError?: DatabaseErrorHandler): Lb07Database {
  return openDatabase(url, LB07_SCHEMA, tables, onError)
}

/** Creates the lb07 schema when it is missing and applies LB-07's pending migrations, returning how many it applied. */
export function migrateLb07(database: Lb07Database): Promise<number> {
  return applyMigrations(database, MIGRATIONS_FOLDER)
}
