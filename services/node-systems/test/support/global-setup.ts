// Vitest global setup for the integration tests: provides one real Postgres and one real
// Redis to every test file.
//
// Schemas, check constraints, row locks and queues are exactly what a fake would get wrong.
// LB_TEST_DATABASE_URL and LB_TEST_REDIS_URL point at running servers (CI starts them, and
// so can a developer without Docker); without them, Testcontainers starts both. Each test
// file makes its own database on the Postgres (test/support/database.ts) and its own key
// prefix on the Redis, so files never share state.
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  /** Values the global setup hands to tests through `inject`. */
  export interface ProvidedContext {
    redisUrl: string
    // A server and a database to connect to; test files create their own databases on it.
    databaseUrl: string
  }
}

// The Postgres and Redis versions production runs.
const POSTGRES_IMAGE = 'pgvector/pgvector:pg17'
const REDIS_IMAGE = 'redis:8.10-alpine'

/** What stops a server a setup function started. */
type Teardown = () => Promise<void>

/** Provides Redis: LB_TEST_REDIS_URL when set, otherwise a container. Returns what to stop afterwards. */
async function provideRedis(project: TestProject): Promise<Teardown> {
  const external = process.env.LB_TEST_REDIS_URL
  if (external) {
    project.provide('redisUrl', external)
    return async () => {}
  }
  const { RedisContainer } = await import('@testcontainers/redis')
  const container = await new RedisContainer(REDIS_IMAGE).start()
  project.provide('redisUrl', container.getConnectionUrl())
  return async () => {
    await container.stop()
  }
}

/** Provides Postgres: LB_TEST_DATABASE_URL when set, otherwise a container. Returns what to stop afterwards. */
async function providePostgres(project: TestProject): Promise<Teardown> {
  const external = process.env.LB_TEST_DATABASE_URL
  if (external) {
    project.provide('databaseUrl', external)
    return async () => {}
  }
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql')
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start()
  project.provide('databaseUrl', container.getConnectionUri())
  return async () => {
    await container.stop()
  }
}

/** Starts (or finds) Postgres and Redis before the tests, and returns the teardown that stops what it started. */
export default async function setup(project: TestProject): Promise<Teardown> {
  const stopRedis = await provideRedis(project)
  const stopPostgres = await providePostgres(project)
  return async () => {
    await stopRedis()
    await stopPostgres()
  }
}
