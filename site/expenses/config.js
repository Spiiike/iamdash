'use strict';

// Reads the settings main.bicep already merges into wetcliff (EXPENSES_OIDC_*,
// LAB_TABLE_*), plus LAB_STORAGE_ACCOUNT added for milestone 3.
function trimSlash(s) {
  return (s || '').replace(/\/+$/, '');
}

function loadConfig(env = process.env, overrides = {}) {
  const baseUrl = trimSlash(env.EXPENSES_BASE_URL || env.EXPENSES_OIDC_POST_LOGOUT_REDIRECT_URI);
  const cfg = {
    // Bicep sets this to https://<org>/oauth2/default (the default custom
    // authorization server). The issuer must match discovery exactly.
    issuer: trimSlash(env.EXPENSES_OIDC_AUTHORITY || env.OKTA_ORG_URL),
    clientId: env.EXPENSES_OIDC_CLIENT_ID,
    clientSecret: env.EXPENSES_OIDC_CLIENT_SECRET,
    baseUrl, // public URL of the mount point, e.g. https://wetcliff.azurewebsites.net/labs/identity/expenses
    redirectUri: env.EXPENSES_OIDC_REDIRECT_URI || (baseUrl && `${baseUrl}/auth/callback`),
    postLogoutRedirectUri: env.EXPENSES_OIDC_POST_LOGOUT_REDIRECT_URI || baseUrl,
    scopes: env.EXPENSES_OIDC_SCOPES || 'openid profile email offline_access',
    appName: env.EXPENSES_APP_NAME || 'glasscliff-expenses', // Accounts PartitionKey
    accountsTable: env.LAB_TABLE_ACCOUNTS || 'Accounts',
    sessionsTable: env.LAB_TABLE_SESSIONS || 'Sessions',
    storageAccount: env.LAB_STORAGE_ACCOUNT,
    tablesConnectionString: env.LAB_TABLES_CONNECTION_STRING, // local/Azurite only
    insecureCookies: env.EXPENSES_INSECURE_COOKIES === 'true', // local http only
    touchIntervalSec: 300,
    ...overrides,
  };

  const problems = [];
  for (const [key, setting] of [
    ['issuer', 'EXPENSES_OIDC_AUTHORITY'],
    ['clientId', 'EXPENSES_OIDC_CLIENT_ID'],
    ['clientSecret', 'EXPENSES_OIDC_CLIENT_SECRET'],
    ['baseUrl', 'EXPENSES_OIDC_POST_LOGOUT_REDIRECT_URI (or EXPENSES_BASE_URL)'],
  ]) {
    if (!cfg[key]) problems.push(`${setting} is not set`);
  }
  if (!overrides.store && !cfg.storageAccount && !cfg.tablesConnectionString) {
    problems.push('LAB_STORAGE_ACCOUNT is not set');
  }
  const secret = cfg.clientSecret || '';
  if (secret.startsWith('SET-ME-')) {
    problems.push('EXPENSES_OIDC_CLIENT_SECRET is still the SET-ME- placeholder; put the webapp01 secret in Key Vault (expenses-oidc-client-secret) and restart wetcliff');
  }
  if (secret.startsWith('@Microsoft.KeyVault')) {
    problems.push("EXPENSES_OIDC_CLIENT_SECRET Key Vault reference did not resolve; check wetcliff's identity has Key Vault Secrets User");
  }
  const warnings = [];
  if (/(^|\s)groups(\s|$)/.test(cfg.scopes) && /\/oauth2\//.test(cfg.issuer)) {
    warnings.push('EXPENSES_OIDC_SCOPES asks for "groups", which a custom authorization server rejects with invalid_scope unless that scope is defined; use "openid profile email offline_access"');
  }
  if (cfg.baseUrl && cfg.redirectUri && !cfg.redirectUri.startsWith(`${cfg.baseUrl}/`)) {
    problems.push(`EXPENSES_OIDC_REDIRECT_URI (${cfg.redirectUri}) must sit under ${cfg.baseUrl}/ so the sign-in cookie reaches it`);
  }
  cfg.problems = problems;
  cfg.warnings = warnings;
  cfg.basePath = cfg.baseUrl ? new URL(cfg.baseUrl).pathname.replace(/\/+$/, '') : '/labs/identity/expenses';
  cfg.callbackPath = cfg.redirectUri && cfg.baseUrl ? cfg.redirectUri.slice(cfg.baseUrl.length) : '/auth/callback';
  return cfg;
}

module.exports = { loadConfig };
