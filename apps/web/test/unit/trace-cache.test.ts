// Tests for the site's short memory of the pages of traces the gateway sent: a page is kept for a moment,
// readers who ask while one is being fetched share that fetch, only a page the gateway answered is kept, and
// the memory is bounded in pages and in bytes.
import { describe, expect, it } from 'vitest'

import { TraceCache } from '../../server/lib/trace-cache.ts'
import type { TraceAnswer } from '../../server/lib/trace-cache.ts'

/** A page the gateway answered, with a body of this text. */
function page(body: string): TraceAnswer {
  return { status: 200, body, headers: {} }
}

/** A cache on a clock the test moves, with small limits, and a fetch that counts how often it is asked. */
function setup(options: { ttlMs?: number, maxEntries?: number, maxBytes?: number } = {}) {
  let now = 1_790_000_000_000
  const cache = new TraceCache(() => now, { ttlMs: 1_000, maxEntries: 3, maxBytes: 100, ...options })
  const fetched: string[] = []
  /** Reads a key, fetching the answer the test gives when the cache has none. */
  const read = (key: string, answer: TraceAnswer | Error = page(`page of ${key}`)) => cache.read(key, async () => {
    fetched.push(key)
    if (answer instanceof Error) throw answer
    return answer
  })
  return {
    cache,
    read,
    fetched,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('a page that was just fetched', () => {
  it('is handed out again until the time is up, without asking the gateway', async () => {
    const { read, fetched, advance } = setup()

    const first = await read('run-a?')
    advance(999)
    const second = await read('run-a?')

    expect(second).toBe(first)
    expect(fetched).toEqual(['run-a?'])
  })

  it('is fetched again once its time is up', async () => {
    const { read, fetched, advance } = setup()
    await read('run-a?')

    advance(1_000)
    await read('run-a?')

    expect(fetched).toEqual(['run-a?', 'run-a?'])
  })

  it('is kept for each page on its own: another cursor or size is another page', async () => {
    const { read, fetched } = setup()

    await read('run-a?')
    await read('run-a?limit=3')
    await read('run-a?after=1-0')
    await read('run-b?')

    expect(fetched).toEqual(['run-a?', 'run-a?limit=3', 'run-a?after=1-0', 'run-b?'])
  })
})

describe('readers who ask at once', () => {
  it('share one fetch, and all get its answer', async () => {
    const { cache, fetched } = setup()
    let finish: (answer: TraceAnswer) => void = () => undefined
    const slow = () => new Promise<TraceAnswer>((resolve) => {
      fetched.push('run-a?')
      finish = resolve
    })

    const readers = [cache.read('run-a?', slow), cache.read('run-a?', slow), cache.read('run-a?', slow)]
    finish(page('the page'))
    const answers = await Promise.all(readers)

    expect(fetched).toEqual(['run-a?'])
    expect(answers.map(answer => answer.body)).toEqual(['the page', 'the page', 'the page'])
  })

  it('all fail together when the fetch fails, and leave nothing behind: the next read asks again', async () => {
    const { cache, read, fetched } = setup()
    let fail: (error: Error) => void = () => undefined
    const slow = () => new Promise<TraceAnswer>((_, reject) => {
      fetched.push('run-a?')
      fail = reject
    })

    const readers = [cache.read('run-a?', slow), cache.read('run-a?', slow)]
    fail(new Error('the gateway did not answer'))
    const outcomes = await Promise.allSettled(readers)
    const later = await read('run-a?')

    expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected'])
    expect(later.body).toBe('page of run-a?')
    expect(fetched).toEqual(['run-a?', 'run-a?'])
  })
})

describe('what is not kept', () => {
  it.each([404, 429, 400, 503])('an answer with the status %i, so a run\'s first span is never hidden behind an old "not found"', async (status) => {
    const { read, fetched } = setup()

    await read('run-a?', { status, body: '{"error":{}}', headers: {} })
    await read('run-a?', { status, body: '{"error":{}}', headers: {} })

    expect(fetched).toEqual(['run-a?', 'run-a?'])
  })

  it('a fetch that throws', async () => {
    const { read, fetched } = setup()

    await expect(read('run-a?', new Error('timed out'))).rejects.toThrow('timed out')
    await expect(read('run-a?', new Error('timed out'))).rejects.toThrow('timed out')

    expect(fetched).toEqual(['run-a?', 'run-a?'])
  })

  it('a 200 with no body', async () => {
    const { read, fetched } = setup()

    await read('run-a?', { status: 200, body: undefined, headers: {} })
    await read('run-a?', { status: 200, body: undefined, headers: {} })

    expect(fetched).toHaveLength(2)
  })
})

describe('the memory', () => {
  it('holds no more pages than it was given room for: the one kept longest ago goes first', async () => {
    const { cache, read, fetched } = setup({ maxEntries: 3 })
    for (const run of ['run-a', 'run-b', 'run-c', 'run-d']) await read(run)

    expect(cache.size).toBe(3)
    await read('run-d')
    await read('run-c')
    expect(fetched).toEqual(['run-a', 'run-b', 'run-c', 'run-d'])
    await read('run-a')
    expect(fetched.at(-1)).toBe('run-a')
  })

  it('holds no more bytes than it was given room for', async () => {
    const { cache, read } = setup({ maxEntries: 10, maxBytes: 100 })

    for (const run of ['a', 'b', 'c', 'd', 'e']) await read(run, page('x'.repeat(40)))

    // Two pages of 40 characters fit in 100; the third pushes the first out.
    expect(cache.size).toBe(2)
  })

  it('does not keep a page that is too big for it alone', async () => {
    const { cache, read, fetched } = setup({ maxBytes: 100 })

    await read('run-a', page('x'.repeat(101)))
    await read('run-a', page('x'.repeat(101)))

    expect(cache.size).toBe(0)
    expect(fetched).toEqual(['run-a', 'run-a'])
  })

  it('clears away pages that are stale when it keeps another', async () => {
    const { cache, read, advance } = setup()
    await read('run-a')
    await read('run-b')
    advance(1_500)

    await read('run-c')

    expect(cache.size).toBe(1)
  })

  it('forgets everything when told to', async () => {
    const { cache, read, fetched } = setup()
    await read('run-a')

    cache.clear()
    await read('run-a')

    expect(cache.size).toBe(1)
    expect(fetched).toEqual(['run-a', 'run-a'])
  })
})
