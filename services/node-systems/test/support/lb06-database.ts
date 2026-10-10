// A database of its own for each LB-06 integration test file, as test/support/database.ts makes one for
// LB-08: a fresh database on the shared server with LB-06's migrations applied, dropped afterwards.
import { randomBytes } from 'node:crypto'

import { Client } from 'pg'

import { migrateLb06, openLb06Database } from '../../src/modules/lb06/db/connection.ts'
import type { Lb06Database } from '../../src/modules/lb06/db/connection.ts'
import { withDatabaseName } from './database.ts'

/** A database made for one test file: where it is, how to open it, and how to remove it. */
export interface Lb06TestDatabase {
  url: string
  open: () => Promise<Lb06Database>
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
export async function createLb06TestDatabase(serverUrl: string): Promise<Lb06TestDatabase> {
  const name = `lbtest_${randomBytes(6).toString('hex')}`
  await onServer(serverUrl, `CREATE DATABASE ${name}`)
  const url = withDatabaseName(serverUrl, name)
  const opened: Lb06Database[] = []
  return {
    url,
    async open() {
      const database = openLb06Database(url)
      opened.push(database)
      await migrateLb06(database)
      return database
    },
    async drop() {
      await Promise.all(opened.map(database => database.close()))
      await onServer(serverUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    },
  }
}
