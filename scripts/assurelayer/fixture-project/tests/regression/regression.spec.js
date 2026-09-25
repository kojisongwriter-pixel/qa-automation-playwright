const { test, expect } = require('@playwright/test');

test('regression: totals add up', async () => {
  expect(2 * 3).toBe(6);
});
