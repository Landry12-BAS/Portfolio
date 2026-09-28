// End-to-end tests for datasheet pages: reading modes, the pager, and a real 404.
import { expect, test } from './fixtures'

test.describe('datasheet', () => {
  test('shows the technical sheet, then the 30-second brief, and remembers the choice', async ({ page }) => {
    await page.goto('/systems/lb-01')
    await expect(page).toHaveTitle('LB-01 Support Desk Agent · Landry Bodjona')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Support Desk Agent')
    await expect(page.getByRole('heading', { name: 'Signal chain' })).toBeVisible()
    await expect(page.getByRole('table')).toContainText('Tickets per visitor per day')

    const modes = page.getByRole('group', { name: 'Reading mode' })
    await modes.getByRole('button', { name: 'Brief' }).click()
    await expect(page.getByRole('heading', { name: 'Signal chain' })).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Problem' })).toBeVisible()

    await page.reload()
    await expect(modes.getByRole('button', { name: 'Brief' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('heading', { name: 'Signal chain' })).toBeHidden()
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
