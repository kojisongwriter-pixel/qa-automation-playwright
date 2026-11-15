// Client-safe evidence package (Phase 1 — Client Evidence Security).
// Run with: npm run test:assurelayer      (offline: no browser, no network)
//
//  - the packager against a test-results/ tree with the EXACT layout of a real
//    AssureLayer run (internal JSON directories, error-context dumps, traces,
//    retries, four browsers) plus hostile inputs
//  - the packager against the REAL output of a Playwright run through the
//    AssureLayer reporters and qa-platform-core's FailureReporter
//  - structural assertions over .github/workflows/ci.yml

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { packageClientEvidence, sanitizeResults, allowedMedia, INTERNAL_DIRS } = require('./package-client-evidence');

const ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const WORKFLOW_CODE = WORKFLOW.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from('screenshot')]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.from('video')]);
const RUNNER = '/home/runner/work/client-qa/client-qa/test-results';
const B = 'flaky-demo-B---fails-on-every-attempt';

function write(root, rel, data) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/** A test-results/ tree laid out exactly like a real AssureLayer run's raw archive. */
function realisticTree() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'client-evidence-'));
  const src = path.join(work, 'test-results');
  write(src, 'assurelayer/results.json', JSON.stringify({
    version: '1.0.0',
    results: [
      { testId: 't-b-firefox', title: 'demo B - fails on every attempt', status: 'failed', retryCount: 2, browserProject: 'firefox', testKey: 'k-b', stack: 'Error at tests/smoke/flaky-demo.spec.js:13', internalNote: 'x' },
      { testId: 't-a-chrome', title: 'demo A', status: 'passed', retryCount: 1, browserProject: 'chrome', testKey: 'k-a' },
      { testId: 't-api', title: 'api check', status: 'skipped', retryCount: 0, browserProject: null, testKey: 'k-api' },
      { testId: 't-bad', title: 'tampered', status: 'exploded', retryCount: 0, browserProject: 'chrome', testKey: 'k' },
      { testId: 't-odd', title: 'odd browser', status: 'passed', retryCount: 0, browserProject: '../../etc', testKey: 'k-o' },
    ],
  }));
  for (const dir of ['confidence', 'decision', 'failures', 'flaky', 'severity']) write(src, `${dir}/047048d8.json`, JSON.stringify({ internal: dir, score: 0.42 }));
  // Real Failure Contracts (one per failed attempt) — absolute runner paths.
  write(src, 'failures/c1.json', JSON.stringify({ testId: 't-b-firefox', retryCount: 1, stackTrace: 'SECRET STACK', artifacts: { screenshot: `${RUNNER}/${B}-firefox-retry1/test-failed-1.png`, video: `${RUNNER}/${B}-firefox-retry1/video.webm`, trace: `${RUNNER}/${B}-firefox-retry1/trace.zip` } }));
  write(src, 'failures/c2.json', JSON.stringify({ testId: 't-b-firefox', retryCount: 2, artifacts: { screenshot: `${RUNNER}/${B}-firefox-retry2/test-failed-1.png`, video: `${RUNNER}/${B}-firefox-retry2/video.webm`, trace: null } }));
  // Hostile / out-of-scope references a contract could carry.
  write(src, 'failures/c3.json', JSON.stringify({ testId: 't-b-firefox', retryCount: 3, artifacts: { screenshot: `${RUNNER}/../../.ssh/id.png`, video: `${RUNNER}/decision/leak.webm`, trace: null } }));
  write(src, 'failures/c4.json', JSON.stringify({ testId: 't-b-firefox', retryCount: 4, artifacts: { screenshot: `${RUNNER}/${B}-firefox-retry2/error-context.md`, video: `${RUNNER}/deep/nested/dir/video.webm`, trace: null } }));
  // Per-test directories: first attempt + retries, media + internal diagnostics.
  for (const suffix of ['firefox', 'firefox-retry1', 'firefox-retry2']) {
    write(src, `${B}-${suffix}/test-failed-1.png`, PNG);
    write(src, `${B}-${suffix}/video.webm`, WEBM);
    write(src, `${B}-${suffix}/error-context.md`, '# Test source\n```ts\nconst secret = 1\n```');
    write(src, `${B}-${suffix}/trace.zip`, 'PK trace with sources');
  }
  write(src, 'flaky-demo-A-chrome/video-1.webm', WEBM);
  write(src, 'flaky-demo-A-chrome/test-failed-2.png', PNG);
  write(src, 'flaky-demo-A-chrome/notes.txt', 'internal');
  write(src, 'flaky-demo-A-chrome/page.html', '<html>');
  write(src, 'decision/screenshot-in-internal-dir.png', PNG);
  write(src, 'deep/nested/dir/video.webm', WEBM);
  write(src, '.hidden/test-failed-1.png', PNG);
  write(src, 'stray-top-level.png', PNG);
  write(src, '.env', 'TOKEN=never');
  return { work, src, out: path.join(work, 'client-evidence') };
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

test('package: exactly the allow-listed files — failure screenshots/videos, sanitized results, manifest', () => {
  const { src, out } = realisticTree();
  packageClientEvidence({ sourceDir: src, outDir: out, run: { githubRunId: '43598945605', runAttempt: '1', assurelayerRunId: 'eef3c311' } });
  assert.deepEqual(listFiles(out), [
    'assurelayer/manifest.json',
    'assurelayer/results.json',
    `${B}-firefox-retry1/test-failed-1.png`,
    `${B}-firefox-retry1/video.webm`,
    `${B}-firefox-retry2/test-failed-1.png`,
    `${B}-firefox-retry2/video.webm`,
    `${B}-firefox/test-failed-1.png`,
    `${B}-firefox/video.webm`,
    'flaky-demo-A-chrome/test-failed-2.png',
    'flaky-demo-A-chrome/video-1.webm',
  ].sort());
  assert.deepEqual(fs.readFileSync(path.join(out, `${B}-firefox-retry2`, 'test-failed-1.png')), PNG, 'copied byte for byte');
});

test('package: internal JSON directories, error-context dumps, traces, test source and stray files are excluded', () => {
  const { src, out } = realisticTree();
  packageClientEvidence({ sourceDir: src, outDir: out });
  const files = listFiles(out);
  for (const dir of ['confidence', 'decision', 'failures', 'flaky', 'severity']) {
    assert.ok(!files.some((f) => f.startsWith(`${dir}/`)), `${dir}/ excluded`);
    assert.ok(INTERNAL_DIRS.includes(dir));
  }
  assert.ok(!files.some((f) => /error-context|\.md$/.test(f)), 'no error-context dumps');
  assert.ok(!files.some((f) => /trace|\.zip$/.test(f)), 'no traces');
  assert.ok(!files.some((f) => /\.(txt|html|env)$|^\.|\/\.|^deep\/|^stray/.test(f)), 'no other, hidden, nested or top-level files');
  const everything = files.map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
  for (const secret of ['SECRET STACK', 'const secret', 'TOKEN=never', 'Error at tests/', 'internalNote', '"score"']) assert.ok(!everything.includes(secret), secret);
});

test('package: results.json is sanitized to the allow-listed fields with checked types', () => {
  const { src, out } = realisticTree();
  packageClientEvidence({ sourceDir: src, outDir: out });
  const doc = JSON.parse(fs.readFileSync(path.join(out, 'assurelayer', 'results.json'), 'utf8'));
  assert.equal(doc.version, '1.0.0');
  assert.deepEqual(doc.results.map((r) => r.testId), ['t-a-chrome', 't-api', 't-b-firefox', 't-odd'], 'an entry with an invalid status is dropped; order is deterministic');
  for (const r of doc.results) assert.deepEqual(Object.keys(r), ['testId', 'title', 'status', 'retryCount', 'browserProject', 'testKey']);
  assert.equal(doc.results.find((r) => r.testId === 't-odd').browserProject, null, 'only a known browser project survives');
  assert.deepEqual(sanitizeResults(null), { version: '1.0.0', results: [] });
  assert.deepEqual(sanitizeResults({ results: 'nope' }), { version: '1.0.0', results: [] });
});

test('package: the manifest keeps test, browser and attempt associations and a SHA-256 of every file', () => {
  const { src, out } = realisticTree();
  const { manifest } = packageClientEvidence({ sourceDir: src, outDir: out, run: { githubRunId: '43598945605', runAttempt: '1', assurelayerRunId: 'eef3c311' } });
  assert.equal(manifest.package, 'client-safe-evidence');
  assert.deepEqual(manifest.run, { githubRunId: '43598945605', runAttempt: '1', assurelayerRunId: 'eef3c311' });
  const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f]));
  assert.deepEqual(
    { ...byPath[`${B}-firefox-retry2/test-failed-1.png`], sha256: undefined },
    { path: `${B}-firefox-retry2/test-failed-1.png`, kind: 'screenshot', testId: 't-b-firefox', title: 'demo B - fails on every attempt', browserProject: 'firefox', retry: 2, sizeBytes: PNG.length, sha256: undefined }
  );
  assert.equal(byPath[`${B}-firefox-retry1/video.webm`].retry, 1);
  assert.equal(byPath[`${B}-firefox/video.webm`].retry, 0, 'first attempt (no contract): attempt from the directory name');
  assert.equal(byPath[`${B}-firefox/video.webm`].browserProject, 'firefox');
  assert.equal(byPath['flaky-demo-A-chrome/video-1.webm'].browserProject, 'chrome');
  for (const f of manifest.files) {
    assert.equal(f.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(out, f.path))).digest('hex'), f.path);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'assurelayer', 'manifest.json'), 'utf8')), manifest);
});

test('package: deterministic — the same input produces identical output; a stale package is replaced', () => {
  const { src, out } = realisticTree();
  packageClientEvidence({ sourceDir: src, outDir: out });
  const snapshot = () => listFiles(out).map((f) => [f, fs.readFileSync(path.join(out, f)).toString('base64')]);
  const first = snapshot();
  write(out, 'leftover/trace.zip', 'stale');
  packageClientEvidence({ sourceDir: src, outDir: out });
  assert.deepEqual(snapshot(), first);
});

test('package: symbolic links are never followed; oversized media is listed as omitted, never truncated', (t) => {
  const { src, out, work } = realisticTree();
  const target = path.join(work, 'outside-secret.png');
  fs.writeFileSync(target, 'outside');
  try {
    fs.symlinkSync(target, path.join(src, `${B}-firefox`, 'test-failed-9.png'));
  } catch {
    t.diagnostic('symbolic links are not permitted on this machine; link case skipped');
  }
  const big = path.join(src, 'big-chrome', 'video.webm');
  fs.mkdirSync(path.dirname(big), { recursive: true });
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 50 * 1024 * 1024 + 1);
  const { manifest } = packageClientEvidence({ sourceDir: src, outDir: out });
  assert.ok(!listFiles(out).includes(`${B}-firefox/test-failed-9.png`), 'link not packaged');
  assert.ok(!listFiles(out).includes('big-chrome/video.webm'));
  assert.deepEqual(manifest.omitted, [{ path: 'big-chrome/video.webm', reason: 'too_large', sizeBytes: 50 * 1024 * 1024 + 1 }]);
});

test('package: no test output at all still yields a valid empty package; the output may never be inside test-results/', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'client-evidence-empty-'));
  const { manifest } = packageClientEvidence({ sourceDir: path.join(work, 'test-results'), outDir: path.join(work, 'client-evidence') });
  assert.deepEqual(manifest.files, []);
  assert.deepEqual(listFiles(path.join(work, 'client-evidence')), ['assurelayer/manifest.json', 'assurelayer/results.json']);
  assert.throws(() => packageClientEvidence({ sourceDir: path.join(work, 'test-results'), outDir: path.join(work, 'test-results', 'pkg') }), /outside test-results/);
});

test('allowedMedia: only "<per-test dir>/<image|video>"', () => {
  assert.equal(allowedMedia('t-chrome-retry1/test-failed-1.png'), 'screenshot');
  assert.equal(allowedMedia('t-chrome/video.webm'), 'video');
  for (const bad of ['../x/a.png', 'a/../b.png', '/abs/a.png', 'a\\b.png', 'decision/a.png', 'a/b/c.png', 'a.png', 'a/trace.zip', 'a/error-context.md', '.git/a.png', 'a/.png', 'a/x.svg', '']) {
    assert.equal(allowedMedia(bad), null, bad);
  }
});

test('package: the REAL output of a Playwright run through the AssureLayer reporters contains no internal file', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'assurelayer-fixture-'));
  const run = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '-c', path.join(__dirname, 'fixture-project', 'playwright.config.js')],
    { cwd, env: { ...process.env, ASSURELAYER_RUN_ID: 'fixture-run', CI: '1', ENV: 'staging', ASSURELAYER_SUITE: 'smoke' }, encoding: 'utf8' }
  );
  assert.equal(run.status, 1, 'the fixture project contains a failing test');
  const rawFiles = listFiles(path.join(cwd, 'test-results'));
  assert.ok(rawFiles.some((f) => f.startsWith('failures/')), 'the raw output does contain internal Failure Contracts');
  const { manifest } = packageClientEvidence({ sourceDir: path.join(cwd, 'test-results'), outDir: path.join(cwd, 'client-evidence') });
  assert.deepEqual(listFiles(path.join(cwd, 'client-evidence')), ['assurelayer/manifest.json', 'assurelayer/results.json'], 'browserless fixture: no media, nothing internal');
  assert.deepEqual(manifest.files, []);
  const results = JSON.parse(fs.readFileSync(path.join(cwd, 'client-evidence', 'assurelayer', 'results.json'), 'utf8')).results;
  assert.deepEqual(results.map((r) => r.status).sort(), ['failed', 'passed', 'passed', 'skipped']);
  for (const r of results) assert.deepEqual(Object.keys(r), ['testId', 'title', 'status', 'retryCount', 'browserProject', 'testKey']);
});

// ---- Workflow ------------------------------------------------------------------------

function step(name) {
  const at = WORKFLOW_CODE.indexOf(`- name: ${name}\n`);
  assert.ok(at >= 0, `step "${name}" exists`);
  const next = WORKFLOW_CODE.indexOf('\n      - name: ', at + 1);
  return { at, text: WORKFLOW_CODE.slice(at, next < 0 ? undefined : next) };
}

test('workflow: AssureLayer runs package and upload client-evidence-<run id>; packaging can never fail the run', () => {
  const pack = step('Package client-safe evidence');
  assert.match(pack.text, /if: \$\{\{ always\(\) && github\.event_name == 'workflow_dispatch' && inputs\.assurelayer_run_id != '' \}\}/);
  assert.match(pack.text, /run: node scripts\/assurelayer\/package-client-evidence\.js\n/);
  const upload = step('Upload client-safe evidence');
  assert.match(upload.text, /uses: actions\/upload-artifact@v4/);
  assert.match(upload.text, /if: \$\{\{ always\(\) && steps\.client_evidence\.outcome == 'success' \}\}/);
  assert.match(upload.text, /name: client-evidence-\$\{\{ github\.run_id \}\}\n/);
  assert.match(upload.text, /path: client-evidence\/\n/, 'only the curated directory');
  assert.match(upload.text, /retention-days: 30\n/);
  assert.match(upload.text, /if-no-files-found: ignore\n/, 'no package -> no artifact (the portal fails closed)');
  assert.ok(pack.at > step('Run tests').at, 'packaged after the tests ran');
});

test('entry point: a packaging error leaves NO package (not even a partial one), warns, and never fails the job', () => {
  const { main } = require('./package-client-evidence');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'client-evidence-main-'));
  write(path.join(cwd, 'test-results'), 't-chrome/test-failed-1.png', PNG);
  const logs = [];
  const original = console.log;
  const realRename = fs.renameSync;
  console.log = (line) => logs.push(line);
  fs.renameSync = () => {
    throw new Error('disk full');
  };
  let ok;
  try {
    ok = main({ GITHUB_RUN_ID: '1' }, cwd);
  } finally {
    fs.renameSync = realRename;
    console.log = original;
  }
  assert.equal(ok, false);
  assert.ok(!fs.existsSync(path.join(cwd, 'client-evidence')), 'nothing to upload');
  assert.ok(!fs.existsSync(path.join(cwd, 'client-evidence.partial')), 'no partial package left behind');
  assert.match(logs.join('\n'), /^::warning::The client-safe evidence package could not be built \(disk full\)/m);
  assert.equal(main({ GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '2', ASSURELAYER_RUN_ID: 'r' }, cwd), true, 'and succeeds normally otherwise');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, 'client-evidence', 'assurelayer', 'manifest.json'), 'utf8')).run, { githubRunId: '7', runAttempt: '2', assurelayerRunId: 'r' });
});

test('workflow: the raw diagnostic artifacts are still uploaded unchanged (internal, for Phase 2)', () => {
  const raw = step('Upload test results');
  assert.match(raw.text, /if: always\(\)\n/);
  assert.match(raw.text, /name: test-results-\$\{\{ github\.run_id \}\}\n/);
  assert.match(raw.text, /path: test-results\/\n/);
  assert.match(raw.text, /retention-days: 30\n/);
  const report = step('Upload HTML report');
  assert.match(report.text, /name: playwright-report-\$\{\{ github\.run_id \}\}\n/);
  assert.match(report.text, /path: playwright-report\/\n/);
  assert.ok(!/name: client-evidence[^\n]*\n[\s\S]*?path: test-results\//.test(step('Upload client-safe evidence').text), 'the package is never the raw directory');
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^client-evidence\/$/m);
});
