// Browser matrix (client side): closed browser allowlist, default selection,
// installation arguments, Playwright project configuration, workflow structure,
// and per-browser identity in the reporter output and callback payload.
// Offline: real Playwright runs of the browserless fixture project, static
// assertions over the workflow, no browser launched, no network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BROWSERS, parseBrowserSelection } = require('./scope');
const { installArgs } = require('./install-browsers');
const { buildPayload } = require('./buildPayload');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_CONFIG = path.join(__dirname, 'fixture-project', 'playwright.config.js');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');

function stepBlock(name) {
  const start = WORKFLOW.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" exists`);
  const next = WORKFLOW.indexOf('\n      - name:', start + 1);
  return WORKFLOW.slice(start, next === -1 ? undefined : next);
}

function runResolveScope(env) {
  const githubEnv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'assurelayer-ghenv-')), 'GITHUB_ENV');
  fs.writeFileSync(githubEnv, '');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'resolve-scope.js')], { env: { PATH: process.env.PATH, GITHUB_ENV: githubEnv, ...env }, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, exported: fs.readFileSync(githubEnv, 'utf8') };
}

function loadConfig(env) {
  const r = spawnSync(
    process.execPath,
    ['-e', "const c=require('./playwright.config.js');console.log(JSON.stringify(c.projects.map((p)=>({name:p.name,channel:p.use&&p.use.channel||null,browser:p.use&&p.use.defaultBrowserType||null,api:!!p.testMatch,ignoresApi:!!p.testIgnore}))))"],
    { cwd: ROOT, env: { PATH: process.env.PATH, ENV: 'staging', ...env }, encoding: 'utf8' }
  );
  return { status: r.status, stderr: r.stderr, projects: r.status === 0 ? JSON.parse(r.stdout) : null };
}

// ---- Selection ----------------------------------------------------------------

test('the closed browser list is chrome, msedge, firefox, webkit; an empty selection means all four', () => {
  assert.deepEqual(BROWSERS, ['chrome', 'msedge', 'firefox', 'webkit']);
  for (const empty of [undefined, null, '', '   ']) assert.deepEqual(parseBrowserSelection(empty), BROWSERS);
});

test('a subset is accepted and normalized to canonical order; invalid, duplicate or empty entries throw', () => {
  assert.deepEqual(parseBrowserSelection('webkit,chrome'), ['chrome', 'webkit']);
  assert.deepEqual(parseBrowserSelection(' firefox '), ['firefox']);
  for (const bad of ['chromium', 'chrome,chrome', 'chrome,,firefox', 'chrome;rm -rf /', 'CHROME', 'safari', ',']) {
    assert.throws(() => parseBrowserSelection(bad), Error, `rejects ${JSON.stringify(bad)}`);
  }
});

test('resolve-scope exports the validated selection, defaults to all four, and rejects invalid input before anything runs', () => {
  const subset = runResolveScope({ ASSURELAYER_ENVIRONMENT: 'staging', ASSURELAYER_SUITE_INPUT: 'smoke', ASSURELAYER_BROWSERS_INPUT: 'firefox,chrome' });
  assert.equal(subset.status, 0, subset.stderr);
  assert.equal(subset.exported, 'ENV=staging\nASSURELAYER_SUITE=smoke\nASSURELAYER_BROWSERS=chrome,firefox\n');
  const all = runResolveScope({ ASSURELAYER_ENVIRONMENT: 'staging', ASSURELAYER_SUITE_INPUT: 'smoke' });
  assert.match(all.exported, /ASSURELAYER_BROWSERS=chrome,msedge,firefox,webkit\n$/);
  for (const bad of ['opera', 'chrome,chrome', 'chrome,']) {
    const r = runResolveScope({ ASSURELAYER_ENVIRONMENT: 'staging', ASSURELAYER_SUITE_INPUT: 'smoke', ASSURELAYER_BROWSERS_INPUT: bad });
    assert.equal(r.status, 1, `exit 1 for ${bad}`);
    assert.equal(r.exported, '', 'nothing exported: no browser set, no fallback');
  }
});

// ---- Installation -----------------------------------------------------------------

test('installation arguments: exactly the selected browsers, branded Chrome/Edge installed explicitly, no shell', () => {
  assert.deepEqual(installArgs(''), ['install', '--with-deps', '--force', 'chrome', 'msedge', 'firefox', 'webkit']);
  assert.deepEqual(installArgs('firefox,webkit'), ['install', '--with-deps', 'firefox', 'webkit'], 'no unnecessary downloads for a subset');
  assert.deepEqual(installArgs('msedge'), ['install', '--with-deps', '--force', 'msedge']);
  assert.throws(() => installArgs('chromium'));
  const src = fs.readFileSync(path.join(__dirname, 'install-browsers.js'), 'utf8');
  assert.match(src, /spawnSync\(process\.execPath, \[cli, \.\.\.args\]/, 'argument array, never a shell string');
  assert.doesNotMatch(src, /shell:\s*true|execSync\(|exec\(/);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'install-browsers.js')], { env: { PATH: process.env.PATH, ASSURELAYER_BROWSERS: 'opera' }, encoding: 'utf8' });
  assert.equal(r.status, 1, 'an invalid selection fails before installing anything');
});

// ---- Playwright projects ------------------------------------------------------------

test('dispatched runs get exactly the selected browser projects (branded channels for Chrome/Edge) plus one browser-independent api project', () => {
  const all = loadConfig({ ASSURELAYER_RUN_ID: 'r', ASSURELAYER_SUITE: 'smoke' });
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(all.projects, [
    { name: 'chrome', channel: 'chrome', browser: 'chromium', api: false, ignoresApi: true },
    { name: 'msedge', channel: 'msedge', browser: 'chromium', api: false, ignoresApi: true },
    { name: 'firefox', channel: null, browser: 'firefox', api: false, ignoresApi: true },
    { name: 'webkit', channel: null, browser: 'webkit', api: false, ignoresApi: true },
    { name: 'api', channel: null, browser: null, api: true, ignoresApi: false },
  ]);
  const subset = loadConfig({ ASSURELAYER_RUN_ID: 'r', ASSURELAYER_SUITE: 'smoke', ASSURELAYER_BROWSERS: 'webkit,firefox' });
  assert.deepEqual(subset.projects.map((p) => p.name), ['firefox', 'webkit', 'api'], 'a subset runs precisely that subset');
  assert.notEqual(loadConfig({ ASSURELAYER_RUN_ID: 'r', ASSURELAYER_SUITE: 'smoke', ASSURELAYER_BROWSERS: 'chromium' }).status, 0, 'an invalid selection throws — never a silent fallback');
  const push = loadConfig({});
  assert.deepEqual(push.projects, [{ name: 'chromium', channel: null, browser: 'chromium', api: false, ignoresApi: false }], 'push / pull_request keep the single bundled-Chromium project');
});

test('API tests are excluded from browser projects and matched once by the api project', () => {
  const { API_TESTS } = require('./scope');
  assert.ok(API_TESTS.test(path.join(ROOT, 'tests', 'api', 'orders.spec.js')));
  assert.ok(!API_TESTS.test(path.join(ROOT, 'tests', 'smoke', 'example.spec.js')));
});

// ---- Workflow -------------------------------------------------------------------------

test('workflow: optional `browsers` string input; selected-browser install runs between scope resolution and tests; inputs only via env', () => {
  assert.match(WORKFLOW, /\n {6}browsers:\n {8}description: [^\n]+\n {8}required: false\n {8}type: string\n/);
  const install = stepBlock('Install selected browsers');
  assert.match(install, /run: node scripts\/assurelayer\/install-browsers\.js/);
  assert.doesNotMatch(install, /inputs\.browsers \}\}\s*$/m, 'the selection reaches the installer via ASSURELAYER_BROWSERS, not interpolation');
  const pushInstall = stepBlock('Install Playwright browsers');
  assert.match(pushInstall, /run: npx playwright install --with-deps chromium/, 'push / pull_request install unchanged');
  for (const step of WORKFLOW.split('\n      - name:').slice(1)) {
    const run = step.match(/\n\s+run: (.*)/);
    if (run) assert.ok(!/\$\{\{/.test(run[1]), `a run: command contains an expression: ${run[1]}`);
  }
});

// ---- Reporter + payload: one result per test per browser ----------------------------------

test('the reporter records every test once per browser with that browser and a shared logical test key; the payload carries them', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'assurelayer-browsers-'));
  const run = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '-c', FIXTURE_CONFIG], {
    cwd,
    env: { ...process.env, ASSURELAYER_RUN_ID: 'fixture-run', CI: '1', ENV: 'staging', ASSURELAYER_SUITE: 'smoke', ASSURELAYER_BROWSERS: 'chrome,firefox' },
    encoding: 'utf8',
  });
  assert.notEqual(run.status, 0, 'the fixture fails one test by design');
  const { results } = JSON.parse(fs.readFileSync(path.join(cwd, 'test-results', 'assurelayer', 'results.json'), 'utf8'));
  const passes = results.filter((r) => r.title === 'passes');
  assert.deepEqual(passes.map((r) => r.browserProject).sort(), ['chrome', 'firefox'], 'one result per selected browser');
  assert.equal(new Set(passes.map((r) => r.testKey)).size, 1, 'same logical test on both browsers');
  assert.equal(new Set(passes.map((r) => r.testId)).size, 2, 'distinct executions (Playwright ids differ per project)');
  assert.equal(new Set(results.map((r) => `${r.browserProject}|${r.testKey}`)).size, results.length, 'no test/browser pair twice');

  const { payload, problems } = buildPayload({ resultsFile: path.join(cwd, 'test-results', 'assurelayer', 'results.json'), failuresDir: path.join(cwd, 'test-results', 'failures'), playwrightOutcome: 'failure' });
  assert.deepEqual(problems, []);
  const failed = payload.results.filter((r) => r.status === 'failed');
  assert.deepEqual(failed.map((r) => r.browser_project).sort(), ['chrome', 'firefox'], 'the failing test failed on each browser, recorded separately');
  for (const f of failed) assert.equal(f.failure.source.browser, f.browser_project, 'the Failure Contract names the same browser');
  for (const r of payload.results) assert.ok(BROWSERS.includes(r.browser_project) && /^[0-9a-f]{40}$/.test(r.test_key));
});
