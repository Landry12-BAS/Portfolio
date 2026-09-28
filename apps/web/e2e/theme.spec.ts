// End-to-end tests for the themes: following the system setting, and a pinned choice
// that survives a reload.
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

/** Finds the toolbar's logo image for one theme. */
const logo = (page: Page, theme: 'light' | 'dark') => page.locator(`header img.lb-logo__img--${theme}`)

test.describe('themes', () => {
  test('follows a light system setting and shows the light logo', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    await expect(page.locator('html')).toHaveClass(/\blight\b/)
    await expect(logo(page, 'light')).toBeVisible()
    await expect(logo(page, 'dark')).toBeHidden()
  })

  test('follows a dark system setting and shows the dark logo', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await expect(logo(page, 'dark')).toBeVisible()
    await expect(logo(page, 'light')).toBeHidden()
  })

  test('lets the visitor pin a theme and keeps it on the next visit', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    const theme = page.getByRole('group', { name: 'Theme' })
    await theme.getByRole('button', { name: 'Dark theme' }).click()
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await expect(logo(page, 'dark')).toBeVisible()

    await page.reload()
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await expect(theme.getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', 'true')

    await theme.getByRole('button', { name: 'Auto' }).click()
    await expect(page.locator('html')).toHaveClass(/\blight\b/)
  })
})
