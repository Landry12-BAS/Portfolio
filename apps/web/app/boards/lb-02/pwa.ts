// The installable board's browser side: registering the service worker (public/lb02-sw.js) under the
// site's Trusted Types policy, noticing whether the page is running as an installed app, and the
// optional install prompt. Nothing here touches the conversation, the calendar or any token: the
// service worker keeps the page and its static files and nothing else (see its own header), and this
// file only starts it and reports what the browser says.
//
// The site's Content Security Policy requires Trusted Types for scripts, and a service worker's
// address is a script address, so it is made by one named policy, `lb-service-worker`, which hands
// out that one address and nothing else. The policy's name is the only thing the board's route adds
// to the list of allowed policies (server/lib/lb02-csp.ts), and there is never a `default` policy.
import { onMounted, onScopeDispose, ref } from 'vue'

import { SERVICE_WORKER_POLICY, SERVICE_WORKER_URL } from '#shared/lb02-app'

/** The part of the site the board owns in one language: where its service worker is registered and the installed app lives. */
export function boardScope(code: 'en' | 'cs'): string {
  return code === 'cs' ? '/cs/systems/lb-02/' : '/systems/lb-02/'
}

/** The part of the Trusted Types API the registration uses: a factory that makes a named policy. */
export interface PolicyFactory {
  createPolicy: (name: string, rules: { createScriptURL: (input: string) => string }) => { createScriptURL: (input: string) => unknown }
}

/** The part of the browser's service worker container the registration uses. */
export interface WorkerContainer {
  register: (url: string, options: { scope: string }) => Promise<unknown>
  readonly controller: unknown
}

/** The browser's globals the registration touches. */
export interface PwaHost {
  isSecureContext: boolean
  trustedTypes?: PolicyFactory
  navigator: { serviceWorker?: WorkerContainer, standalone?: boolean }
  matchMedia?: (query: string) => { matches: boolean }
}

/** How the registration went. */
export type WorkerState = 'idle' | 'registering' | 'registered' | 'unsupported' | 'failed'

/** The answer of the install prompt: whether the visitor accepted the browser's offer to install the app. */
export interface InstallChoice {
  outcome: 'accepted' | 'dismissed'
}

/** The browser's offer to install the app, kept until the visitor asks for it. */
export interface InstallPrompt {
  prompt: () => Promise<void>
  userChoice: Promise<InstallChoice>
}

// The policy is made once: making a second one with the same name is an error.
let policy: { createScriptURL: (input: string) => unknown } | undefined

/** Makes the service worker's address a Trusted Types value where the browser has them, or leaves it text where it has not. */
export function trustedWorkerUrl(factory: PolicyFactory | undefined): string {
  if (!factory) return SERVICE_WORKER_URL
  policy ??= factory.createPolicy(SERVICE_WORKER_POLICY, {
    createScriptURL: (input) => {
      if (input !== SERVICE_WORKER_URL) throw new TypeError('This policy only hands out the board\'s service worker.')
      return input
    },
  })
  return policy.createScriptURL(SERVICE_WORKER_URL) as string
}

/**
 * Registers the service worker for the part of the site the board owns (`scope`). A browser without
 * service workers, or a page that is not a secure context, is `unsupported`; a registration the
 * browser or the page's policy refuses is `failed`. The board works the same in both cases.
 */
export async function registerWorker(scope: string, host: PwaHost): Promise<WorkerState> {
  const container = host.navigator.serviceWorker
  if (!container || !host.isSecureContext) return 'unsupported'
  try {
    await container.register(trustedWorkerUrl(host.trustedTypes), { scope })
    return 'registered'
  }
  catch {
    return 'failed'
  }
}

/** Tells whether the page is running as an installed app, in its own window, as the browser reports it. */
export function isStandalone(host: Pick<PwaHost, 'matchMedia' | 'navigator'>): boolean {
  if (host.navigator.standalone === true) return true
  return host.matchMedia?.('(display-mode: standalone)').matches === true
}

/** Reads the browser's install event, which only some browsers send, as the offer it carries; anything else is not one. */
export function readInstallPrompt(event: Event): InstallPrompt | undefined {
  const candidate = event as Partial<InstallPrompt>
  if (typeof candidate.prompt !== 'function' || typeof candidate.userChoice?.then !== 'function') return undefined
  return { prompt: () => candidate.prompt!(), userChoice: candidate.userChoice }
}

/**
 * The board's app state, for the component that shows it: starts the service worker once the page is
 * shown, and keeps `worker`, `controlled` (the page was loaded through the worker, so what it loaded is
 * on the device), `installed` and `canInstall` up to date. The install prompt is only ever shown when the
 * visitor asks for it.
 */
export function usePwa(scope: string) {
  const worker = ref<WorkerState>('idle')
  const controlled = ref(false)
  const installed = ref(false)
  const canInstall = ref(false)
  let offer: InstallPrompt | undefined

  /** Keeps the browser's offer to install, and stops the browser from showing it by itself. */
  function onBeforeInstall(event: Event): void {
    const found = readInstallPrompt(event)
    if (!found) return
    event.preventDefault()
    offer = found
    canInstall.value = true
  }

  /** The app was installed: the offer is used up. */
  function onInstalled(): void {
    installed.value = true
    canInstall.value = false
    offer = undefined
  }

  /** Reads whether the worker controls the page. */
  function readControl(): void {
    controlled.value = navigator.serviceWorker?.controller != null
  }

  /** Shows the browser's install prompt, which only a visitor's own click may do. */
  async function install(): Promise<InstallChoice['outcome'] | 'unavailable'> {
    const current = offer
    if (!current) return 'unavailable'
    offer = undefined
    canInstall.value = false
    await current.prompt()
    return (await current.userChoice).outcome
  }

  onMounted(async () => {
    installed.value = isStandalone({ navigator, matchMedia: window.matchMedia.bind(window) })
    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    navigator.serviceWorker?.addEventListener('controllerchange', readControl)
    readControl()
    worker.value = 'registering'
    worker.value = await registerWorker(scope, {
      isSecureContext: window.isSecureContext,
      trustedTypes: (window as { trustedTypes?: PolicyFactory }).trustedTypes,
      navigator,
    })
  })

  onScopeDispose(() => {
    if (typeof window === 'undefined') return
    window.removeEventListener('beforeinstallprompt', onBeforeInstall)
    window.removeEventListener('appinstalled', onInstalled)
    navigator.serviceWorker?.removeEventListener('controllerchange', readControl)
  })

  return { worker, controlled, installed, canInstall, install }
}
