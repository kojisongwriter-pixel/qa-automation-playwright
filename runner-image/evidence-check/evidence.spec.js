// Fails ON PURPOSE (see playwright.config.js in this folder): an in-memory page,
// an assertion that cannot pass, so every browser records its failure evidence.
const { test, expect } = require('@playwright/test');

test('evidence capture (expected to fail)', async ({ page }) => {
  await page.setContent('<main><h1>AssureLayer evidence check</h1></main>');
  await expect(page.locator('h1')).toHaveText('text that is never on the page', { timeout: 1000 });
});
