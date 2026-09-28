// End-to-end accessibility checks: axe finds no WCAG 2.2 AA violation on the home page,
// a datasheet or the 404 page, in both languages and both themes.
import AxeBuilder from '@axe-core/playwright'

import { expect, test } from './fixtures'

const pages = ['/', '/systems/lb-01', '/systems/lb-99', '/cs', '/cs/systems/lb-01', '/cs/systems/lb-99']

// The class the theme script puts on <html>, matched as a whole word.
const themeClass = { light: /\blight\b/, dark: /\bdark\b/ } as const

for (const colorScheme of ['light', 'dark'] as const) {
  for (const path of pages) {
    test(`${path} meets WCAG 2.2 AA in the ${colorScheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme })
      await page.goto(path)
      await expect(page.locator('html')).toHaveClass(themeClass[colorScheme])
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()
      expect(results.violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([])
    })
  }
}
