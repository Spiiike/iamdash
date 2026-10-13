'use strict';
/*
 * Glasscliff Expenses OIDC login (milestone 3).
 *
 *   const { createExpensesRouter } = require('./expenses');
 *   app.use('/labs/identity/expenses', createExpensesRouter());
 *
 * Routes (relative to the mount point):
 *   GET  /               claims page with a live session, sign-in page without
 *   GET  /auth/login     authorization code + PKCE with webapp01
 *   GET  /auth/callback  code exchange, ID token check, Accounts check, Sessions row
 *   POST /auth/logout    deletes the Sessions row, then Okta logout
 */
const express = require('express');
const { loadConfig } = require('./config');
const { createOidcClient, OAuthError } = require('./oidc');
const { createTableStore } = require('./store');
const c = require('./crypto');
const views = require('./views');

const TX_COOKIE = 'gc_exp_tx';
const SID_COOKIE = 'gc_exp_sid';
const TX_MAX_AGE_SEC = 600;
const SESSION_COOKIE_MAX_AGE_SEC = 12 * 3600;

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* ignore malformed cookie */
      }
    }
  }
  return out;
}

function createExpensesRouter(options = {}) {
  const cfg = options.config || loadConfig(process.env, options.store ? { store: true } : {});
  const router = express.Router();
  const log = options.logger || console;

  for (const w of cfg.warnings || []) log.warn(`[expenses] ${w}`);
  if (cfg.problems.length) {
    log.error(`[expenses] not configured: ${cfg.problems.join('; ')}`);
    router.use((req, res) => res.status(503).type('html').send(views.misconfigured(cfg.problems)));
    return router;
  }

  const keys = c.deriveKeys(cfg.clientSecret);
  const oidc = options.oidc || createOidcClient(cfg);
  const store = options.store || createTableStore(cfg);
  const base = cfg.basePath;
  const now = options.now || (() => new Date());
  let mountChecked = false;

  const cookie = (res, name, value, maxAgeSec) => {
    const attrs = [`${name}=${encodeURIComponent(value)}`, `Path=${base}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
    if (!cfg.insecureCookies) attrs.push('Secure');
    res.append('Set-Cookie', attrs.join('; '));
  };
  const clearCookie = (res, name) => cookie(res, name, '', 0);
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const html = (res, status, body) => res.status(status).set('Cache-Control', 'no-store').type('html').send(body);

  // Only same-app paths are allowed after login (no open redirects).
  const safeReturnTo = (v) =>
    typeof v === 'string' && v.startsWith(`${base}/`) && !v.startsWith('//') && !/[\\\r\n]/.test(v) ? v : `${base}/`;
  const expiryFrom = (t) => new Date(now().getTime() + (Number(t.expires_in) || 3600) * 1000).toISOString();

  router.use((req, res, next) => {
    if (!mountChecked) {
      mountChecked = true;
      if (req.baseUrl !== base) log.warn(`[expenses] mounted at ${req.baseUrl} but configured for ${base}; cookies and redirects will not line up`);
    }
    next();
  });

  // ---- login -------------------------------------------------------------
  router.get('/auth/login', wrap(async (req, res) => {
    const tx = { state: c.random(), nonce: c.random(), verifier: c.random(48), returnTo: safeReturnTo(req.query.returnTo) };
    const url = await oidc.authorizeUrl({ state: tx.state, nonce: tx.nonce, codeChallenge: c.pkceChallenge(tx.verifier) });
    cookie(res, TX_COOKIE, c.sign(keys.sign, { ...tx, iat: now().getTime() }), TX_MAX_AGE_SEC);
    res.redirect(302, url);
  }));

  // ---- callback ----------------------------------------------------------
  router.get(cfg.callbackPath, wrap(async (req, res) => {
    const tx = c.unsign(keys.sign, parseCookies(req)[TX_COOKIE]);
    clearCookie(res, TX_COOKIE);

    if (req.query.error) {
      log.warn(`[expenses] Okta returned ${req.query.error}: ${req.query.error_description || ''}`);
      return html(res, 403, views.error({ basePath: base, title: 'Okta did not sign you in', message: req.query.error_description || req.query.error }));
    }
    if (!tx || now().getTime() - tx.iat > TX_MAX_AGE_SEC * 1000 || !c.safeEqual(tx.state, String(req.query.state || ''))) {
      return html(res, 400, views.error({
        basePath: base,
        title: 'Sign-in expired',
        message: 'The sign-in attempt expired or came from another browser tab. Start again from the sign-in page.',
      }));
    }
    if (!req.query.code) {
      return html(res, 400, views.error({ basePath: base, title: 'Sign-in failed', message: 'Okta did not return an authorization code.' }));
    }

    const { tokens, claims } = await oidc.exchangeCode(String(req.query.code), tx.verifier, tx.nonce);
    const login = claims.preferred_username || claims.email;

    // Okta authenticates; the SCIM-provisioned account authorizes. This matters
    // because webapp01 uses Federation Broker Mode (no assignment check in Okta).
    const account = login ? await store.findAccountByUserName(login) : null;
    if (!account || !account.active) {
      log.warn(`[expenses] login refused for ${login}: ${account ? 'account inactive' : 'no account'}`);
      return html(res, 403, views.noAccess({ basePath: base, userName: login, inactive: !!account }));
    }

    const ts = now().toISOString();
    const entity = {
      // Same key SCIM's invalidateSessions and terminate's countSessions use.
      partitionKey: String(account.userName).toLowerCase(),
      rowKey: `${ts.replace(/[-:.TZ]/g, '')}-${c.random(9)}`,
      app: cfg.appName,
      accountId: account.id,
      userName: account.userName,
      oktaSub: claims.sub,
      createdAt: ts,
      lastSeenAt: ts,
      accessTokenExpiresAt: expiryFrom(tokens),
      tokens: c.encrypt(keys.enc, { refreshToken: tokens.refresh_token || null, idToken: tokens.id_token }),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 256),
    };
    await store.createSession(entity);
    if (!tokens.refresh_token) log.warn('[expenses] no refresh token issued; enable the Refresh Token grant on webapp01 and allow offline_access');
    log.info(`[expenses] session ${entity.rowKey} started for ${account.userName}`);

    cookie(res, SID_COOKIE, c.sign(keys.sign, { pk: entity.partitionKey, rk: entity.rowKey }), SESSION_COOKIE_MAX_AGE_SEC);
    res.redirect(302, tx.returnTo);
  }));

  // ---- session check -----------------------------------------------------
  // Resolves to the live session row, or sends a response and resolves null.
  async function liveSession(req, res) {
    const ref = c.unsign(keys.sign, parseCookies(req)[SID_COOKIE]);
    if (!ref) return { anonymous: true };

    const ended = async (reason) => {
      clearCookie(res, SID_COOKIE);
      let why = reason;
      if (!why) {
        // Row gone: SCIM deactivation, terminate's safety net, or an admin. Say which if we can.
        const account = await store.findAccountByUserName(ref.pk).catch(() => null);
        why = !account || !account.active ? 'account_deactivated' : 'session_closed';
      }
      log.info(`[expenses] session ${ref.rk} for ${ref.pk} is over: ${why}`);
      html(res, 401, views.sessionEnded({ basePath: base, reason: why, sessionId: ref.rk }));
      return null;
    };

    let session = await store.getSession(ref.pk, ref.rk);
    if (!session) return ended();

    // Second layer: once terminate revokes Okta tokens, the refresh fails too.
    const expiresAt = Date.parse(session.accessTokenExpiresAt || 0);
    if (!expiresAt || expiresAt - 30_000 < now().getTime()) {
      const saved = c.decrypt(keys.enc, session.tokens) || {};
      let t;
      try {
        if (!saved.refreshToken) throw new OAuthError(400, { error: 'invalid_grant', error_description: 'no refresh token stored' });
        t = await oidc.refresh(saved.refreshToken);
      } catch (err) {
        if (!(err instanceof OAuthError) || err.oauthError !== 'invalid_grant') throw err;
        await store.deleteSession(ref.pk, ref.rk);
        return ended('okta_refresh_rejected');
      }
      const patch = {
        accessTokenExpiresAt: expiryFrom(t),
        tokens: c.encrypt(keys.enc, { refreshToken: t.refresh_token || saved.refreshToken, idToken: t.id_token || saved.idToken }),
        lastSeenAt: now().toISOString(),
      };
      if (!(await store.updateSession(ref.pk, ref.rk, patch))) return ended();
      session = { ...session, ...patch };
    } else if (now().getTime() - Date.parse(session.lastSeenAt || 0) > cfg.touchIntervalSec * 1000) {
      if (!(await store.updateSession(ref.pk, ref.rk, { lastSeenAt: now().toISOString() }))) return ended();
    }
    return session;
  }

  router.get('/', wrap(async (req, res) => {
    const session = await liveSession(req, res);
    if (!session) return;
    if (session.anonymous) return html(res, 200, views.landing({ basePath: base }));
    const account = (await store.findAccountByUserName(session.userName)) || { userName: session.userName, displayName: session.userName };
    html(res, 200, views.home({ basePath: base, account, session }));
  }));

  // ---- logout ------------------------------------------------------------
  router.post('/auth/logout', wrap(async (req, res) => {
    const ref = c.unsign(keys.sign, parseCookies(req)[SID_COOKIE]);
    clearCookie(res, SID_COOKIE);
    let idToken = null;
    if (ref) {
      const session = await store.getSession(ref.pk, ref.rk);
      if (session) {
        idToken = (c.decrypt(keys.enc, session.tokens) || {}).idToken || null;
        await store.deleteSession(ref.pk, ref.rk);
        log.info(`[expenses] session ${ref.rk} for ${ref.pk} ended: user_logout`);
      }
    }
    const okta = await oidc.logoutUrl(idToken, c.random(16)).catch(() => null);
    res.redirect(303, okta || `${base}/`);
  }));

  // ---- errors ------------------------------------------------------------
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const ref = c.random(6);
    log.error(`[expenses] ${ref} ${req.method} ${req.originalUrl}: ${err.stack || err}`);
    html(res, 502, views.error({
      basePath: base,
      title: 'Sign-in failed',
      message: err instanceof OAuthError ? 'Okta rejected the request from Expenses.' : 'Expenses could not complete the request.',
      ref,
    }));
  });

  return router;
}

module.exports = { createExpensesRouter };
