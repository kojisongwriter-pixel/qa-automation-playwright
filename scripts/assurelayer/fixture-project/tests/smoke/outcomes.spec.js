const { test, expect } = require('@playwright/test');

test('passes', async () => {
  expect(1 + 1).toBe(2);
});

test('fails with an assertion', async () => {
  expect(1 + 1).toBe(3);
});

test.skip('is skipped', async () => {});

// Fails on the first attempt, passes on the retry (Playwright calls this "flaky").
test('recovers on retry', async ({}, testInfo) => {
  expect(testInfo.retry).toBeGreaterThan(0);
});
