// LB-08's connection to its own schema, and the types the rest of the module uses for it.
import { fileURLToPath } from 'node:url'

import { applyMigrations, openDatabase } from '../../../core/database.ts'
import type { Database, DatabaseErrorHandler } from '../../../core/database.ts'
import { LB08_SCHEMA, tables } from './schema.ts'

/** LB-08's database: a pool whose search_path holds only the lb08 schema, with the system's tables for typed queries. */
export type Lb08Database = Database<typeof tables>
/** The Drizzle client of LB-08's database. */
export type Lb08Db = Lb08Database['db']
/** A transaction of LB-08's database. */
export type Lb08Tx = Parameters<Parameters<Lb08Db['transaction']>[0]>[0]
/** What a query needs to run on: the database itself, or a transaction of it. */
export type Executor = Pick<Lb08Db, 'select' | 'insert' | 'update' | 'delete' | 'execute'>

// The folder drizzle-kit writes LB-08's migrations to (drizzle.config.ts).
const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url))

/** Opens LB-08's database from a postgres:// URL; the pool connects when first used. */
export function openLb08Database(url: string, onError?: DatabaseErrorHandler): Lb08Database {
  return openDatabase(url, LB08_SCHEMA, tables, onError)
}

/** Creates the lb08 schema when it is missing and applies LB-08's pending migrations, returning how many it applied. */
export function migrateLb08(database: Lb08Database): Promise<number> {
  return applyMigrations(database, MIGRATIONS_FOLDER)
}
