// Tests of LB-04's board state against the fake site: reading the visitor's day, reviewing a sample live
// (the check, the request, the polling as the review moves through its states, the pages, the report and
// the Scope), a file that is refused and the place that comes back, the day's limit, the visitor's own PDF
// checked in the browser first, a redline, stopping and reopening, deleting, and the replay of a recording.
// The back end is the mock's LB-04, which runs the real extraction and the real review pipeline with the
// reference reviewer for a model; the clock is the test's, and the first open of each sample is done
// before the fake timers start, because a worker thread does not obey them.
import { createPinia, setActivePinia } from 'pinia'
import type { Recording } from '@lb/contracts'
import { readLb04Seed } from '@lb/api-clients/testing'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { POLL_MS } from '~/boards/lb-04/limits'
import { useLb04Store } from '~/boards/lb-04/store'
import { useReplayStore } from '~/stores/replay'
import { useScopeStore } from '~/stores/scope'
import { useSessionStore } from '~/stores/session'

import { Lb04Site, warmUp } from '../support/lb04-site'
import { recordLb04Sample } from '../support/lb04-recording'

const TODAY = new Date('2026-10-02T09:30:00.000Z')
let recording: Recording

beforeAll(async () => {
  await warmUp(['wholesale-supply', 'clean-supply', 'scanned-supply', 'master-supply-31'])
  recording = await recordLb04Sample()
}, 60_000)

/** Starts a fake site and a fresh store reading through it. */
function start() {
  const site = new Lb04Site({ verified: false })
  vi.stubGlobal('fetch', site.fetch)
  vi.stubGlobal('location', new URL('http://site.test/'))
  setActivePinia(createPinia())
  return { site, store: useLb04Store(), session: useSessionStore(), scope: useScopeStore(), replay: useReplayStore() }
}

/** Lets the given number of milliseconds pass with the store's timers running. */
async function wait(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** Lets time pass in small steps until a condition holds, or fails. */
async function until(condition: () => boolean, stepMs = POLL_MS, limit = 40): Promise<void> {
  for (let step = 0; step < limit && !condition(); step += 1) await wait(stepMs)
  expect(condition()).toBe(true)
}

/** Reads the session, then reviews a sample as the visitor, and lets the first answers land. */
async function reviewSample(store: ReturnType<typeof useLb04Store>, session: ReturnType<typeof useSessionStore>, id: string): Promise<void> {
  await session.load()
  await store.loadLimits()
  await store.reviewSample(id)
  await wait(0)
}

describe('LB-04\'s board', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(TODAY)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe('before anything is reviewed', () => {
    it('reads the visitor\'s day and contracts without asking for anything that spends it', async () => {
      const { site, store, session } = start()
      await session.load()
      await store.loadLimits()
      await store.loadMine()

      expect(store.quota).toEqual({ limit: 3, used: 0, remaining: 3, resetsAt: '2026-10-03T00:00:00.000Z' })
      expect(store.mine).toEqual([])
      expect(site.calls.filter(call => call.method !== 'GET')).toEqual([])
    })

    it('reads the playbook once, and not again while it is read or has been', async () => {
      const { site, store, session } = start()
      await session.load()
      await Promise.all([store.loadPlaybook(), store.loadPlaybook()])
      await store.loadPlaybook()

      expect(store.playbook?.topics).toHaveLength(9)
      expect(store.playbookStatus).toBe('ready')
      expect(site.callsTo('/api/lb04/playbook')).toHaveLength(1)
    })
  })

  describe('a live review of a sample', () => {
    it('runs the check once, sends the sample\'s ID, counts one of the day\'s contracts and starts reading the trace', async () => {
      const { site, store, session, scope } = start()
      await reviewSample(store, session, 'wholesale-supply')

      expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
      expect(site.callsTo('/api/lb04/contracts', 'POST')[0]?.body).toEqual({ from: 'sample', sampleId: 'wholesale-supply' })
      expect(store.runMode).toBe('live')
      expect(store.phase).toBe('following')
      expect(store.contract).toMatchObject({ state: 'queued', origin: 'sample', sampleId: 'wholesale-supply' })
      expect(store.quota).toMatchObject({ used: 1, remaining: 2 })
      expect(scope.runId).toBe(store.contract?.runId)
    })

    it('polls the contract as it moves through its states, reads the pages once the file has been read and the report when it is done', async () => {
      const { site, store, session, scope } = start()
      await reviewSample(store, session, 'wholesale-supply')
      const seen = new Set<string>()
      for (let step = 0; step < 40 && store.contract?.state !== 'done'; step += 1) {
        await wait(POLL_MS)
        seen.add(store.contract?.state ?? '')
      }
      await wait(2_000)

      expect([...seen]).toEqual(expect.arrayContaining(['extracting', 'analysing', 'verifying', 'done']))
      expect(store.phase).toBe('over')
      expect(store.pages).toHaveLength(11)
      expect(site.callsTo('/api/lb04/contracts/')).not.toHaveLength(0)
      expect(site.callsTo(`/api/lb04/contracts/${store.contract?.id}/pages`)).toHaveLength(1)
      expect(store.report?.findings.filter(finding => finding.kind === 'risk')).toHaveLength(4)
      expect(store.report?.notLegalAdvice).toBe('Not legal advice')
      expect(scope.phase).toBe('finished')
      expect(scope.timeline.rows.some(row => row.alias === 'lb-long')).toBe(true)
      expect(store.quota?.used).toBe(1)
    })

    it('does not fetch the PDF until the viewer asks for it, and then once', async () => {
      const { site, store, session } = start()
      await reviewSample(store, session, 'wholesale-supply')
      await until(() => store.report !== undefined)

      expect(site.callsTo('/file')).toEqual([])
      const first = store.report?.findings.find(finding => finding.kind === 'risk')
      store.show(first?.id ?? '')
      store.show(first?.id ?? '')
      await wait(0)

      expect(site.callsTo(`/api/lb04/contracts/${store.contract?.id}/file`)).toHaveLength(1)
      expect(store.pdf?.byteLength).toBe(readLb04Seed().samples.find(sample => sample.entry.id === 'wholesale-supply')?.bytes.byteLength)
      expect(store.pdfStatus).toBe('ready')
      expect(store.focus?.findingId).toBe(first?.id)
      expect(store.focus?.tick).toBe(2)
    })

    it('shows a file that is refused as failed with its reason, and reads the day again, which has the place back', async () => {
      const { store, session } = start()
      await reviewSample(store, session, 'scanned-supply')
      await until(() => store.contract?.state === 'failed')
      await wait(0)

      expect(store.failure?.code).toBe('no_text_layer')
      expect(store.phase).toBe('over')
      expect(store.report).toBeUndefined()
      expect(store.quota?.used).toBe(0)
    })

    it('refuses a sample that does not exist without taking anything from the day', async () => {
      const { store, session } = start()
      await session.load()
      await store.loadLimits()
      await store.reviewSample('not-a-sample')

      expect(store.problem?.code).toBe('unknown_sample')
      expect(store.phase).toBe('idle')
      expect(store.runMode).toBe('idle')
      expect(store.quota?.used).toBe(0)
    })

    it('says the day is spent, with when it starts again, and counts nothing left', async () => {
      const { site, store, session } = start()
      await session.load()
      await store.loadLimits()
      for (let count = 0; count < 3; count += 1) site.mock.create('fake-session-0123456789', { from: 'sample', sampleId: 'clean-supply' })
      await store.reviewSample('clean-supply')

      expect(store.problem?.code).toBe('daily_limit')
      expect(store.problem?.kind).toBe('quota')
      expect(store.problem?.resetsAt).toBe('2026-10-03T00:00:00.000Z')
      expect(store.quota?.remaining).toBe(0)
      expect(store.phase).toBe('idle')
    })

    it('says the model is unavailable when the review ends that way, and the place comes back', async () => {
      const { site, store, session } = start()
      await session.load()
      await store.loadLimits()
      site.mock.failNext('analysis_unavailable')
      await store.reviewSample('wholesale-supply')
      await until(() => store.contract?.state === 'failed')
      await wait(0)

      expect(store.failure?.code).toBe('analysis_unavailable')
      expect(store.quota?.used).toBe(0)
    })

    it('says the check was not passed, and nothing is sent, when the service says it is needed and the visitor cannot pass it', async () => {
      const { site, store, session } = start()
      await session.load()
      site.failNext('POST /api/session/verify', { status: 403, body: { error: { code: 'verification_failed', message: 'No.' } } })
      await store.reviewSample('clean-supply')

      expect(site.callsTo('/api/lb04/contracts', 'POST')).toEqual([])
      expect(store.problem?.kind).toBe('verification')
      expect(store.phase).toBe('idle')
    })

    it('runs the check again when a new day made the service ask for it, and sends once more', async () => {
      const { site, store, session } = start()
      await session.load()
      await store.reviewSample('clean-supply')
      store.reset()
      site.failNext('POST /api/lb04/contracts', { status: 403, body: { error: { code: 'verification_required', message: 'Run the check.' } } })
      await store.reviewSample('clean-supply')

      expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(2)
      expect(site.callsTo('/api/lb04/contracts', 'POST')).toHaveLength(3)
      expect(store.problem).toBeUndefined()
      expect(store.contract?.state).toBe('queued')
    })
  })

  describe('a PDF the visitor chose', () => {
    it('is refused in the browser when it is empty, too large or not a PDF, and nothing is sent', async () => {
      const { site, store, session } = start()
      await session.load()
      await store.loadLimits()

      await store.reviewFile(new Blob([new Uint8Array(2 * 1_048_576 + 1)]), 'big.pdf')
      expect(store.problem?.code).toBe('file_too_large')
      await store.reviewFile(new Blob(['Dear sir, a letter']), 'letter.pdf')
      expect(store.problem?.code).toBe('not_a_pdf')
      await store.reviewFile(new Blob([]), 'empty.pdf')
      expect(store.problem?.code).toBe('not_a_pdf')

      expect(site.callsTo('/api/lb04/contracts', 'POST')).toEqual([])
      expect(store.phase).toBe('idle')
      expect(store.quota?.used).toBe(0)
    })

    it('is sent as base64 with its name cut to what the service takes, kept in the browser for the viewer, and counted as a file', async () => {
      const { site, store, session } = start()
      await session.load()
      await store.loadLimits()
      const bytes = readLb04Seed().samples.find(sample => sample.entry.id === 'clean-supply')?.bytes ?? new Uint8Array()
      await store.reviewFile(new Blob([bytes.slice()]), `${'n'.repeat(300)}.pdf`)

      const sent = site.callsTo('/api/lb04/contracts', 'POST')[0]?.body as { from: string, filename: string, contentBase64: string }
      expect(sent.from).toBe('upload')
      expect(sent.filename).toHaveLength(200)
      expect(sent.contentBase64).toBe(Buffer.from(bytes).toString('base64'))
      expect(store.pdf).toEqual(bytes)
      expect(store.pdfStatus).toBe('ready')
      expect(store.contract?.origin).toBe('upload')
      expect(site.callsTo('/file')).toEqual([])
    })
  })

  describe('a redline', () => {
    it('is asked for after the review is done, merged into the report once, and the contract\'s count of them read again', async () => {
      const { site, store, session } = start()
      await reviewSample(store, session, 'wholesale-supply')
      await until(() => store.report !== undefined)
      const first = store.report?.findings.find(finding => finding.kind === 'risk')?.id ?? ''
      await store.makeRedline(first)
      await wait(0)

      expect(site.callsTo(`/api/lb04/contracts/${store.contract?.id}/findings/${first}/redline`, 'POST')).toHaveLength(1)
      expect(store.report?.redlines).toHaveLength(1)
      expect(store.report?.redlines[0]).toMatchObject({ findingId: first, source: 'model' })
      expect(store.contract?.redlinesLeft).toBe(2)
      expect(store.redlining).toBeUndefined()
    })

    it('shows the same redline again for nothing, and says when the three are made', async () => {
      const { store, session } = start()
      await reviewSample(store, session, 'wholesale-supply')
      await until(() => store.report !== undefined)
      const ids = store.report?.findings.map(finding => finding.id) ?? []
      await store.makeRedline(ids[0] ?? '')
      await store.makeRedline(ids[0] ?? '')
      expect(store.report?.redlines).toHaveLength(1)
      expect(store.contract?.redlinesLeft).toBe(2)
      await store.makeRedline(ids[1] ?? '')
      await store.makeRedline(ids[2] ?? '')
      await store.makeRedline(ids[3] ?? '')

      expect(store.redlineProblem?.code).toBe('redline_limit')
      expect(store.report?.redlines).toHaveLength(3)
      expect(store.canRedline).toBe(false)
    })

    it('says the model is unavailable when it is, and the contract keeps its redline', async () => {
      const { site, store, session } = start()
      await reviewSample(store, session, 'wholesale-supply')
      await until(() => store.report !== undefined)
      site.failNext('POST /api/lb04/contracts', { status: 503, body: { error: { code: 'analysis_unavailable', message: 'The model is unavailable right now.' } } })
      await store.makeRedline(store.report?.findings[0]?.id ?? '')

      expect(store.redlineProblem?.code).toBe('analysis_unavailable')
      expect(store.report?.redlines).toEqual([])
    })
  })

  describe('stopping, reopening and deleting', () => {
    it('stops waiting and leaves the board empty, with the contract in the visitor\'s list and the place still taken', async () => {
      const { store, session } = start()
      await reviewSample(store, session, 'wholesale-supply')
      store.stopWaiting()
      await wait(0)

      expect(store.contract).toBeUndefined()
      expect(store.phase).toBe('idle')
      expect(store.stoppedWaiting).toBe(true)
      expect(store.mine).toHaveLength(1)
      expect(store.quota?.used).toBe(1)
    })

    it('opens one of the visitor\'s contracts that is finished, reading its report and pages whole', async () => {
      const { site, store, session } = start()
      await session.load()
      const created = site.mock.create('fake-session-0123456789', { from: 'sample', sampleId: 'clean-supply' })
      const id = (created.body as { id: string }).id
      for (let poll = 0; poll < 4; poll += 1) await site.mock.get('fake-session-0123456789', id)
      await store.openContract(id)
      await wait(0)

      expect(store.runMode).toBe('live')
      expect(store.contract?.state).toBe('done')
      expect(store.phase).toBe('over')
      expect(store.report?.findings).toEqual([])
      expect(store.pages).toHaveLength(11)
    })

    it('opens one that is still being reviewed, and follows it to the end', async () => {
      const { site, store, session } = start()
      await session.load()
      const created = site.mock.create('fake-session-0123456789', { from: 'sample', sampleId: 'clean-supply' })
      await store.openContract((created.body as { id: string }).id)
      await until(() => store.contract?.state === 'done')

      expect(store.report).toBeDefined()
    })

    it('says a contract that is gone is gone', async () => {
      const { store, session } = start()
      await session.load()
      await store.openContract('3b241101-e2bb-4255-8caf-4136c566a962')

      expect(store.problem?.code).toBe('contract_not_found')
      expect(store.phase).toBe('idle')
    })

    it('deletes the contract on the board now, and the place for the day is not given back', async () => {
      const { site, store, session } = start()
      await reviewSample(store, session, 'clean-supply')
      await until(() => store.report !== undefined)
      await store.deleteContract()
      await store.loadLimits()

      expect(site.callsTo(`/api/lb04/contracts/${site.mock.list('fake-session-0123456789').body && ''}`)).toBeDefined()
      expect(site.calls.some(call => call.method === 'DELETE')).toBe(true)
      expect(store.contract).toBeUndefined()
      expect(store.report).toBeUndefined()
      expect(store.quota?.used).toBe(1)
    })
  })

  describe('a replay of a recording', () => {
    it('hands the recorded answers back one after another, makes no request and spends nothing, and ends with the report', async () => {
      const { site, store, session, scope } = start()
      await session.load()
      const before = site.calls.length
      store.replayRecording(recording, { kind: 'sample', sampleId: 'wholesale-supply' })

      expect(store.runMode).toBe('replay')
      await wait(9_000)

      expect(site.calls.length).toBe(before)
      expect(store.contract?.state).toBe('done')
      expect(store.report?.findings.length).toBeGreaterThan(0)
      expect(store.report?.redlines).toHaveLength(1)
      expect(store.pages).toHaveLength(11)
      expect(store.pdf?.byteLength).toBeGreaterThan(1_000)
      expect(store.phase).toBe('over')
      expect(scope.replayed).toBe(true)
      expect(scope.runId).toBe(recording.trace.runId)
    })

    it('shows the review first and the report at its end, not before', async () => {
      const { store, session } = start()
      await session.load()
      store.replayRecording(recording, { kind: 'sample', sampleId: 'wholesale-supply' })
      await wait(1)

      expect(store.report).toBeUndefined()
      await wait(9_000)
      expect(store.report).toBeDefined()
    })

    it('is stopped by starting something else, and the board is empty again after a reset', async () => {
      const { store, session } = start()
      await session.load()
      store.replayRecording(recording, { kind: 'sample', sampleId: 'wholesale-supply' })
      await wait(500)
      store.reset()
      await wait(9_000)

      expect(store.runMode).toBe('idle')
      expect(store.report).toBeUndefined()
      expect(store.contract).toBeUndefined()
    })
  })
})
