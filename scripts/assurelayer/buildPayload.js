// Builds the AssureLayer results-callback payload (contract version 1.0.0):
//
//   { version, execution_status, results: [{ test_id, test_title, status,
//     retry_count, failure }], execution_error }
//
// It only ASSEMBLES what the run already produced:
//   - per-test outcomes from the results collector reporter, and
//   - Failure Contracts exactly as qa-platform-core's FailureReporter wrote
//     them (test-results/failures/*.json).
// No failure classification happens here and no second failure schema exists.

const fs = require('fs');
const path = require('path');

const CALLBACK_VERSION = '1.0.0';

function readJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}

// A test can produce several Failure Contracts (one per failed attempt).
// The FINAL failed attempt (highest retryCount) is the one that represents it.
function latestContractByTestId(contracts) {
  const byTest = new Map();
  for (const contract of contracts) {
    const current = byTest.get(contract.testId);
    if (!current || contract.retryCount >= current.retryCount) byTest.set(contract.testId, contract);
  }
  return byTest;
}

/**
 * @param {{ resultsFile: string, failuresDir: string, playwrightOutcome: string }} input
 * @returns {{ payload: object, problems: string[] }}
 */
function buildPayload({ resultsFile, failuresDir, playwrightOutcome }) {
  const problems = [];

  // success -> passed, failure -> failed, anything else (cancelled/skipped/undefined) -> error.
  let executionStatus =
    playwrightOutcome === 'success' ? 'passed' : playwrightOutcome === 'failure' ? 'failed' : 'error';
  let executionError = null;

  if (!fs.existsSync(resultsFile)) {
    problems.push('The results collector produced no results file (the run may have crashed before any test ended).');
    return {
      payload: {
        version: CALLBACK_VERSION,
        execution_status: 'error',
        results: [],
        execution_error: problems.join(' '),
      },
      problems,
    };
  }

  const collected = JSON.parse(fs.readFileSync(resultsFile, 'utf8')).results || [];
  const contracts = latestContractByTestId(readJsonFiles(failuresDir));

  const results = [];
  for (const entry of collected) {
    if (entry.status === 'failed') {
      const failure = contracts.get(entry.testId);
      if (!failure) {
        // Never fabricate a Failure Contract. Report the gap honestly: the run
        // is sent as an execution error and the test is left out of the batch.
        problems.push(`No Failure Contract was produced for failed test ${entry.testId}.`);
        continue;
      }
      results.push({
        test_id: entry.testId,
        test_title: entry.title ?? null,
        status: 'failed',
        retry_count: entry.retryCount,
        failure,
      });
    } else {
      results.push({
        test_id: entry.testId,
        test_title: entry.title ?? null,
        status: entry.status,
        retry_count: entry.retryCount,
        failure: null,
      });
    }
  }

  if (problems.length > 0) {
    executionStatus = 'error';
    executionError = problems.join(' ').slice(0, 4000);
  }

  return {
    payload: {
      version: CALLBACK_VERSION,
      execution_status: executionStatus,
      results,
      execution_error: executionError,
    },
    problems,
  };
}

module.exports = { buildPayload, latestContractByTestId, CALLBACK_VERSION };
