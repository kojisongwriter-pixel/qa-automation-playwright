// Evidence check (runner image build only — never part of a client run).
// Proves the image produces the evidence a real failure needs, in all four
// browsers: failure screenshots, videos (FFmpeg) and retry traces, with the same
// `use` settings as the project's playwright.config.js. Its single test fails ON
// PURPOSE against an in-memory page (no network, no application, nothing reported).

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'evidence.spec.js',
  outputDir: process.env.EVIDENCE_OUT || '/tmp/assurelayer-evidence-check',
  retries: 1,
  workers: 1,
  reporter: 'list',
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'msedge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
