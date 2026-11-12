#!/usr/bin/env node
// Runner image check (dispatched runs in the prebuilt runner image). Before any
// test runs, proves the image matches this repository: the Node.js major the
// workflow requires, the Playwright version in package-lock.json, and — for each
// SELECTED browser — the executable the tests will use (branded Chrome / Edge, or
// Playwright's Firefox / WebKit build at the exact revision this Playwright
// expects), plus FFmpeg for video. Any mismatch fails the step, so a run can
// never silently test with browsers its Playwright was not built for.
//
// It also records the image (configured reference + the build record baked into
// the image) in runner-image-record/ — uploaded with the test results as the
// run's evidence (Playwright empties test-results/ when it starts) — and in the
// workflow log.

const fs = require('fs');
const path = require('path');
const { parseBrowserSelection } = require('./scope');

const REQUIRED_NODE_MAJOR = 26;
const BRANDED = { chrome: '/opt/google/chrome/chrome', msedge: '/opt/microsoft/msedge/msedge' };

/**
 * Pure check (exported for tests). `revisions` are the revisions this
 * repository's Playwright expects (playwright-core/browsers.json).
 */
function checkRunnerImage({ record, selection, nodeVersion, repoPlaywright, revisions, exists }) {
  const problems = [];
  const browsers = parseBrowserSelection(selection);
  if (!record) return { browsers, problems: ['the image has no build record (/etc/assurelayer-runner-image.json)'] };
  if (Number(String(nodeVersion).replace(/^v/, '').split('.')[0]) !== REQUIRED_NODE_MAJOR) problems.push(`Node.js ${nodeVersion} is not Node ${REQUIRED_NODE_MAJOR}`);
  if (record.playwright !== repoPlaywright) problems.push(`the image was built for Playwright ${record.playwright}, this repository uses ${repoPlaywright}`);
  const browsersPath = record.browsers_path;
  const hosted = (name) => {
    const expected = revisions[name];
    const built = record[name] && record[name].playwright_revision;
    if (built !== expected) problems.push(`${name}: the image has revision ${built}, Playwright ${repoPlaywright} expects ${expected}`);
    else if (!exists(path.join(browsersPath, `${name}-${expected}`))) problems.push(`${name}: ${name}-${expected} is missing from ${browsersPath}`);
  };
  for (const b of browsers) {
    if (BRANDED[b]) {
      if (!exists(BRANDED[b])) problems.push(`${b}: ${BRANDED[b]} is missing`);
      if (!record[b]) problems.push(`${b}: no version recorded`);
    } else {
      hosted(b);
    }
  }
  hosted('ffmpeg');
  return { browsers, problems };
}

function main(env = process.env) {
  const recordPath = env.ASSURELAYER_RUNNER_RECORD || '/etc/assurelayer-runner-image.json';
  const record = fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8')) : null;
  const root = path.join(__dirname, '..', '..');
  const repoPlaywright = require(path.join(root, 'node_modules', '@playwright', 'test', 'package.json')).version;
  const revisions = Object.fromEntries(require(path.join(root, 'node_modules', 'playwright-core', 'browsers.json')).browsers.map((b) => [b.name, b.revision]));

  let result;
  try {
    result = checkRunnerImage({ record, selection: env.ASSURELAYER_BROWSERS, nodeVersion: process.version, repoPlaywright, revisions, exists: fs.existsSync });
  } catch (error) {
    console.error(`assurelayer runner image: ${error.message}`);
    return 1;
  }

  const summary = { configured_image: env.ASSURELAYER_RUNNER_IMAGE || null, record, selected_browsers: result.browsers, problems: result.problems };
  console.log(`assurelayer runner image: ${summary.configured_image}`);
  if (record) {
    console.log(`  built ${record.build_date} from ${record.source_commit} · ${record.os} · Node ${record.node} · Playwright ${record.playwright}`);
    console.log(`  Chrome ${record.chrome} · Edge ${record.msedge} · Firefox ${record.firefox && record.firefox.version} (r${record.firefox && record.firefox.playwright_revision}) · WebKit r${record.webkit && record.webkit.playwright_revision} · FFmpeg r${record.ffmpeg && record.ffmpeg.playwright_revision}`);
  }
  fs.mkdirSync(path.join(root, 'runner-image-record'), { recursive: true });
  fs.writeFileSync(path.join(root, 'runner-image-record', 'assurelayer-runner-image.json'), `${JSON.stringify(summary, null, 2)}\n`);

  if (result.problems.length) {
    for (const p of result.problems) console.error(`assurelayer runner image: ${p}`);
    return 2;
  }
  console.log(`assurelayer runner image: OK for ${result.browsers.join(', ')}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { checkRunnerImage, main };
