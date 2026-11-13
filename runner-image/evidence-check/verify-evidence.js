#!/usr/bin/env node
// Checks the evidence check's output: for each of the four browsers, a failure
// screenshot (.png) and video (.webm) and, from the retry, a trace (trace.zip).
// Exit 2 when anything is missing.

const fs = require('fs');
const path = require('path');

const BROWSERS = ['chrome', 'msedge', 'firefox', 'webkit'];

/** Pure check (exported for tests): `files` are paths relative to the output directory. */
function checkEvidence(files) {
  const rows = BROWSERS.map((browser) => {
    // Playwright names each test's folder "<test>-<project>" and the retry "<test>-<project>-retry1".
    const mine = files.filter((f) => new RegExp(`-${browser}(-retry\\d+)?[\\\\/]`).test(f));
    return {
      browser,
      screenshot: mine.some((f) => f.endsWith('.png')),
      video: mine.some((f) => f.endsWith('.webm')),
      trace: mine.some((f) => /-retry\d+[\\/]/.test(f) && f.endsWith('trace.zip')),
    };
  });
  const missing = rows.flatMap((r) => ['screenshot', 'video', 'trace'].filter((k) => !r[k]).map((k) => `${r.browser}: no ${k}`));
  return { rows, missing };
}

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]));
}

if (require.main === module) {
  const out = process.env.EVIDENCE_OUT || '/tmp/assurelayer-evidence-check';
  const { rows, missing } = checkEvidence(walk(out));
  for (const r of rows) console.log(`evidence ${r.browser.padEnd(8)} screenshot=${r.screenshot} video=${r.video} trace=${r.trace}`);
  if (missing.length) {
    console.error(`evidence check failed: ${missing.join('; ')}`);
    process.exitCode = 2;
  } else {
    console.log('evidence check: screenshots, videos and retry traces produced in all four browsers');
  }
}

module.exports = { checkEvidence };
