// LB-02's journeys: a curated sample run live, the double-booking attempt from a second tab, a connection
// that drops, a handoff and the message limit, replays of recorded samples, the keyboard, and Czech.
// They are registered by e2e/lb02.spec.ts, which runs them one after another on a calendar nobody has touched.
import { expect, test } from '../fixtures'
import { ASKS_FOR_CUPPING, beginConversation, calendarCollisions, control, openBoard, say, slotRow, watchSockets, watchWrites } from './support'

/** Registers the journeys. */
export function journeys(): void {
  test.describe('a curated sample run live', () => {
    test('goes from the first message to a recorded booking, and the calendar moves from free to held to booked', async ({ page }) => {
      const writes = watchWrites(page)
      const sockets = watchSockets(page)
      await openBoard(page)
      await expect(page.getByTestId('board-state')).toHaveText('Live')
      await expect(page.getByTestId('connection')).toHaveText('Not started')
      await expect(page.locator('input[name="sample"]')).toHaveCount(5)
      await expect(page.locator('input[data-testid^="day-"]')).toHaveCount(14)

      // This sample has a recording, so it replays by default; the live run is the second button.
      await page.getByTestId('run-sample-live').click()
      await expect(page.getByTestId('connection')).toHaveText('Connected')
      await expect(page.getByTestId('script-progress')).toHaveText('Message 1 of 3 sent')
      await expect(page.getByTestId('line-concierge')).toHaveCount(1)
      await expect(page.getByTestId('composer-field')).toBeFocused()
      await expect(slotRow(page, 'held')).toHaveCount(0)

      await page.getByTestId('script-next').click()
      await expect(page.getByTestId('receipt')).toHaveCount(1)
      await expect(page.getByTestId('receipt')).toContainText('Hold placed')
      await expect(page.getByTestId('hold-timer')).toContainText('left')
      await expect(slotRow(page, 'held', 'Held for you')).toHaveCount(1)
      await expect(page.getByTestId('calendar-announcement')).toContainText('is now held')

      await page.getByTestId('script-next').click()
      await expect(page.getByTestId('booking-code')).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      await expect(page.getByTestId('hold-timer')).toHaveCount(0)
      await expect(slotRow(page, 'booked', 'Booked for you')).toHaveCount(1)
      await expect(page.getByTestId('messages-count')).toHaveText('27 of 30')

      await expect(page.getByTestId('email-badge')).toHaveText('Recorded, never sent')
      await expect(page.getByTestId('email-to')).toHaveText('jana@example.test')
      await expect(page.getByTestId('email-body')).toContainText('was never sent to jana@example.test')
      await expect(page.getByTestId('scope-row').first()).toBeVisible()

      expect(sockets.opened).toEqual([expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/ws\/lb02\/$/)])
      expect(sockets.opened[0]).not.toContain('token')
      expect(JSON.parse(sockets.sent[0] ?? '{}')).toMatchObject({ type: 'hello', conversation: null })
      // The only writes are the check that the visitor is a person and the pass for the socket; the conversation itself is a socket.
      expect(writes.toSorted()).toEqual(['POST /api/session/verify', 'POST /api/tokens/lb-02'])
    })

    test('shows the tools the concierge called, including what the booking rules refused, only in the Technical reading', async ({ page }) => {
      await openBoard(page)
      await beginConversation(page)
      await say(page, ASKS_FOR_CUPPING('Jana Novak', 'jana@example.test'))
      await expect(page.getByTestId('tools').first()).toContainText('update_details')
      await page.getByRole('group', { name: 'Reading mode' }).getByRole('button', { name: 'Brief' }).click()
      await expect(page.getByTestId('tools')).toHaveCount(0)
      await expect(page.getByTestId('chain')).toHaveCount(0)
      await page.getByRole('group', { name: 'Reading mode' }).getByRole('button', { name: 'Technical' }).click()
      await expect(page.getByTestId('tools').first()).toBeVisible()
    })

    test('refuses the injection attempt before any model reads it, and holds and books nothing', async ({ page }) => {
      await openBoard(page)
      await page.getByRole('radio', { name: /Injection attempt/ }).check()
      await expect(page.getByTestId('no-recording')).toBeVisible()
      await page.getByTestId('start-sample').click()
      await expect(page.getByTestId('receipt')).toContainText('Message refused')
      await expect(page.getByTestId('booking-code')).toHaveCount(0)
      await expect(slotRow(page, 'held')).toHaveCount(0)
    })
  })

  test.describe('trying to double-book from a second tab', () => {
    test('the second tab sees the slot held and is not offered it, the first confirms, and the second sees it booked without a reload', async ({ page, context }) => {
      await openBoard(page)
      await beginConversation(page)
      await say(page, ASKS_FOR_CUPPING('Jana Novak', 'jana@example.test'))
      await say(page, 'Yes, that one.')
      await expect(slotRow(page, 'held', 'Held for you')).toHaveCount(1)

      const second = await context.newPage()
      // Both tabs are one visitor with one allowance, of which the first tab's conversation has used one.
      await openBoard(second, '/systems/lb-02/board', '9 of 10')
      // The calendar opens on the first day with a free slot, tomorrow's, where the first tab's hold already shows as someone else's.
      await expect(slotRow(second, 'held')).toHaveCount(1)
      await expect(slotRow(second, 'held')).not.toContainText('for you')

      await beginConversation(second)
      await say(second, ASKS_FOR_CUPPING('Ben Hall', 'ben@example.test'))
      await expect(second.getByTestId('line-concierge').last()).toContainText('could not find a free time')
      await say(second, 'Just book 14:30 anyway.')
      await expect(second.getByTestId('hold-timer')).toHaveCount(0)
      await expect(second.getByTestId('booking-code')).toHaveCount(0)

      await say(page, 'Yes, please confirm it.')
      await expect(page.getByTestId('booking-code')).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      await expect(slotRow(second, 'booked', 'Cupping session')).toHaveCount(1)
      await expect(second.getByTestId('calendar-announcement')).toContainText('is now booked')
      await expect(second.getByTestId('booking-code')).toHaveCount(0)
    })

    test('shows another visitor taking a slot on the live calendar as it happens', async ({ page }) => {
      await openBoard(page)
      await beginConversation(page)
      const before = await slotRow(page, 'booked').count()
      await control(page, 'other-visitor', { action: 'books', offering: 'tasting', day: 1, time: '12:00' })
      // The calendar is open on tomorrow, the first day with a free slot, where the slot is.
      await expect(slotRow(page, 'booked', 'Coffee tasting')).toHaveCount(1)
      await expect(page.getByTestId('calendar-announcement')).toContainText(/is now booked|slots on the calendar changed/)
      expect(before).toBe(0)
    })
  })

  test.describe('a connection that drops', () => {
    test('is opened again by itself, says so while it does, picks the conversation up and loads the calendar afresh', async ({ page }) => {
      await openBoard(page)
      await beginConversation(page)
      await say(page, ASKS_FOR_CUPPING('Jana Novak', 'jana@example.test'))
      const loads: string[] = []
      page.on('request', (request) => {
        if (request.url().includes('/api/lb02/calendar')) loads.push(request.url())
      })

      await control(page, 'drop', { code: 1001 })
      await expect(page.getByTestId('connection')).toContainText('Reconnecting')
      await expect(page.getByTestId('connection')).toHaveText('Connected')
      await expect(page.getByTestId('line-visitor')).toHaveCount(1)
      await expect(page.getByTestId('line-concierge')).toHaveCount(1)
      await expect(page.getByTestId('calendar-announcement')).toHaveText('The connection came back, so the calendar was loaded again.')
      expect(loads.length).toBeGreaterThan(0)
      await say(page, 'Yes, that one.')
      await expect(page.getByTestId('hold-timer')).toBeVisible()
    })

    test('keeps waiting for the answer when the turn went on without the connection, and shows it when it comes', async ({ page }) => {
      await openBoard(page)
      await beginConversation(page)
      await control(page, 'limits', { thinkMs: 4_000 })
      await page.getByTestId('composer-field').fill('Hello there.')
      await page.getByTestId('composer-field').press('Enter')
      await expect(page.getByTestId('working')).toBeVisible()

      await control(page, 'drop', { code: 1001 })
      await expect(page.getByTestId('connection')).toHaveText('Connected')
      await expect(page.getByTestId('working')).toBeVisible()
      await expect(page.getByTestId('notice')).toHaveCount(0)
      await expect(page.getByTestId('line-visitor')).toHaveCount(1)
      await expect(page.getByTestId('line-concierge')).toHaveCount(0)

      await expect(page.getByTestId('line-concierge')).toHaveCount(1, { timeout: 15_000 })
      await expect(page.getByTestId('working')).toHaveCount(0)
      await expect(page.getByTestId('notice')).toHaveCount(0)
      await expect(page.getByTestId('messages-count')).toHaveText('29 of 30')
    })

    test('says the last message has no answer when the drop took the answer, and sending it again is answered', async ({ page }) => {
      await openBoard(page)
      await beginConversation(page)
      await control(page, 'limits', { thinkMs: 60_000 })
      await page.getByTestId('composer-field').fill('Hello there.')
      await page.getByTestId('composer-field').press('Enter')
      await expect(page.getByTestId('working')).toBeVisible()

      await control(page, 'lose-turns')
      await control(page, 'drop', { code: 1001 })
      await expect(page.getByTestId('connection')).toHaveText('Connected')
      await expect(page.getByTestId('notice')).toContainText('Your last message has no answer')
      await expect(page.getByTestId('line-visitor')).toHaveCount(1)
      await expect(page.getByTestId('line-concierge')).toHaveCount(0)
      await expect(page.getByTestId('messages-count')).toHaveText('29 of 30')

      await control(page, 'limits', { thinkMs: 0 })
      await say(page, 'Hello again.')
      await expect(page.getByTestId('notice')).toHaveCount(0)
      await expect(page.getByTestId('messages-count')).toHaveText('28 of 30')
    })

    test('is told a conversation cannot be found when its data is gone, in plain words', async ({ page }) => {
      await openBoard(page)
      await beginConversation(page)
      await control(page, 'reset')
      await control(page, 'drop', { code: 1001 })
      await expect(page.getByTestId('ended')).toHaveText('That conversation no longer exists. Conversations are deleted after 24 hours.', { timeout: 20_000 })
      await expect(page.getByTestId('resume-ended')).toHaveCount(0)
      await page.getByTestId('again').click()
      await expect(page.getByTestId('start')).toBeVisible()
      await expect(page.getByTestId('start').getByRole('heading', { name: 'Start a conversation' })).toBeFocused()
    })
  })

  test.describe('handing over to a person and the message limit', () => {
    test('hands the conversation to a person on request, with the reason and every line said, and the focus on it', async ({ page }) => {
      await openBoard(page)
      await beginConversation(page)
      await say(page, 'Can I speak to a real person please?')
      const card = page.getByTestId('handoff')
      await expect(card).toBeFocused()
      await expect(page.getByTestId('handoff-reason')).toHaveText('The visitor asked for a person')
      // Every line said: the visitor's, the note of what the concierge did, and its reply.
      await expect(page.getByTestId('handoff-transcript').locator('li')).toHaveCount(3)
      await expect(page.getByTestId('handoff-transcript').locator('li[data-role="visitor"]')).toContainText('Can I speak to a real person please?')
      await expect(page.getByTestId('composer-field')).toBeDisabled()
      await expect(page.getByTestId('composer-hint')).toContainText('finished')
      await expect(page.getByTestId('receipt')).toContainText('Handed to a person')
      await page.getByTestId('again').click()
      await expect(page.getByTestId('start')).toBeVisible()
      await expect(page.getByTestId('handoff')).toHaveCount(0)
    })

    test('hands the conversation over when the message limit is reached', async ({ page }) => {
      await control(page, 'limits', { messagesPerConversation: 2 })
      await openBoard(page)
      await beginConversation(page)
      await say(page, 'Hello there.')
      await say(page, 'A cupping tomorrow please.')
      await expect(page.getByTestId('messages-count')).toHaveText('0 of 30')
      await expect(page.getByTestId('composer-hint')).toContainText('last message')
      await say(page, 'And one more thing.')
      await expect(page.getByTestId('receipt').last()).toContainText('Message limit reached')
      await expect(page.getByTestId('handoff-reason')).toHaveText('The conversation reached its message limit')
    })
  })

  test.describe('replaying recorded samples', () => {
    test('plays the booking as a replay: no token, no socket, no write, and the allowance untouched', async ({ page }) => {
      const writes = watchWrites(page)
      const sockets = watchSockets(page)
      await openBoard(page)
      await expect(page.locator('.state[data-recording="yes"]')).toHaveCount(3)
      await page.getByTestId('start-sample').click()
      await expect(page.getByTestId('board-state')).toHaveText('Replay')
      await expect(page.getByTestId('replay-banner')).toContainText('Replay of a recorded run')
      await expect(page.getByTestId('connection')).toHaveText('Replay')
      await expect(page.getByTestId('booking-code')).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/, { timeout: 15_000 })
      await expect(page.getByTestId('line-visitor')).toHaveCount(3)
      await expect(page.getByTestId('email-badge')).toHaveText('Recorded, never sent')
      await expect(page.getByTestId('calendar')).toContainText('The calendar as it was when this was recorded.')
      await expect(page.getByTestId('composer-field')).toBeDisabled()
      await expect(page.getByTestId('scope-row').first()).toBeVisible()
      await expect(page.getByTestId('quota')).toContainText('10 of 10')
      expect(writes).toEqual([])
      expect(sockets.opened).toEqual([])
    })

    test('plays the Czech conversation in which another visitor\'s hold runs out, with the wait shown', async ({ page }) => {
      await openBoard(page, '/cs/systems/lb-02/board', '10 z 10')
      await page.getByRole('radio', { name: /Druhá karta blokuje termín/ }).check()
      await page.getByTestId('start-sample').click()
      await expect(page.getByTestId('line-pause')).toHaveText('o 6 min později', { timeout: 15_000 })
      await expect(page.getByTestId('booking-code')).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/, { timeout: 15_000 })
      await expect(page.getByTestId('email-badge')).toContainText('nikdy neodesláno')
    })
  })

  test.describe('the layout', () => {
    test('gives the calendar room beside the phone, keeps the visitor\'s own slot in the list, and no name, state or mark runs into another, from a phone to a wide screen', async ({ page }) => {
      await openBoard(page)
      await page.getByTestId('start-sample').click()
      await expect(page.getByTestId('booking-code')).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/, { timeout: 15_000 })
      await expect(page.locator('.day .own-mark')).toHaveCount(1)
      await expect(page.getByTestId('slots').locator('li[data-state="booked"]')).toContainText('Booked for you')
      for (const width of [390, 768, 1000, 1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 })
        const calendar = await page.getByTestId('calendar').boundingBox()
        const phone = await page.getByTestId('phone').boundingBox()
        if (!calendar || !phone) throw new Error(`the calendar or the phone is not drawn at ${width} px`)
        expect(calendar.width, `the calendar's width at ${width} px`).toBeGreaterThanOrEqual(280)
        if (width >= 1000) expect(calendar.y, `the calendar beside the phone at ${width} px`).toBeLessThan(phone.y + phone.height)
        expect(await calendarCollisions(page), `at ${width} px`).toEqual([])
      }
    })
  })

  test.describe('the keyboard', () => {
    test('starts a conversation, writes and sends a message, and moves along the calendar\'s days, all without a mouse', async ({ page }) => {
      await openBoard(page)
      await page.getByRole('button', { name: 'Your own conversation' }).focus()
      await page.keyboard.press('Enter')
      await page.getByTestId('begin').focus()
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('composer-field')).toBeFocused()
      await page.keyboard.type('Hello! A cupping for two tomorrow please. I am Jana Novak, jana@example.test.')
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('line-concierge')).toHaveCount(1)
      await expect(page.getByTestId('composer-field')).toBeFocused()

      const days = page.locator('input[data-testid^="day-"]')
      await days.first().focus()
      await page.keyboard.press('ArrowRight')
      await expect(days.nth(1)).toBeChecked()
      await expect(days.nth(1)).toBeFocused()
      await page.keyboard.press('ArrowLeft')
      await expect(days.first()).toBeChecked()
    })

    test('has no focus trap: tabbing forward from the top reaches the chat, the message field, the calendar\'s days and the guide, and leaves the page', async ({ page }) => {
      await openBoard(page)
      await beginConversation(page)
      // Clicking the page's title sets the place the next Tab starts from: the top of the page.
      await page.getByRole('heading', { level: 1 }).click()
      const visited: string[] = []
      let left = false
      for (let step = 0; step < 250 && !left; step += 1) {
        await page.keyboard.press('Tab')
        const place = await page.evaluate(() => `${document.activeElement?.tagName}:${document.activeElement?.getAttribute('data-testid') ?? ''}`)
        left = place.startsWith('BODY')
        visited.push(place)
      }
      expect(left, 'focus leaves the page after its last control').toBe(true)
      expect(visited).toContain('DIV:chat-log')
      expect(visited).toContain('TEXTAREA:composer-field')
      expect(visited.some(place => place.startsWith('INPUT:day-'))).toBe(true)
      expect(visited).toContain('A:open-second-tab')
      expect(visited.indexOf('DIV:chat-log')).toBeLessThan(visited.indexOf('TEXTAREA:composer-field'))
      expect(visited.indexOf('TEXTAREA:composer-field')).toBeLessThan(visited.indexOf('A:open-second-tab'))
    })

    test('puts the chat log in the tab order before the message field, so it can be scrolled with the arrow keys', async ({ page }) => {
      await openBoard(page)
      await beginConversation(page)
      await expect(page.getByTestId('composer-field')).toBeFocused()
      await page.keyboard.press('Shift+Tab')
      await expect(page.getByTestId('chat-log')).toBeFocused()
      await expect(page.getByTestId('chat-log')).toHaveAttribute('role', 'log')
      await page.keyboard.press('Tab')
      await expect(page.getByTestId('composer-field')).toBeFocused()
    })
  })

  test.describe('in the dark theme', () => {
    test('runs a sample live in English: the hold, the booking and the recorded email', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' })
      await openBoard(page)
      await expect(page.locator('html')).toHaveClass(/\bdark\b/)
      await page.getByTestId('run-sample-live').click()
      await expect(page.getByTestId('connection')).toHaveText('Connected')
      await page.getByTestId('script-next').click()
      await expect(page.getByTestId('hold-timer')).toContainText('left')
      await expect(slotRow(page, 'held', 'Held for you')).toHaveCount(1)
      await page.getByTestId('script-next').click()
      await expect(page.getByTestId('booking-code')).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      await expect(slotRow(page, 'booked', 'Booked for you')).toHaveCount(1)
      await expect(page.getByTestId('email-badge')).toHaveText('Recorded, never sent')
    })
  })

  for (const colorScheme of ['light', 'dark'] as const) {
    czechJourney(colorScheme)
  }
}

/** Registers the journey in Czech under a colour scheme: the same sample, live, with every word in Czech. */
function czechJourney(colorScheme: 'light' | 'dark'): void {
  test.describe(`in Czech, ${colorScheme} theme`, () => {
    test('runs a sample live in Czech, with the receipts, the hold and the recorded email in Czech', async ({ page }) => {
      await page.emulateMedia({ colorScheme })
      await openBoard(page, '/cs/systems/lb-02/board', '10 z 10')
      await expect(page.locator('html')).toHaveClass(colorScheme === 'dark' ? /\bdark\b/ : /\blight\b/)
      await page.getByRole('radio', { name: /Rezervace česky/ }).check()
      await page.getByTestId('start-sample').click()
      await expect(page.getByTestId('connection')).toHaveText('Připojeno')
      await page.getByTestId('script-next').click()
      await expect(page.getByTestId('receipt')).toContainText('Termín zablokován')
      await expect(page.getByTestId('hold-timer')).toContainText('zbývá')
      await page.getByTestId('script-next').click()
      await expect(page.getByTestId('booking-code')).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
      await expect(page.getByTestId('email-badge')).toContainText('nikdy neodesláno')
      await expect(page.locator('html')).toHaveAttribute('lang', 'cs')
    })
  })
}
