// End-to-end tests of LB-02's evaluation board, in a real browser against the test build of the site and
// the mock back end (its HTTP routes and its WebSocket). The journeys (a sample run live, the double-booking
// attempt from a second tab, a dropped connection, a handoff, the message limit, replays, the keyboard,
// Czech), the installable app (manifest, service worker, offline, what is cached) and the accessibility of
// every state, in both languages and both themes. Every test also fails on a CSP or Trusted Types violation,
// a page error or a console error (e2e/fixtures.ts). The Turnstile check is the test build's stand-in.
//
// The calendar is one for everyone, so these tests run one after another and each starts from a calendar
// nobody has touched (the mock's reset control); no other file uses LB-02's mock.
import { test } from './fixtures'
import { accessibility } from './lb02/a11y'
import { installableApp } from './lb02/app'
import { journeys } from './lb02/journeys'
import { control } from './lb02/support'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await control(page, 'reset')
  await control(page, 'limits', { messagesPerConversation: 30, thinkMs: 0 })
})

journeys()
installableApp()
accessibility()
