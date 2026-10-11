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

// Browser projects (closed list, canonical order) — the same four ids the
// AssureLayer dashboard stores and dispatches. Each is a Playwright project:
//   chrome  branded Google Chrome (channel "chrome")
//   msedge  branded Microsoft Edge (channel "msedge")
//   firefox Playwright's Firefox
//   webkit  Playwright's WebKit (Safari's engine — not Safari on an Apple device)
const BROWSERS = ['chrome', 'msedge', 'firefox', 'webkit'];

// UI tests run once per selected browser; API tests (tests/api/**) run once,
// browser-independent, in the `api` project. Matched against the absolute path.
const API_TESTS = /[\\/]tests[\\/]api[\\/]/;

/**
 * The browser selection for a dispatched run. Empty/absent = all four (the
 * AssureLayer default). Otherwise a comma-separated list: every id must be in
 * BROWSERS, no duplicates, nothing empty. Returned in canonical order. Anything
 * else THROWS — a run never silently falls back to a different browser set.
 */
function parseBrowserSelection(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [...BROWSERS];
  const ids = String(raw).split(',').map((s) => s.trim());
  for (const id of ids) {
    if (!BROWSERS.includes(id)) {
      throw new Error(`Unsupported browser "${id.slice(0, 40)}". Allowed: ${BROWSERS.join(', ')}`);
    }
  }
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate browser in the selection.');
  return BROWSERS.filter((b) => ids.includes(b));
}

function resolveScope(environment, suite, browsers) {
  if (!ENVIRONMENTS.includes(environment)) {
    throw new Error(`Unsupported environment "${String(environment).slice(0, 40)}". Allowed: ${ENVIRONMENTS.join(', ')}`);
  }
  if (!Object.prototype.hasOwnProperty.call(SUITE_DIRS, suite)) {
    throw new Error(`Unsupported suite "${String(suite).slice(0, 40)}". Allowed: ${SUITES.join(', ')}`);
  }
  return { environment, suite, testDir: SUITE_DIRS[suite], browsers: parseBrowserSelection(browsers) };
}

function suiteTestDir(suite) {
  if (!Object.prototype.hasOwnProperty.call(SUITE_DIRS, suite)) {
    throw new Error(`Unsupported suite "${String(suite).slice(0, 40)}". Allowed: ${SUITES.join(', ')}`);
  }
  return SUITE_DIRS[suite];
}

module.exports = { ENVIRONMENTS, SUITES, SUITE_DIRS, BROWSERS, API_TESTS, parseBrowserSelection, resolveScope, suiteTestDir };
