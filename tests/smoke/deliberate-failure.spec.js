const { test, expect } = require('../../fixtures');

// DELIBERATE FAILURE — exists only to exercise AssureLayer's failure path
// (FailureReporter -> Decision Engine -> Grounded QA Analyst -> Release Gate)
// end to end. It is expected to fail on every run; remove it once that path
// has been verified.
//
// A plain value assertion (not the auto-retrying toHaveTitle) is used on
// purpose: it fails immediately and deterministically, and its message
// ("expect(received).toBe(expected)") carries no locator call log, so
// FailureReporter tags it as an assertion_failure rather than a selector one.
// navigate() (the 'load' event) is used instead of goto(), whose extra
// 'networkidle' wait can exceed the test timeout and turn this into a
// timeout_failure instead of the intended assertion failure.
test('deliberate failure: page title matches an intentionally wrong value', async ({ examplePage }) => {
  await examplePage.navigate('/');
  expect(await examplePage.page.title()).toBe('AssureLayer deliberate failure-path check');
});
