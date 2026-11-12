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
  assert.match(docker, /^FROM ubuntu:24\.04@sha256:[0-9a-f]{64}$/m, 'base image pinned by digest');
  assert.match(docker, /ARG NODE_VERSION=26\.\d+\.\d+/);
  assert.match(docker, /SHASUMS256\.txt[\s\S]*sha256sum -c -/, 'Node.js archive verified against the release checksums');
  const lock = JSON.parse(read('package-lock.json'));
  assert.match(docker, new RegExp(`ARG PLAYWRIGHT_VERSION=${lock.packages['node_modules/@playwright/test'].version.replace(/\./g, '\\.')}\\b`), 'same Playwright as package-lock.json');
  assert.match(docker, /playwright@\$\{PLAYWRIGHT_VERSION\}" install --with-deps chrome msedge firefox webkit/, 'all four browsers with their OS packages');
  const copies = [...docker.matchAll(/^(COPY|ADD) (.+)$/gm)].map((m) => m[2]);
  assert.deepEqual(copies, ['record-versions.js /usr/local/lib/assurelayer/record-versions.js'], 'nothing from the project is copied in');
  const instructions = docker.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(instructions, /TOKEN|SECRET|PASSWORD|_authToken/i, 'no credential in any instruction');
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
