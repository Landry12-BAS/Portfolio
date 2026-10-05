// What LB-07's end-to-end tests share: the mock back end's controls, the words that differ between the two
// languages, opening the board, picking and running a curated run, waiting for a run's state, watching what a
// page sends, holding the board's view of a live run still at a moment, telling whether the page is wider than
// the window, and telling whether a picture was drawn.
import type { Lb07State } from '@lb/contracts'
import type { Locator, Page, Response, Route } from '@playwright/test'

import type { Lb07SampleId } from '../../shared/data/samples/lb07'
import { expect } from '../fixtures'

// The mock back end's address, which the end-to-end server (e2e/support/serve.ts) starts.
export const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 8121}`

/** What differs between the two languages in these tests. */
export const LANGUAGES = [
  { code: 'en', prefix: '', full: '2 of 2', one: '1 of 2', none: '0 of 2', live: 'Live', replay: 'Replay', brief: 'Brief', technical: 'Technical', done: 'Done', kept: 'Kept', firstStep: 'Go to /', queued: '2 runs are ahead of yours.' },
  { code: 'cs', prefix: '/cs', full: '2 z 2', one: '1 z 2', none: '0 z 2', live: 'Živě', replay: 'Přehrání', brief: 'Stručný', technical: 'Technický', done: 'Hotovo', kept: 'Ponechán', firstStep: 'Otevřít /', queued: 'Před vaším během jsou 2 další.' },
] as const

/** One of the two languages, with its words. */
export type Language = (typeof LANGUAGES)[number]

/** The English words, which most journeys use. */
export const ENGLISH: Language = LANGUAGES[0]

// The address of one run's view in the site's API: the id is a UUID.
const RUN_VIEW = /\/api\/lb07\/runs\/[\da-f-]{36}$/

/** Calls one of the mock's controls for LB-07 (`/__mock/lb07/<action>`): reset, fail (with a code) or occupy (with runs and ms). */
export async function control(page: Page, action: 'reset' | 'fail' | 'occupy', data: object = {}): Promise<void> {
  const answer = await page.request.post(`${MOCK}/__mock/lb07/${action}`, { data })
  expect(answer.ok(), `the mock's ${action} control`).toBe(true)
}

/** Opens the board in a language and waits until it has read the session and counted the day's runs. */
export async function openBoard(page: Page, language: Language = ENGLISH, counted: string = language.full): Promise<void> {
  await page.goto(`${language.prefix}/systems/lb-07/board`)
  await expect(page.getByTestId('quota')).toContainText(counted)
}

/** Picks one of the curated runs. */
export async function choose(page: Page, sample: Lb07SampleId): Promise<void> {
  await page.getByTestId(`sample-${sample}`).locator('input').check()
}

/** Waits for the answer to the request that starts a run, so what the board shows next is the new run's. */
export function runStarted(page: Page): Promise<Response> {
  return page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/lb07/runs')
}

/** Runs a curated run live and waits for the board to show it. */
export async function runLive(page: Page, sample: Lb07SampleId): Promise<void> {
  await choose(page, sample)
  const started = runStarted(page)
  await page.getByTestId('live-sample').click()
  expect((await started).status()).toBe(201)
  await expect(page.getByTestId('run-panel')).toBeVisible()
}

/** Replays a curated run's recording and waits for the replay to end. */
export async function replay(page: Page, sample: Lb07SampleId): Promise<void> {
  await choose(page, sample)
  await page.getByTestId('replay-sample').click()
  await expectState(page, 'done')
}

/** Waits for the run on the board to be in a state. */
export async function expectState(page: Page, state: Lb07State, timeout = 30_000): Promise<void> {
  await expect(page.getByTestId('run-state')).toHaveAttribute('data-state', state, { timeout })
}

/** Waits for a run that is done, with its verdict, its test and its evidence read. */
export async function expectFinished(page: Page): Promise<void> {
  await expectState(page, 'done')
  await expect(page.getByTestId('verdict')).toBeVisible()
  await expect(page.getByTestId('test-code')).toBeVisible()
  await expect(page.getByTestId('screenshot').first()).toBeVisible()
}

/** Records the requests that could change something, so a test can say that none was made. */
export function watchWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })
  return writes
}

/** The moments a test can hold a live run at: waiting in the queue, or running with one step passed and one to come. */
export type Moment = 'queued' | 'running'

/** Tells whether a view of a run is at a moment. */
function isAt(moment: Moment, body: string): boolean {
  const view = JSON.parse(body) as { state?: string, steps?: { status?: string }[] }
  if (moment === 'queued') return view.state === 'queued'
  const statuses = (view.steps ?? []).map(step => step.status)
  return view.state === 'running' && statuses.includes('passed') && statuses.includes('pending')
}

/**
 * Holds the board's view of a live run still from the first read that finds it at a moment: from then on
 * every read of the run is answered with that view, so a check of the page sees the run at that moment, not
 * one that moves under it. The run itself goes on in the mock. Returns what lets the board see it again.
 */
export async function holdRunAt(page: Page, moment: Moment): Promise<() => Promise<void>> {
  let held: string | undefined
  /** Answers a read of the run: with the held view once there is one, else as the site does. */
  async function answer(route: Route): Promise<void> {
    if (route.request().method() !== 'GET') return route.continue()
    if (held !== undefined) return route.fulfill({ status: 200, contentType: 'application/json', body: held })
    const response = await route.fetch()
    const body = await response.text()
    if (response.ok() && isAt(moment, body)) held = body
    return route.fulfill({ response, body })
  }
  await page.route(RUN_VIEW, answer)
  return () => page.unroute(RUN_VIEW, answer)
}

/** How many pixels the page is wider than the window, which a visitor would have to scroll sideways for: zero when it fits. */
export function overflowWidth(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth))
}

/** The width a picture was drawn at, once it is in view: zero for a picture that did not load. */
export async function drawnWidth(picture: Locator): Promise<number> {
  await picture.scrollIntoViewIfNeeded()
  await expect.poll(() => picture.evaluate(element => (element as HTMLImageElement).complete)).toBe(true)
  return picture.evaluate(element => (element as HTMLImageElement).naturalWidth)
}
