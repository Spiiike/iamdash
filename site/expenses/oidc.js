'use strict';
const { createRemoteJWKSet, jwtVerify } = require('jose');

class OAuthError extends Error {
  constructor(status, body) {
    super(`token endpoint HTTP ${status}: ${body.error || 'unknown'}${body.error_description ? ` (${body.error_description})` : ''}`);
    this.status = status;
    this.oauthError = body.error;
  }
}

function createOidcClient(cfg) {
  let discovery = null;
  let jwks = null;

  async function discover() {
    if (discovery) return discovery;
    const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    const doc = await res.json();
    if (doc.issuer !== cfg.issuer) {
      throw new Error(`OIDC issuer mismatch: configured ${cfg.issuer}, discovery says ${doc.issuer}`);
    }
    jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
    discovery = doc; // cached only on success
    return doc;
  }

  async function authorizeUrl({ state, nonce, codeChallenge }) {
    const d = await discover();
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      scope: cfg.scopes,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async function tokenRequest(params) {
    const d = await discover();
    const basic = Buffer.from(
      `${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`
    ).toString('base64');
    const res = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(params).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new OAuthError(res.status, body);
    return body;
  }

  async function verifyIdToken(idToken, expectedNonce) {
    await discover();
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: cfg.issuer,
      audience: cfg.clientId,
      algorithms: ['RS256'],
      clockTolerance: 60,
    });
    if (expectedNonce !== undefined && payload.nonce !== expectedNonce) {
      throw new Error('ID token nonce mismatch');
    }
    return payload;
  }

  async function exchangeCode(code, codeVerifier, nonce) {
    const t = await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: codeVerifier,
    });
    if (!t.id_token) throw new Error('token response has no id_token; is the openid scope granted?');
    const claims = await verifyIdToken(t.id_token, nonce);
    return { tokens: t, claims };
  }

  async function refresh(refreshToken) {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: cfg.scopes });
    if (t.id_token) await verifyIdToken(t.id_token); // no nonce on refresh
    return t;
  }

  async function logoutUrl(idToken, state) {
    const d = await discover();
    if (!d.end_session_endpoint || !idToken) return null;
    const url = new URL(d.end_session_endpoint);
    url.search = new URLSearchParams({
      id_token_hint: idToken,
      post_logout_redirect_uri: cfg.postLogoutRedirectUri,
      state,
    }).toString();
    return url.toString();
  }

  return { discover, authorizeUrl, exchangeCode, refresh, verifyIdToken, logoutUrl };
}

module.exports = { createOidcClient, OAuthError };
