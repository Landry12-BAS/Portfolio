// End-to-end tests for the selection guide: filtering, and opening a datasheet.
import { expect, test } from './fixtures'

test.describe('catalog', () => {
  test('lists the ten systems and filters them like a parts distributor', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveTitle('Ten live AI systems · Landry Bodjona')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('A portfolio you can operate')

    const rows = page.getByRole('region', { name: 'Systems' }).locator('tbody tr')
    await expect(rows).toHaveCount(10)

    const backend = page.getByRole('group', { name: 'Filter by back end' })
    const technique = page.getByRole('group', { name: 'Filter by technique' })

    await backend.getByRole('button', { name: 'Django' }).click()
    await expect(rows).toHaveCount(3)
    await expect(page.getByText('Showing 3 of 10 systems')).toBeVisible()
    await expect(backend.getByRole('button', { name: 'Django' })).toHaveAttribute('aria-pressed', 'true')

    await technique.getByRole('button', { name: 'Vision' }).click()
    await expect(page.getByText('No system matches both filters.')).toBeVisible()

    await page.getByRole('button', { name: 'Clear filters' }).click()
    await expect(rows).toHaveCount(10)
    await expect(page.getByRole('button', { name: 'Clear filters' })).toBeHidden()
  })

  test('on a phone, shows what each system does under its name, with no column hidden to the side', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    const region = page.getByRole('region', { name: 'Systems' })

    await expect(region.getByRole('columnheader')).toHaveText(['Part', 'System'])
    const first = region.locator('tbody tr').first()
    await expect(first).toContainText('Files a ticket, then approves the cited reply')
    await expect(first).toContainText('Django · RAG · Tool use · Citations')
    expect(await region.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
  })

  test('on a desktop, keeps all six columns', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('region', { name: 'Systems' }).getByRole('columnheader')).toHaveText([
      'Part', 'System', 'What a visitor does', 'Back end', 'Techniques', 'Phase',
    ])
  })

  test('opens a datasheet from its part number', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'LB-05', exact: true }).first().click()
    await expect(page).toHaveURL(/\/systems\/lb-05$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Data Analyst')
  })
})
