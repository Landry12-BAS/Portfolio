// Loading and running Cloudflare Turnstile's widget in the browser, under the site's security
// policy. The page's Content Security Policy requires Trusted Types for scripts, so the widget's
// script address is made by one named policy (`lb-turnstile`) that hands out that one address and
// nothing else; the policy's name is the only addition the board pages make to the list of
// allowed policies (nuxt.config.ts). The widget is invisible unless Cloudflare decides the visitor
// must do something, and it is only ever started when a visitor begins a live run.

/** The only script address the policy will hand out. */
export const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
/** The name of the Trusted Types policy, which the Content Security Policy must list. */
export const TURNSTILE_POLICY_NAME = 'lb-turnstile'

/** The part of Turnstile's browser API the site uses. */
export interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileOptions) => string | undefined
  remove: (widgetId: string) => void
}

/** The options the site passes to `render`. */
export interface TurnstileOptions {
  'sitekey': string
  // Invisible unless the visitor has to interact, which Cloudflare decides.
  'appearance': 'interaction-only'
  'theme': 'auto'
  'callback': (token: string) => void
  'error-callback': () => void
  'expired-callback': () => void
  'timeout-callback': () => void
}

/** The part of the Trusted Types API the loader uses: a factory that makes a named policy. */
interface PolicyFactory {
  createPolicy: (name: string, rules: { createScriptURL: (input: string) => string }) => { createScriptURL: (input: string) => unknown }
}

/** The part of a page the loader needs: a way to make a script element, and a place to put it. */
export interface ScriptPage {
  createElement: (tag: 'script') => HTMLScriptElement
  head: { append: (script: HTMLScriptElement) => void }
}

/** The browser's globals the loader touches. */
interface TurnstileWindow {
  turnstile?: TurnstileApi
  trustedTypes?: PolicyFactory
}

// The policy is made once: making a second one with the same name is an error.
let policy: { createScriptURL: (input: string) => unknown } | undefined

/** Makes the script's address a Trusted Types value where the browser has them, or leaves it text where it has not. */
function trustedScriptUrl(factory: PolicyFactory | undefined): string {
  if (!factory) return TURNSTILE_SCRIPT_URL
  policy ??= factory.createPolicy(TURNSTILE_POLICY_NAME, {
    createScriptURL: (input) => {
      if (input !== TURNSTILE_SCRIPT_URL) throw new TypeError('This policy only hands out Turnstile\'s script.')
      return input
    },
  })
  return policy.createScriptURL(TURNSTILE_SCRIPT_URL) as string
}

/** Adds Turnstile's script to the page and waits for it to load. Fails if it cannot be loaded. */
export async function loadTurnstile(page: ScriptPage, host: TurnstileWindow): Promise<TurnstileApi> {
  if (host.turnstile) return host.turnstile
  await new Promise<void>((resolve, reject) => {
    const script = page.createElement('script')
    script.src = trustedScriptUrl(host.trustedTypes)
    script.async = true
    script.addEventListener('load', () => resolve())
    script.addEventListener('error', () => reject(new Error('Turnstile could not be loaded.')))
    page.head.append(script)
  })
  if (!host.turnstile) throw new Error('Turnstile did not start.')
  return host.turnstile
}

/** What the widget reports back: a token, or that it could not make one. */
export interface ChallengeHandlers {
  onToken: (token: string) => void
  onFailure: () => void
}

/** A widget on the page, which can be taken away. */
export interface RunningChallenge {
  remove: () => void
}

/** Puts the widget in a container and starts the check. Its answers go to the handlers. */
export async function startChallenge(container: HTMLElement, siteKey: string, handlers: ChallengeHandlers, host: TurnstileWindow = window as unknown as TurnstileWindow): Promise<RunningChallenge> {
  const api = await loadTurnstile(container.ownerDocument, host)
  const id = api.render(container, {
    'sitekey': siteKey,
    'appearance': 'interaction-only',
    'theme': 'auto',
    'callback': handlers.onToken,
    'error-callback': handlers.onFailure,
    // A token that expired before it was used, or a check that timed out, is a check that did not pass.
    'expired-callback': handlers.onFailure,
    'timeout-callback': handlers.onFailure,
  })
  const remove = (): void => {
    if (id !== undefined) api.remove(id)
  }
  return { remove }
}
