// Waiting for something that happens on its own, such as a worker finishing a job.

/**
 * Calls `read` until it returns something other than undefined or false, and returns that.
 * Fails with `what` after `timeoutMs`, so a test that would hang says what it was waiting for.
 */
export async function waitFor<Found>(what: string, read: () => Promise<Found | undefined | false>, timeoutMs = 15_000, intervalMs = 25): Promise<Found> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await read()
    if (found !== undefined && found !== false) return found
    if (Date.now() > deadline) throw new Error(`Gave up waiting for ${what} after ${timeoutMs} ms.`)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}
