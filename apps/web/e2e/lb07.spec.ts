// End-to-end tests of LB-07's evaluation board, in a real browser against the test build of the site and the
// mock back end: the journeys (e2e/lb07/journeys.ts: a replay, a live run to the report and the test, a re-plan,
// the visitor's own goal and bugs, the queue, the busy browser, the day's runs, failures and refusals, the code
// view, the visitor's runs of the hour, the Brief reading, the keyboard, both languages) and the accessibility
// of every state (e2e/lb07/a11y.ts: axe, WCAG 2.2 AA, both languages and both themes). Every test also fails on
// a CSP or Trusted Types violation, a page error or a console error (e2e/fixtures.ts). The Turnstile check is
// the test build's stand-in.
//
// The one browser and its queue are one for every visitor, as on the real service, so these tests run one
// after another and each starts from a queue nobody holds and no run made (the mock's reset control); no other
// file uses LB-07's mock. A run on the mock takes several seconds, so a test may take up to a minute.
import { test } from './fixtures'
import { accessibility } from './lb07/a11y'
import { journeys } from './lb07/journeys'
import { control } from './lb07/support'

test.describe.configure({ mode: 'serial', timeout: 60_000 })

test.beforeEach(async ({ page }) => {
  await control(page, 'reset')
})

journeys()
accessibility()
