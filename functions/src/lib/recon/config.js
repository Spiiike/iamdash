'use strict';

/*
 * Settings shared by the reconciler and the lifecycle verify.entra / verify.google
 * steps. Read once per call from the environment, so a Key Vault rotation is
 * picked up on the next run without a redeploy.
 */

const { isUnresolvedKeyVaultRef } = require('../storage');

const usable = (v) => Boolean(v) && !isUnresolvedKeyVaultRef(v) && !String(v).startsWith('SET-ME-');

function parseExceptions(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    throw new Error('RECON_EXCEPTIONS is not valid JSON');
  }
}

/** Okta read settings. A dedicated read-only token is preferred when present. */
function oktaSettings(env = process.env) {
  const token = usable(env.RECON_OKTA_API_TOKEN) ? env.RECON_OKTA_API_TOKEN : env.OKTA_API_TOKEN;
  return {
    orgUrl: (env.OKTA_ORG_URL || '').replace(/\/+$/, ''),
    token: usable(token) ? token : '',
    entraAppId: env.OKTA_ENTRA_APP_ID || '',
    googleAppId: env.OKTA_GOOGLE_APP_ID || '',
  };
}

/** Google service-account settings, or null when Google isn't configured. */
function googleSettings(env = process.env) {
  const privateKey = env.GOOGLE_SA_PRIVATE_KEY;
  if (!env.GOOGLE_SA_CLIENT_EMAIL || !usable(privateKey)) return null;
  return {
    clientEmail: env.GOOGLE_SA_CLIENT_EMAIL,
    privateKey,
    // Only needed for the domain-wide-delegation route; see sources/google.js.
    subject: env.GOOGLE_ADMIN_SUBJECT || undefined,
    // "my_customer" means "the caller's own organization", which only resolves
    // when the caller impersonates a user. A service account holding its own
    // admin role has to name the customer: Admin console > Account settings.
    customer: env.GOOGLE_CUSTOMER || (env.GOOGLE_ADMIN_SUBJECT ? 'my_customer' : ''),
  };
}

/** Entra is read with the Function App's own identity, so "configured" = opted in. */
function entraEnabled(env = process.env) {
  return (env.RECON_ENTRA_ENABLED || 'true').toLowerCase() === 'true';
}

/** Everything the scheduled reconciliation needs. Throws naming every gap at once. */
function reconConfig(env = process.env) {
  const okta = oktaSettings(env);
  const google = googleSettings(env);
  const missing = [];
  if (!okta.orgUrl) missing.push('OKTA_ORG_URL');
  if (!okta.token) missing.push('OKTA_API_TOKEN (or RECON_OKTA_API_TOKEN), resolved');
  if (!okta.entraAppId) missing.push('OKTA_ENTRA_APP_ID');
  if (!okta.googleAppId) missing.push('OKTA_GOOGLE_APP_ID');
  if (!google) missing.push('GOOGLE_SA_CLIENT_EMAIL and GOOGLE_SA_PRIVATE_KEY, resolved');
  else if (!google.customer) missing.push('GOOGLE_CUSTOMER (the C0… customer id from Admin console > Account settings)');
  if (!entraEnabled(env)) missing.push('RECON_ENTRA_ENABLED is false');
  if (missing.length) throw new Error(`recon: not configured: ${missing.join('; ')}`);
  return {
    okta,
    google,
    reconcile: {
      managedGoogleOu: env.RECON_MANAGED_OU || '/Okta Users',
      expectedExceptions: parseExceptions(env.RECON_EXCEPTIONS),
    },
  };
}

module.exports = { reconConfig, oktaSettings, googleSettings, entraEnabled, parseExceptions, usable };
