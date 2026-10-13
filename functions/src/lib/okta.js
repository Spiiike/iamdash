'use strict';
// Minimal Okta management API client for the lifecycle handlers.
// Auth: SSWS API token (OKTA_AUTH_MODE=SSWS, the lab default).
// Retries 429 and 5xx with backoff up to LAB_MAX_STEP_RETRIES attempts.

const { isUnresolvedKeyVaultRef } = require('./storage');

class OktaError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
    this.oktaErrorCode = body?.errorCode;
  }
}

function config() {
  const orgUrl = (process.env.OKTA_ORG_URL || '').replace(/\/+$/, '');
  const token = process.env.OKTA_API_TOKEN || '';
  const mode = (process.env.OKTA_AUTH_MODE || 'SSWS').toUpperCase();
  if (!orgUrl) throw new OktaError('OKTA_ORG_URL is not set', 503);
  if (mode !== 'SSWS') throw new OktaError(`OKTA_AUTH_MODE=${mode} is not implemented; use SSWS`, 503);
  if (!token || token.startsWith('SET-ME-') || isUnresolvedKeyVaultRef(token)) {
    throw new OktaError('Okta API token is not configured (placeholder or unresolved Key Vault reference)', 503);
  }
  return { orgUrl, token };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, path, body) {
  const { orgUrl, token } = config();
  const attempts = Math.max(1, parseInt(process.env.LAB_MAX_STEP_RETRIES || '3', 10));
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch(`${orgUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `SSWS ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = { raw: text };
    }
    if (res.ok) return { status: res.status, body: json };

    lastErr = new OktaError(json?.errorSummary || `Okta ${method} ${path} returned ${res.status}`, res.status, json);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === attempts) throw lastErr;
    const reset = Number(res.headers.get('x-rate-limit-reset'));
    const wait = res.status === 429 && reset ? Math.min(10_000, Math.max(500, reset * 1000 - Date.now())) : 500 * 2 ** (attempt - 1);
    await sleep(wait);
  }
  throw lastErr;
}

const enc = encodeURIComponent;

module.exports = {
  OktaError,
  configured() {
    try {
      config();
      return true;
    } catch {
      return false;
    }
  },
  // GET /api/v1/users/{id|login}
  async getUser(idOrLogin) {
    try {
      return (await request('GET', `/api/v1/users/${enc(idOrLogin)}`)).body;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  },
  // Creates and activates. With no password Okta leaves the user PROVISIONED
  // and emails an activation link to profile.email.
  // credentials are only supplied by the demo path: giving Okta a password
  // makes the user ACTIVE without sending an activation email, which matters
  // because demo addresses have no mailbox.
  async createUser(profile, credentials) {
    const body = credentials ? { profile, credentials } : { profile };
    return (await request('POST', '/api/v1/users?activate=true', body)).body;
  },
  async updateProfile(userId, profile) {
    return (await request('POST', `/api/v1/users/${enc(userId)}`, { profile })).body;
  },
  async assignToApp(appId, userId, userName) {
    return (await request('POST', `/api/v1/apps/${enc(appId)}/users`, { id: userId, scope: 'USER', credentials: { userName } })).body;
  },
  // Adds a user to a group. Used when the downstream apps (Office 365, Google
  // Workspace) are assigned to a group rather than to people one at a time.
  async addToGroup(groupId, userId) {
    await request('PUT', `/api/v1/groups/${enc(groupId)}/users/${enc(userId)}`);
  },
  async getAppUser(appId, userId) {
    try {
      return (await request('GET', `/api/v1/apps/${enc(appId)}/users/${enc(userId)}`)).body;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  },
  // Ends Okta sessions and revokes OAuth/OIDC tokens issued to the user.
  async clearSessions(userId) {
    await request('DELETE', `/api/v1/users/${enc(userId)}/sessions?oauthTokens=true`);
  },
  // Only used to clean up expired demo users. The user must be deactivated first.
  async deleteUser(userId) {
    await request('DELETE', `/api/v1/users/${enc(userId)}?sendEmail=false`);
  },

  async deactivate(userId) {
    await request('POST', `/api/v1/users/${enc(userId)}/lifecycle/deactivate?sendEmail=false`);
  },
};
