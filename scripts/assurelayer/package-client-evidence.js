// AssureLayer client-safe evidence package (Phase 1 — Client Evidence Security).
//
// Builds client-evidence/ — uploaded as the GitHub Actions artifact
// client-evidence-<run id>, the ONLY archive the AssureLayer portal delivers to
// client organization members — from the run's test-results/ directory, by an
// explicit ALLOW-LIST. Nothing is copied by directory; every file is chosen
// individually, validated, and listed in the manifest:
//
//   <test dir>/test-failed-N.png   Playwright's failure screenshots
//   <test dir>/video.webm          Playwright's retained failure videos
//   <test dir>/video-N.webm          (one per page)
//   ...plus any screenshot / video a Failure Contract names, if it is an image
//   or video directly inside a per-test directory.
//   assurelayer/results.json       SANITIZED: only testId, title, status,
//                                  retryCount, browserProject, testKey
//   assurelayer/manifest.json      what is included (path, test, browser,
//                                  attempt, size, SHA-256) and the run identity
//
// Never included (internal diagnostics): confidence/, decision/, failures/,
// flaky/, severity/ and every other internal directory, error-context dumps,
// traces, test source, anything that is not a regular file (symbolic links),
// anything nested deeper than one per-test directory.
//
// Paths keep their test-results/-relative form, so the portal's stored
// evidence paths resolve inside this package. The output is deterministic:
// the same input always produces the same files and the same manifest.
//
// The complete raw test-results/ directory is still uploaded unchanged as
// test-results-<run id> by the workflow (internal; never linked by the portal).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BROWSERS } = require('./scope');

const PACKAGE_VERSION = '1.0.0';
/** Directories qa-platform-core and AssureLayer write inside test-results/ — internal, never packaged. */
const INTERNAL_DIRS = ['assurelayer', 'confidence', 'decision', 'failures', 'flaky', 'severity'];
const PLAYWRIGHT_MEDIA = [/^test-failed-\d+\.png$/, /^video(-\d+)?\.webm$/];
const MEDIA_KIND = { '.png': 'screenshot', '.jpg': 'screenshot', '.jpeg': 'screenshot', '.webm': 'video', '.mp4': 'video' };
/** Largest single media file packaged (larger files are listed as omitted, never truncated). */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const RESULT_FIELDS = { testId: 'string', title: 'string', status: 'string', retryCount: 'number', browserProject: 'string', testKey: 'string' };
const STATUSES = new Set(['passed', 'failed', 'skipped']);

/** test-results/-relative path of a runner path (absolute or relative), or null. Mirrors the portal's mapping. */
function pathInTestResults(runnerPath) {
  if (typeof runnerPath !== 'string' || runnerPath.length === 0) return null;
  const normalized = runnerPath.replace(/\\/g, '/');
  let rel;
  if (normalized.startsWith('test-results/')) rel = normalized.slice('test-results/'.length);
  else {
    const at = normalized.indexOf('/test-results/');
    if (at < 0) return null;
    rel = normalized.slice(at + '/test-results/'.length);
  }
  return rel || null;
}

/**
 * The media kind of a relative path when it is allowed into the package:
 * exactly "<per-test directory>/<file>", safe segments, not an internal
 * directory, an image / video extension. Otherwise null.
 */
function allowedMedia(rel) {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512) return null;
  if (rel.startsWith('/') || rel.includes('\\') || /[\u0000-\u001f]/.test(rel)) return null;
  const segments = rel.split('/');
  if (segments.length !== 2) return null;
  const [dir, file] = segments;
  if ([dir, file].some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return null;
  if (INTERNAL_DIRS.includes(dir)) return null;
  return MEDIA_KIND[path.extname(file).toLowerCase()] || null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** results.json reduced to the allow-listed fields, with types checked (anything else is dropped). */
function sanitizeResults(raw) {
  const entries = raw && Array.isArray(raw.results) ? raw.results : [];
  const results = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const out = {};
    for (const [field, type] of Object.entries(RESULT_FIELDS)) {
      const value = entry[field];
      out[field] = typeof value === type ? value : null;
    }
    if (typeof out.testId !== 'string' || !STATUSES.has(out.status)) continue;
    if (out.browserProject !== null && !BROWSERS.includes(out.browserProject)) out.browserProject = null;
    if (out.title !== null) out.title = out.title.slice(0, 500);
    results.push(out);
  }
  results.sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0));
  return { version: '1.0.0', results };
}

/** Playwright names per-test directories "<slug>-<project>[-retryN]": attempt + browser from the name. */
function fromDirectoryName(dir) {
  const retry = /-retry(\d+)$/.exec(dir);
  const base = retry ? dir.slice(0, -retry[0].length) : dir;
  const browser = BROWSERS.find((b) => base.endsWith(`-${b}`)) || null;
  return { retry: retry ? Number(retry[1]) : 0, browserProject: browser };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * @param {{ sourceDir: string, outDir: string, run?: { githubRunId?: string|null, runAttempt?: string|null, assurelayerRunId?: string|null } }} input
 * @returns {{ manifest: object }}
 */
function packageClientEvidence({ sourceDir, outDir, run = {} }) {
  const source = path.resolve(sourceDir);
  const out = path.resolve(outDir);
  if (out === source || out.startsWith(source + path.sep) || source.startsWith(out + path.sep)) {
    throw new Error('The client evidence package must be written outside test-results/.');
  }
  // Built under a temporary name and renamed only when complete: a failure
  // part-way can never leave a partial package to be uploaded.
  const building = `${out}.partial`;
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(building, { recursive: true, force: true });
  const manifest = build(source, building, run);
  fs.renameSync(building, out);
  return { manifest };
}

function build(source, out, run) {
  fs.mkdirSync(path.join(out, 'assurelayer'), { recursive: true });

  const results = sanitizeResults(readJson(path.join(source, 'assurelayer', 'results.json')));
  const resultById = new Map(results.results.map((r) => [r.testId, r]));

  // Failure Contracts (every attempt): which test each referenced file belongs to.
  const owner = new Map();
  const failuresDir = path.join(source, 'failures');
  const contractFiles = fs.existsSync(failuresDir) ? fs.readdirSync(failuresDir).filter((n) => n.endsWith('.json')).sort() : [];
  for (const name of contractFiles) {
    const contract = readJson(path.join(failuresDir, name));
    if (!contract || typeof contract.testId !== 'string') continue;
    for (const kind of ['screenshot', 'video']) {
      const rel = pathInTestResults(contract.artifacts && contract.artifacts[kind]);
      if (rel && allowedMedia(rel) === kind) owner.set(rel, { testId: contract.testId, retry: typeof contract.retryCount === 'number' ? contract.retryCount : null });
    }
  }

  // Candidates: Playwright's own failure media in each per-test directory + contract-named media.
  const candidates = new Set(owner.keys());
  for (const dirent of fs.existsSync(source) ? fs.readdirSync(source, { withFileTypes: true }) : []) {
    if (!dirent.isDirectory() || INTERNAL_DIRS.includes(dirent.name)) continue;
    for (const file of fs.readdirSync(path.join(source, dirent.name), { withFileTypes: true })) {
      if (file.isFile() && PLAYWRIGHT_MEDIA.some((re) => re.test(file.name))) candidates.add(`${dirent.name}/${file.name}`);
    }
  }

  const files = [];
  const omitted = [];
  for (const rel of [...candidates].sort()) {
    const kind = allowedMedia(rel);
    if (!kind) continue;
    const from = path.join(source, ...rel.split('/'));
    let stat;
    try {
      stat = fs.lstatSync(from);
    } catch {
      continue; // named by a contract but not on disk
    }
    if (!stat.isFile()) continue; // symbolic links and anything not a regular file are never followed
    if (stat.size > MAX_FILE_BYTES) {
      omitted.push({ path: rel, reason: 'too_large', sizeBytes: stat.size });
      continue;
    }
    const to = path.join(out, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    const dir = fromDirectoryName(rel.split('/')[0]);
    const contract = owner.get(rel) || null;
    const result = contract ? resultById.get(contract.testId) : null;
    files.push({
      path: rel,
      kind,
      testId: contract ? contract.testId : null,
      title: result ? result.title : null,
      browserProject: (result && result.browserProject) || dir.browserProject,
      retry: contract && contract.retry !== null ? contract.retry : dir.retry,
      sizeBytes: stat.size,
      sha256: sha256(to),
    });
  }

  const manifest = {
    version: PACKAGE_VERSION,
    package: 'client-safe-evidence',
    run: {
      githubRunId: run.githubRunId || null,
      runAttempt: run.runAttempt || null,
      assurelayerRunId: run.assurelayerRunId || null,
    },
    contents: 'Failure screenshots and videos, and sanitized test results. Internal diagnostic files (traces, error context, test source and internal assessment data) are excluded.',
    results: 'assurelayer/results.json',
    files,
    omitted,
  };
  fs.writeFileSync(path.join(out, 'assurelayer', 'results.json'), JSON.stringify(results, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'assurelayer', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

module.exports = { packageClientEvidence, sanitizeResults, allowedMedia, pathInTestResults, INTERNAL_DIRS, PACKAGE_VERSION };

/**
 * Workflow entry point. It never fails the job: on any error the (partial)
 * package is removed and a warning is printed, so no client-evidence artifact
 * is uploaded and the portal offers no evidence archive - fail closed, never
 * the raw test-results archive instead.
 */
function main(env = process.env, cwd = process.cwd()) {
  const outDir = path.join(cwd, 'client-evidence');
  try {
    const { manifest } = packageClientEvidence({
      sourceDir: path.join(cwd, 'test-results'),
      outDir,
      run: { githubRunId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, assurelayerRunId: env.ASSURELAYER_RUN_ID },
    });
    const count = (kind) => manifest.files.filter((f) => f.kind === kind).length;
    console.log(`Client-safe evidence package: ${count('screenshot')} screenshot(s), ${count('video')} video(s), sanitized results; ${manifest.omitted.length} omitted.`);
    return true;
  } catch (err) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(`${outDir}.partial`, { recursive: true, force: true });
    console.log(`::warning::The client-safe evidence package could not be built (${String(err && err.message).slice(0, 200)}). No evidence package is uploaded; test results are unaffected.`);
    return false;
  }
}

module.exports.main = main;

if (require.main === module) main();
