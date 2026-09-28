import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    redisUrl: string
  }
}

// Integration tests run against a real Redis, because the budget script and the span
// streams are Redis features a fake would only imitate. CI starts one with
// Testcontainers; where Docker isn't available, LB_TEST_REDIS_URL points at a local
// server instead. Each test uses its own key prefix, so they never share state.
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
