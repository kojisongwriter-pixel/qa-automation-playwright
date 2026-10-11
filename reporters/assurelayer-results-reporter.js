// AssureLayer results collector — a minimal Playwright reporter that records the
// FINAL outcome of every test in the run (passed / failed / skipped, plus how
// many retries were used). It performs NO failure classification: failure
// details come exclusively from qa-platform-core's own FailureReporter (its
// validated Failure Contracts), which is enabled alongside this reporter.
//
// Browser identity: every result carries the Playwright project that produced
// it (browserProject — one of chrome, msedge, firefox, webkit; null for the
// browser-independent `api` project) and a testKey: the project-independent
// identity of the logical test (file + title path), so the same test executed
// on several browsers can be grouped. testId stays Playwright's own id, which
// already differs per project — one result per test per browser.
//
// Enabled only for AssureLayer-dispatched runs (see playwright.config.js), so
// push / pull_request executions are unaffected.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BROWSERS } = require('../scripts/assurelayer/scope');

const OUTPUT_FILE = path.join('test-results', 'assurelayer', 'results.json');

function finalStatus(test) {
  // Playwright's own verdict after retries: expected | unexpected | flaky | skipped.
  switch (test.outcome()) {
    case 'expected':
    case 'flaky': // failed at least once but ultimately passed on retry
      return 'passed';
    case 'skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

function browserProjectOf(test) {
  const project = test.parent.project();
  const name = project ? project.name : null;
  return BROWSERS.includes(name) ? name : null;
}

// titlePath() = ['', <project name>, <file>, ...describe titles, <test title>]:
// dropping the first two entries leaves an identity that is the same on every browser.
function testKeyOf(test) {
  const logical = test.titlePath().slice(2).join('\u001e');
  return crypto.createHash('sha256').update(logical).digest('hex').slice(0, 40);
}

class AssureLayerResultsReporter {
  constructor() {
    this.tests = new Map();
  }

  onBegin() {
    this.tests.clear();
  }

  onTestEnd(test, result) {
    // Called once per attempt; the last call for a test carries the final retry index.
    this.tests.set(test.id, { test, retry: result.retry });
  }

  onEnd() {
    const results = [];
    for (const { test, retry } of this.tests.values()) {
      results.push({
        testId: test.id,
        title: test.title,
        status: finalStatus(test),
        retryCount: retry,
        browserProject: browserProjectOf(test),
        testKey: testKeyOf(test),
      });
    }
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ version: '1.0.0', results }, null, 2));
  }
}

module.exports = AssureLayerResultsReporter;
