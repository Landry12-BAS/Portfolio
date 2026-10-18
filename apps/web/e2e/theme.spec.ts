// End-to-end tests for the themes: following the system setting, a pinned choice that survives a
// reload, and a board's marks that must still stand out on the dark theme's tint and sheet.
import type { Page } from '@playwright/test'

import { expect, test } from './fixtures'

/** Finds the toolbar's logo image for one theme. */
const logo = (page: Page, theme: 'light' | 'dark') => page.locator(`header img.lb-logo__img--${theme}`)

/** Gives the relative luminance of a colour the browser computed, `rgb(r, g, b)`, as WCAG defines it. */
function luminance(color: string): number {
  const [red, green, blue] = (color.match(/\d+/g) ?? []).slice(0, 3).map((value) => {
    const channel = Number(value) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0)
}

/** Gives the contrast ratio of two computed colours, as WCAG defines it. */
function contrast(one: string, two: string): number {
  const [lighter, darker] = [luminance(one), luminance(two)].sort((a, b) => b - a)
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05)
}

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

  test('draws a board\'s marks so they stand out in the dark theme: the allowance meter\'s fill and the chosen sample', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/systems/lb-01/board')
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await expect(page.getByTestId('quota')).toBeVisible()
    const fill = await page.locator('.meter .fill').evaluate(element => getComputedStyle(element).backgroundColor)
    const track = await page.locator('.meter').evaluate(element => getComputedStyle(element).backgroundColor)
    const chosen = page.getByTestId('sample-picker').locator('.card.chosen')
    const card = await chosen.evaluate(element => getComputedStyle(element).backgroundColor)
    const border = await chosen.evaluate(element => getComputedStyle(element).borderTopColor)
    const radio = await chosen.locator('.radio').evaluate(element => getComputedStyle(element).accentColor)
    expect(contrast(fill, track), 'the meter\'s fill on its track').toBeGreaterThanOrEqual(3)
    expect(contrast(radio, card), 'the chosen radio on its card').toBeGreaterThanOrEqual(3)
    expect(contrast(border, card), 'the chosen card\'s border on the card').toBeGreaterThanOrEqual(3)
  })
})
