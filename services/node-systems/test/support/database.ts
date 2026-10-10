// A database of its own for each integration test file.
//
// LB-08's tables are declared inside the lb08 schema, so two test files can't share a
// Postgres database without seeing each other's rows. Each file makes a fresh database on
// the shared server, applies the migrations to it, and drops it afterwards. Postgres
// creates a database from a template in a few milliseconds, so this stays fast.
import { randomBytes } from 'node:crypto'

import { Client } from 'pg'

import { migrateLb08, openLb08Database } from '../../src/modules/lb08/db/connection.ts'
import type { Lb08Database } from '../../src/modules/lb08/db/connection.ts'

/** A database made for one test file: where it is, how to open it, and how to remove it. */
export interface TestDatabase {
  // A postgres:// URL of the new database.
  url: string
  // Opens LB-08's connection to it, with the migrations applied.
  open: () => Promise<Lb08Database>
  // Drops the database. Open connections are closed first.
  drop: () => Promise<void>
}

/** Replaces the database name in a postgres:// URL. */
export function withDatabaseName(url: string, name: string): string {
  const changed = new URL(url)
  changed.pathname = `/${name}`
  return changed.toString()
}

/** Runs one statement on the server's own database, which is where databases are made and dropped. */
async function onServer(serverUrl: string, statement: string): Promise<void> {
  const client = new Client({ connectionString: serverUrl })
  await client.connect()
  try {
    await client.query(statement)
  }
  finally {
    await client.end()
  }
}

/** Makes a database named `lbtest_<random>` on the server at `serverUrl`. */
export async function createTestDatabase(serverUrl: string): Promise<TestDatabase> {
  const name = `lbtest_${randomBytes(6).toString('hex')}`
  await onServer(serverUrl, `CREATE DATABASE ${name}`)
  const url = withDatabaseName(serverUrl, name)
  const opened: Lb08Database[] = []
  return {
    url,
    async open() {
      const database = openLb08Database(url)
      opened.push(database)
      await migrateLb08(database)
      return database
    },
    async drop() {
      await Promise.all(opened.map(database => database.close()))
      await onServer(serverUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    },
  }
}
