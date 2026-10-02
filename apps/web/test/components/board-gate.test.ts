// Tests for the Turnstile check on a board: the loader that adds Cloudflare's script under
// Trusted Types, and the gate component that runs the widget only when a visitor starts a live
// run. Cloudflare itself is never contacted: the widget is a stand-in that reports what a test says.
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TURNSTILE_POLICY_NAME, TURNSTILE_SCRIPT_URL } from '~/board-kit/turnstile'
import BoardTurnstileGate from '~/components/board/TurnstileGate.vue'
import { useSessionStore } from '~/stores/session'

import { FakeSite } from '../support/fake-site'
import { mountWithSite } from '../support/mount'

/** The options the page passed to the widget, as the stand-in saw them. */
interface Rendered {
  'sitekey': string
  'appearance': string
  'callback': (token: string) => void
  'error-callback': () => void
  'timeout-callback': () => void
}

/** Puts a stand-in widget on the page and returns what it was asked to render. */
function installWidget(): { renders: Rendered[], remove: ReturnType<typeof vi.fn> } {
  const renders: Rendered[] = []
  const remove = vi.fn()
  const render = (_: HTMLElement, options: Rendered): string => {
    renders.push(options)
    return `widget-${renders.length}`
  }
  Object.assign(window, { turnstile: { render, remove } })
  return { renders, remove }
}

/** A script element that records what the loader gave it and never loads anything. */
class FakeScript extends EventTarget {
  src = ''
  async = false
}

/** A page whose scripts are only recorded: the real one would try to fetch Cloudflare's. */
function fakePage(): { page: Parameters<typeof import('~/board-kit/turnstile').loadTurnstile>[0], scripts: FakeScript[] } {
  const scripts: FakeScript[] = []
  const page = {
    createElement: () => new FakeScript() as unknown as HTMLScriptElement,
    head: { append: (script: unknown) => scripts.push(script as FakeScript) },
  }
  return { page, scripts }
}

describe('the Turnstile loader', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('adds the script and resolves once Turnstile is on the page', async () => {
    const { loadTurnstile } = await import('~/board-kit/turnstile')
    const { page, scripts } = fakePage()
    const host: { turnstile?: unknown } = {}
    const loading = loadTurnstile(page, host as never)
    expect(scripts).toHaveLength(1)
    expect(scripts[0]?.src).toBe(TURNSTILE_SCRIPT_URL)
    expect(scripts[0]?.async).toBe(true)
    host.turnstile = { render: vi.fn(), remove: vi.fn() }
    scripts[0]?.dispatchEvent(new Event('load'))
    await expect(loading).resolves.toBe(host.turnstile)
  })

  it('does not add the script again when Turnstile is already there', async () => {
    const { loadTurnstile } = await import('~/board-kit/turnstile')
    const { page, scripts } = fakePage()
    const turnstile = { render: vi.fn(), remove: vi.fn() }
    await expect(loadTurnstile(page, { turnstile })).resolves.toBe(turnstile)
    expect(scripts).toHaveLength(0)
  })

  it('fails when the script cannot be loaded, or loads without starting Turnstile', async () => {
    const { loadTurnstile } = await import('~/board-kit/turnstile')
    const blocked = fakePage()
    const blockedLoad = loadTurnstile(blocked.page, {})
    blocked.scripts[0]?.dispatchEvent(new Event('error'))
    await expect(blockedLoad).rejects.toThrow('could not be loaded')

    const empty = fakePage()
    const emptyLoad = loadTurnstile(empty.page, {})
    empty.scripts[0]?.dispatchEvent(new Event('load'))
    await expect(emptyLoad).rejects.toThrow('did not start')
  })

  it('makes the script\'s address with one named Trusted Types policy that hands out that address and no other', async () => {
    const { loadTurnstile } = await import('~/board-kit/turnstile')
    const { page, scripts } = fakePage()
    let rules: { createScriptURL: (input: string) => string } | undefined
    const createPolicy = vi.fn((name: string, given: { createScriptURL: (input: string) => string }) => {
      rules = given
      return { createScriptURL: (input: string) => ({ trusted: given.createScriptURL(input), name }) }
    })
    const host: { turnstile?: unknown, trustedTypes: { createPolicy: typeof createPolicy } } = { trustedTypes: { createPolicy } }
    const first = loadTurnstile(page, host as never)
    host.turnstile = { render: vi.fn(), remove: vi.fn() }
    scripts[0]?.dispatchEvent(new Event('load'))
    await first
    expect(createPolicy).toHaveBeenCalledTimes(1)
    expect(createPolicy.mock.calls[0]?.[0]).toBe(TURNSTILE_POLICY_NAME)
    expect(rules?.createScriptURL(TURNSTILE_SCRIPT_URL)).toBe(TURNSTILE_SCRIPT_URL)
    expect(() => rules?.createScriptURL('https://evil.example/turnstile.js')).toThrow(TypeError)
  })

  it('renders the widget invisibly in a container and removes it on request', async () => {
    const { startChallenge } = await import('~/board-kit/turnstile')
    const render = vi.fn(() => 'widget-7')
    const remove = vi.fn()
    const container = document.createElement('div')
    const running = await startChallenge(container, 'site-key', { onToken: vi.fn(), onFailure: vi.fn() }, { turnstile: { render, remove } })
    expect(render).toHaveBeenCalledWith(container, expect.objectContaining({ sitekey: 'site-key', appearance: 'interaction-only' }))
    running.remove()
    expect(remove).toHaveBeenCalledWith('widget-7')
  })
})

describe('BoardTurnstileGate', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', new FakeSite({ testMode: false }).fetch)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    Reflect.deleteProperty(window, 'turnstile')
  })

  /** Mounts the gate with the session already read, and starts the check as a board would. */
  async function startCheck() {
    const widget = installWidget()
    const wrapper = mountWithSite(BoardTurnstileGate)
    const session = useSessionStore()
    await session.load()
    const passed = session.ensureVerified()
    await vi.waitFor(() => expect(widget.renders).toHaveLength(1))
    return { widget, wrapper, session, passed }
  }

  it('shows nothing, and loads nothing, until a check begins', () => {
    const wrapper = mountWithSite(BoardTurnstileGate)
    expect(wrapper.find('[data-testid="gate"]').exists()).toBe(false)
    expect(document.head.querySelector('script')).toBeNull()
  })

  it('starts the invisible widget with the site key while the check runs, and says it is checking', async () => {
    const { widget, wrapper } = await startCheck()
    expect(widget.renders[0]).toMatchObject({ sitekey: 'test-site-key', appearance: 'interaction-only' })
    expect(wrapper.get('[role="status"]').text()).toBe('Checking that you are a person…')
  })

  it('passes the token to the server and goes away when the check passes', async () => {
    const { widget, wrapper, passed, session } = await startCheck()
    widget.renders[0]?.callback('good-token')
    await expect(passed).resolves.toBe(true)
    await nextTick()
    expect(session.verified).toBe(true)
    expect(wrapper.find('[data-testid="gate"]').exists()).toBe(false)
    expect(widget.remove).toHaveBeenCalledWith('widget-1')
  })

  it('fails when the widget reports an error, and offers to try again', async () => {
    const { widget, wrapper, passed } = await startCheck()
    widget.renders[0]?.['error-callback']()
    await expect(passed).resolves.toBe(false)
    await nextTick()
    expect(wrapper.get('[role="alert"]').text()).toContain('could not tell that you are a person')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('fails when the widget takes too long', async () => {
    const { widget, passed } = await startCheck()
    widget.renders[0]?.['timeout-callback']()
    await expect(passed).resolves.toBe(false)
  })

  it('does not start a widget in the test build, which passes the check by itself', async () => {
    vi.stubGlobal('fetch', new FakeSite({ testMode: true }).fetch)
    const widget = installWidget()
    mountWithSite(BoardTurnstileGate)
    const session = useSessionStore()
    await expect(session.ensureVerified()).resolves.toBe(true)
    expect(widget.renders).toHaveLength(0)
  })
})
