// Unit tests for the kinds of failure a board tells apart, and for how an error answer is read:
// the platform's shape gives a code and a message, anything else gives only a status.
import { describe, expect, it } from 'vitest'

import { ApiProblem, badAnswerProblem, isApiProblem, kindOfStatus, networkProblem, problemFromAnswer } from '~/board-kit/problem'

describe('kindOfStatus', () => {
  it.each([
    [0, 'network', 'network'],
    [403, 'verification_required', 'verification'],
    [403, 'verification_failed', 'verification'],
    [429, 'daily_limit', 'quota'],
    [503, 'unavailable', 'unavailable'],
    [504, 'upstream_timeout', 'timeout'],
    [502, 'upstream_failed', 'upstream'],
    [404, 'not_found', 'notFound'],
    [409, 'not_waiting', 'conflict'],
    [400, 'invalid_request', 'rejected'],
    [413, 'payload_too_large', 'rejected'],
    [415, 'unsupported_media_type', 'rejected'],
    [422, 'invalid', 'rejected'],
    [500, 'internal_error', 'unknown'],
    [403, 'forbidden_origin', 'unknown'],
  ])('reads %i %s as %s', (status, code, kind) => {
    expect(kindOfStatus(status, code)).toBe(kind)
  })
})

describe('problemFromAnswer', () => {
  it('reads the platform error shape: code, message and when a limit resets', () => {
    const problem = problemFromAnswer(429, { error: { code: 'daily_limit', message: 'A visitor may file 20 tickets a day.', resets_at: '2026-10-03T00:00:00Z' } })
    expect(problem).toMatchObject({ status: 429, code: 'daily_limit', kind: 'quota', message: 'A visitor may file 20 tickets a day.', resetsAt: '2026-10-03T00:00:00Z' })
  })

  it('falls back to the status alone for a body of any other shape', () => {
    for (const body of [undefined, 'Bad Gateway', { detail: 'nope' }, { error: 'plain' }, { error: { code: '', message: 'x' } }]) {
      expect(problemFromAnswer(502, body)).toMatchObject({ status: 502, code: 'error', kind: 'upstream' })
    }
  })

  it('does not carry a field it did not plan for', () => {
    const problem = problemFromAnswer(400, { error: { code: 'invalid_request', message: 'No.', secret: 'x' } })
    expect(Object.keys(problem)).not.toContain('secret')
  })
})

describe('the problems a board makes itself', () => {
  it('has a network problem with no status and a bad-answer problem that counts as the system failing', () => {
    expect(networkProblem()).toMatchObject({ status: 0, kind: 'network' })
    expect(badAnswerProblem()).toMatchObject({ status: 502, kind: 'upstream' })
  })

  it('tells an ApiProblem from any other error', () => {
    expect(isApiProblem(new ApiProblem(500, 'x', 'y'))).toBe(true)
    expect(isApiProblem(new Error('x'))).toBe(false)
    expect(isApiProblem({ status: 500 })).toBe(false)
  })
})
