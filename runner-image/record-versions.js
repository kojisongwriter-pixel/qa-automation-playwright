#!/usr/bin/env node
// Prints the runner image's build record (JSON): build metadata and the exact
// versions of everything a run depends on. Runs at image build time only.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const version = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright';
// Playwright's own browser directories, e.g. firefox-1532, webkit-2311, ffmpeg-1011.
const revision = (name) => {
  const dir = fs.readdirSync(browsersPath).find((d) => d.startsWith(`${name}-`));
  if (!dir) throw new Error(`${name} is not installed under ${browsersPath}`);
  return dir.slice(name.length + 1);
};
const firefoxIni = fs.readFileSync(path.join(browsersPath, `firefox-${revision('firefox')}`, 'firefox', 'application.ini'), 'utf8');

// Security-relevant OS packages, by exact Debian version (missing ones are omitted).
const PACKAGES = ['libc6', 'libc-bin', 'libgstreamer1.0-0', 'gstreamer1.0-plugins-bad', 'libgstreamer-plugins-bad1.0-0', 'openssl', 'libssl3t64'];
// dpkg-query exits non-zero when any listed package is absent; its output still lists the present ones.
const packages = Object.fromEntries(
  spawnSync('dpkg-query', ['-W', '-f', '${Package} ${Version}\\n', ...PACKAGES], { encoding: 'utf8' })
    .stdout.split('\n')
    .map((l) => l.trim().split(' '))
    .filter(([name, ver]) => name && ver)
);

const record = {
  image: 'assurelayer-runner',
  build_date: process.env.BUILD_DATE || 'unknown',
  source_commit: process.env.SOURCE_COMMIT || 'unknown',
  // The exact base image (tag@digest) it was built FROM. The image's own digest is
  // known only after the push; the in-job check records it with the run.
  base_image: process.env.BASE_IMAGE || 'unknown',
  os: version('bash', ['-c', '. /etc/os-release && echo "$PRETTY_NAME"']),
  packages,
  node: process.version.replace(/^v/, ''),
  npm: version('npm', ['--version']),
  playwright: process.env.PLAYWRIGHT_VERSION,
  browsers_path: browsersPath,
  chrome: version('google-chrome', ['--version']).replace(/^Google Chrome /, ''),
  msedge: version('microsoft-edge-stable', ['--version']).replace(/^Microsoft Edge /, ''),
  firefox: { version: (firefoxIni.match(/^Version=(.+)$/m) || [])[1], playwright_revision: revision('firefox') },
  webkit: { playwright_revision: revision('webkit') },
  ffmpeg: { playwright_revision: revision('ffmpeg') },
};
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
