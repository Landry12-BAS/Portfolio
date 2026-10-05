// End-to-end layout checks at phone width: nothing may push the page sideways, in either
// language, once the theme switch has rendered.
import { expect, test } from './fixtures'

for (const path of ['/', '/cs', '/systems/lb-06', '/cs/systems/lb-06']) {
  test(`${path} fits a 360-pixel screen without sideways scrolling`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto(path)
    // The theme switch renders in the browser only; measure once it is there.
    await expect(page.getByRole('group', { name: /^(Theme|Motiv)$/ })).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBe(0)
    // The wordmark is hidden from sight here, but the home link keeps its name.
    await expect(page.getByRole('link', { name: 'Landry Bodjona', exact: true })).toBeVisible()
  })
}

// WCAG 2.2, 2.4.11 (Focus Not Obscured): the toolbar sticks to the top, so an element that takes the focus from far
// below (Shift+Tab, or a player after a result) must scroll to just under it and not behind it.
test('an element that takes the focus from far below lands under the sticky toolbar, not behind it', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 })
  await page.goto('/systems/lb-06')
  await expect(page.getByRole('group', { name: /^(Theme|Motiv)$/ })).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))

  const target = page.getByRole('main').getByRole('link').first()
  await target.focus()

  const targetTop = await target.evaluate(element => element.getBoundingClientRect().top)
  const toolbarBottom = await page.locator('.toolbar').evaluate(element => element.getBoundingClientRect().bottom)
  expect(targetTop).toBeGreaterThanOrEqual(toolbarBottom)
})
