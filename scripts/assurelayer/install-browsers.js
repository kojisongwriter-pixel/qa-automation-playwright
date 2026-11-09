#!/usr/bin/env node
// Installs EXACTLY the browsers selected for this dispatched run (and their OS
// dependencies) with the repository's pinned Playwright version, before any test
// runs. The selection comes from ASSURELAYER_BROWSERS (written by
// resolve-scope.js) and is validated again here against the same closed list.
//
// Two phases:
//   1. OS packages (apt, as root) and the Playwright-hosted downloads (FFmpeg,
//      Firefox, WebKit, into the browser cache) run at the same time. They share
//      no files or locks, and only the download process touches the browser
//      cache. Both are always awaited, and either failing fails this step.
//   2. Only then: branded Google Chrome and Microsoft Edge, which need apt and so
//      cannot overlap phase 1. This command also names Firefox and WebKit: their
//      downloads are already complete, so it just runs Playwright's host
//      requirements check now that the OS packages exist.
//
// No shell is involved: Playwright is started with an argument array, so a
// value can never be interpreted as a command. A failed installation fails this
// step, so a browser that is not available can never be reported as tested.

const path = require('path');
const { spawn } = require('child_process');
const { parseBrowserSelection } = require('./scope');

const CLI = path.join(__dirname, '..', '..', 'node_modules', '@playwright', 'test', 'cli.js');

/** Same reading of CI as Playwright's own getAsBooleanFromENV. */
function isCi(env) {
  return Boolean(env.CI) && env.CI !== 'false' && env.CI !== '0';
}

/**
 * The Playwright CLI arguments for each operation (exported for tests).
 *
 * Under CI Playwright always runs the branded Chrome / Edge install scripts, so
 * `--force` adds nothing there and would only re-download FFmpeg, Firefox and
 * WebKit. Outside CI it is still what makes Playwright replace a branded browser
 * that is already installed.
 */
function installPlan(selection, env = process.env) {
  const browsers = parseBrowserSelection(selection);
  const branded = browsers.filter((b) => b === 'chrome' || b === 'msedge');
  const hosted = browsers.filter((b) => b === 'firefox' || b === 'webkit');
  return {
    osDeps: ['install-deps', ...browsers],
    downloads: ['install', 'ffmpeg', ...hosted],
    browsers: ['install', ...(branded.length && !isCi(env) ? ['--force'] : []), ...browsers],
  };
}

/** Runs one Playwright CLI command; resolves to its exit code, non-zero on any failure. */
function runPlaywright(args, env, cli = CLI) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit', env });
    child.on('error', (error) => {
      console.error(`assurelayer install-browsers: could not start playwright: ${error.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code === null ? 1 : code));
  });
}

async function main(env = process.env, run = runPlaywright) {
  let plan;
  try {
    plan = installPlan(env.ASSURELAYER_BROWSERS, env);
  } catch (error) {
    console.error(`assurelayer install-browsers: ${error.message}`);
    return 1;
  }

  const step = async (name, args, stepEnv) => {
    const startedAt = Date.now();
    console.log(`assurelayer install-browsers: [${name}] playwright ${args.join(' ')}`);
    const code = await run(args, stepEnv);
    console.log(`assurelayer install-browsers: [${name}] exit ${code} after ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
    return { name, code };
  };

  // The check that ends `playwright install` would run before apt has finished,
  // so it is left to the phase 2 command.
  const downloadEnv = { ...env, PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: '1' };
  const results = await Promise.all([step('os-deps', plan.osDeps, env), step('downloads', plan.downloads, downloadEnv)]);
  if (results.every((r) => r.code === 0)) results.push(await step('browsers', plan.browsers, env));

  const failed = results.filter((r) => r.code !== 0).map((r) => r.name);
  if (failed.length) {
    console.error(`assurelayer install-browsers: installation failed (${failed.join(', ')})`);
    return 3;
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { installPlan, runPlaywright, main };
