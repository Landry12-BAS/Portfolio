// Tests of the rule that decides which view of a run the board takes: only a view of the run on the board, never one
// brought by a read older than the newest taken, and never one that turns an ended run back into a running one.
import { describe, expect, it } from 'vitest'
import type { Lb10Run } from '~/boards/lb-10/schemas'
import { isOver, takesView } from '~/boards/lb-10/views'

/** A run as the service writes it, with what a test changes. */
function run(changes: Partial<Lb10Run> = {}): Lb10Run {
  return {
    run_id: 'run-0000000001',
    state: 'running',
    pack: 'lb01-drafter',
    pack_version: '0123456789abcdef',
    providers: ['groq'],
    calls_done: 0,
    calls_total: 20,
    cached_calls: 0,
    started_at: '2026-10-05T09:30:00.123456Z',
    finished_at: null,
    failure: null,
    report: null,
    ...changes,
  }
}

describe('the view the board takes', () => {
  it('knows a run has ended once it is done or failed', () => {
    expect(isOver('running')).toBe(false)
    expect(isOver('done')).toBe(true)
    expect(isOver('failed')).toBe(true)
  })

  it('takes the first view of a run, and the answer that started it', () => {
    expect(takesView(undefined, run(), undefined, 0)).toBe(true)
    expect(takesView(undefined, run(), 1, 0)).toBe(true)
  })

  it('takes a newer read of the same run, and the same read again', () => {
    expect(takesView(run({ calls_done: 4 }), run({ calls_done: 8 }), 3, 2)).toBe(true)
    expect(takesView(run({ calls_done: 4 }), run({ calls_done: 4 }), 2, 2)).toBe(true)
  })

  it('drops a read older than the newest view it took, whatever it says', () => {
    expect(takesView(run({ calls_done: 8 }), run({ calls_done: 4 }), 1, 2)).toBe(false)
    expect(takesView(run({ calls_done: 8 }), run({ state: 'done' }), 1, 2)).toBe(false)
  })

  it('drops a view of another run than the one on the board', () => {
    expect(takesView(run(), run({ run_id: 'run-0000000002' }), 5, 1)).toBe(false)
    expect(takesView(run(), run({ run_id: 'run-0000000002' }), undefined, 1)).toBe(false)
  })

  it('never turns a run that has ended back into one still going', () => {
    const done = run({ state: 'done', calls_done: 20 })
    expect(takesView(done, run({ calls_done: 12 }), 9, 2)).toBe(false)
    expect(takesView(done, run({ state: 'done', calls_done: 20 }), 9, 2)).toBe(true)
    expect(takesView(run({ state: 'failed', failure: 'no_answers' }), run(), undefined, 0)).toBe(false)
  })
})
