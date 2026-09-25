const { baseTest, expect } = require('@kojisongwriter-pixel/qa-platform-core');
const { ExamplePage } = require('../pages/ExamplePage');

const test = baseTest.extend({
  examplePage: async ({ page }, use) => {
    await use(new ExamplePage(page));
  },
});

module.exports = { test, expect };
