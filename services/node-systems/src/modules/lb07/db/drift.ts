// Checking that LB-07's committed migrations still match its schema file, as LB-08's and LB-04's drift
// checks do: drizzle-kit's snapshot of the schema beside the latest migration is compared with the
// schema as it is now, and an empty answer means the two agree.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api'
import type { DrizzleSnapshotJSON } from 'drizzle-kit/api'

import * as schema from './schema.ts'

const SNAPSHOTS = fileURLToPath(new URL('./migrations/meta', import.meta.url))

/** Reads the newest snapshot drizzle-kit wrote: the schema as the last migration left it. */
function latestSnapshot(): DrizzleSnapshotJSON {
  const files = readdirSync(SNAPSHOTS).filter(name => name.endsWith('_snapshot.json')).sort()
  const newest = files.at(-1)
  if (!newest) throw new Error('There is no migration snapshot to compare the schema with.')
  return JSON.parse(readFileSync(`${SNAPSHOTS}/${newest}`, 'utf8')) as DrizzleSnapshotJSON
}

/** Returns the SQL a new migration would hold: nothing when the migrations are up to date with `schema.ts`. */
export async function pendingSchemaChanges(): Promise<string[]> {
  return generateMigration(latestSnapshot(), generateDrizzleJson(schema))
}
