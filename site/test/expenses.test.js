'use strict';
// node test/expenses.test.js  - no Azure or Okta needed.
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const express = require('express');
const { generateKeyPair, exportJWK, SignJWT } = require('jose');
const { createExpensesRouter } = require('../expenses');
const { loadConfig } = require('../expenses/config');
const { normalizeAccount } = require('../expenses/store');

const listen = (app) => new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
const MOUNT = '/labs/identity/expenses';

// ---------- mock Okta (default custom authorization server) ----------------
async function startOkta(clientId, clientSecret) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const state = { codes: new Map(), refresh: new Map(), user: { sub: '00u1', login: 'Pat.Lee@example.com' }, badNonce: false };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  let iss;
  const idToken = (nonce) => {
    const claims = { preferred_username: state.user.login, email: state.user.login, ...(nonce ? { nonce: state.badNonce ? 'wrong' : nonce } : {}) };
    return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(iss).setAudience(clientId).setSubject(state.user.sub).setIssuedAt().setExpirationTime('1h').sign(privateKey);
  };
  const as = express.Router();
  as.get('/.well-known/openid-configuration', (q, r) => r.json({
    issuer: iss, authorization_endpoint: `${iss}/v1/authorize`, token_endpoint: `${iss}/v1/token`,
    jwks_uri: `${iss}/v1/keys`, end_session_endpoint: `${iss}/v1/logout`,
  }));
  as.get('/v1/keys', (q, r) => r.json({ keys: [jwk] }));
  as.get('/v1/authorize', (q, r) => {
    assert.equal(q.query.client_id, clientId);
    assert.equal(q.query.code_challenge_method, 'S256');
    assert.match(q.query.scope, /offline_access/);
    const code = crypto.randomBytes(8).toString('hex');
    state.codes.set(code, { nonce: q.query.nonce, challenge: q.query.code_challenge, redirect: q.query.redirect_uri });
    r.redirect(`${q.query.redirect_uri}?code=${code}&state=${encodeURIComponent(q.query.state)}`);
  });
  as.post('/v1/token', async (q, r) => {
    const [id, secret] = Buffer.from((q.headers.authorization || '').replace('Basic ', ''), 'base64').toString().split(':').map(decodeURIComponent);
    if (id !== clientId || secret !== clientSecret) return r.status(401).json({ error: 'invalid_client' });
    if (q.body.grant_type === 'authorization_code') {
      const c = state.codes.get(q.body.code); state.codes.delete(q.body.code);
      if (!c || c.redirect !== q.body.redirect_uri) return r.status(400).json({ error: 'invalid_grant' });
      if (crypto.createHash('sha256').update(q.body.code_verifier).digest('base64url') !== c.challenge) return r.status(400).json({ error: 'invalid_grant', error_description: 'PKCE' });
      const rt = crypto.randomBytes(8).toString('hex'); state.refresh.set(rt, true);
      return r.json({ token_type: 'Bearer', expires_in: 3600, access_token: 'at', refresh_token: rt, id_token: await idToken(c.nonce) });
    }
    if (q.body.grant_type === 'refresh_token') {
      if (!state.refresh.get(q.body.refresh_token)) return r.status(400).json({ error: 'invalid_grant', error_description: 'revoked' });
      return r.json({ token_type: 'Bearer', expires_in: 3600, access_token: 'at2', id_token: await idToken() });
    }
    r.status(400).json({ error: 'unsupported_grant_type' });
  });
  app.use('/oauth2/default', as);
  const server = await listen(app);
  iss = `http://127.0.0.1:${server.address().port}/oauth2/default`;
  return { server, iss, state, revokeAll: () => state.refresh.clear() };
}

// ---------- in-memory tables with the Functions app's semantics ------------
function memoryStore(appName) {
  const accounts = new Map(); // `${pk}|${rk}` -> entity as scim.js toEntity writes it
  const sessions = new Map();
  const k = (pk, rk) => `${pk}|${rk}`;
  const hooks = {};
  return {
    accounts, sessions, hooks,
    addAccount(id, userName, active, resource) {
      accounts.set(k(appName, id), { partitionKey: appName, rowKey: id, userName, userNameLower: userName.toLowerCase(), active, displayName: '', resource: JSON.stringify({ userName, ...resource }) });
    },
    // storage.js invalidateSessions / countSessions
    invalidateSessions(u) { let n = 0; for (const [key, s] of sessions) if (s.partitionKey === u.toLowerCase()) { sessions.delete(key); n++; } return n; },
    countSessions(u) { return [...sessions.values()].filter((s) => s.partitionKey === u.toLowerCase()).length; },
    async findAccountByUserName(u) {
      const e = [...accounts.values()].find((a) => a.partitionKey === appName && a.userNameLower === String(u).toLowerCase());
      return e ? normalizeAccount(e) : null;
    },
    async createSession(e) { sessions.set(k(e.partitionKey, e.rowKey), { ...e }); return { ...e }; },
    async getSession(pk, rk) { const s = sessions.get(k(pk, rk)); if (hooks.afterGet) { const h = hooks.afterGet; hooks.afterGet = null; h(); } return s ? { ...s } : null; },
    async updateSession(pk, rk, p) { const key = k(pk, rk); if (!sessions.has(key)) return false; sessions.set(key, { ...sessions.get(key), ...p }); return true; },
    async deleteSession(pk, rk) { sessions.delete(k(pk, rk)); },
  };
}

// ---------- tiny browser ---------------------------------------------------
function browser() {
  const jar = new Map();
  async function go(url, opts = {}) {
    const res = await fetch(url, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), cookie: [...jar].map(([n, v]) => `${n}=${v}`).join('; ') } });
    for (const sc of res.headers.getSetCookie()) {
      const [nv, ...attrs] = sc.split(';'); const i = nv.indexOf('=');
      const name = nv.slice(0, i); const val = nv.slice(i + 1);
      if (attrs.some((a) => a.trim() === 'Max-Age=0') || val === '') jar.delete(name); else jar.set(name, val);
    }
    return res;
  }
  async function follow(url, opts, max = 6) {
    let res = await go(url, opts);
    while (max-- && [301, 302, 303].includes(res.status)) res = await go(new URL(res.headers.get('location'), url).toString());
    return res;
  }
  return { go, follow, jar };
}

// ---------- tests ----------------------------------------------------------
(async () => {
  const CLIENT_ID = '0oa1exampleclient0de';
  const SECRET = 'test-secret-' + crypto.randomBytes(8).toString('hex');
  const okta = await startOkta(CLIENT_ID, SECRET);
  const store = memoryStore('glasscliff-expenses');
  let clock = Date.now();
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };

  const app = express();
  const holder = {};
  app.use(MOUNT, (req, res, next) => holder.router(req, res, next));
  const srv = await listen(app);
  const APP = `http://127.0.0.1:${srv.address().port}`;
  const HOME = `${APP}${MOUNT}/`;
  // The exact setting names main.bicep merges into wetcliff.
  const env = {
    EXPENSES_OIDC_AUTHORITY: okta.iss,
    EXPENSES_OIDC_CLIENT_ID: CLIENT_ID,
    EXPENSES_OIDC_CLIENT_SECRET: SECRET,
    EXPENSES_OIDC_REDIRECT_URI: `${APP}${MOUNT}/auth/callback`,
    EXPENSES_OIDC_POST_LOGOUT_REDIRECT_URI: `${APP}${MOUNT}`,
    EXPENSES_OIDC_SCOPES: 'openid profile email offline_access',
    EXPENSES_APP_NAME: 'glasscliff-expenses',
    EXPENSES_INSECURE_COOKIES: 'true',
  };
  const config = loadConfig(env, { store: true });
  holder.router = createExpensesRouter({ config, store, logger, now: () => new Date(clock) });

  store.addAccount('scim-1', 'pat.lee@example.com', true, {
    name: { givenName: 'Pat', familyName: 'Lee' }, title: 'Analyst',
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'Finance', manager: { displayName: 'Robin Ode' } },
  });

  let pass = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log(`ok   ${name}`); }
    catch (e) { console.log(`FAIL ${name}\n     ${e.stack}`); console.log(logs.slice(-5).join('\n')); process.exitCode = 1; }
  };
  const signIn = async () => { const b = browser(); const r = await b.follow(`${APP}${MOUNT}/auth/login`); return { b, r }; };

  await t('config reads the Bicep setting names', async () => {
    assert.deepEqual(config.problems, []);
    assert.equal(config.basePath, MOUNT); assert.equal(config.callbackPath, '/auth/callback');
  });

  await t('groups scope on a custom authorization server is flagged', async () => {
    const c2 = loadConfig({ ...env, EXPENSES_OIDC_SCOPES: 'openid profile email groups offline_access' }, { store: true });
    assert.match(c2.warnings.join(), /groups/);
  });

  await t('anonymous visitor gets the sign-in page', async () => {
    const r = await browser().go(HOME);
    assert.equal(r.status, 200); assert.match(await r.text(), /Sign in with Okta/);
  });

  let pat;
  await t('login writes a Sessions row keyed like SCIM expects', async () => {
    const { b, r } = await signIn(); pat = b;
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /Pat Lee/); assert.match(html, /Analyst/); assert.match(html, /Finance/); assert.match(html, /Robin Ode/);
    assert.equal(store.countSessions('pat.lee@example.com'), 1, 'countSessions sees it');
    const row = [...store.sessions.values()][0];
    assert.equal(row.partitionKey, 'pat.lee@example.com'); assert.equal(row.accountId, 'scim-1');
    assert.ok(!row.tokens.includes('.'), 'tokens encrypted');
    assert.ok(pat.jar.has('gc_exp_sid')); assert.ok(!pat.jar.has('gc_exp_tx'));
  });

  await t('cookies are HttpOnly, Lax, scoped to the mount path', async () => {
    const sc = (await browser().go(`${APP}${MOUNT}/auth/login`)).headers.getSetCookie()[0];
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/); assert.match(sc, new RegExp(`Path=${MOUNT}`));
  });

  await t('transfer shows up on the next page view', async () => {
    const e = store.accounts.get('glasscliff-expenses|scim-1');
    const res = JSON.parse(e.resource); res.title = 'Senior Analyst'; e.resource = JSON.stringify(res);
    assert.match(await (await pat.go(HOME)).text(), /Senior Analyst/);
  });

  await t('terminate: SCIM deactivation deletes the row and the open tab is ended', async () => {
    store.accounts.get('glasscliff-expenses|scim-1').active = false; // PATCH active=false
    assert.equal(store.invalidateSessions('pat.lee@example.com'), 1); // what scim.js does next
    const r = await pat.go(HOME);
    assert.equal(r.status, 401);
    const html = await r.text();
    assert.match(html, /account was deactivated/); assert.match(html, /account_deactivated/);
    const rk = [...logs].reverse().find((m) => /is over/.test(m)).match(/session (\S+) /)[1];
    assert.match(html, new RegExp(`<dd>${rk.slice(rk.indexOf('-') + 1, rk.indexOf('-') + 9)}</dd>`), 'session id shows the random part');
    assert.doesNotMatch(html, /<dd>2026\d{4}<\/dd>/, 'not the date');
    assert.doesNotMatch(html, /Sign in again/);
    assert.ok(!pat.jar.has('gc_exp_sid'));
    assert.equal(store.countSessions('pat.lee@example.com'), 0, 'verify.expensesSessionsEnded would find 0');
  });

  await t('deactivated account cannot sign back in', async () => {
    const { r } = await signIn();
    assert.equal(r.status, 403); assert.match(await r.text(), /deactivated/);
    assert.equal(store.countSessions('pat.lee@example.com'), 0);
    store.accounts.get('glasscliff-expenses|scim-1').active = true;
  });

  await t('row deleted while account still active reads as closed, not deactivated', async () => {
    const { b } = await signIn();
    store.invalidateSessions('pat.lee@example.com');
    const r = await b.go(HOME);
    assert.equal(r.status, 401); assert.match(await r.text(), /session_closed/);
  });

  await t('SCIM deleting the row mid-request does not resurrect it', async () => {
    const { b } = await signIn();
    clock += 10 * 60 * 1000; // lastSeenAt touch due
    store.hooks.afterGet = () => store.invalidateSessions('pat.lee@example.com');
    const r = await b.go(HOME);
    assert.equal(r.status, 401);
    assert.equal(store.countSessions('pat.lee@example.com'), 0);
  });

  await t('expired access token is refreshed silently', async () => {
    const { b } = await signIn();
    const before = [...store.sessions.values()][0].accessTokenExpiresAt;
    clock += 2 * 3600 * 1000;
    assert.equal((await b.go(HOME)).status, 200);
    assert.ok(Date.parse([...store.sessions.values()][0].accessTokenExpiresAt) > Date.parse(before));
    store.invalidateSessions('pat.lee@example.com');
  });

  await t('Okta token revocation ends the session and deletes the row', async () => {
    const { b } = await signIn();
    okta.revokeAll();
    clock += 2 * 3600 * 1000;
    const r = await b.go(HOME);
    assert.equal(r.status, 401); assert.match(await r.text(), /okta_refresh_rejected/);
    assert.equal(store.countSessions('pat.lee@example.com'), 0);
  });

  await t('no Expenses account: 403, no session', async () => {
    okta.state.user = { sub: '00u2', login: 'nobody@example.com' };
    const { r } = await signIn();
    assert.equal(r.status, 403); assert.match(await r.text(), /don't have an Expenses account/);
    assert.equal(store.sessions.size, 0);
    okta.state.user = { sub: '00u1', login: 'Pat.Lee@example.com' };
  });

  await t('state mismatch is rejected', async () => {
    const b = browser();
    const r1 = await b.go(`${APP}${MOUNT}/auth/login`);
    const cb = new URL((await fetch(r1.headers.get('location'), { redirect: 'manual' })).headers.get('location'));
    cb.searchParams.set('state', 'forged');
    assert.equal((await b.go(cb.toString())).status, 400);
  });

  await t('ID token with wrong nonce is rejected', async () => {
    okta.state.badNonce = true;
    const { r } = await signIn();
    okta.state.badNonce = false;
    assert.equal(r.status, 502); assert.equal(store.sessions.size, 0);
  });

  await t('Okta error on callback is shown', async () => {
    const b = browser(); await b.go(`${APP}${MOUNT}/auth/login`);
    const r = await b.go(`${APP}${MOUNT}/auth/callback?error=invalid_scope&error_description=One%20or%20more%20scopes%20are%20not%20configured`);
    assert.equal(r.status, 403); assert.match(await r.text(), /scopes are not configured/);
  });

  await t('tampered session cookie is treated as signed out', async () => {
    const { b } = await signIn();
    b.jar.set('gc_exp_sid', b.jar.get('gc_exp_sid').replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')));
    const r = await b.go(HOME);
    assert.equal(r.status, 200); assert.match(await r.text(), /Sign in with Okta/);
    store.invalidateSessions('pat.lee@example.com');
  });

  await t('returnTo cannot redirect off-site', async () => {
    for (const bad of ['https://evil.example', '//evil.example', '/other-app']) {
      const b = browser();
      let r = await b.go(`${APP}${MOUNT}/auth/login?returnTo=${encodeURIComponent(bad)}`);
      r = await b.go((await fetch(r.headers.get('location'), { redirect: 'manual' })).headers.get('location'));
      assert.equal(r.headers.get('location'), `${MOUNT}/`, bad);
    }
    for (const [k2, s] of store.sessions) if (s) store.sessions.delete(k2);
  });

  await t('logout deletes the row and goes to Okta logout', async () => {
    const { b } = await signIn();
    const r = await b.go(`${APP}${MOUNT}/auth/logout`, { method: 'POST' });
    assert.equal(r.status, 303);
    const loc = new URL(r.headers.get('location'));
    assert.equal(loc.pathname, '/oauth2/default/v1/logout');
    assert.ok(loc.searchParams.get('id_token_hint'));
    assert.equal(loc.searchParams.get('post_logout_redirect_uri'), `${APP}${MOUNT}`);
    assert.equal(store.countSessions('pat.lee@example.com'), 0);
  });

  await t('placeholder secret yields a 503 explaining what to fix', async () => {
    const cfg = loadConfig({ ...env, EXPENSES_OIDC_CLIENT_SECRET: 'SET-ME-expenses-oidc-client-secret' }, { store: true });
    const saved = holder.router; holder.router = createExpensesRouter({ config: cfg, store, logger });
    const r = await fetch(`${APP}${MOUNT}/auth/login`);
    holder.router = saved;
    assert.equal(r.status, 503); assert.match(await r.text(), /placeholder/);
  });

  console.log(`\n${pass} passed`);
  srv.close(); okta.server.close();
})();
