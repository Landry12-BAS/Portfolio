// End-to-end tests for datasheet pages: reading modes, the pager, and a real 404.
import { expect, test } from './fixtures'

test.describe('datasheet', () => {
  test('shows the technical sheet, then the 30-second brief, and remembers the choice', async ({ page }) => {
    await page.goto('/systems/lb-01')
    await expect(page).toHaveTitle('LB-01 Support Desk Agent · Landry Bodjona')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Support Desk Agent')
    await expect(page.getByRole('heading', { name: 'Signal chain' })).toBeVisible()
    await expect(page.getByRole('table', { name: 'Table 1. Operating limits' })).toContainText('Tickets per visitor per day')
    // What LB-01's recordings measured: the first figure times the torn-bag run step by step, and the
    // second table has a row per curated sample, with the one injection attempt handed to a person.
    const figure = page.getByRole('figure', { name: 'Figure 1. Time per step' })
    await expect(figure).toContainText('rerank')
    await expect(figure).toContainText('6.1 s')
    const measured = page.getByRole('table', { name: 'Table 2. Measured characteristics' })
    await expect(measured.getByRole('row')).toHaveCount(9)
    await expect(measured.getByRole('row', { name: /Injection attempt/ })).toContainText('Handed to a person: injection attempt')
    await expect(page.getByText(/^Measured on October 7, 2026 on a development machine/)).toBeVisible()

    const modes = page.getByRole('group', { name: 'Reading mode' })
    await modes.getByRole('button', { name: 'Brief' }).click()
    await expect(page.getByRole('heading', { name: 'Signal chain' })).toBeHidden()
    await expect(page.getByRole('table', { name: 'Table 2. Measured characteristics' })).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Problem' })).toBeVisible()

    await page.reload()
    await expect(modes.getByRole('button', { name: 'Brief' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('heading', { name: 'Signal chain' })).toBeHidden()
  })

  test('opens the evaluation board from the top of the sheet, before anything else to read', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/systems/lb-06')
    const action = page.getByRole('link', { name: 'Open the evaluation board' }).first()
    await expect(action).toBeInViewport()
    const actionTop = (await action.boundingBox())!.y
    const modesTop = (await page.getByRole('group', { name: 'Reading mode' }).boundingBox())!.y
    expect(actionTop).toBeLessThan(modesTop)

    await action.click()
    await expect(page).toHaveURL(/\/systems\/lb-06\/board$/)
  })

  test('steps to the next part', async ({ page }) => {
    await page.goto('/systems/lb-01')
    await page.getByRole('navigation', { name: 'Other parts' }).getByRole('link', { name: /LB-02 Booking Concierge/ }).click()
    await expect(page).toHaveURL(/\/systems\/lb-02$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Booking Concierge')
  })

  test('answers an unknown part with a 404 page', async ({ page }) => {
    const response = await page.goto('/systems/lb-99')
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Part not found')
    await page.getByRole('button', { name: 'Back to the catalog' }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('A portfolio you can operate')
  })
})
