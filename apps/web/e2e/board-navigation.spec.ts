// Board permissions arrive in HTTP headers, so entering or leaving a board must load a document.
import { expect, test } from './fixtures'

for (const prefix of ['', '/cs']) {
  test(`${prefix || '/'} loads the board's document policy and restores the datasheet's policy`, async ({ page }) => {
    const datasheet = `${prefix}/systems/lb-01`
    const board = `${datasheet}/board`
    await page.goto(datasheet)
    const open = prefix ? 'Otevřít vývojovou desku' : 'Open the evaluation board'
    const [document] = await Promise.all([
      page.waitForResponse(response => response.request().isNavigationRequest() && new URL(response.url()).pathname === board),
      page.getByRole('link', { name: open }).first().click(),
    ])
    expect(document.headers()['content-security-policy']).toContain('trusted-types vue lb-turnstile')
    expect(document.headers()['content-security-policy']).toContain('frame-src https://challenges.cloudflare.com')
    await expect(page.getByRole('heading', { name: /^LB-01 / })).toBeVisible()

    const back = prefix ? 'Zpět na katalogový list' : 'Back to the datasheet'
    const [returned] = await Promise.all([
      page.waitForResponse(response => response.request().isNavigationRequest() && new URL(response.url()).pathname === datasheet),
      page.getByRole('link', { name: back, exact: true }).click(),
    ])
    expect(returned.headers()['content-security-policy']).not.toContain('lb-turnstile')
    expect(returned.headers()['content-security-policy']).not.toContain('challenges.cloudflare.com')
  })
}
