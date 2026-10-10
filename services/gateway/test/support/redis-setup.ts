// Vitest global setup for the integration tests: provides one real Redis to every test.
//
// Integration tests run against a real Redis, because the budget script and the span
// streams are Redis features a fake would only imitate. CI starts one with
// Testcontainers; where Docker isn't available, LB_TEST_REDIS_URL points at a local
// server instead. Each test uses its own key prefix, so they never share state.
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  /** Values the global setup hands to tests through `inject`. */
  export interface ProvidedContext {
    redisUrl: string
  }
}

/** Starts (or finds) Redis before the tests, and returns the teardown that stops it. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env.LB_TEST_REDIS_URL
  if (external) {
    project.provide('redisUrl', external)
    return async () => {}
  }
  const { RedisContainer } = await import('@testcontainers/redis')
  const container = await new RedisContainer('redis:8.10-alpine').start()
  project.provide('redisUrl', container.getConnectionUrl())
  return async () => {
    await container.stop()
  }
}
