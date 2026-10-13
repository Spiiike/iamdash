'use strict';
// Reads the LAB_* settings main.bicep already merges into wetcliff.
function loadDashboardConfig(env = process.env, overrides = {}) {
  const key = env.LAB_OPERATOR_KEY || '';
  const cfg = {
    lifecycleEndpoint: (env.LAB_LIFECYCLE_ENDPOINT || '').replace(/\/+$/, ''),
    operatorHeader: (env.LAB_OPERATOR_HEADER || 'x-lab-operator-key').toLowerCase(),
    operatorKey: key,
    scenarioContainerUrl: env.LAB_SYNTHETIC_SCENARIO_CONTAINER || '',
    listLimit: 25,
    listTtlMs: 5000, // list is shared by every visitor for 5 s
    liveTtlMs: 3000, // an operation still running
    doneTtlMs: 60000, // a finished operation does not change
    upstreamTimeoutMs: 8000,
    demoTimeoutMs: 60000, // a hire waits for Okta's SCIM push
    demoEnabled: (env.DEMO_ENABLED || 'true').toLowerCase() === 'true',
    demoPerIpCooldownMs: 10 * 60 * 1000,
    demoGlobalPerHour: 20,
    ...overrides,
  };
  cfg.liveProblems = [];
  if (!cfg.lifecycleEndpoint) cfg.liveProblems.push('LAB_LIFECYCLE_ENDPOINT is not set');
  if (!key) cfg.liveProblems.push('LAB_OPERATOR_KEY is not set');
  if (key.startsWith('@Microsoft.KeyVault')) cfg.liveProblems.push("LAB_OPERATOR_KEY Key Vault reference did not resolve; check wetcliff's identity has Key Vault Secrets User");
  if (key.startsWith('SET-ME-')) cfg.liveProblems.push('LAB_OPERATOR_KEY is a SET-ME- placeholder');
  cfg.liveEnabled = cfg.liveProblems.length === 0;
  return cfg;
}

module.exports = { loadDashboardConfig };
