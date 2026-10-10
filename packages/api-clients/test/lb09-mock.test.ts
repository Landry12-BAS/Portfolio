// The mock's LB-09 against what the real service does, as running the board on the real Django service and
// worker showed it: a meeting the service could not finish for its own reasons gives the visitor's place for
// the day back and one the visitor sent wrong does not, a failed meeting counts the chat calls it spent, the
// calls are counted stage by stage as the worker reports them, and a CSV cell that a spreadsheet would read
// as a formula is written as text.
import { readFileSync } from 'node:fs'

import { beforeEach, describe, expect, it } from 'vitest'

import { LB09_GIVEN_BACK, Lb09Mock, lb09SafeCell, readLb09Seed } from '../src/testing/index.ts'

const START = Date.parse('2026-10-05T10:00:00.000Z')
const STAGE_MS = 700
const JANA = 'session-jana-000000000000'
let clock = START
let mock: Lb09Mock

/** The body of a meeting's answer, as a record. */
function body(answer: { body?: unknown }): Record<string, unknown> {
  return answer.body as Record<string, unknown>
}

/** Starts a curated meeting for Jana, and returns its ID. */
function startSample(): string {
  return String(body(mock.start(JANA, { source: 'sample', sample: 'weekend-staffing', mode: 'fast', language: 'en' })).id)
}

/** What Jana has left of the day. */
function leftToday(): number {
  return Number(body(mock.limits(JANA)).left_today)
}

beforeEach(() => {
  clock = START
  mock = new Lb09Mock(readLb09Seed(), { now: () => clock, verify: () => JANA, stageMs: STAGE_MS })
})

describe('the day\'s recordings', () => {
  it('a meeting the service could not finish gives its place back once it has failed, as the service does', () => {
    mock.failNext('transcriber')
    const failing = startSample()
    expect(leftToday()).toBe(4)
    clock += 10 * STAGE_MS
    expect(body(mock.get(JANA, failing)).failure).toBe('transcriber')
    expect(leftToday()).toBe(5)
    expect(body(mock.list(JANA) as { body: unknown[] })).toHaveLength(1)
  })

  it('a recording the decoder refuses stays counted', () => {
    mock.failNext('too_long')
    startSample()
    clock += 10 * STAGE_MS
    expect(leftToday()).toBe(4)
  })

  it('names the same failures as given back as the service and the board do', () => {
    const service = readFileSync(new URL('../../../services/django-systems/lb09/meetings.py', import.meta.url), 'utf8')
    const block = /GIVEN_BACK[^=]*= \(([^)]*)\)/.exec(service)?.[1] ?? ''
    const named = [...block.matchAll(/Meeting\.Failure\.([A-Z_]+)/g)].map(match => (match[1] ?? '').toLowerCase())
    expect([...named].sort()).toEqual([...LB09_GIVEN_BACK].sort())
  })
})

describe('the chat calls', () => {
  it('are counted as the worker reports them: one at extracting, two at aligning and when done', () => {
    const id = startSample()
    const calls = () => body(mock.get(JANA, id)).model_calls
    clock += 4 * STAGE_MS
    expect(body(mock.get(JANA, id)).stage).toBe('extracting')
    expect(calls()).toBe(1)
    clock += STAGE_MS
    expect(body(mock.get(JANA, id)).stage).toBe('aligning')
    expect(calls()).toBe(2)
    clock += 5 * STAGE_MS
    expect(calls()).toBe(2)
  })

  it('a meeting whose model failed counts both of the labeller\'s attempts', () => {
    mock.failNext('model')
    const id = startSample()
    clock += 10 * STAGE_MS
    expect(body(mock.get(JANA, id))).toMatchObject({ status: 'failed', failure: 'model', model_calls: 2 })
  })
})

describe('the CSV export', () => {
  it('writes a cell that begins like a formula as text, full-width signs too, and leaves the rest alone', () => {
    expect(lb09SafeCell('=HYPERLINK("http://evil.example/x","Click")')).toBe('\'=HYPERLINK("http://evil.example/x","Click")')
    expect(lb09SafeCell('+1 day')).toBe('\'+1 day')
    expect(lb09SafeCell('-2 boxes')).toBe('\'-2 boxes')
    expect(lb09SafeCell('@SUM(A1)')).toBe('\'@SUM(A1)')
    expect(lb09SafeCell(`${String.fromCharCode(0xFF1D)}1+1`)).toBe(`'${String.fromCharCode(0xFF1D)}1+1`)
    expect(lb09SafeCell('Peter')).toBe('Peter')
    expect(lb09SafeCell('')).toBe('')
  })

  it('is what a finished meeting exports', () => {
    const id = startSample()
    clock += 10 * STAGE_MS
    const csv = String(body(mock.export(JANA, id, 'csv')).content)
    expect(csv.split('\n')[0]).toBe('kind,text,owner,deadline,start_seconds,end_seconds,evidence')
    expect(csv).toContain('"action","Cover the market stall on Saturday morning"')
  })
})
