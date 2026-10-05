// Tests of the plain modules behind LB-07's board: the stepper drawn from a run's state (and the stages a run
// skips when its plan was not run to its end), the plans its steps came from, which failures give the
// visitor's run back (the same list as the mock's, which a test of the mock checks against the service's),
// the evidence a finished run has, the time in the browser, the polling pace, the check of a goal, the code
// view's cutting of a test into pieces, the board's own notices, the reading of recorded exchanges, the
// strict checks of a screenshot before it is shown, and the curated samples, which must be the golden set's.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LB07_GIVEN_BACK, MOCK_REPLAN_SAMPLE, syntheticScreenshot } from '@lb/api-clients/testing'
import type { Lb07Report, Lb07RunView, Lb07StepView } from '@lb/contracts'
import { LB07_SAMPLES } from '#shared/data/samples/lb07'
import { decodeBase64, hasPngSignature, MAX_SCREENSHOT_BYTES, screenshotBytes, screenshotPath } from '#shared/lb07-evidence'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { ApiProblem } from '~/board-kit/problem'
import { tokenize, tokenizeLine } from '~/boards/lb-07/code'
import { factOf } from '~/boards/lb-07/exchange'
import { goalProblem, normalizeGoal } from '~/boards/lb-07/goal'
import { FIRST_POLL_MS, POLL_MS, pollDelay, QUEUED_POLL_MS, QUICK_POLLS, SLOW_POLL_MS } from '~/boards/lb-07/pace'
import { ownNoticeOf } from '~/boards/lb-07/problems'
import { evidenceRefs, GIVEN_BACK, planCompleted, planGroups, secondsRun, skipsChecks, stepperOf } from '~/boards/lb-07/run'

/** A step of a run, as the service shows it. */
function step(index: number, status: Lb07StepView['status'], plan = 0): Lb07StepView {
  return { index, step: { action: 'goto', path: '/' }, status, plan, durationMs: status === 'running' ? null : 100, outcome: status === 'passed' ? 'ok' : null }
}

/** The parts of a run the stepper reads. */
function runOf(state: Lb07RunView['state'], steps: Lb07StepView[] = [], failure: Lb07RunView['failure'] = null): Pick<Lb07RunView, 'state' | 'failure' | 'steps'> {
  return { state, steps, failure }
}

/** The statuses of the stepper's stages, in order. */
function statuses(run: Pick<Lb07RunView, 'state' | 'failure' | 'steps'>, report?: Pick<Lb07Report, 'verification'>): string[] {
  return stepperOf(run, report).map(stage => `${stage.stage}:${stage.status}`)
}

describe('the stepper', () => {
  it('marks the stages before the run\'s state done, its own current, and the rest to come', () => {
    expect(statuses(runOf('queued'))).toEqual(['queue:current', 'plan:waiting', 'run:waiting', 'cross:waiting', 'report:waiting', 'verify:waiting', 'done:waiting'])
    expect(statuses(runOf('replanning', [step(0, 'passed'), step(1, 'failed')]))).toEqual(['queue:done', 'plan:done', 'run:current', 'cross:waiting', 'report:waiting', 'verify:waiting', 'done:waiting'])
    expect(statuses(runOf('done', [step(0, 'passed')]))).toEqual(['queue:done', 'plan:done', 'run:done', 'cross:done', 'report:done', 'verify:done', 'done:done'])
  })

  it('says the second engine and the clean shop were skipped when a step stopped at the sandbox', () => {
    const steps = [step(0, 'passed'), step(1, 'blocked'), step(2, 'skipped')]
    expect(statuses(runOf('reporting', steps))).toEqual(['queue:done', 'plan:done', 'run:done', 'cross:skipped', 'report:current', 'verify:skipped', 'done:waiting'])
    expect(skipsChecks(runOf('verifying', steps))).toBe(true)
    expect(skipsChecks(runOf('running', steps))).toBe(false)
  })

  it('stops a failed run at the stage its failure belongs to', () => {
    expect(statuses(runOf('failed', [], { code: 'planning_unavailable', message: 'x' }))).toEqual(['queue:done', 'plan:failed', 'run:skipped', 'cross:skipped', 'report:skipped', 'verify:skipped', 'done:skipped'])
    expect(statuses(runOf('failed', [step(0, 'passed')], { code: 'run_timeout', message: 'x' }))[2]).toBe('run:failed')
    expect(statuses(runOf('failed', [], { code: 'goal_refused', message: 'x' }))[0]).toBe('queue:failed')
    expect(statuses(runOf('failed', [step(0, 'passed')], { code: 'internal', message: 'x' }))[2]).toBe('run:failed')
  })

  it('takes the report\'s word over the steps\' on whether the plan ran to its end', () => {
    const blocked = { verdict: 'not_verified', red: null, cross: null, green: null } as const
    expect(planCompleted([step(0, 'passed')], { verification: blocked })).toBe(false)
    expect(planCompleted([step(0, 'passed'), step(1, 'failed')])).toBe(false)
    expect(planCompleted([step(0, 'passed'), step(1, 'failed'), step(2, 'passed', 1)])).toBe(true)
    expect(planCompleted([])).toBe(false)
  })
})

describe('the plans a run\'s steps came from', () => {
  it('groups the steps by plan and says which failed step asked for each re-plan', () => {
    const groups = planGroups([step(0, 'passed'), step(1, 'failed'), step(2, 'passed', 1), step(3, 'failed', 1), step(4, 'passed', 2)])
    expect(groups.map(group => [group.plan, group.after, group.steps.length])).toEqual([[0, null, 2], [1, 2, 2], [2, 4, 1]])
  })
})

describe('what a failure means for the visitor\'s day', () => {
  it('gives the run back for exactly the failures the mock gives back, which are the service\'s', () => {
    expect([...GIVEN_BACK].sort()).toEqual([...LB07_GIVEN_BACK].sort())
  })
})

describe('the evidence of a finished run', () => {
  it('lists the screenshots the findings name, in order, then the next two pieces the run keeps at its end', () => {
    const finding = (id: string, evidenceIds: string[], stepIndex: number) => ({ id, kind: 'expectation_failed' as const, engine: 'chromium' as const, stepIndex, title: 't', detail: 'd', rule: null, path: '/cart', evidenceIds })
    const { named, closing } = evidenceRefs({ findings: [finding('f1', ['e2'], 4), finding('f2', ['e1'], 1), finding('f3', ['e2'], 4), finding('f4', [], 6)] })
    expect(named.map(ref => [ref.id, ref.stepIndex, ref.path])).toEqual([['e1', 1, '/cart'], ['e2', 4, '/cart']])
    expect(closing).toEqual(['e3', 'e4'])
    expect(evidenceRefs({ findings: [] }).closing).toEqual(['e1', 'e2'])
  })
})

describe('the time in the browser', () => {
  it('counts from the start to the end, or to now while the run goes, and nothing before it starts', () => {
    expect(secondsRun({ startedAt: null, endedAt: null }, 0)).toBeUndefined()
    expect(secondsRun({ startedAt: '2026-10-05T10:00:00.000Z', endedAt: '2026-10-05T10:01:12.400Z' }, 0)).toBe(72)
    expect(secondsRun({ startedAt: '2026-10-05T10:00:00.000Z', endedAt: null }, Date.parse('2026-10-05T10:00:09.600Z'))).toBe(10)
  })
})

describe('the polling pace', () => {
  it('asks soon at first, quickly while the run moves, slowly while others are ahead of it and once it has gone on', () => {
    expect(pollDelay({ state: 'queued', queuePosition: 2 }, 0)).toBe(FIRST_POLL_MS)
    expect(pollDelay({ state: 'queued', queuePosition: 2 }, 1)).toBe(QUEUED_POLL_MS)
    expect(pollDelay({ state: 'queued', queuePosition: 0 }, 1)).toBe(POLL_MS)
    expect(pollDelay({ state: 'running', queuePosition: null }, 5)).toBe(POLL_MS)
    expect(pollDelay({ state: 'running', queuePosition: null }, QUICK_POLLS)).toBe(SLOW_POLL_MS)
  })
})

describe('a goal of the visitor\'s own', () => {
  it('is taken when it is 3 to 300 characters of plain text, and refused with the rule it breaks otherwise', () => {
    expect(goalProblem('Buy a bag of Decaf Mexico.')).toBeUndefined()
    expect(goalProblem('  ab  ')).toBe('tooShort')
    expect(goalProblem('x'.repeat(301))).toBe('tooLong')
    expect(goalProblem('Buy a bag\u0007 now')).toBe('control')
    expect(goalProblem('Buy a​bag')).toBe('control')
  })

  it('reads as one line: a line break becomes a space, as a goal has no use for one', () => {
    expect(normalizeGoal(' Buy two bags\nof Ethiopia Guji\r\nwith WELCOME10 ')).toBe('Buy two bags of Ethiopia Guji with WELCOME10')
    expect(goalProblem('Buy two bags\nof Ethiopia Guji')).toBeUndefined()
  })
})

describe('the code view', () => {
  it('cuts a line into comments, strings, keywords and the rest, and loses no character', () => {
    const line = '  await page.getByRole("button", { name: "Add \\"x\\" to cart" }).click() // step 2'
    const tokens = tokenizeLine(line)
    expect(tokens.map(token => token.text).join('')).toBe(line)
    expect(tokens.filter(token => token.kind === 'string').map(token => token.text)).toEqual(['"button"', '"Add \\"x\\" to cart"'])
    expect(tokens.find(token => token.kind === 'keyword')?.text).toBe('await')
    expect(tokens.at(-1)).toEqual({ kind: 'comment', text: '// step 2' })
  })

  it('keeps an unterminated string and a string that holds // as strings, and splits a test into its lines', () => {
    expect(tokenizeLine('const url = "http://shop" + \'open').map(token => token.kind)).toEqual(['keyword', 'plain', 'string', 'plain', 'string'])
    expect(tokenize('a\nb\n').map(line => line.map(token => token.text).join(''))).toEqual(['a', 'b'])
  })
})

describe('the board\'s own notices', () => {
  it('are chosen by the failure\'s code, never by its status alone', () => {
    expect(ownNoticeOf(new ApiProblem(503, 'busy', 'x'))).toBe('busy')
    expect(ownNoticeOf(new ApiProblem(503, 'queue_unavailable', 'x'))).toBe('queue')
    expect(ownNoticeOf(new ApiProblem(503, 'planning_unavailable', 'x'))).toBe('model')
    expect(ownNoticeOf(new ApiProblem(404, 'run_not_found', 'x'))).toBe('gone')
    expect(ownNoticeOf(new ApiProblem(503, 'unavailable', 'x'))).toBeUndefined()
    expect(ownNoticeOf(new ApiProblem(429, 'daily_limit', 'x'))).toBeUndefined()
  })
})

describe('a recorded exchange', () => {
  const recording = JSON.parse(readFileSync(join(import.meta.dirname, '../../e2e/fixtures/recordings/lb-07/coupon-double-discount.json'), 'utf8')) as { exchanges: Parameters<typeof factOf>[0][] }

  it('is read into the same facts the live calls make: the start, the views, the report, the test and the evidence', () => {
    const kinds = recording.exchanges.map(exchange => factOf(exchange)?.kind)
    expect(kinds[0]).toBe('started')
    expect(kinds).toContain('view')
    expect(kinds).toContain('report')
    expect(kinds).toContain('test')
    expect(kinds.filter(kind => kind === 'evidence')).toHaveLength(3)
  })

  it('is passed over when it is not a success, is not the right shape, or is not one of LB-07\'s reads', () => {
    const first = recording.exchanges[0]!
    expect(factOf({ ...first, response: { status: 409, body: first.response.body } })).toBeUndefined()
    expect(factOf({ ...first, response: { status: 201, body: { id: 'x' } } })).toBeUndefined()
    expect(factOf({ request: { method: 'DELETE', path: '/api/lb07/runs/abc' }, response: { status: 204 } })).toBeUndefined()
    expect(factOf({ request: { method: 'GET', path: '/api/lb07/runs/abc/evidence/e1/image' }, response: { status: 200, body: {} } })).toBeUndefined()
  })
})

describe('a screenshot before it is shown', () => {
  it('is a PNG no larger than the service keeps, decoded strictly from base64', () => {
    const png = syntheticScreenshot(3)
    expect(screenshotBytes(png.toString('base64'))).toEqual(new Uint8Array(png))
    expect(hasPngSignature(new Uint8Array(png))).toBe(true)
    expect(screenshotBytes(Buffer.from('GIF89a, not a PNG at all').toString('base64'))).toBeUndefined()
    expect(screenshotBytes(`${png.toString('base64')}*`)).toBeUndefined()
    expect(decodeBase64('aGVsbG8')).toBeUndefined()
    expect(decodeBase64('aGVs bG8=')).toBeUndefined()
    const oversize = Buffer.concat([png, Buffer.alloc(MAX_SCREENSHOT_BYTES)])
    expect(screenshotBytes(oversize.toString('base64'))).toBeUndefined()
  })

  it('of a live run is a picture on the site\'s own origin', () => {
    expect(screenshotPath('0a1b2c3d-1111-4222-8333-444455556666', 'e2')).toBe('/api/lb07/runs/0a1b2c3d-1111-4222-8333-444455556666/evidence/e2/image')
  })
})

describe('the curated samples', () => {
  it('are the golden set\'s cases marked as samples, with their goals, bugs and verdicts, in its order', () => {
    const golden = parse(readFileSync(join(import.meta.dirname, '../../../../evals/lb07/golden.yaml'), 'utf8')) as { cases: { id: string, sample?: boolean, goal: string, bugs: string[], expect: { verdict: string } }[] }
    const samples = golden.cases.filter(entry => entry.sample === true).map(entry => ({ id: entry.id, goal: entry.goal, bugs: entry.bugs, verdict: entry.expect.verdict }))
    expect(LB07_SAMPLES).toEqual(samples)
    expect(LB07_SAMPLES.map(sample => sample.id)).toContain(MOCK_REPLAN_SAMPLE)
  })
})
