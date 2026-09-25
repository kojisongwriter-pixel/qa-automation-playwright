#!/usr/bin/env node
// Resolves the AssureLayer-dispatched execution scope and exports it to the
// remaining workflow steps through $GITHUB_ENV:
//
//   ENV                 -> config/environments.js selects the target URL, and
//                          qa-platform-core's FailureReporter stamps it into
//                          every Failure Contract as `environment`
//   ASSURELAYER_SUITE   -> playwright.config.js selects the test directory
//
// The inputs arrive ONLY as environment variables (never spliced into a shell
// command) and are validated against closed allow-lists first. An invalid or
// missing value fails the step BEFORE any test runs.

const fs = require('fs');
const { resolveScope } = require('./scope');

function main(env = process.env) {
  const environment = env.ASSURELAYER_ENVIRONMENT;
  const suite = env.ASSURELAYER_SUITE_INPUT;

  let scope;
  try {
    scope = resolveScope(environment, suite);
  } catch (error) {
    console.error(`assurelayer resolve-scope: ${error.message}`);
    return 1;
  }

  if (!env.GITHUB_ENV) {
    console.error('assurelayer resolve-scope: GITHUB_ENV is not set');
    return 2;
  }
  fs.appendFileSync(env.GITHUB_ENV, `ENV=${scope.environment}\nASSURELAYER_SUITE=${scope.suite}\n`);
  console.log(`assurelayer resolve-scope: environment=${scope.environment} suite=${scope.suite} testDir=${scope.testDir}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main };
