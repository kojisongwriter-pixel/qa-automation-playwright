// @ts-check
const { defineConfig, devices } = require('@playwright/test');
const config = require('./config/environments');

// AssureLayer-dispatched executions (workflow_dispatch with an assurelayer_run_id)
// additionally emit per-test outcomes and qa-platform-core Failure Contracts so the
// results callback can report them. Push / pull_request runs never set this, so
// their reporters and behavior are exactly as before.
const assurelayerRun = !!process.env.ASSURELAYER_RUN_ID;

// A dispatched scope (resolve-scope.js exported ASSURELAYER_SUITE / ASSURELAYER_BROWSERS):
// an AssureLayer run, or an operator's manual cross-browser dispatch.
const dispatched = assurelayerRun || !!process.env.ASSURELAYER_SUITE;

// For a dispatched run the SUITE selects which tests execute (ASSURELAYER_SUITE is
// validated and exported by scripts/assurelayer/resolve-scope.js). An invalid or
// missing suite throws here, so a run can never silently fall back to a different
// scope than the one that was requested. Push / pull_request runs keep './tests'.
const { suiteTestDir, parseBrowserSelection, API_TESTS } = require('./scripts/assurelayer/scope');
const testDir = dispatched ? suiteTestDir(process.env.ASSURELAYER_SUITE) : './tests';

// The four supported browser projects. Branded Chrome and Edge are selected by
// their Playwright CHANNEL (a device descriptor alone would be bundled Chromium).
const BROWSER_USE = {
  chrome: { ...devices['Desktop Chrome'], channel: 'chrome' },
  msedge: { ...devices['Desktop Edge'], channel: 'msedge' },
  firefox: { ...devices['Desktop Firefox'] },
  // Playwright's WebKit: Safari's engine — not Safari on an Apple device.
  webkit: { ...devices['Desktop Safari'] },
};

// Dispatched runs: exactly the selected browsers (ASSURELAYER_BROWSERS, validated —
// an invalid value throws; absent = all four) for UI tests, plus ONE browser-
// independent `api` project for tests/api/** (API tests never repeat per browser).
// Push / pull_request runs keep the original single bundled-Chromium project.
const projects = dispatched
  ? [
      ...parseBrowserSelection(process.env.ASSURELAYER_BROWSERS).map((name) => ({ name, testIgnore: API_TESTS, use: BROWSER_USE[name] })),
      { name: 'api', testMatch: API_TESTS, use: {} },
    ]
  : [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }];

module.exports = defineConfig({
  testDir,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,

  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    // Dispatched runs also list every test with its browser project in the job log.
    ...(dispatched ? [['list']] : []),
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

  projects,
});
