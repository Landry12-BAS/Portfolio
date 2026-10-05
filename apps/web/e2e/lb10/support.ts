// What LB-10's end-to-end tests share: the mock back end's controls, the words that differ between the two languages,
// opening the board, reading and typing the prompt, starting a run and waiting for its state, watching what a page
// sends, scripting the site's answer to the request that starts a run (for the states only a scripted answer reaches,
// so no test changes what the mock does for another), and telling whether the page is wider than the window.
import type { Page, Response } from '@playwright/test'

import type { Lb10SampleId } from '../../shared/data/samples/lb10'
import { expect } from '../fixtures'

// The mock back end's address, which the end-to-end server (e2e/support/serve.ts) starts.
export const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 8121}`

/** What differs between the two languages in these tests. */
export const LANGUAGES = [
  { code: 'en', prefix: '', left: '1 of 1', used: '0 of 1', brief: 'Brief', technical: 'Technical', done: 'Done', replay: 'Replay', unchangedReport: 'Production\'s prompt ran alone', noDifference: 'No detectable difference', worse: 'Worse' },
  { code: 'cs', prefix: '/cs', left: '1 z 1', used: '0 z 1', brief: 'Stručný', technical: 'Technický', done: 'Hotovo', replay: 'Přehrání', unchangedReport: 'Produkční prompt běžel sám', noDifference: 'Žádný prokazatelný rozdíl', worse: 'Horší' },
] as const

/** One of the two languages, with its words. */
export type Language = (typeof LANGUAGES)[number]

/** The English words, which most journeys use. */
export const ENGLISH: Language = LANGUAGES[0]

/** The address of the board in a language. */
export function boardPath(language: Language = ENGLISH): string {
  return `${language.prefix}/systems/lb-10/board`
}

/** Calls one of the mock's controls for LB-10 (`/__mock/lb10/<action>`): reset, fail, fail-calls, busy, unavailable, nightly or baselines. */
export async function control(page: Page, action: string, data: object = {}): Promise<void> {
  const answer = await page.request.post(`${MOCK}/__mock/lb10/${action}`, { data })
  expect(answer.ok(), `the mock's ${action} control`).toBe(true)
}

/** Opens the board in a language and waits until it has read the prompts and counted the day's run. */
export async function openBoard(page: Page, language: Language = ENGLISH, counted: string = language.left): Promise<void> {
  await page.goto(boardPath(language))
  await expect(page.getByTestId('quota')).toContainText(counted)
  await expect(page.getByTestId('prompt-input')).toBeVisible()
}

/** The prompt in the editor. */
export function promptOf(page: Page): Promise<string> {
  return page.getByTestId('prompt-input').inputValue()
}

/** Puts a text in the editor, as a visitor's typing or pasting would. */
export async function setPrompt(page: Page, text: string): Promise<void> {
  await page.getByTestId('prompt-input').fill(text)
}

/** Picks one of the five prompts to measure. */
export async function chooseTarget(page: Page, pack: string): Promise<void> {
  await page.getByTestId(`target-${pack}`).locator('input').check()
}

/** Picks one of the prepared edits. */
export async function chooseSample(page: Page, sample: Lb10SampleId): Promise<void> {
  await page.getByTestId(`sample-${sample}`).locator('input').check()
}

/** Waits for the answer to the request that starts a run, so what the board shows next is the new run's. */
export function runStarted(page: Page): Promise<Response> {
  return page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/lb10/runs')
}

/** Starts the edit in the editor live, and returns the status the service answered with. */
export async function runEdit(page: Page): Promise<number> {
  const started = runStarted(page)
  await page.getByTestId('run-live').click()
  return (await started).status()
}

/** Waits for the run on the board to be in a state. */
export async function expectState(page: Page, state: 'running' | 'done' | 'failed', timeout = 30_000): Promise<void> {
  await expect(page.getByTestId('run-state')).toHaveAttribute('data-state', state, { timeout })
}

/** Waits for a run that is done, with its report on the board. */
export async function expectReport(page: Page): Promise<void> {
  await expectState(page, 'done')
  await expect(page.getByTestId('report')).toBeVisible()
}

/** Records the requests that could change something, so a test can say that none was made. */
export function watchWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })
  return writes
}

/** Answers the next request that starts a run with a status and a body of the test's own, in this page alone. */
export async function answerStartWith(page: Page, status: number, body: object): Promise<void> {
  let answered = false
  await page.route('**/api/lb10/runs', async (route) => {
    if (answered || route.request().method() !== 'POST') return route.fallback()
    answered = true
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
  })
}

/** A run's view as the service writes it, at a moment of the test's choosing: by default a run halfway through. */
export function scriptedView(changes: object = {}): Record<string, unknown> {
  return {
    run_id: 'scripted-run-0001',
    state: 'running',
    pack: 'lb01-drafter',
    pack_version: '0123456789abcdef',
    providers: ['groq'],
    calls_done: 12,
    calls_total: 20,
    cached_calls: 10,
    started_at: new Date().toISOString(),
    finished_at: null,
    failure: null,
    report: null,
    ...changes,
  }
}

/**
 * Scripts a run in this page alone: the request that starts it is answered as taken, and every read of it with the
 * view the test last set, so the board stands still at a moment while it is checked, and the mock never sees the run.
 * Returns what sets the next view.
 */
export async function scriptRun(page: Page, first: Record<string, unknown> = scriptedView()): Promise<(next: Record<string, unknown>) => void> {
  let view = first
  await page.route('**/api/lb10/runs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ run: view, remaining_runs: 0 }) })
  })
  await page.route(/\/api\/lb10\/runs\/[\w-]{8,64}$/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) }))
  return (next) => {
    view = next
  }
}

/** Answers every read of a path in this page with the site's own answer, changed by the test. */
export async function changeReads(page: Page, path: string, change: (body: Record<string, unknown>) => object): Promise<void> {
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const response = await route.fetch()
    const body = await response.json() as Record<string, unknown>
    return route.fulfill({ response, body: JSON.stringify(change(body)) })
  })
}

/** How many pixels the page is wider than the window, which a visitor would have to scroll sideways for: zero when it fits. */
export function overflowWidth(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth))
}
