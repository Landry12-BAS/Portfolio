// End-to-end tests for the two languages: Czech pages at /cs, the page language and
// hreflang links, the language switch, and links that stay in the visitor's language.
import { expect, pressUntilPressed, test } from './fixtures'

test.describe('languages', () => {
  test('serves Czech at /cs, marked as Czech for browsers and search engines', async ({ page }) => {
    await page.goto('/cs')
    await expect(page.locator('html')).toHaveAttribute('lang', 'cs')
    await expect(page).toHaveTitle('Deset živých AI systémů · Landry Bodjona')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Portfolio, které si můžete vyzkoušet')
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /^Deset živých AI systémů/)

    // Each page links to its twin in the other language, and to a default for everyone else.
    await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute('href', /^https?:\/\/[^/]+\/?$/)
    await expect(page.locator('link[rel="alternate"][hreflang="cs"]')).toHaveAttribute('href', /\/cs$/)
    await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveCount(1)
  })

  test('keeps English as the default at /', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    const languages = page.getByRole('navigation', { name: 'Language' })
    await expect(languages.getByRole('link', { name: 'EN English' })).toHaveAttribute('aria-current', 'true')
  })

  test('switches a datasheet to Czech and back, staying on the same part', async ({ page }) => {
    await page.goto('/systems/lb-01')
    await page.getByRole('navigation', { name: 'Language' }).getByRole('link', { name: 'CZ Čeština' }).click()
    await expect(page).toHaveURL(/\/cs\/systems\/lb-01$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agent zákaznické podpory')
    await expect(page.getByRole('heading', { name: 'Signálový řetězec' })).toBeVisible()
    await expect(page.getByRole('table')).toContainText('Požadavků na návštěvníka za den')

    await page.getByRole('navigation', { name: 'Jazyk' }).getByRole('link', { name: 'EN English' }).click()
    await expect(page).toHaveURL(/\/systems\/lb-01$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Support Desk Agent')
  })

  test('filters the catalog in Czech and keeps its links in Czech', async ({ page }) => {
    await page.goto('/cs')
    const backend = page.getByRole('group', { name: 'Filtrovat podle backendu' })
    // The first press may land before hydration; see pressUntilPressed.
    await pressUntilPressed(backend.getByRole('button', { name: 'Django' }))
    await expect(page.getByText('Zobrazeno 3 z 10 systémů')).toBeVisible()

    await page.getByRole('region', { name: 'Systémy' }).getByRole('link', { name: 'LB-09', exact: true }).click()
    await expect(page).toHaveURL(/\/cs\/systems\/lb-09$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Záznamník schůzek')
  })

  test('keeps single-letter Czech words off the end of a line', async ({ page }) => {
    await page.goto('/cs/systems/lb-06')
    // Playwright's text matching treats a non-breaking space as a space, so read the raw text.
    const text = await page.locator('main').evaluate(element => element.textContent ?? '')
    expect(text).toContain('návrat k\u00A0předchozí verzi')
    expect(text).not.toContain('návrat k předchozí')
  })

  test('answers an unknown part in Czech with a 404, and goes back to the Czech catalog', async ({ page }) => {
    const response = await page.goto('/cs/systems/lb-99')
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Díl nenalezen')
    await page.getByRole('button', { name: 'Zpět do katalogu' }).click()
    await expect(page).toHaveURL(/\/cs$/)
  })

  test('names the theme switch in Czech', async ({ page }) => {
    await page.goto('/cs')
    const theme = page.getByRole('group', { name: 'Motiv' })
    await theme.getByRole('button', { name: 'Tmavý motiv' }).click()
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  })
})
