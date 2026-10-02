// What LB-02's end-to-end tests share: the mock back end's controls, opening the board, starting and
// talking in a conversation, watching what a page sends, and finding a slot on the live calendar.
import type { Locator, Page } from '@playwright/test'

import { expect } from '../fixtures'

// The mock back end's address, which the end-to-end server (e2e/support/serve.ts) starts.
export const MOCK = `http://127.0.0.1:${process.env.E2E_MOCK_PORT ?? 8121}`

/** Calls one of the mock's controls (`/__mock/lb02/<action>`). */
export async function control(page: Page, action: string, data: object = {}): Promise<void> {
  const answer = await page.request.post(`${MOCK}/__mock/lb02/${action}`, { data })
  expect(answer.ok(), `the mock's ${action} control`).toBe(true)
}

/** Opens the board and waits until it has read the session, counted the day's conversations and loaded the calendar. */
export async function openBoard(page: Page, path = '/systems/lb-02/board', counted = '10 of 10'): Promise<void> {
  await page.goto(path)
  await expect(page.getByTestId('quota')).toContainText(counted)
  await expect(page.locator('[data-testid="slots"] li').first()).toBeVisible()
}

/** Records the requests that could change something, so a test can say that none was made. */
export function watchWrites(page: Page): string[] {
  const writes: string[] = []
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/api/')) writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
  })
  return writes
}

/** Records the WebSockets a page opens, with the text frames it sent. */
export function watchSockets(page: Page): { opened: string[], sent: string[] } {
  const seen = { opened: [] as string[], sent: [] as string[] }
  page.on('websocket', (socket) => {
    seen.opened.push(socket.url())
    socket.on('framesent', frame => seen.sent.push(String(frame.payload)))
  })
  return seen
}

/** Switches the start panel to the visitor's own conversation and starts one. */
export async function beginConversation(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Your own conversation' }).click()
  await page.getByTestId('begin').click()
  await expect(page.getByTestId('connection')).toHaveText('Connected')
}

/** Writes a message in the field and sends it with Enter; waits for the concierge's reply to appear. */
export async function say(page: Page, text: string): Promise<void> {
  const before = await page.getByTestId('line-concierge').count()
  const field = page.getByTestId('composer-field')
  await field.fill(text)
  await field.press('Enter')
  await expect(page.getByTestId('line-concierge')).toHaveCount(before + 1)
  await expect(page.getByTestId('working')).toHaveCount(0)
}

/** The slot row of a state on the calendar's chosen day. */
export function slotRow(page: Page, state: 'free' | 'held' | 'booked', text?: string | RegExp): Locator {
  const rows = page.locator(`[data-testid="slots"] [data-state="${state}"]`)
  return text === undefined ? rows : rows.filter({ hasText: text })
}

/** What a visitor writes to ask for a cupping tomorrow at 14:30 for two, giving a name and an address. */
export const ASKS_FOR_CUPPING = (name: string, email: string): string => `Hello! I'd like a cupping for two tomorrow at 14:30. I'm ${name}, ${email}.`
