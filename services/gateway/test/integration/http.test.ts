// Integration tests over a real socket: what happens when the caller goes away mid-call.
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { chunk } from '../support/fake-provider.ts'
import { chatBody, startGateway } from '../support/gateway.ts'
import type { TestGateway } from '../support/gateway.ts'

let gw: TestGateway
let base: string

beforeEach(async () => {
  gw = await startGateway()
  await gw.app.listen({ host: '127.0.0.1', port: 0 })
  base = `http://127.0.0.1:${(gw.app.server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await gw.close()
})

/** Polls until the condition holds, failing after `timeoutMs`. */
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('a caller that leaves', () => {
  it('stops the provider stream as soon as the client disconnects', async () => {
    gw.providers.alpha.enqueue({ kind: 'stream', steps: [chunk('Your'), { pauseMs: 150 }, chunk(' order'), { pauseMs: 5_000 }, '[DONE]'] })
    const runId = 'run-leaving-0001'
    const controller = new AbortController()

    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...(await gw.headers({ 'x-lb-run-id': runId })), 'content-type': 'application/json' },
      body: JSON.stringify(chatBody({ stream: true })),
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()

    await waitFor(() => gw.providers.alpha.abandoned === 1)
    // The call span lands once the relay has wound down.
    await waitFor(async () => (await gw.runSpans(runId)).some(span => span.kind === 'gateway.call'))
    const call = (await gw.runSpans(runId)).find(span => span.kind === 'gateway.call')
    expect(call).toMatchObject({ status: 'error', attrs: { error: 'client_closed' } })
  })

  it('abandons a slow non-streamed call too', async () => {
    gw.providers.alpha.enqueue({ kind: 'hang' })
    const controller = new AbortController()

    const pending = fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...(await gw.headers()), 'content-type': 'application/json' },
      body: JSON.stringify(chatBody()),
      signal: controller.signal,
    }).catch((error: unknown) => error)
    await waitFor(() => gw.providers.alpha.requests.length === 1)
    controller.abort()
    await pending

    await waitFor(() => gw.providers.alpha.abandoned === 1)
    expect(gw.providers.beta.requests).toHaveLength(0)
  })
})
