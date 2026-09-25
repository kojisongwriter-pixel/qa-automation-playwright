// AssureLayer results collector — a minimal Playwright reporter that records the
// FINAL outcome of every test in the run (passed / failed / skipped, plus how
// many retries were used). It performs NO failure classification: failure
// details come exclusively from qa-platform-core's own FailureReporter (its
// validated Failure Contracts), which is enabled alongside this reporter.
//
// Enabled only for AssureLayer-dispatched runs (see playwright.config.js), so
// push / pull_request executions are unaffected.

const fs = require('fs');
const path = require('path');

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
      });
    }
    fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ version: '1.0.0', results }, null, 2));
  }
}

module.exports = AssureLayerResultsReporter;
