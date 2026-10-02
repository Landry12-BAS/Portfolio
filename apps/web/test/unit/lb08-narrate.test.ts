// Tests of a run's events told as sentences: the log's line for each kind of event, in English and in
// Czech, the few events worth saying aloud as they happen, and the small helpers they share (a
// step's name, an error in words, whole seconds). The sentences come from the real messages, so a
// message that loses a parameter, or a Czech one that does not fit, fails here.
import type { RunEvent, WorkflowGraph } from '@lb/contracts'
import { describe, expect, it } from 'vitest'

import type { Words } from '~/boards/lb-08/graph/words'
import { announcementFor, announcementsAfter, errorWords, secondsOf, sentenceFor, stepName, valueWords } from '~/boards/lb-08/run/narrate'
import cs from '../../i18n/locales/cs'
import en from '../../i18n/locales/en'

import { sampleGraph } from '../support/lb08-graphs'

/** Builds the words for a language from its messages, with parameters filled in. */
function wordsIn(messages: unknown): Words {
  const root = (messages as { lb08: Record<string, unknown> }).lb08
  const lookup = (key: string): string | undefined => {
    const found = key.split('.').slice(1).reduce<unknown>((place, part) => (typeof place === 'object' && place !== null ? (place as Record<string, unknown>)[part] : undefined), root)
    return typeof found === 'string' ? found : undefined
  }
  return {
    say: (key, params = {}) => (lookup(key) ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? '')),
    has: key => lookup(key) !== undefined,
  }
}

const english = wordsIn(en)
const czech = wordsIn(cs)
const graph: WorkflowGraph = sampleGraph('low-stock-reorder')
const base = { at: '2026-10-02T09:30:00.000Z', runId: '11111111-1111-4111-8111-111111111111' }

/** Makes an event with the parts every event has. */
function event<T extends Omit<RunEvent, 'seq' | 'at' | 'runId'>>(seq: number, rest: T): RunEvent {
  return { ...base, seq, ...rest } as RunEvent
}

describe('the sentences of the log', () => {
  it('names a step by its label in the graph that ran, and by its id when it has no graph', () => {
    expect(stepName(graph, 'tell_purchasing')).toBe('Tell purchasing')
    expect(stepName(undefined, 'tell_purchasing')).toBe('tell_purchasing')
    expect(stepName(graph, 'not_a_step')).toBe('not_a_step')
  })

  it('tells how a run began and ended', () => {
    const narration = { graph, words: english }

    expect(sentenceFor(event(1, { type: 'run.queued', version: 3, replayOf: null }), narration)).toBe('The run was queued, version 3.')
    expect(sentenceFor(event(1, { type: 'run.queued', version: 3, replayOf: '22222222-2222-4222-8222-222222222222' }), narration)).toBe('The replay was queued, version 3.')
    expect(sentenceFor(event(2, { type: 'run.started' }), narration)).toBe('The run started.')
    expect(sentenceFor(event(3, { type: 'run.succeeded' }), narration)).toBe('The run succeeded.')
    expect(sentenceFor(event(3, { type: 'run.failed', nodeId: 'tell_purchasing' }), narration)).toBe('The run failed at Tell purchasing.')
    expect(sentenceFor(event(3, { type: 'run.awaiting_approval', nodeId: 'tell_purchasing' }), narration)).toBe('The run is waiting for Tell purchasing.')
  })

  it('tells a failed attempt by what comes next: another attempt in so many seconds, the last one, or no point in trying again', () => {
    const narration = { graph, words: english }
    const failed = { type: 'step.failed' as const, nodeId: 'tell_purchasing', maxAttempts: 3, code: 'connector_unavailable', message: 'The connector is unavailable.' }

    expect(sentenceFor(event(4, { ...failed, attempt: 1, retryInMs: 1000 }), narration)).toBe('Tell purchasing: attempt 1 of 3 failed. The connector was unavailable. The next attempt is in 1 s.')
    expect(sentenceFor(event(5, { ...failed, attempt: 2, retryInMs: 2000 }), narration)).toContain('The next attempt is in 2 s.')
    expect(sentenceFor(event(6, { ...failed, attempt: 3, retryInMs: null }), narration)).toBe('Tell purchasing: attempt 3 of 3 failed. The connector was unavailable. No attempts are left.')
    expect(sentenceFor(event(7, { ...failed, attempt: 1, code: 'unknown_product', retryInMs: null }), narration)).toBe('Tell purchasing: failed for good. The product is not in the stock list. Trying again would not help.')
  })

  it('tells a step that went right on the first attempt and one that needed more', () => {
    const narration = { graph, words: english }

    expect(sentenceFor(event(4, { type: 'step.started', nodeId: 'reorder_task', attempt: 1 }), narration)).toBe('Add the reorder task: attempt 1 started.')
    expect(sentenceFor(event(5, { type: 'step.succeeded', nodeId: 'reorder_task', attempt: 1, output: {} }), narration)).toBe('Add the reorder task: done.')
    expect(sentenceFor(event(6, { type: 'step.succeeded', nodeId: 'reorder_task', attempt: 3, output: {} }), narration)).toBe('Add the reorder task: done on attempt 3.')
  })

  it('tells the dead letter, the skips, the question and the answer, and what the sandbox did', () => {
    const narration = { graph, words: english }

    expect(sentenceFor(event(7, { type: 'step.dead_lettered', nodeId: 'tell_purchasing', attempts: 3 }), narration)).toBe('Tell purchasing: put in the dead-letter queue after 3 attempts.')
    expect(sentenceFor(event(8, { type: 'step.skipped', nodeId: 'reorder_task', reason: 'branch_not_taken' }), narration)).toBe('Add the reorder task: skipped, the other branch was taken.')
    expect(sentenceFor(event(9, { type: 'step.skipped', nodeId: 'reorder_task', reason: 'upstream_skipped' }), narration)).toBe('Add the reorder task: skipped, the steps before it did not run.')
    expect(sentenceFor(event(10, { type: 'step.awaiting_approval', nodeId: 'tell_purchasing', approver: 'finance' }), narration)).toBe('Tell purchasing: waiting for Finance.')
    expect(sentenceFor(event(11, { type: 'step.decided', nodeId: 'tell_purchasing', decision: 'rejected' }), narration)).toBe('Tell purchasing: answer recorded: rejected.')
    expect(sentenceFor(event(12, { type: 'effect.sent', nodeId: 'tell_purchasing', connector: 'slack_alert', messageId: 'msg-1' }), narration)).toBe('Tell purchasing: sent, as message msg-1.')
    expect(sentenceFor(event(13, { type: 'effect.duplicate_suppressed', nodeId: 'tell_purchasing', connector: 'slack_alert', messageId: 'msg-1', originalRunId: '22222222-2222-4222-8222-222222222222' }), narration))
      .toBe('Tell purchasing: already sent by an earlier run as msg-1, so it was not sent again.')
  })

  it('says every kind of event in Czech without leaving a parameter unfilled', () => {
    const narration = { graph, words: czech }
    const events: RunEvent[] = [
      event(1, { type: 'run.queued', version: 2, replayOf: null }),
      event(2, { type: 'run.queued', version: 2, replayOf: '22222222-2222-4222-8222-222222222222' }),
      event(3, { type: 'run.started' }),
      event(4, { type: 'run.awaiting_approval', nodeId: 'tell_purchasing' }),
      event(5, { type: 'run.succeeded' }),
      event(6, { type: 'run.failed', nodeId: 'tell_purchasing' }),
      event(7, { type: 'step.started', nodeId: 'tell_purchasing', attempt: 2 }),
      event(8, { type: 'step.succeeded', nodeId: 'tell_purchasing', attempt: 1, output: {} }),
      event(9, { type: 'step.succeeded', nodeId: 'tell_purchasing', attempt: 2, output: {} }),
      event(10, { type: 'step.failed', nodeId: 'tell_purchasing', attempt: 1, maxAttempts: 3, code: 'connector_unavailable', message: 'x', retryInMs: 1000 }),
      event(11, { type: 'step.failed', nodeId: 'tell_purchasing', attempt: 3, maxAttempts: 3, code: 'connector_unavailable', message: 'x', retryInMs: null }),
      event(12, { type: 'step.failed', nodeId: 'tell_purchasing', attempt: 1, maxAttempts: 3, code: 'unknown_product', message: 'x', retryInMs: null }),
      event(13, { type: 'step.dead_lettered', nodeId: 'tell_purchasing', attempts: 3 }),
      event(14, { type: 'step.skipped', nodeId: 'tell_purchasing', reason: 'branch_not_taken' }),
      event(15, { type: 'step.skipped', nodeId: 'tell_purchasing', reason: 'upstream_skipped' }),
      event(16, { type: 'step.awaiting_approval', nodeId: 'tell_purchasing', approver: 'finance' }),
      event(17, { type: 'step.decided', nodeId: 'tell_purchasing', decision: 'approved' }),
      event(18, { type: 'effect.sent', nodeId: 'tell_purchasing', connector: 'slack_alert', messageId: 'msg-1' }),
      event(19, { type: 'effect.duplicate_suppressed', nodeId: 'tell_purchasing', connector: 'slack_alert', messageId: 'msg-1', originalRunId: '22222222-2222-4222-8222-222222222222' }),
    ]

    for (const item of events) {
      const sentence = sentenceFor(item, narration)
      expect(sentence, item.type).not.toMatch(/[{}]/)
      expect(sentence, item.type).not.toContain('lb08.')
      expect(sentence.length, item.type).toBeGreaterThan(8)
    }
    expect(sentenceFor(events[9]!, narration)).toContain('Konektor byl nedostupný.')
  })
})

describe('what is said aloud', () => {
  it('says a retry with its wait, a dead letter and the end of a run, and nothing for the events between', () => {
    const narration = { graph, words: english }

    expect(announcementFor(event(1, { type: 'step.failed', nodeId: 'tell_purchasing', attempt: 1, maxAttempts: 3, code: 'connector_unavailable', message: 'x', retryInMs: 1000 }), narration))
      .toBe('Tell purchasing: attempt 1 failed. Trying again in 1 seconds.')
    expect(announcementFor(event(2, { type: 'step.dead_lettered', nodeId: 'tell_purchasing', attempts: 3 }), narration)).toBe('Tell purchasing used all its attempts and went to the dead-letter queue.')
    expect(announcementFor(event(3, { type: 'run.started' }), narration)).toBe('The run started.')
    expect(announcementFor(event(4, { type: 'run.succeeded' }), narration)).toBe('The run succeeded.')
    expect(announcementFor(event(5, { type: 'run.failed', nodeId: 'tell_purchasing' }), narration)).toBe('The run failed.')
    expect(announcementFor(event(6, { type: 'run.awaiting_approval', nodeId: 'tell_purchasing' }), narration)).toBe('The run is waiting for an approval.')
    expect(announcementFor(event(7, { type: 'step.started', nodeId: 'tell_purchasing', attempt: 1 }), narration)).toBeUndefined()
    expect(announcementFor(event(8, { type: 'effect.sent', nodeId: 'tell_purchasing', connector: 'slack_alert', messageId: 'm' }), narration)).toBeUndefined()
    // A failure with nothing to wait for is told by the dead letter that follows it, so it is not told twice.
    expect(announcementFor(event(9, { type: 'step.failed', nodeId: 'tell_purchasing', attempt: 3, maxAttempts: 3, code: 'connector_unavailable', message: 'x', retryInMs: null }), narration)).toBeUndefined()
  })

  it('tells only what came after the last thing told, in order', () => {
    const narration = { graph, words: english }
    const events = [
      event(1, { type: 'run.started' }),
      event(2, { type: 'step.failed', nodeId: 'tell_purchasing', attempt: 1, maxAttempts: 3, code: 'connector_unavailable', message: 'x', retryInMs: 1000 }),
      event(3, { type: 'step.dead_lettered', nodeId: 'tell_purchasing', attempts: 3 }),
      event(4, { type: 'run.failed', nodeId: 'tell_purchasing' }),
    ]

    expect(announcementsAfter(events, 0, narration)).toHaveLength(4)
    expect(announcementsAfter(events, 2, narration)).toEqual(['Tell purchasing used all its attempts and went to the dead-letter queue.', 'The run failed.'])
    expect(announcementsAfter(events, 4, narration)).toEqual([])
  })
})

describe('the small helpers', () => {
  it('says an error by its code, and an error the board does not know in general words', () => {
    expect(errorWords(english, 'connector_unavailable')).toBe('The connector was unavailable.')
    expect(errorWords(english, 'something_new')).toBe('The step failed.')
    expect(errorWords(czech, 'something_new')).toBe('Krok selhal.')
  })

  it('rounds a wait up to whole seconds, never to nothing while there is still some left', () => {
    expect(secondsOf(0)).toBe(0)
    expect(secondsOf(-5)).toBe(0)
    expect(secondsOf(1)).toBe(1)
    expect(secondsOf(1000)).toBe(1)
    expect(secondsOf(1001)).toBe(2)
    expect(secondsOf(2000)).toBe(2)
  })

  it('writes a value for a reader: yes and no in words, numbers and texts as they are', () => {
    expect(valueWords(english, true)).toBe('yes')
    expect(valueWords(english, false)).toBe('no')
    expect(valueWords(czech, true)).toBe('ano')
    expect(valueWords(english, 640)).toBe('640')
    expect(valueWords(english, 'Café Lumen')).toBe('Café Lumen')
  })
})
