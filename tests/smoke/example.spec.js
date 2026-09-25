const { test, expect } = require('../../fixtures');

test('example page loads successfully', async ({ examplePage }) => {
  await examplePage.goto();
  await expect(examplePage.page).toHaveTitle(/Playwright/);
  await expect(examplePage.heading).toBeVisible();
});
