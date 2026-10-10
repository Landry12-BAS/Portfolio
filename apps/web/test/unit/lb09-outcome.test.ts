// Tests of what the end of a meeting means on LB-09's board: which failures gave the visitor's place back (the same
// list as the service's and the mock's, read from their code so the three cannot drift apart), and the stage a
// failure is marked at when the board did not see every stage go by.
import { readFileSync } from 'node:fs'

import { LB09_GIVEN_BACK } from '@lb/api-clients/testing'
import { describe, expect, it } from 'vitest'

import { failedStage, givesPlaceBack, GIVEN_BACK_FAILURES, isLb09SampleId } from '~/boards/lb-09/outcome'
import { FAILURES } from '~/boards/lb-09/schemas'

describe('a failed meeting\'s place for the day', () => {
  it('is given back for the service\'s own failures and kept for the visitor\'s', () => {
    expect(FAILURES.filter(failure => givesPlaceBack(failure))).toEqual(['transcriber', 'model', 'audio_gone', 'stale', 'pipeline_error'])
    expect(givesPlaceBack(null)).toBe(false)
  })

  it('follows the same list as the service and the mock back end', () => {
    const service = readFileSync(new URL('../../../../services/django-systems/lb09/meetings.py', import.meta.url), 'utf8')
    const block = /GIVEN_BACK[^=]*= \(([^)]*)\)/.exec(service)?.[1] ?? ''
    const named = [...block.matchAll(/Meeting\.Failure\.([A-Z_]+)/g)].map(match => (match[1] ?? '').toLowerCase())
    expect([...GIVEN_BACK_FAILURES].sort()).toEqual([...named].sort())
    expect([...GIVEN_BACK_FAILURES].sort()).toEqual([...LB09_GIVEN_BACK].sort())
  })
})

describe('the stage a meeting failed in', () => {
  it('is the furthest stage seen, or the earliest its failure belongs to, whichever is later', () => {
    expect(failedStage(['received', 'decoding', 'failed'], 'too_long')).toBe('decoding')
    expect(failedStage(['received', 'failed'], 'no_speech')).toBe('transcribing')
    expect(failedStage(['received', 'transcribing', 'failed'], 'model')).toBe('labelling')
    expect(failedStage(['received', 'decoding', 'transcribing', 'labelling', 'extracting', 'failed'], 'model')).toBe('extracting')
  })

  it('is unknown for a meeting the worker lost before the board saw it work', () => {
    expect(failedStage(['received', 'failed'], 'stale')).toBeUndefined()
    expect(failedStage(['failed'], 'pipeline_error')).toBeUndefined()
    expect(failedStage(['received', 'decoding', 'transcribing', 'failed'], 'stale')).toBe('transcribing')
  })
})

describe('a sample\'s key', () => {
  it('is known only for the curated samples', () => {
    expect(isLb09SampleId('monday-roasting-plan')).toBe(true)
    expect(isLb09SampleId('grinder-repair')).toBe(false)
  })
})
