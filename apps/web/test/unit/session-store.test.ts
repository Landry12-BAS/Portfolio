// Unit tests for the session store: it reads the session's state, runs the Turnstile check once
// and only when it is needed, and never starts a run on a deployment with no back end.
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionStore } from '~/stores/session'

import { FakeSite } from '../support/fake-site'

/** Installs a fake site as the page's `fetch` and starts a fresh store. */
function start(options: ConstructorParameters<typeof FakeSite>[0] = {}) {
  const site = new FakeSite(options)
  vi.stubGlobal('fetch', site.fetch)
  setActivePinia(createPinia())
  return { site, session: useSessionStore() }
}

describe('the session store', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the state of the session from the server', async () => {
    const { session } = start()
    expect(session.verified).toBe(false)
    await session.load()
    expect(session.loading).toBe('ready')
    expect(session.available).toBe(true)
    expect(session.verified).toBe(false)
    expect(session.state?.resetsAt).toBe('2026-10-03T00:00:00.000Z')
  })

  it('joins a second read of the state to the first', async () => {
    const { site, session } = start()
    await Promise.all([session.load(), session.load()])
    expect(site.callsTo('/api/session')).toHaveLength(1)
  })

  it('passes the check with the test build\'s stand-in, without a widget', async () => {
    const { site, session } = start()
    expect(await session.ensureVerified()).toBe(true)
    expect(session.verified).toBe(true)
    expect(session.challenge).toBe('idle')
    expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
  })

  it('runs the check once however many runs ask for it at the same time', async () => {
    const { site, session } = start()
    const answers = await Promise.all([session.ensureVerified(), session.ensureVerified(), session.ensureVerified()])
    expect(answers).toEqual([true, true, true])
    expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
  })

  it('does not run the check again once it has passed', async () => {
    const { site, session } = start({ verified: true })
    expect(await session.ensureVerified()).toBe(true)
    expect(site.callsTo('/api/session/verify')).toHaveLength(0)
  })

  it('says no, and does not ask, when this deployment has no back end', async () => {
    const { site, session } = start({ available: false })
    expect(await session.ensureVerified()).toBe(false)
    expect(session.available).toBe(false)
    expect(site.callsTo('/api/session/verify')).toHaveLength(0)
  })

  it('waits for the widget\'s token when there is no stand-in, and passes with a good one', async () => {
    const { site, session } = start({ testMode: false })
    const passing = session.ensureVerified()
    await vi.waitFor(() => expect(session.challenge).toBe('running'))
    session.provideToken('good-token')
    expect(await passing).toBe(true)
    expect(site.callsTo('/api/session/verify', 'POST')[0]?.body).toEqual({ token: 'good-token' })
  })

  it('fails when the widget gives no token, and can be tried again', async () => {
    const { session } = start({ testMode: false })
    const failing = session.ensureVerified()
    await vi.waitFor(() => expect(session.challenge).toBe('running'))
    session.provideToken(undefined)
    expect(await failing).toBe(false)
    expect(session.challenge).toBe('failed')

    const again = session.ensureVerified()
    await vi.waitFor(() => expect(session.challenge).toBe('running'))
    session.provideToken('good-token')
    expect(await again).toBe(true)
    expect(session.challenge).toBe('idle')
  })

  it('keeps the server\'s refusal of a token the check did not accept', async () => {
    const { session } = start({ testMode: false })
    const refused = session.ensureVerified()
    await vi.waitFor(() => expect(session.challenge).toBe('running'))
    session.provideToken('forged-token')
    expect(await refused).toBe(false)
    expect(session.problem).toMatchObject({ kind: 'verification', status: 403 })
    expect(session.verified).toBe(false)
  })

  it('runs the check again after the server says a new day has begun', async () => {
    const { site, session } = start({ verified: true })
    await session.load()
    site.verified = false
    session.forgetVerification()
    expect(session.verified).toBe(false)
    expect(await session.ensureVerified()).toBe(true)
    expect(site.callsTo('/api/session/verify', 'POST')).toHaveLength(1)
  })

  it('treats a site that cannot be reached as having no back end', async () => {
    const { session } = start()
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network down')))
    expect(await session.ensureVerified()).toBe(false)
    expect(session.loading).toBe('failed')
    expect(session.problem?.kind).toBe('network')
  })

  it('rejects a session state that is not what the server promises', async () => {
    const { session } = start()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ available: true, verified: 'yes' }), { status: 200 }))
    await session.load()
    expect(session.loading).toBe('failed')
    expect(session.state).toBeUndefined()
  })
})
