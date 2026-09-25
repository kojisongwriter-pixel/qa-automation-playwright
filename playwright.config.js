// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const config = require('./config/environments');

// AssureLayer-dispatched executions (workflow_dispatch with an assurelayer_run_id)
// additionally emit per-test outcomes and qa-platform-core Failure Contracts so the
// results callback can report them. Push / pull_request runs never set this, so
// their reporters and behavior are exactly as before.
const assurelayerRun = !!process.env.ASSURELAYER_RUN_ID;

// For an AssureLayer-dispatched run the SUITE selects which tests execute
// (ASSURELAYER_SUITE is validated and exported by scripts/assurelayer/resolve-scope.js).
// An invalid or missing suite throws here, so a run can never silently fall back
// to a different scope than the one that was requested. Push / pull_request runs
// keep the original './tests'.
const { suiteTestDir } = require('./scripts/assurelayer/scope');
const testDir = assurelayerRun ? suiteTestDir(process.env.ASSURELAYER_SUITE) : './tests';

module.exports = defineConfig({
  testDir,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ...(assurelayerRun
      ? [
          ['./reporters/assurelayer-results-reporter.js'],
          ['@kojisongwriter-pixel/qa-platform-core/src/reporter/failureReporter'],
        ]
      : []),
  ],

  use: {
    baseURL: config.baseURL,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },

  outputDir: 'test-results/',

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
