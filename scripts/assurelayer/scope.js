// Execution scope for AssureLayer-dispatched runs.
//
// AssureLayer derives `environment` and `suite` from the run's own database
// records (closed vocabularies) and sends them as workflow_dispatch inputs. This
// module is the CLIENT side of that contract:
//
//   dashboard selection = DB selection = dispatch input
//     -> ENV of this run -> Failure Contract `environment`
//     -> the Playwright test directory that actually runs
//
// The vocabularies below mirror the dashboard's (lib/runs/execution-scope.ts) and
// the workflow's `type: choice` inputs. Nothing here is ever interpolated into a
// shell command: values are validated against these allow-lists and reach the
// Playwright process only through the environment.

const ENVIRONMENTS = ['staging', 'production'];

// suite -> test directory (relative to the project root). `full` is everything.
const SUITE_DIRS = {
  smoke: './tests/smoke',
  regression: './tests/regression',
  api: './tests/api',
  full: './tests',
};

const SUITES = Object.keys(SUITE_DIRS);

function resolveScope(environment, suite) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(`Unsupported environment "${String(environment).slice(0, 40)}". Allowed: ${ENVIRONMENTS.join(', ')}`);
  }
  if (!Object.prototype.hasOwnProperty.call(SUITE_DIRS, suite)) {
    throw new Error(`Unsupported suite "${String(suite).slice(0, 40)}". Allowed: ${SUITES.join(', ')}`);
  }
  return { environment, suite, testDir: SUITE_DIRS[suite] };
}

function suiteTestDir(suite) {
  if (!Object.prototype.hasOwnProperty.call(SUITE_DIRS, suite)) {
    throw new Error(`Unsupported suite "${String(suite).slice(0, 40)}". Allowed: ${SUITES.join(', ')}`);
  }
  return SUITE_DIRS[suite];
}

module.exports = { ENVIRONMENTS, SUITES, SUITE_DIRS, resolveScope, suiteTestDir };
