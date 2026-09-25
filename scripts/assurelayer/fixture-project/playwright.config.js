// Offline fixture project used ONLY by scripts/assurelayer/assurelayer.test.js.
// It mirrors how the real playwright.config.js selects the test directory from
// ASSURELAYER_SUITE (through the SAME scripts/assurelayer/scope.js mapping) and
// enables the AssureLayer reporters, but its tests need no browser and no network.
const path = require('path');
const { defineConfig } = require('@playwright/test');
const { suiteTestDir } = require('../scope');

module.exports = defineConfig({
  testDir: path.resolve(__dirname, suiteTestDir(process.env.ASSURELAYER_SUITE || 'full')),
  testMatch: '**/*.spec.js',
  retries: 1,
  workers: 1,
  outputDir: 'test-results/',
  reporter: [
    ['list'],
    [path.resolve(__dirname, '../../../reporters/assurelayer-results-reporter.js')],
    ['@kojisongwriter-pixel/qa-platform-core/src/reporter/failureReporter'],
  ],
});
