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
const { installPlan, runPlaywright, main: installBrowsers } = require('./install-browsers');
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

const CI = { CI: 'true' };

test('installation plan: exactly the selected browsers, branded Chrome/Edge installed explicitly, no shell', () => {
  assert.deepEqual(installPlan('', CI), {
    osDeps: ['install-deps', 'chrome', 'msedge', 'firefox', 'webkit'],
    downloads: ['install', 'ffmpeg', 'firefox', 'webkit'],
    browsers: ['install', 'chrome', 'msedge', 'firefox', 'webkit'],
  });
  assert.deepEqual(installPlan('firefox,webkit', CI), {
    osDeps: ['install-deps', 'firefox', 'webkit'],
    downloads: ['install', 'ffmpeg', 'firefox', 'webkit'],
    browsers: ['install', 'firefox', 'webkit'],
  });
  assert.deepEqual(installPlan('msedge', CI), {
    osDeps: ['install-deps', 'msedge'],
    downloads: ['install', 'ffmpeg'],
    browsers: ['install', 'msedge'],
  });
  assert.throws(() => installPlan('chromium', CI));
  const src = fs.readFileSync(path.join(__dirname, 'install-browsers.js'), 'utf8');
  assert.match(src, /spawn\(process\.execPath, \[cli, \.\.\.args\]/, 'argument array, never a shell string');
  assert.doesNotMatch(src, /shell:\s*true|execSync\(|exec\(/);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'install-browsers.js')], { env: { PATH: process.env.PATH, ASSURELAYER_BROWSERS: 'opera' }, encoding: 'utf8' });
  assert.equal(r.status, 1, 'an invalid selection fails before installing anything');
});

test('installation plan: --force never re-downloads under CI, and still replaces branded browsers outside it', () => {
  for (const env of [{ CI: 'true' }, { CI: '1' }]) {
    assert.ok(!installPlan('', env).browsers.includes('--force'), `CI=${env.CI}`);
  }
  for (const env of [{}, { CI: 'false' }, { CI: '0' }]) {
    assert.deepEqual(installPlan('', env).browsers, ['install', '--force', 'chrome', 'msedge', 'firefox', 'webkit'], `CI=${env.CI}`);
  }
  assert.deepEqual(installPlan('firefox', {}).browsers, ['install', 'firefox'], 'no --force without a branded browser');
  for (const selection of ['', 'chrome', 'firefox,webkit']) {
    const plan = installPlan(selection, CI);
    assert.equal(plan.downloads.filter((a) => a === 'ffmpeg').length, 1, 'FFmpeg is requested once');
    assert.ok(!plan.browsers.includes('ffmpeg'), 'phase 2 does not ask for FFmpeg');
    assert.ok(!plan.osDeps.includes('--force') && !plan.downloads.includes('--force'));
  }
});

// A controllable stand-in for the Playwright CLI: each started operation stays
// pending until the test settles it, so ordering needs no timers.
function fakePlaywright() {
  const started = [];
  const run = (args, env) => new Promise((resolve) => started.push({ args, env, finish: resolve }));
  const osDeps = () => started.find((s) => s.args[0] === 'install-deps');
  const downloads = () => started.find((s) => s.args.includes('ffmpeg'));
  return { started, run, osDeps, downloads };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const silenced = async (fn) => {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
};
const ENV = { ...CI, ASSURELAYER_BROWSERS: '' };

test('installer: OS packages and downloads overlap, and Chrome/Edge start only after both succeed', () => silenced(async () => {
  const pw = fakePlaywright();
  const done = installBrowsers(ENV, pw.run);
  await flush();
  assert.equal(pw.started.length, 2, 'both operations are running before either has finished');
  assert.ok(pw.osDeps() && pw.downloads());
  pw.osDeps().finish(0);
  await flush();
  assert.equal(pw.started.length, 2, 'phase 2 waits for the downloads too');
  pw.downloads().finish(0);
  await flush();
  assert.equal(pw.started.length, 3);
  assert.deepEqual(pw.started[2].args, ['install', 'chrome', 'msedge', 'firefox', 'webkit']);
  pw.started[2].finish(0);
  assert.equal(await done, 0);
}));

test('installer: only the early download skips the host check; the post-apt command keeps it', () => silenced(async () => {
  const pw = fakePlaywright();
  const done = installBrowsers(ENV, pw.run);
  await flush();
  assert.equal(pw.downloads().env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS, '1');
  assert.equal(pw.osDeps().env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS, undefined);
  pw.osDeps().finish(0);
  pw.downloads().finish(0);
  await flush();
  assert.equal(pw.started[2].env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS, undefined);
  pw.started[2].finish(0);
  await done;
}));

for (const [failing, other] of [['osDeps', 'downloads'], ['downloads', 'osDeps']]) {
  test(`installer: a failed ${failing} fails the step, after waiting for ${other}, and Chrome/Edge never start`, () => silenced(async () => {
    const pw = fakePlaywright();
    let settled = false;
    const done = installBrowsers(ENV, pw.run).then((code) => {
      settled = true;
      return code;
    });
    await flush();
    pw[failing]().finish(1);
    await flush();
    assert.equal(settled, false, 'the other operation is still awaited');
    pw[other]().finish(0);
    assert.equal(await done, 3);
    assert.equal(pw.started.length, 2, 'phase 2 did not start');
  }));
}

test('installer: a failed Chrome/Edge install fails the step', () => silenced(async () => {
  const pw = fakePlaywright();
  const done = installBrowsers(ENV, pw.run);
  await flush();
  pw.osDeps().finish(0);
  pw.downloads().finish(0);
  await flush();
  pw.started[2].finish(1);
  assert.equal(await done, 3);
}));

test('installer: an invalid selection starts nothing', () => silenced(async () => {
  const pw = fakePlaywright();
  assert.equal(await installBrowsers({ ...CI, ASSURELAYER_BROWSERS: 'opera' }, pw.run), 1);
  assert.equal(pw.started.length, 0);
}));

test('runPlaywright: reports the real exit code, a kill, and a missing script as failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-browsers-'));
  try {
    const script = (name, body) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, body);
      return file;
    };
    assert.equal(await runPlaywright([], process.env, script('ok.js', 'process.exit(0)')), 0);
    assert.equal(await runPlaywright([], process.env, script('bad.js', 'process.exit(7)')), 7);
    assert.notEqual(await runPlaywright([], process.env, script('killed.js', "process.kill(process.pid, 'SIGKILL'); setInterval(() => {}, 1000)")), 0);
    assert.notEqual(await runPlaywright([], process.env, path.join(dir, 'missing.js')), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
