// Unit tests for the run context: the rules a run must satisfy before its first call, and
// that the current run follows the code through awaits without leaking between runs.
import { describe, expect, it } from 'vitest'

import { createRun, currentRun, currentSpanId, newRunId, OutsideRunError, runScope, spanScope } from '../../src/run.ts'

const SESSION = 'session-0123456789abcdef'

/** Waits for a number of milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('a run', () => {
  it('is a visitor run by default, and needs the visitor\'s session', () => {
    expect(createRun({ system: 'lb-08', runId: 'run-12345678', session: SESSION })).toEqual({ system: 'lb-08', runId: 'run-12345678', dataClass: 'visitor', session: SESSION })
    expect(() => createRun({ system: 'lb-08', runId: 'run-12345678' })).toThrow('needs the visitor\'s session key')
  })

  it('may be synthetic, with no session', () => {
    expect(createRun({ system: 'lb-08', runId: 'run-12345678', dataClass: 'synthetic' }).session).toBeUndefined()
  })

  it.each([
    [{ system: 'lb-8', runId: 'run-12345678', session: SESSION }, 'part number'],
    [{ system: 'LB-08', runId: 'run-12345678', session: SESSION }, 'part number'],
    [{ system: 'lb-08', runId: 'short', session: SESSION }, 'run ID'],
    [{ system: 'lb-08', runId: 'has spaces in it', session: SESSION }, 'run ID'],
    [{ system: 'lb-08', runId: 'x'.repeat(65), session: SESSION }, 'run ID'],
    [{ system: 'lb-08', runId: 'run-12345678', session: 'too-short' }, 'session key'],
    [{ system: 'lb-08', runId: 'run-12345678', session: `${SESSION}:colon` }, 'session key'],
    [{ system: 'lb-08', runId: 'run-12345678', session: SESSION, dataClass: 'public' as never }, 'data class'],
  ])('is refused when it breaks the gateway\'s rules: %j', (input, reason) => {
    expect(() => createRun(input)).toThrow(reason)
  })

  it('gets a random 22-character ID that is safe in URLs and Redis keys', () => {
    const id = newRunId()

    expect(id).toMatch(/^[\w-]{22}$/)
    expect(newRunId()).not.toBe(id)
    expect(() => createRun({ system: 'lb-08', runId: id, session: SESSION })).not.toThrow()
  })
})

describe('the current run', () => {
  const run = createRun({ system: 'lb-08', runId: 'run-12345678', session: SESSION })

  it('is none outside a run, and is the run inside it, across awaits and timers', async () => {
    expect(currentRun()).toBeUndefined()

    await runScope(run, async () => {
      expect(currentRun()).toBe(run)
      await pause(5)
      expect(currentRun()).toBe(run)
      await Promise.all([pause(1).then(() => currentRun()), Promise.resolve().then(() => currentRun())]).then((seen) => {
        expect(seen).toEqual([run, run])
      })
    })

    expect(currentRun()).toBeUndefined()
  })

  it('keeps two runs that overlap apart', async () => {
    const other = createRun({ system: 'lb-08', runId: 'run-87654321', session: SESSION })
    const seen: string[] = []

    await Promise.all([
      runScope(run, async () => {
        await pause(10)
        seen.push(`a:${currentRun()?.runId}`)
      }),
      runScope(other, async () => {
        await pause(2)
        seen.push(`b:${currentRun()?.runId}`)
      }),
    ])

    expect(seen.sort()).toEqual(['a:run-12345678', 'b:run-87654321'])
  })

  it('returns what the work returns, and throws what it throws', async () => {
    expect(runScope(run, () => 42)).toBe(42)
    await expect(runScope(run, async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
  })
})

describe('the open span', () => {
  const run = createRun({ system: 'lb-08', runId: 'run-12345678', session: SESSION })

  it('starts with none, and nests inside a run', () => {
    runScope(run, () => {
      expect(currentSpanId()).toBeUndefined()
      spanScope('0123456789abcdef', () => {
        expect(currentSpanId()).toBe('0123456789abcdef')
        spanScope('fedcba9876543210', () => {
          expect(currentSpanId()).toBe('fedcba9876543210')
          expect(currentRun()).toBe(run)
        })
        expect(currentSpanId()).toBe('0123456789abcdef')
      })
      expect(currentSpanId()).toBeUndefined()
    })
  })

  it('belongs to a run, and has the gateway\'s 16-hex-digit form', () => {
    expect(() => spanScope('0123456789abcdef', () => 1)).toThrow(OutsideRunError)
    runScope(run, () => {
      expect(() => spanScope('not-hex', () => 1)).toThrow('16 lowercase hex digits')
      expect(() => spanScope('0123456789ABCDEF', () => 1)).toThrow(RangeError)
    })
  })
})
