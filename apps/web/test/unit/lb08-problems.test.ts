// Tests of which notice LB-08's board gives a failed call: its own when the failure's code says so,
// the kit's when only the status does. The failures are built the way the browser builds them, from
// the status and body of an answer the site's server passed on, so the test follows a real failure
// from the wire to the notice.
import { describe, expect, it } from 'vitest'

import { problemFromAnswer } from '~/board-kit/problem'
import { ownNoticeOf } from '~/boards/lb-08/problems'

/** The failure the browser makes of an answer with this status and error. */
function failure(status: number, error: Record<string, unknown>) {
  return problemFromAnswer(status, { error: { message: 'A sentence for people.', ...error } })
}

// What the service says when the model cannot be reached, word for word (services/node-systems, generate/service.ts).
const GENERATION_MESSAGE = 'Describing a workflow is unavailable right now: the free model quota may be spent, or a provider may be down. Try one of the samples, or come back later.'

describe('the notice LB-08\'s board gives a failed call', () => {
  describe('when the model cannot be reached', () => {
    it('is the board\'s own, though the kit sorts every 503 as a deployment with no back end', () => {
      const problem = failure(503, { code: 'generation_unavailable', message: GENERATION_MESSAGE })

      expect(problem.kind).toBe('unavailable')
      expect(ownNoticeOf(problem)).toBe('generation')
    })

    it('does not depend on what the message says, which is English and never shown', () => {
      expect(ownNoticeOf(failure(503, { code: 'generation_unavailable', message: 'This service has no connection to the model gateway.' }))).toBe('generation')
    })
  })

  describe('when the back end itself is missing or down', () => {
    it.each([
      ['the site has no back end', 503, 'unavailable'],
      ['a service that is closing, or a proxy in front of it, answered something else', 503, 'upstream_error'],
    ])('is the kit\'s: %s', (_reason, status, code) => {
      const problem = failure(status, { code })

      expect(problem.kind).toBe('unavailable')
      expect(ownNoticeOf(problem)).toBeUndefined()
    })

    it('is the kit\'s when the browser could not reach the site at all', () => {
      expect(ownNoticeOf(problemFromAnswer(0, undefined))).toBeUndefined()
    })
  })

  describe('for the other failures that mean more than their status', () => {
    it('is the list of problems found when a description cannot be built as a workflow', () => {
      const problems = [{ code: 'unknown_connector', path: 'nodes.1.connector', message: 'There is no sms connector.' }]

      expect(ownNoticeOf(failure(422, { code: 'workflow_rejected', problems }))).toBe('refused')
    })

    it('is the kit\'s when a rejection lists no problem to show', () => {
      expect(ownNoticeOf(failure(422, { code: 'workflow_rejected' }))).toBeUndefined()
      expect(ownNoticeOf(failure(422, { code: 'invalid_input', fields: 'totalEur' }))).toBeUndefined()
    })

    it('says the visitor keeps as many workflows as are allowed', () => {
      expect(ownNoticeOf(failure(409, { code: 'workflow_limit' }))).toBe('tooMany')
    })

    it.each(['run_not_finished', 'version_conflict', 'not_waiting', 'already_replayed'])('says a request no longer fits the state of a run: %s', (code) => {
      expect(ownNoticeOf(failure(409, { code }))).toBe('conflict')
    })
  })

  describe('for the failures the kit says right', () => {
    it.each([
      [429, 'daily_limit', 'quota'],
      [404, 'not_found', 'notFound'],
      [403, 'verification_required', 'verification'],
      [422, 'invalid_request', 'rejected'],
      [502, 'upstream_error', 'upstream'],
    ])('leaves %i %s to the kit\'s %s notice', (status, code, kind) => {
      const problem = failure(status, { code })

      expect(problem.kind).toBe(kind)
      expect(ownNoticeOf(problem)).toBeUndefined()
    })
  })
})
