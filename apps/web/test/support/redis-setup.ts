// Vitest global setup for the contract tests: provides one real Redis to every test, because the
// span streams the gateway serves to the Scope are a Redis feature a fake would only imitate. CI
// (and a developer with a local Redis) sets LB_TEST_REDIS_URL; otherwise Testcontainers starts one in
// Docker. Each test uses a key prefix of its own, so they never share state.
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
