#!/usr/bin/env node
// Installs EXACTLY the browsers selected for this dispatched run (and their OS
// dependencies) with the repository's pinned Playwright version, before any test
// runs. The selection comes from ASSURELAYER_BROWSERS (written by
// resolve-scope.js) and is validated again here against the same closed list.
//
// No shell is involved: Playwright is started with an argument array, so a
// value can never be interpreted as a command. Branded Google Chrome and
// Microsoft Edge are installed explicitly (`--force` reinstalls the stable
// channel even when the runner image already ships one, so the version used is
// the one Playwright installed now). A failed installation fails this step,
// so a browser that is not available can never be reported as tested.

const path = require('path');
const { spawnSync } = require('child_process');
const { parseBrowserSelection } = require('./scope');

/** The Playwright CLI arguments for a selection (exported for tests). */
function installArgs(selection) {
  const browsers = parseBrowserSelection(selection);
  const branded = browsers.filter((b) => b === 'chrome' || b === 'msedge');
  return ['install', '--with-deps', ...(branded.length ? ['--force'] : []), ...browsers];
}

function main(env = process.env) {
  let args;
  try {
    args = installArgs(env.ASSURELAYER_BROWSERS);
  } catch (error) {
    console.error(`assurelayer install-browsers: ${error.message}`);
    return 1;
  }
  const cli = path.join(__dirname, '..', '..', 'node_modules', '@playwright', 'test', 'cli.js');
  console.log(`assurelayer install-browsers: playwright ${args.join(' ')}`);
  const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`assurelayer install-browsers: installation failed (exit ${r.status})`);
    return 3;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { installArgs, main };
