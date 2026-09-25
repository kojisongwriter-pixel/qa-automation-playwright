const { createEnvironments } = require('@kojisongwriter-pixel/qa-platform-core');

const environments = createEnvironments({
  local:      'https://playwright.dev',
  staging:    'https://playwright.dev',
  production: 'https://playwright.dev',
});

const ENV = process.env.ENV || 'local';

if (!environments[ENV]) {
  throw new Error(
    `Unknown environment: "${ENV}". Valid options: ${Object.keys(environments).join(', ')}`
  );
}

module.exports = environments[ENV];
