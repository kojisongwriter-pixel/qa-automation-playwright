#!/usr/bin/env node
// AssureLayer results callback — runs as the last workflow step of an
// AssureLayer-dispatched execution (workflow_dispatch only).
//
//   1. Assemble ONE complete result batch (scripts/assurelayer/buildPayload.js).
//   2. Request a FRESH GitHub Actions OIDC token, audience = the AssureLayer
//      audience, immediately before every attempt. The token is masked in logs,
//      never written to disk, and sent only as the Authorization bearer.
//   3. POST it to {ASSURELAYER_API_URL}/api/runs/{ASSURELAYER_RUN_ID}/results.
//      The batch is idempotent and RESUMABLE server-side, so retrying is safe.
//
// RETRY POLICY (bounded — permanent identity failures are never retried forever):
//   * HTTP 5xx, including the server's 503 `processing_budget_exhausted` /
//     `processing_in_progress` ("saved what fit, retry to resume"), honoring
//     Retry-After                                        -> retry
//   * network failure / timeout                          -> retry
//   * HTTP 403 `run_not_bound` (the dispatch's binding may not be stored yet —
//     a narrow, plausible race)                          -> retry, at most
//                                                           MAX_NOT_BOUND_RETRIES times
//   * every other 4xx (wrong run/repo/workflow/attempt, malformed, conflict)
//                                                        -> permanent: fail now
// Total attempts are capped at MAX_ATTEMPTS.
//
// Exit code is non-zero if the callback could not be delivered/accepted. This
// step runs with `if: always()`, but it can never turn a failed Playwright run
// green: the Playwright step's own failure already fails the job.

const path = require('path');
const { buildPayload } = require('./assurelayer/buildPayload');

const RESULTS_FILE = path.join('test-results', 'assurelayer', 'results.json');
const FAILURES_DIR = path.join('test-results', 'failures');

// MUST equal CLIENT_MAX_ATTEMPTS in the dashboard's lib/runs/processing-limits.ts:
// the server's per-run Analyst workload cap is derived from it.
const MAX_ATTEMPTS = 8;
const MAX_NOT_BOUND_RETRIES = 5;
const NOT_BOUND_DELAY_MS = 5000;
const MAX_RETRY_AFTER_MS = 30000;
const REQUEST_TIMEOUT_MS = 280000; // the server processes the batch inline (its budget is 240 s)

// Default backoff between generic retries (ms). Overridable (comma-separated)
// only so the behavior can be tested quickly; when overridden it also replaces
// the Retry-After and run_not_bound delays.
const DEFAULT_DELAYS_MS = [2000, 5000, 10000, 15000, 15000, 15000, 15000];
const OVERRIDE_DELAYS_MS = process.env.ASSURELAYER_RETRY_DELAYS_MS
  ? process.env.ASSURELAYER_RETRY_DELAYS_MS.split(',').map(Number)
  : null;

function delayFor(attemptIndex, hint) {
  if (OVERRIDE_DELAYS_MS) return OVERRIDE_DELAYS_MS[Math.min(attemptIndex, OVERRIDE_DELAYS_MS.length - 1)];
  if (hint !== undefined) return hint;
  return DEFAULT_DELAYS_MS[Math.min(attemptIndex, DEFAULT_DELAYS_MS.length - 1)];
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`assurelayer-callback: missing required environment variable ${name}`);
    process.exit(2);
  }
  return value;
}

async function fetchOidcToken(audience) {
  const requestUrl = requireEnv('ACTIONS_ID_TOKEN_REQUEST_URL');
  const requestToken = requireEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN');
  const url = `${requestUrl}${requestUrl.includes('?') ? '&' : '?'}audience=${encodeURIComponent(audience)}`;
  const response = await fetch(url, { headers: { Authorization: `bearer ${requestToken}` } });
  if (!response.ok) {
    await response.text().catch(() => {}); // release the connection
    throw new Error(`OIDC token request failed with HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!body || typeof body.value !== 'string' || body.value.length === 0) {
    throw new Error('OIDC token response contained no token');
  }
  return body.value;
}

async function postOnce(url, token, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function errorCodeOf(text) {
  try {
    const code = JSON.parse(text)?.error?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

function retryAfterMs(response) {
  const seconds = Number(response.headers.get('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const runId = requireEnv('ASSURELAYER_RUN_ID');
  const apiUrl = requireEnv('ASSURELAYER_API_URL').replace(/\/+$/, '');
  const audience = requireEnv('ASSURELAYER_OIDC_AUDIENCE');

  const { payload, problems } = buildPayload({
    resultsFile: RESULTS_FILE,
    failuresDir: FAILURES_DIR,
    playwrightOutcome: process.env.PLAYWRIGHT_OUTCOME,
  });
  for (const problem of problems) console.warn(`assurelayer-callback: ${problem}`);
  console.log(
    `assurelayer-callback: sending ${payload.results.length} result(s), execution_status=${payload.execution_status}`
  );

  const url = `${apiUrl}/api/runs/${encodeURIComponent(runId)}/results`;

  let lastError = null;
  let notBoundRetries = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let waitMs;
    try {
      // A fresh token for every attempt: OIDC tokens are short-lived.
      const token = await fetchOidcToken(audience);
      console.log(`::add-mask::${token}`);

      const response = await postOnce(url, token, payload);
      const text = await response.text();

      if (response.ok) {
        console.log(`assurelayer-callback: accepted (HTTP ${response.status}) ${text}`);
        return 0;
      }
      console.error(`assurelayer-callback: attempt ${attempt + 1}/${MAX_ATTEMPTS} not accepted (HTTP ${response.status}) ${text}`);
      const code = errorCodeOf(text);

      if (response.status >= 500) {
        // includes the resumable 503s: completed work is already saved server-side
        lastError = new Error(`HTTP ${response.status}${code ? ` ${code}` : ''}`);
        waitMs = delayFor(attempt, retryAfterMs(response));
      } else if (response.status === 403 && code === 'run_not_bound' && notBoundRetries < MAX_NOT_BOUND_RETRIES) {
        notBoundRetries += 1;
        lastError = new Error('HTTP 403 run_not_bound');
        waitMs = delayFor(attempt, NOT_BOUND_DELAY_MS);
      } else {
        // Every other 4xx is a definitive answer: retrying cannot help.
        return 1;
      }
    } catch (error) {
      lastError = error;
      console.error(`assurelayer-callback: attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${error.name}: ${error.message}`);
      waitMs = delayFor(attempt);
    }

    if (attempt < MAX_ATTEMPTS - 1) await sleep(waitMs);
  }

  console.error(`assurelayer-callback: giving up after ${MAX_ATTEMPTS} attempts (${lastError && lastError.message})`);
  return 1;
}

if (require.main === module) {
  // Set exitCode and let the event loop drain rather than calling
  // process.exit(): forcing an exit while fetch keep-alive sockets are still
  // open can abort the process on Windows (exit code 0xC0000409) and mask the
  // real result.
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`assurelayer-callback: unexpected error: ${error.name}: ${error.message}`);
      process.exitCode = 1;
    }
  );
}

module.exports = { main, MAX_ATTEMPTS, MAX_NOT_BOUND_RETRIES };
