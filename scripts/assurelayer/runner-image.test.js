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
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

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
