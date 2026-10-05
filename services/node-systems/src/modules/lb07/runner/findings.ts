// The findings code makes while a page runs, with no model involved: console errors and page errors,
// requests that failed or were answered with an error status, and the requests and navigations the
// sandbox stopped. Each becomes a `RunnerFinding` with a title from a closed set of patterns and a
// detail that is the page's own words, bounded and made plain, labelled with the step that was running.
import type { Lb07Engine } from '@lb/contracts'
import type { Page } from 'playwright-core'

import { describeTarget, shopPathOf } from './guard.ts'
import type { RunnerFinding } from './protocol.ts'
import { plainDetail } from './snapshot.ts'

/** How a navigation, a request or a socket was stopped. */
export type BlockedHow = 'goto' | 'link' | 'request' | 'socket' | 'redirect'

// How a blocked-navigation finding begins, by how it was stopped.
const BLOCKED_WORDS: Readonly<Record<BlockedHow, string>> = {
  goto: 'A step to go to',
  link: 'A link to',
  request: 'A request to',
  socket: 'A socket to',
  redirect: 'A redirect to',
}

// The longest title a finding may have (the protocol's and the API's limit).
const MAX_TITLE_CHARS = 120

/** Makes a title one plain line of at most 120 characters: control and format characters become spaces. */
function plainTitle(title: string): string {
  const plain = title.replaceAll(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replaceAll(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS).trim()
  return plain === '' ? 'A finding' : plain
}

/** Collects the findings of one page and hands them over in batches. */
export class FindingCollector {
  readonly #engine: Lb07Engine
  readonly #shopOrigin: string
  #pending: RunnerFinding[] = []
  #stepIndex: number | null = null
  #blocked = 0
  #offOrigin = 0
  // Every finding made, kept short: the same console error on the same path is one finding.
  readonly #seen = new Set<string>()

  /** Starts collecting for one engine's page. */
  constructor(engine: Lb07Engine, shopOrigin: string) {
    this.#engine = engine
    this.#shopOrigin = shopOrigin
  }

  /** The step that is running, for the labels. */
  set stepIndex(index: number | null) {
    this.#stepIndex = index
  }

  /** How many requests and navigations the sandbox stopped. */
  get blocked(): number {
    return this.#blocked
  }

  /** How many requests reached another origin. Zero, or the sandbox has a hole. */
  get offOrigin(): number {
    return this.#offOrigin
  }

  /** Adds a finding, unless the same one was already made. Its title is made plain and bounded, whatever went into it. */
  add(finding: Omit<RunnerFinding, 'engine' | 'stepIndex'>): void {
    const key = `${finding.kind}|${finding.rule ?? ''}|${finding.path ?? ''}|${finding.detail.slice(0, 120)}`
    if (this.#seen.has(key)) return
    this.#seen.add(key)
    this.#pending.push({ ...finding, title: plainTitle(finding.title), engine: this.#engine, stepIndex: this.#stepIndex })
  }

  /** Records a request, a socket or a navigation the sandbox stopped: by the plan's check (a goto, a link), by interception (a request, a socket), or by the browser's own network (a request or a redirect's next hop). */
  blockedNavigation(target: string, how: BlockedHow): void {
    this.#blocked += 1
    this.add({ kind: 'blocked_navigation', title: 'Stopped at the sandbox: an address outside the shop', detail: plainDetail(`${BLOCKED_WORDS[how]} ${target} was refused: the browser may reach only the staging shop.`), rule: null, path: null })
  }

  /** Counts a request that reached another origin, which must never happen. */
  offOriginReached(): void {
    this.#offOrigin += 1
  }

  /** Hands over the findings made since the last call. */
  drain(): RunnerFinding[] {
    const batch = this.#pending
    this.#pending = []
    return batch
  }

  /** Listens to the page: console errors, thrown errors, failed requests and error responses. */
  attach(page: Page): void {
    page.on('console', (message) => {
      if (message.type() !== 'error') return
      const text = message.text()
      // A failed resource is reported by the response listener; the console's own line about it would be the same finding twice.
      if (/the server responded with a status of \d{3}/.test(text)) return
      this.add({ kind: 'console_error', title: 'An error was logged to the console', detail: plainDetail(text, 400), rule: null, path: shopPathOf(page.url(), this.#shopOrigin) })
    })
    page.on('pageerror', (error) => {
      this.add({ kind: 'console_error', title: 'The page threw an error', detail: plainDetail(`${error.name}: ${error.message}`, 400), rule: null, path: shopPathOf(page.url(), this.#shopOrigin) })
    })
    page.on('response', (response) => {
      const status = response.status()
      if (status < 400) return
      const request = response.request()
      const url = new URL(response.url())
      if (url.origin !== this.#shopOrigin) return
      const path = url.pathname.slice(0, 120)
      this.add({ kind: 'failed_request', title: `A request was answered with ${status}`, detail: plainDetail(`${request.method()} ${path} was answered with ${status}${request.isNavigationRequest() ? ' (a page)' : ''}.`), rule: null, path })
    })
    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? ''
      // A request interception aborted is already a blocked-navigation finding.
      if (failure.includes('BLOCKED_BY_CLIENT')) return
      const url = new URL(request.url())
      if (url.origin !== this.#shopOrigin) {
        // Interception never saw it (the next hop of a redirect does not pass it): the browser's own network stopped it.
        this.blockedNavigation(describeTarget(request.url()), request.redirectedFrom() === null ? 'request' : 'redirect')
        return
      }
      const path = url.pathname.slice(0, 120)
      this.add({ kind: 'failed_request', title: 'A request failed', detail: plainDetail(`${request.method()} ${path} failed: ${failure || 'no answer'}.`), rule: null, path })
    })
    page.on('requestfinished', (request) => {
      if (new URL(request.url()).origin !== this.#shopOrigin) this.offOriginReached()
    })
  }

  /** Describes an address another origin's request pointed at, for a blocked finding. */
  static targetOf(url: string): string {
    return describeTarget(url)
  }
}
