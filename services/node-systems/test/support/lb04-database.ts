// A database of its own for each LB-04 integration test file, as test/support/database.ts makes one for
// LB-08: a fresh database on the shared server with LB-04's migrations applied, dropped afterwards.
// LB-04's tables live inside the lb04 schema, so two test files can't share one database without
// seeing each other's contracts.
import { randomBytes } from 'node:crypto'

import { Client } from 'pg'

import { migrateLb04, openLb04Database } from '../../src/modules/lb04/db/connection.ts'
import type { Lb04Database } from '../../src/modules/lb04/db/connection.ts'
import { withDatabaseName } from './database.ts'

/** A database made for one test file: where it is, how to open it, and how to remove it. */
export interface Lb04TestDatabase {
  // A postgres:// URL of the new database.
  url: string
  // Opens LB-04's connection to it, with the migrations applied.
  open: () => Promise<Lb04Database>
  // Drops the database. Open connections are closed first.
  drop: () => Promise<void>
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
export async function createLb04TestDatabase(serverUrl: string): Promise<Lb04TestDatabase> {
  const name = `lbtest_${randomBytes(6).toString('hex')}`
  await onServer(serverUrl, `CREATE DATABASE ${name}`)
  const url = withDatabaseName(serverUrl, name)
  const opened: Lb04Database[] = []
  return {
    url,
    async open() {
      const database = openLb04Database(url)
      opened.push(database)
      await migrateLb04(database)
      return database
    },
    async drop() {
      await Promise.all(opened.map(database => database.close()))
      await onServer(serverUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    },
  }
}
