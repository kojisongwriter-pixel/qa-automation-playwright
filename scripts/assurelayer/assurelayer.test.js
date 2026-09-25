// Client-template validation for the AssureLayer results callback (Prompt 3).
// Run with: npm run test:assurelayer      (offline: no browser, no network)
//
//  - a REAL Playwright run through qa-platform-core's FailureReporter and the
//    results collector, then payload assembly, validated by the engine's own
//    validateFailureContract
//  - the callback script against local mock OIDC + AssureLayer endpoints
//  - structural assertions over .github/workflows/ci.yml

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const { buildPayload } = require('./buildPayload');
const { validateFailureContract } = require('@kojisongwriter-pixel/qa-platform-core/src/validation/validateFailureContract');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_CONFIG = path.join(__dirname, 'fixture-project', 'playwright.config.js');
const CALLBACK_SCRIPT = path.join(ROOT, 'scripts', 'assurelayer-callback.js');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
// Structural assertions must look at YAML, not at prose inside # comments.
const WORKFLOW_CODE = WORKFLOW.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');

// Runs the offline fixture project exactly the way the workflow does after
// resolve-scope.js: ENV and ASSURELAYER_SUITE in the environment.
function runFixtureProject(scope = { ENV: 'staging', ASSURELAYER_SUITE: 'smoke' }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'assurelayer-fixture-'));
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

// One Playwright run shared by the payload tests (fails by design: one test fails).
const fixture = runFixtureProject();

test('the fixture run really failed one test (Playwright exit code preserved)', () => {
  assert.notEqual(fixture.result.status, 0, fixture.result.stdout + fixture.result.stderr);
});

test('the results collector records the FINAL outcome of every test, including skipped and retried', () => {
  const file = path.join(fixture.cwd, 'test-results', 'assurelayer', 'results.json');
  assert.ok(fs.existsSync(file), 'results.json must be written');
  const { results } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const byTitle = Object.fromEntries(results.map((r) => [r.title, r]));

  assert.equal(byTitle['passes'].status, 'passed');
  assert.equal(byTitle['fails with an assertion'].status, 'failed');
  assert.equal(byTitle['fails with an assertion'].retryCount, 1);
  assert.equal(byTitle['is skipped'].status, 'skipped', 'skipped is never reported as passed');
  assert.equal(byTitle['recovers on retry'].status, 'passed', 'flaky (passed on retry) is finally passed');
  assert.equal(byTitle['recovers on retry'].retryCount, 1);
});

test('buildPayload produces the versioned callback contract with engine-validated Failure Contracts', () => {
  const { payload, problems } = buildPayload({
    resultsFile: path.join(fixture.cwd, 'test-results', 'assurelayer', 'results.json'),
    failuresDir: path.join(fixture.cwd, 'test-results', 'failures'),
    playwrightOutcome: 'failure',
  });
  assert.deepEqual(problems, []);
  assert.equal(payload.version, '1.0.0');
  assert.equal(payload.execution_status, 'failed');
  assert.equal(payload.execution_error, null);
  assert.deepEqual(Object.keys(payload).sort(), ['execution_error', 'execution_status', 'results', 'version']);

  const statuses = payload.results.map((r) => r.status).sort();
  assert.deepEqual(statuses, ['failed', 'passed', 'passed', 'skipped']);

  const failed = payload.results.find((r) => r.status === 'failed');
  assert.deepEqual(Object.keys(failed).sort(), ['failure', 'retry_count', 'status', 'test_id', 'test_title']);
  assert.equal(validateFailureContract(failed.failure).valid, true, 'the failure is the engine Failure Contract, unmodified');
  assert.equal(failed.failure.testId, failed.test_id);
  assert.equal(failed.failure.retryCount, 1, 'the FINAL failed attempt represents the test');
  assert.equal(failed.failure.failureType, 'assertion_failure', 'classification came from FailureReporter, not this repo');

  for (const r of payload.results.filter((x) => x.status !== 'failed')) assert.equal(r.failure, null);
});

test('a failed test with no Failure Contract is reported as an execution error, never fabricated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assurelayer-nocontract-'));
  const resultsFile = path.join(dir, 'results.json');
  fs.writeFileSync(resultsFile, JSON.stringify({ results: [{ testId: 't1', title: 'x', status: 'failed', retryCount: 0 }] }));
  const { payload, problems } = buildPayload({ resultsFile, failuresDir: path.join(dir, 'none'), playwrightOutcome: 'failure' });
  assert.equal(problems.length, 1);
  assert.equal(payload.execution_status, 'error');
  assert.equal(payload.results.length, 0);
  assert.match(payload.execution_error, /No Failure Contract/);
});

test('no results file (crashed run) -> execution_status error, zero results', () => {
  const { payload } = buildPayload({ resultsFile: path.join(os.tmpdir(), 'does-not-exist.json'), failuresDir: 'x', playwrightOutcome: 'failure' });
  assert.equal(payload.execution_status, 'error');
  assert.deepEqual(payload.results, []);
});

test('Playwright outcome maps to execution_status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assurelayer-outcome-'));
  const resultsFile = path.join(dir, 'r.json');
  fs.writeFileSync(resultsFile, JSON.stringify({ results: [{ testId: 't', title: 't', status: 'passed', retryCount: 0 }] }));
  const status = (o) => buildPayload({ resultsFile, failuresDir: dir, playwrightOutcome: o }).payload.execution_status;
  assert.equal(status('success'), 'passed');
  assert.equal(status('failure'), 'failed');
  assert.equal(status('cancelled'), 'error');
  assert.equal(status(undefined), 'error');
});

// ---- callback script against local mock endpoints -------------------------

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function runCallback({ apiHandler, oidcHandler }) {
  const api = await startServer(apiHandler);
  const oidc = await startServer(oidcHandler || ((req, res) => { res.end(JSON.stringify({ value: 'FAKE.OIDC.TOKEN' })); }));

  // Reuse the fixture run's real outputs as this callback's input.
  const cwd = fixture.cwd;
  const child = spawn(process.execPath, [CALLBACK_SCRIPT], {
    cwd,
    env: {
      ...process.env,
      ASSURELAYER_RUN_ID: 'run-123',
      ASSURELAYER_API_URL: api.url,
      ASSURELAYER_OIDC_AUDIENCE: 'the-audience',
      ACTIONS_ID_TOKEN_REQUEST_URL: `${oidc.url}/token?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-request-token',
      PLAYWRIGHT_OUTCOME: 'failure',
      ASSURELAYER_RETRY_DELAYS_MS: '10,10,10',
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

test('the callback requests a fresh OIDC token for the AssureLayer audience and POSTs the batch with it', async () => {
  const seen = { oidc: [], api: [] };
  const oidcHandler = (req, res) => {
    seen.oidc.push({ url: req.url, auth: req.headers.authorization });
    res.end(JSON.stringify({ value: 'FAKE.OIDC.TOKEN' }));
  };
  const apiHandler = (req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.api.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.statusCode = 200;
      res.end(JSON.stringify({ run: { status: 'failed' } }));
    });
  };
  const { code, out } = await runCallback({ apiHandler, oidcHandler });

  assert.equal(code, 0, out);
  assert.equal(seen.oidc.length, 1);
  assert.match(seen.oidc[0].url, /audience=the-audience/);
  assert.equal(seen.oidc[0].auth, 'bearer runtime-request-token');
  assert.equal(seen.api.length, 1);
  assert.equal(seen.api[0].method, 'POST');
  assert.equal(seen.api[0].url, '/api/runs/run-123/results');
  assert.equal(seen.api[0].auth, 'Bearer FAKE.OIDC.TOKEN');
  assert.equal(seen.api[0].body.version, '1.0.0');
  assert.equal(seen.api[0].body.results.length, 4);
  // The token is only ever announced to GitHub's masking mechanism, never echoed elsewhere.
  assert.ok(out.includes('::add-mask::FAKE.OIDC.TOKEN'));
  assert.equal(out.split('FAKE.OIDC.TOKEN').length - 1, 1, 'token appears only in the add-mask directive');
});

test('transient 5xx responses are retried (with a fresh token) and then succeed', async () => {
  let calls = 0;
  const apiHandler = (req, res) => {
    calls += 1;
    req.resume();
    req.on('end', () => {
      res.statusCode = calls < 3 ? 503 : 200;
      res.end('{}');
    });
  };
  const { code } = await runCallback({ apiHandler });
  assert.equal(code, 0);
  assert.equal(calls, 3);
});

test('a definitive 4xx (e.g. identity/conflict rejection) is NOT retried and fails the step', async () => {
  let calls = 0;
  const apiHandler = (req, res) => {
    calls += 1;
    req.resume();
    req.on('end', () => {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: { code: 'wrong_run_id' } }));
    });
  };
  const { code, out } = await runCallback({ apiHandler });
  assert.equal(code, 1);
  assert.equal(calls, 1);
  assert.match(out, /403/);
});

test('an OIDC token request failure fails the step without contacting AssureLayer', async () => {
  let apiCalls = 0;
  const { code } = await runCallback({
    apiHandler: (req, res) => { apiCalls += 1; res.end('{}'); },
    oidcHandler: (req, res) => { res.statusCode = 500; res.end('nope'); },
  });
  assert.equal(code, 1);
  assert.equal(apiCalls, 0);
});

test('missing configuration fails fast with a distinct exit code', () => {
  const r = spawnSync(process.execPath, [CALLBACK_SCRIPT], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ASSURELAYER_RUN_ID/);
});

// ---- workflow structure (Step 30) -----------------------------------------

function stepBlock(name) {
  const start = WORKFLOW.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" exists`);
  const next = WORKFLOW.indexOf('\n      - name:', start + 1);
  return WORKFLOW.slice(start, next === -1 ? undefined : next);
}

test('push and pull_request triggers are preserved', () => {
  assert.match(WORKFLOW, /on:\s*\n\s+push:\s*\n\s+branches: \[main\]\s*\n\s+pull_request:\s*\n\s+branches: \[main\]/);
});

test('workflow_dispatch accepts the assurelayer_run_id input', () => {
  assert.match(WORKFLOW, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+assurelayer_run_id:/);
  assert.match(WORKFLOW, /assurelayer_run_id:[\s\S]*?type: string/);
});

test('permissions are exactly id-token: write, contents: read, packages: read — nothing else', () => {
  const block = WORKFLOW.match(/permissions:\n((?:\s{6}\S.*\n)+)/);
  assert.ok(block, 'a permissions block exists');
  const lines = block[1].trim().split('\n').map((l) => l.trim()).sort();
  assert.deepEqual(lines, ['contents: read', 'id-token: write', 'packages: read']);
  assert.equal((WORKFLOW_CODE.match(/:\s*write\b/g) || []).length, 1, 'only id-token is write');
});

test('package installation: `npm ci` gets NODE_AUTH_TOKEN from GITHUB_TOKEN (no personal token in the workflow)', () => {
  const step = stepBlock('Install dependencies');
  assert.match(step, /run: npm ci/);
  assert.match(step, /NODE_AUTH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(WORKFLOW_CODE, /registry-url: 'https:\/\/npm\.pkg\.github\.com'/);
  assert.match(WORKFLOW_CODE, /scope: '@kojisongwriter-pixel'/);
  // no personal/other credential anywhere: the only secrets reference is GITHUB_TOKEN
  const secretRefs = [...WORKFLOW_CODE.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secretRefs)], ['GITHUB_TOKEN']);
  assert.ok(!/\b(PAT|ghp_|github_pat_)\b/.test(WORKFLOW_CODE));
});

test('the callback step runs only for workflow_dispatch and even when Playwright failed', () => {
  const step = stepBlock('Report results to AssureLayer');
  assert.match(step, /if: \$\{\{ always\(\) && github\.event_name == 'workflow_dispatch'/);
  assert.match(step, /run: node scripts\/assurelayer-callback\.js/);
  assert.match(step, /PLAYWRIGHT_OUTCOME: \$\{\{ steps\.tests\.outcome \}\}/);
  assert.ok(!/continue-on-error/.test(step));
});

test('the Playwright step is NOT masked: no continue-on-error, so its failure still fails the job', () => {
  const step = stepBlock('Run tests');
  assert.match(step, /run: npx playwright test/);
  assert.match(step, /id: tests/);
  assert.ok(!/continue-on-error/.test(WORKFLOW_CODE), 'continue-on-error is not used anywhere in the workflow');
  assert.ok(!/\|\|\s*true/.test(WORKFLOW_CODE), 'no `|| true` swallowing failures');
});

test('the callback step is the only step gated on workflow_dispatch; push/PR never reach it', () => {
  const matches = WORKFLOW.match(/github\.event_name == 'workflow_dispatch'/g) || [];
  assert.equal(matches.length, 1);
  assert.ok(!/github\.event_name == 'push'/.test(WORKFLOW));
});

test('the playwright config enables the AssureLayer reporters only when ASSURELAYER_RUN_ID is set', () => {
  const config = fs.readFileSync(path.join(ROOT, 'playwright.config.js'), 'utf8');
  assert.match(config, /const assurelayerRun = !!process\.env\.ASSURELAYER_RUN_ID;/);
  assert.match(config, /\.\.\.\(assurelayerRun/);
  assert.match(config, /reporters\/assurelayer-results-reporter\.js/);
  assert.match(config, /qa-platform-core\/src\/reporter\/failureReporter/);
  // The html reporter that push/PR runs use is unconditional and unchanged.
  assert.match(config, /\['html', \{ outputFolder: 'playwright-report', open: 'never' \}\]/);
});
