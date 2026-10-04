// A database of its own for each LB-07 integration test file: a fresh database on the shared server with
// LB-07's migrations applied, dropped afterwards.
import { randomBytes } from 'node:crypto'

import { Client } from 'pg'

import { migrateLb07, openLb07Database } from '../../src/modules/lb07/db/connection.ts'
import type { Lb07Database } from '../../src/modules/lb07/db/connection.ts'
import { withDatabaseName } from './database.ts'

/** A database made for one test file. */
export interface Lb07TestDatabase {
  url: string
  open: () => Promise<Lb07Database>
  drop: () => Promise<void>
}

/** Runs one statement on the server's own database. */
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

/** Makes a database named `lbtest_<random>` on the server. */
export async function createLb07TestDatabase(serverUrl: string): Promise<Lb07TestDatabase> {
  const name = `lbtest_${randomBytes(6).toString('hex')}`
  await onServer(serverUrl, `CREATE DATABASE ${name}`)
  const url = withDatabaseName(serverUrl, name)
  const opened: Lb07Database[] = []
  return {
    url,
    async open() {
      const database = openLb07Database(url)
      opened.push(database)
      await migrateLb07(database)
      return database
    },
    async drop() {
      await Promise.all(opened.map(database => database.close()))
      await onServer(serverUrl, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    },
  }
}
