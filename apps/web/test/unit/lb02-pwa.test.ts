// Tests of the installable board's browser side: the one Trusted Types policy that makes the service
// worker's address (and refuses to make any other), registering the worker with the right scope and
// reporting honestly when the browser or the page's policy will not have it, telling an installed app
// from a tab, and reading the browser's install offer. The browser's globals are stand-ins.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SERVICE_WORKER_POLICY, SERVICE_WORKER_URL } from '#shared/lb02-app'

import type { PolicyFactory, PwaHost } from '~/boards/lb-02/pwa'

/** Loads the module afresh, since it keeps its one policy in a variable. */
async function loadPwa() {
  vi.resetModules()
  return await import('~/boards/lb-02/pwa')
}

/** A Trusted Types factory that records the policies made and the rules they were made with. */
function factory() {
  const made: { name: string, rules: { createScriptURL: (input: string) => string } }[] = []
  const stand: PolicyFactory = {
    createPolicy: (name, rules) => {
      made.push({ name, rules })
      return { createScriptURL: input => rules.createScriptURL(input) }
    },
  }
  return { stand, made }
}

/** A host with a service worker container whose `register` is a spy. */
function host(overrides: Partial<PwaHost> = {}) {
  const register = vi.fn(() => Promise.resolve({}))
  const stand: PwaHost = { isSecureContext: true, navigator: { serviceWorker: { register, controller: null } }, ...overrides }
  return { stand, register }
}

describe('the service worker\'s Trusted Types policy', () => {
  it('leaves the address as text where the browser has no Trusted Types', async () => {
    const { trustedWorkerUrl } = await loadPwa()
    expect(trustedWorkerUrl(undefined)).toBe(SERVICE_WORKER_URL)
  })

  it('makes one policy with the agreed name, never `default`, and uses it for the worker\'s address', async () => {
    const { trustedWorkerUrl } = await loadPwa()
    const { stand, made } = factory()
    expect(trustedWorkerUrl(stand)).toBe(SERVICE_WORKER_URL)
    expect(trustedWorkerUrl(stand)).toBe(SERVICE_WORKER_URL)
    expect(made.map(policy => policy.name)).toEqual([SERVICE_WORKER_POLICY])
    expect(SERVICE_WORKER_POLICY).not.toBe('default')
  })

  it('hands out the worker\'s address and no other', async () => {
    const { trustedWorkerUrl } = await loadPwa()
    const { stand, made } = factory()
    trustedWorkerUrl(stand)
    const rules = made[0]?.rules
    expect(rules?.createScriptURL(SERVICE_WORKER_URL)).toBe(SERVICE_WORKER_URL)
    // eslint-disable-next-line no-script-url -- the test hands the policy a script URL to prove it refuses it
    for (const other of ['/other.js', 'https://evil.test/lb02-sw.js', '/lb02-sw.js?x=1', '//evil.test/lb02-sw.js', 'javascript:alert(1)', '']) {
      expect(() => rules?.createScriptURL(other)).toThrow(TypeError)
    }
  })
})

describe('registering the service worker', () => {
  let pwa: Awaited<ReturnType<typeof loadPwa>>

  beforeEach(async () => {
    pwa = await loadPwa()
  })

  it('registers the worker for the board\'s part of the site and says so', async () => {
    const { stand, register } = host()
    expect(await pwa.registerWorker('/systems/lb-02/', stand)).toBe('registered')
    expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL, { scope: '/systems/lb-02/' })
  })

  it('makes the address through the policy when the browser has them', async () => {
    const { stand: policies, made } = factory()
    const { stand, register } = host({ trustedTypes: policies })
    await pwa.registerWorker('/cs/systems/lb-02/', stand)
    expect(made).toHaveLength(1)
    expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL, { scope: '/cs/systems/lb-02/' })
  })

  it('is unsupported without service workers or outside a secure context, and registers nothing', async () => {
    const { stand: insecure, register } = host({ isSecureContext: false })
    expect(await pwa.registerWorker('/systems/lb-02/', insecure)).toBe('unsupported')
    expect(await pwa.registerWorker('/systems/lb-02/', { isSecureContext: true, navigator: {} })).toBe('unsupported')
    expect(register).not.toHaveBeenCalled()
  })

  it('has failed when the browser or the page\'s policy refuses the registration', async () => {
    const { stand, register } = host()
    register.mockRejectedValueOnce(new TypeError('This document requires \'TrustedScriptURL\' assignment.'))
    expect(await pwa.registerWorker('/systems/lb-02/', stand)).toBe('failed')
  })

  it('names the part of the site the board owns in each language', () => {
    expect(pwa.boardScope('en')).toBe('/systems/lb-02/')
    expect(pwa.boardScope('cs')).toBe('/cs/systems/lb-02/')
  })
})

describe('running as an installed app', () => {
  it('knows by the display mode, or by Safari\'s own flag', async () => {
    const { isStandalone } = await loadPwa()
    expect(isStandalone({ navigator: {}, matchMedia: query => ({ matches: query === '(display-mode: standalone)' }) })).toBe(true)
    expect(isStandalone({ navigator: { standalone: true } })).toBe(true)
    expect(isStandalone({ navigator: {}, matchMedia: () => ({ matches: false }) })).toBe(false)
    expect(isStandalone({ navigator: {} })).toBe(false)
  })
})

describe('the browser\'s install offer', () => {
  it('reads an event that carries the offer', async () => {
    const { readInstallPrompt } = await loadPwa()
    const prompt = vi.fn(() => Promise.resolve())
    const event = Object.assign(new Event('beforeinstallprompt'), { prompt, userChoice: Promise.resolve({ outcome: 'accepted' as const }) })
    const offer = readInstallPrompt(event)
    await offer?.prompt()
    expect(prompt).toHaveBeenCalledTimes(1)
    expect((await offer?.userChoice)?.outcome).toBe('accepted')
  })

  it('does not take any other event for an offer', async () => {
    const { readInstallPrompt } = await loadPwa()
    expect(readInstallPrompt(new Event('beforeinstallprompt'))).toBeUndefined()
    expect(readInstallPrompt(Object.assign(new Event('x'), { prompt: 'yes', userChoice: 1 }))).toBeUndefined()
  })
})
