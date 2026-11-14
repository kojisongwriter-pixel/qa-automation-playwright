// Prebuilt runner image: the in-job image check (versions and executables of the
// selected browsers), the image definition (pinned base, verified sources, no
// project source or secrets) and the build/publish workflow (validation before
// publish, digest-only consumption, no silent change of the approved image).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkRunnerImage } = require('./verify-runner-image');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const RECORD = {
  playwright: '1.61.0',
  node: '26.13.0',
  browsers_path: '/ms-playwright',
  chrome: '157.0.8103.78',
  msedge: '157.0.4341.46',
  firefox: { version: '151.0', playwright_revision: '1532' },
  webkit: { playwright_revision: '2311' },
  ffmpeg: { playwright_revision: '1011' },
};
const REVISIONS = { firefox: '1532', webkit: '2311', ffmpeg: '1011', chromium: '1228' };
const PRESENT = new Set(['/opt/google/chrome/chrome', '/opt/microsoft/msedge/msedge', '/ms-playwright/firefox-1532', '/ms-playwright/webkit-2311', '/ms-playwright/ffmpeg-1011']);
const check = (over = {}) =>
  checkRunnerImage({ record: RECORD, selection: '', nodeVersion: 'v26.13.0', repoPlaywright: '1.61.0', revisions: REVISIONS, exists: (p) => PRESENT.has(p.replace(/\\/g, '/')), ...over });

test('image check: a matching image passes for all four browsers', () => {
  const r = check();
  assert.deepEqual(r.browsers, ['chrome', 'msedge', 'firefox', 'webkit']);
  assert.deepEqual(r.problems, []);
});

test('image check: a Playwright, Node or browser-revision mismatch fails before any test runs', () => {
  assert.match(check({ repoPlaywright: '1.62.0' }).problems.join(' '), /built for Playwright 1\.61\.0, this repository uses 1\.62\.0/);
  assert.match(check({ nodeVersion: 'v24.12.0' }).problems.join(' '), /is not Node 26/);
  assert.match(check({ revisions: { ...REVISIONS, webkit: '2400' } }).problems.join(' '), /webkit: the image has revision 2311, Playwright 1\.61\.0 expects 2400/);
  assert.match(check({ revisions: { ...REVISIONS, ffmpeg: '1012' } }).problems.join(' '), /ffmpeg/, 'video recording needs the matching FFmpeg');
  assert.match(check({ record: null }).problems.join(' '), /no build record/);
});

test('image check: only the SELECTED browsers must be present; a missing selected browser fails', () => {
  const noEdge = (p) => PRESENT.has(p.replace(/\\/g, '/')) && !p.includes('msedge');
  assert.deepEqual(check({ selection: 'chrome,firefox', exists: noEdge }).problems, [], 'Edge not selected -> not required');
  assert.match(check({ selection: 'msedge', exists: noEdge }).problems.join(' '), /msedge: \/opt\/microsoft\/msedge\/msedge is missing/);
  assert.throws(() => check({ selection: 'chromium' }), 'an unsupported selection is refused as everywhere else');
});

test('image definition: pinned base, verified Node.js, the project\'s Playwright installer, no project source or secrets', () => {
  const docker = read('runner-image/Dockerfile');
  assert.match(docker, /^ARG BASE_IMAGE=ubuntu:26\.04@sha256:[0-9a-f]{64}$/m, 'Ubuntu 26.04 base pinned by digest');
  assert.match(docker, /^FROM \$\{BASE_IMAGE\}\nARG BASE_IMAGE$/m, 'built FROM exactly that, and the digest reaches the build record');
  assert.match(docker, /BASE_IMAGE="\$\{BASE_IMAGE\}"[^\n]*\\\n\s*node \/usr\/local\/lib\/assurelayer\/record-versions\.js/);
  assert.match(docker, /apt-get update \\\n\s*&& apt-get upgrade -y/, "the base image's own packages get the current security updates");
  assert.match(docker, /ARG NODE_VERSION=26\.\d+\.\d+/);
  assert.match(docker, /SHASUMS256\.txt[\s\S]*sha256sum -c -/, 'Node.js archive verified against the release checksums');
  const lock = JSON.parse(read('package-lock.json'));
  assert.match(docker, new RegExp(`ARG PLAYWRIGHT_VERSION=${lock.packages['node_modules/@playwright/test'].version.replace(/\./g, '\\.')}\\b`), 'same Playwright as package-lock.json');
  assert.match(docker, /npm install -g "playwright@\$\{PLAYWRIGHT_VERSION\}"/, "the project's Playwright installer");
  assert.match(docker, /playwright install-deps chrome msedge firefox webkit/, 'OS packages of all four browsers');
  for (const part of ['chrome', 'msedge', 'firefox webkit']) assert.match(docker, new RegExp(`RUN playwright install ${part} &&`), `${part} in its own layer`);
  assert.match(docker, /ARG NODE_VERSION=26\.13\.1/, 'the Node 26 security release');
  assert.match(docker, /ARG NPM_VERSION=11\.21\.2[\s\S]*npm install -g "npm@\$\{NPM_VERSION\}"/, 'npm with the fixed undici / brace-expansion, same major');
  const copies = [...docker.matchAll(/^(COPY|ADD) (.+)$/gm)].map((m) => m[2]);
  assert.ok(!/^RUN .*playwright install .*--force/m.test(docker));
  assert.deepEqual(copies, ['record-versions.js /usr/local/lib/assurelayer/record-versions.js'], 'nothing from the project is copied in');
  const instructions = docker.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(instructions, /TOKEN|SECRET|PASSWORD|_authToken/i, 'no credential in any instruction');
});

test('build record: names the base image and the exact security-relevant OS packages', () => {
  const rec = read('runner-image/record-versions.js');
  assert.match(rec, /base_image: process\.env\.BASE_IMAGE/);
  for (const p of ['libc6', 'libc-bin', 'gstreamer1.0-plugins-bad', 'libgstreamer-plugins-bad1.0-0']) assert.ok(rec.includes(`'${p}'`), p);
  assert.match(rec, /spawnSync\('dpkg-query'/, 'a package missing from the list cannot fail the build');
});

test('vulnerability scan: pinned Trivy, every severity, unfixed included, complete report kept', () => {
  const wf = read('.github/workflows/runner-image.yml');
  const step = wf.slice(wf.indexOf('- name: Vulnerability scan'), wf.indexOf('- name: Publish'));
  assert.match(step, /TRIVY: aquasec\/trivy@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c/, 'scanner pinned by digest');
  assert.doesNotMatch(step, /--ignore-unfixed|--severity|--skip-|\.trivyignore|--ignorefile/, 'nothing filtered or suppressed');
  assert.match(step, /--format json --output \/out\/trivy\.json/);
  assert.match(step, /name: trivy-report-\$\{\{ steps\.build\.outputs\.tag \}\}[\s\S]*trivy\.json/, 'the complete JSON report is uploaded');
  assert.ok(wf.indexOf('- name: Vulnerability scan') < wf.indexOf('- name: Publish'), 'scanned before publishing');
  const { summarize } = require('../../runner-image/summarize-scan');
  const report = {
    ArtifactName: 'img',
    Results: [
      { Target: 'os', Type: 'ubuntu', Packages: [{}, {}], Vulnerabilities: [
        { VulnerabilityID: 'CVE-1', Severity: 'HIGH', PkgName: 'a', InstalledVersion: '1', Status: 'affected' },
        { VulnerabilityID: 'CVE-2', Severity: 'MEDIUM', PkgName: 'b', InstalledVersion: '1', FixedVersion: '2', Status: 'fixed' },
        { VulnerabilityID: 'CVE-3', Severity: 'LOW', PkgName: 'c', InstalledVersion: '1' },
      ] },
      { Target: 'Node.js', Type: 'node-pkg', Vulnerabilities: [{ VulnerabilityID: 'CVE-4', Severity: 'CRITICAL', PkgName: 'd', InstalledVersion: '1', FixedVersion: '3' }] },
    ],
  };
  const s = summarize(report, { Version: '0.76.1', VulnerabilityDB: { Version: 2, UpdatedAt: '2026-11-14T01:05:40Z' } });
  assert.deepEqual(s.counts.HIGH, { total: 1, fixable: 0, unfixed: 1 }, 'unfixed findings are counted, not dropped');
  assert.deepEqual(s.counts.MEDIUM, { total: 1, fixable: 1, unfixed: 0 });
  assert.equal(s.counts.LOW.total, 1);
  assert.deepEqual(s.serious.map((f) => f.VulnerabilityID), ['CVE-1', 'CVE-4']);
  assert.match(s.markdown, /Trivy 0\.76\.1 · database v2 updated 2026-11-14T01:05:40Z/);
  assert.match(s.markdown, /- HIGH CVE-1 `a` 1 → fixed: none \(affected, ubuntu\)/);
});

const DISPATCHED = "github.event_name == 'workflow_dispatch' && (inputs.assurelayer_run_id != '' || inputs.browsers != '')";
function job(name) {
  const wf = read('.github/workflows/ci.yml');
  const start = wf.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} exists`);
  const next = wf.slice(start + 1).search(/\n  [a-z][\w-]*:\n/);
  return next === -1 ? wf.slice(start) : wf.slice(start, start + 1 + next);
}

test('ci.yml: dispatched runs go to the runner-image job, everything else (and the rollback switch) to the unchanged test job — never both', () => {
  assert.ok(job('test').includes(`if: \${{ !(${DISPATCHED} && vars.ASSURELAYER_RUNNER_IMAGE_DISABLED != 'true') }}`));
  assert.ok(job('assurelayer').includes(`if: \${{ ${DISPATCHED} && vars.ASSURELAYER_RUNNER_IMAGE_DISABLED != 'true' }}`));
});

test('ci.yml runner-image job: pinned by immutable digest (same in container and env), pulled with GITHUB_TOKEN, nothing installed per run', () => {
  const j = job('assurelayer');
  const images = [...j.matchAll(/ghcr\.io\/kojisongwriter-pixel\/assurelayer-runner@sha256:([0-9a-f]{64})/g)].map((m) => m[1]);
  assert.equal(images.length, 2, 'container.image and ASSURELAYER_RUNNER_IMAGE, both a sha256 digest');
  assert.equal(images[0], images[1], 'the recorded image is the image that runs');
  assert.doesNotMatch(j, /assurelayer-runner:(latest|\d)/, 'never a mutable tag');
  assert.match(j, /credentials:\s*\n\s*username: \$\{\{ github\.actor \}\}\s*\n\s*password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(j, /permissions:\s*\n\s*id-token: write\s*\n\s*contents: read\s*\n\s*packages: read\s*\n/);
  assert.doesNotMatch(j, /playwright install|install-browsers|apt-get|setup-node/, 'browsers, OS packages and Node.js come from the image');
});

test('ci.yml runner-image job: scope, image check, tests, callback and artifacts as in the test job, in order', () => {
  const j = job('assurelayer');
  const order = ['Checkout', 'Install dependencies', 'Resolve AssureLayer execution scope', 'Verify runner image', 'Run tests', 'Report results to AssureLayer', 'Upload HTML report', 'Upload test results'];
  const at = order.map((n) => j.indexOf(`- name: ${n}`));
  assert.ok(at.every((i) => i >= 0), order.join(', '));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  const step = (n) => j.slice(j.indexOf(`- name: ${n}`), j.indexOf('\n      - name:', j.indexOf(`- name: ${n}`) + 1));
  assert.match(step('Resolve AssureLayer execution scope'), /ASSURELAYER_BROWSERS_INPUT: \$\{\{ inputs\.browsers \}\}/, 'inputs only via env');
  assert.match(step('Verify runner image'), /run: node scripts\/assurelayer\/verify-runner-image\.js/);
  assert.match(step('Run tests'), /id: tests[\s\S]*ASSURELAYER_RUN_ID: \$\{\{ inputs\.assurelayer_run_id \}\}/);
  assert.match(step('Run tests'), /HOME: \/root/, 'Firefox runs as root in the job container only with a root-owned HOME');
  assert.match(step('Report results to AssureLayer'), /if: \$\{\{ always\(\) && inputs\.assurelayer_run_id != '' \}\}[\s\S]*PLAYWRIGHT_OUTCOME: \$\{\{ steps\.tests\.outcome \}\}/);
  assert.match(step('Upload test results'), /test-results\/\s*\n\s*runner-image-record\//, 'the image record travels with the evidence');
  assert.doesNotMatch(j, /continue-on-error/);
});

test('build workflow: daily + manual, validates the candidate (versions, four browsers, scan) BEFORE publishing, publishes by digest, never edits main', () => {
  const wf = read('.github/workflows/runner-image.yml');
  assert.match(wf, /schedule:\s*\n\s*- cron: /);
  assert.match(wf, /workflow_dispatch:/);
  assert.doesNotMatch(wf, /^\s+push:|pull_request:/m, 'only the daily schedule and a manual dispatch build images');
  const at = (s) => { const i = wf.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('name: Build candidate image') < at('name: Four-browser smoke test in the candidate image'));
  assert.ok(at('name: Four-browser smoke test in the candidate image') < at('name: Publish'), 'nothing is published unless the candidate passed');
  assert.ok(at('name: Vulnerability scan') < at('name: Publish'));
  assert.match(wf, /ASSURELAYER_BROWSERS: chrome,msedge,firefox,webkit/);
  assert.match(wf, /verify-runner-image\.js/);
  assert.match(wf, /docker manifest inspect|RepoDigests/, 'the immutable digest is read back after the push');
  assert.doesNotMatch(wf, /git push origin (HEAD:)?main|git push origin main/, 'the approved image is never changed on main by the schedule');
  assert.match(wf, /runner-image\/update-/, 'a digest change is proposed on its own branch for review');
  assert.match(wf, /packages: write/);
  assert.doesNotMatch(wf, /secrets\.(?!GITHUB_TOKEN|ASSURELAYER_PACKAGES_TOKEN)\w+/, 'no new secrets');
});

const { checkEvidence } = require('../../runner-image/evidence-check/verify-evidence');

test('evidence check: screenshot, video and retry trace required for every browser', () => {
  const ok = ['chrome', 'msedge', 'firefox', 'webkit'].flatMap((b) => [
    `evidence-evidence-capture-expected-to-fail-${b}/test-failed-1.png`,
    `evidence-evidence-capture-expected-to-fail-${b}/video.webm`,
    `evidence-evidence-capture-expected-to-fail-${b}-retry1/trace.zip`,
  ]);
  assert.deepEqual(checkEvidence(ok).missing, []);
  assert.deepEqual(checkEvidence(ok.filter((f) => !(f.includes('-webkit') && f.endsWith('.webm')))).missing, ['webkit: no video']);
  assert.deepEqual(checkEvidence(ok.filter((f) => !f.includes('msedge-retry1'))).missing, ['msedge: no trace'], 'the trace comes from the retry');
  const wf = read('.github/workflows/runner-image.yml');
  assert.ok(wf.indexOf('name: Failure evidence check in the candidate image') < wf.indexOf('name: Publish'), 'checked before publishing');
  assert.match(wf, /if \[ "\$code" -ne 1 \]; then echo "expected the evidence test to fail/, 'the deliberate failure must actually fail');
  const cfg = read('runner-image/evidence-check/playwright.config.js');
  assert.match(cfg, /screenshot: 'only-on-failure',\s*\n\s*video: 'retain-on-failure',\s*\n\s*trace: 'on-first-retry'/, "same evidence settings as the project's config");
  assert.match(read('playwright.config.js'), /screenshot: 'only-on-failure',\s*\n\s*video: 'retain-on-failure',\s*\n\s*trace: 'on-first-retry'/);
});

// A minimal evaluator for the GitHub Actions expressions used by the reporter
// decision: literals, property access, !, ==, !=, &&, || (value-returning),
// parentheses and status functions. Comparison follows GitHub: strings compare
// case-insensitively, null equals only null.
function evaluate(expr, ctx) {
  const tokens = expr.match(/'(?:[^']|'')*'|&&|\|\||==|!=|[!()]|[A-Za-z_][\w.-]*(?:\(\))?/g);
  let i = 0;
  const peek = () => tokens[i];
  const truthy = (v) => !(v === null || v === undefined || v === false || v === '' || v === 0);
  const eq = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : (a ?? null) === (b ?? null));
  function primary() {
    const t = tokens[i++];
    if (t === '(') { const v = or(); assert.equal(tokens[i++], ')'); return v; }
    if (t === '!') return !truthy(primary());
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (t.endsWith('()')) return ctx.functions[t.slice(0, -2)]();
    return t.split('.').reduce((o, k) => (o == null ? null : o[k] ?? null), ctx);
  }
  function cmp() {
    let v = primary();
    while (peek() === '==' || peek() === '!=') { const op = tokens[i++]; const r = primary(); v = op === '==' ? eq(v, r) : !eq(v, r); }
    return v;
  }
  function and() { let v = cmp(); while (peek() === '&&') { i++; const r = cmp(); v = truthy(v) ? r : v; } return v; }
  function or() { let v = and(); while (peek() === '||') { i++; const r = and(); v = truthy(v) ? v : r; } return v; }
  const v = or();
  assert.equal(i, tokens.length, `parsed all of: ${expr}`);
  return v;
}
// Job outputs and env values are strings: true -> 'true', null -> ''.
const asString = (v) => (v === null || v === undefined ? '' : String(v));
const exprOf = (text, key) => {
  const m = text.match(new RegExp(`\\n\\s*${key}: \\$\\{\\{ (.+?) \\}\\}`));
  assert.ok(m, `${key} is an expression`);
  return m[1];
};

// What GitHub would decide for the reporter job, from the image job's step outcomes.
function reporterDecision({ steps, jobResult, workflowCancelled = false, runId = 'RUN-1' }) {
  const a = job('assurelayer');
  const r = job('report-runner-image-failure');
  const stepsCtx = Object.fromEntries(Object.entries(steps).map(([id, outcome]) => [id, { outcome }]));
  const fns = { functions: { cancelled: () => workflowCancelled, always: () => true } };
  const outputs = {
    callback_succeeded: asString(evaluate(exprOf(a, 'callback_succeeded'), { steps: stepsCtx, ...fns })),
    tests_outcome: asString(evaluate(exprOf(a, 'tests_outcome'), { steps: stepsCtx, ...fns })),
  };
  const ctx = { needs: { assurelayer: { result: jobResult, outputs } }, inputs: { assurelayer_run_id: runId }, ...fns };
  const runs = Boolean(evaluate(exprOf(r, 'if'), ctx));
  const outcome = asString(evaluate(exprOf(r, 'PLAYWRIGHT_OUTCOME'), ctx));
  return { runs, outcome, outputs };
}

test('reporter: skipped when the image job callback was accepted — whatever the tests did', () => {
  for (const tests of ['success', 'failure']) {
    // Tests failed + callback accepted: the job still fails (Playwright's step), and the reporter must stay out.
    const d = reporterDecision({ steps: { tests, callback: 'success' }, jobResult: tests === 'success' ? 'success' : 'failure' });
    assert.equal(d.outputs.callback_succeeded, 'true');
    assert.equal(d.runs, false, `tests ${tests}`);
  }
  // Callback accepted but an artifact upload failed afterwards: still no second report.
  assert.equal(reporterDecision({ steps: { tests: 'success', callback: 'success' }, jobResult: 'failure' }).runs, false);
});

test('reporter: runs when the container never started, reporting an execution error with no results', () => {
  // Observed on GitHub (run 43550575660, unpullable digest): "Initialize containers"
  // failed, tests were 'skipped', the always() callback step 'failure', nothing uploaded.
  const observed = reporterDecision({ steps: { tests: 'skipped', callback: 'failure' }, jobResult: 'failure' });
  // And if GitHub ever reports no step outcomes at all:
  const empty = reporterDecision({ steps: {}, jobResult: 'failure' });
  const { buildPayload } = require('./buildPayload');
  for (const [d, expected] of [[observed, 'skipped'], [empty, 'runner_image_unavailable']]) {
    assert.equal(d.outputs.callback_succeeded, 'false');
    assert.equal(d.runs, true);
    assert.equal(d.outcome, expected);
    const { payload } = buildPayload({ resultsFile: path.join(ROOT, 'no-such', 'results.json'), failuresDir: path.join(ROOT, 'no-such'), playwrightOutcome: d.outcome });
    assert.equal(payload.execution_status, 'error');
    assert.deepEqual(payload.results, []);
  }
});

test('reporter: runs when checkout or setup failed before the callback could be accepted', () => {
  // Checkout failed: the always() callback step runs but cannot succeed (no script).
  const d = reporterDecision({ steps: { tests: 'skipped', callback: 'failure' }, jobResult: 'failure' });
  assert.equal(d.runs, true);
  assert.equal(d.outcome, 'skipped', 'mapped to execution_status error');
  // The callback step never ran at all (e.g. the job failed in a step before it with no always()).
  assert.equal(reporterDecision({ steps: { tests: 'skipped' }, jobResult: 'failure' }).runs, true);
});

test('reporter: retries a failed callback with the SAME Playwright outcome (idempotent resend, no new results)', () => {
  for (const tests of ['success', 'failure']) {
    const d = reporterDecision({ steps: { tests, callback: 'failure' }, jobResult: 'failure' });
    assert.equal(d.runs, true);
    assert.equal(d.outcome, tests, 'resends what the image job would have sent');
  }
  const r = job('report-runner-image-failure');
  assert.match(r, /uses: actions\/download-artifact@v8\n\s*with:\n\s*name: test-results-\$\{\{ github\.run_id \}\}/, "resends the image job's own uploaded results");
  assert.match(r, /if: \$\{\{ needs\.assurelayer\.outputs\.results_artifact != '' \}\}\n\s*uses: actions\/download-artifact@v8/, 'downloads only what the image job actually uploaded');
  assert.match(r, /- name: Report results to AssureLayer\n\s*if: \$\{\{ !cancelled\(\) \}\}/, 'reports even if the download failed');
  const a = job('assurelayer');
  assert.match(a, /results_artifact: \$\{\{ steps\.upload-results\.outputs\.artifact-id \}\}/);
  assert.ok(a.indexOf('id: callback') < a.indexOf('name: test-results-${{ github.run_id }}'), 'results are uploaded after the callback attempt');
  assert.match(a, /- name: Upload test results\n\s*id: upload-results\n\s*uses: actions\/upload-artifact@v6\n\s*if: always\(\)/);
});

test('reporter: never reports a cancelled run as an execution failure', () => {
  assert.equal(reporterDecision({ steps: { tests: 'cancelled', callback: 'success' }, jobResult: 'cancelled', workflowCancelled: true }).runs, false);
  assert.equal(reporterDecision({ steps: { tests: 'cancelled', callback: 'failure' }, jobResult: 'cancelled', workflowCancelled: true }).runs, false);
  assert.equal(reporterDecision({ steps: {}, jobResult: 'cancelled', workflowCancelled: true }).runs, false, 'cancelled while the container was starting');
  // Even if the image job had already failed, a workflow cancellation keeps the reporter out.
  assert.equal(reporterDecision({ steps: { tests: 'failure', callback: 'failure' }, jobResult: 'failure', workflowCancelled: true }).runs, false);
});

test('reporter: out of non-AssureLayer runs and of the rollback path', () => {
  assert.equal(reporterDecision({ steps: {}, jobResult: 'failure', runId: '' }).runs, false, 'browsers-only dispatch: no AssureLayer run to report to');
  assert.equal(reporterDecision({ steps: {}, jobResult: 'skipped' }).runs, false, 'ASSURELAYER_RUNNER_IMAGE_DISABLED: the image job is skipped');
  assert.equal(reporterDecision({ steps: { tests: 'success', callback: 'success' }, jobResult: 'success' }).runs, false);
});

test('reporter: never executes tests, never uses the image, never runs Playwright', () => {
  const r = job('report-runner-image-failure');
  assert.match(r, /needs: assurelayer/);
  assert.doesNotMatch(r, /playwright test|npx playwright|npm ci|container:/);
  assert.equal((r.match(/run: node scripts\/assurelayer-callback\.js/g) || []).length, 1, 'exactly one callback');
  assert.doesNotMatch(job('assurelayer'), /Execution started|steps\.started/, 'container start alone no longer counts as reported');
});

test('GitHub actions on their Node 24 majors (release notes reviewed); no Node 20 majors left', () => {
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/runner-image.yml']) {
    const uses = [...read(f).matchAll(/uses: (actions\/[\w/-]+)@(v\d+)/g)].map((m) => `${m[1]}@${m[2]}`);
    for (const u of uses) assert.match(u, /^actions\/(checkout@v5|setup-node@v5|cache@v5|cache\/(restore|save)@v5|upload-artifact@v6|download-artifact@v8)$/, `${f}: ${u}`);
  }
});

test('build workflow: retention is report-only; the proposal names the current and proposed digests', () => {
  const wf = read('.github/workflows/runner-image.yml');
  assert.match(wf, /name: Retention report/);
  assert.doesNotMatch(wf, /packages\/container\/[\w-]+\/versions\/\d|delete-package-versions|--method DELETE|-X DELETE/, 'nothing is deleted');
  assert.ok(wf.includes('echo "- current (approved): \\`${old}\\`"'), 'the current approved digest is named');
  assert.ok(wf.includes('echo "- proposed: \\`${REF}\\`"'), 'the proposed digest is named');
  assert.match(wf, /compressed transfer: /);
});
