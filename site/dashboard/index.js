'use strict';
/*
 * Glasscliff identity lab dashboard (milestone 4).
 *
 *   const { createDashboardRouter } = require('./dashboard');
 *   app.use('/labs/identity/expenses', createExpensesRouter()); // first
 *   app.use('/labs/identity', createDashboardRouter());
 *
 * Public and read-only. Live operations are fetched server-side with the
 * operator key and masked (dashboard/mask.js) before they reach the browser.
 *
 *   GET /                         the page
 *   GET /api/operations           recent operations, masked
 *   GET /api/operations/:id       one operation with steps, masked; only ids
 *                                 in the current recent list are served
 *   GET /api/scenarios            replay list, each with its provenance
 *   GET /api/scenarios/:id        one replay, masked
 *   GET /api/demo/state?run=...   independent readback of a demo person, read
 *                                 straight from the Expenses tables (readback.js)
 */
const crypto = require('crypto');
const express = require('express');
const { loadDashboardConfig } = require('./config');
const { createMasker, OP_ID } = require('./mask');
const { createUpstream } = require('./upstream');
const { createScenarioSource } = require('./scenarios');
const { renderPage } = require('./page');
const { createReadback } = require('./readback');

function createDashboardRouter(options = {}) {
  const cfg = options.config || loadDashboardConfig();
  const log = options.logger || console;
  const router = express.Router();
  const masker = createMasker(cfg.operatorKey || crypto.randomBytes(32).toString('hex'));
  const upstream = cfg.liveEnabled ? options.upstream || createUpstream(cfg, options) : null;
  const scenarios = options.scenarios || createScenarioSource(cfg, { log });
  const readback = options.readback || createReadback({ log });
  if (!cfg.liveEnabled) log.warn(`[dashboard] live runs disabled: ${cfg.liveProblems.join('; ')}`);

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const json = (res, status, body, cache = 'no-store') =>
    res.status(status).set({ 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' }).json(body);
  const liveOff = (res) => json(res, 503, { error: 'Live runs are unavailable right now. Replays still work.' });

  router.get('/', (req, res) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set({
      'Content-Security-Policy': [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'self' 'nonce-${nonce}'`,
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    const homeHref = options.homeHref || req.baseUrl.replace(/\/[^/]*$/, '') || '/';
    res.type('html').send(renderPage({ nonce, basePath: req.baseUrl, liveEnabled: cfg.liveEnabled, homeHref }));
  });

  router.get('/api/operations', wrap(async (req, res) => {
    if (!upstream) return liveOff(res);
    const list = await upstream.listOperations();
    json(res, 200, { operations: list.map((op) => masker.operation(op)).filter(Boolean) });
  }));

  router.get('/api/operations/:id', wrap(async (req, res) => {
    if (!upstream) return liveOff(res);
    const id = req.params.id;
    if (!OP_ID.test(id)) return json(res, 400, { error: 'That is not an operation id.' });
    // Only recent operations are public; this also stops id guessing from reaching the API.
    const recent = await upstream.listOperations();
    if (!recent.some((op) => op.operationId === id)) return json(res, 404, { error: 'No recent run has that id.' });
    const op = await upstream.getStatus(id);
    if (!op) return json(res, 404, { error: 'No recent run has that id.' });
    json(res, 200, masker.operation(op, { withSteps: true }));
  }));

  // ------------------------------------------------------------ demo ----
  // Visitors can start a throwaway hire, move them, and offboard them. The
  // demo identity is invented by the lifecycle API, never by the browser: the
  // browser only ever holds an opaque runKey, signed here, so it cannot aim a
  // transfer or an offboarding at a real person.
  // Opaque handle for a demo run: signed here, meaningless to the browser.
  const demoKey = crypto.hkdfSync('sha256', Buffer.from(String(cfg.operatorKey || 'demo')), Buffer.alloc(0), 'glasscliff-demo-runkey-v1', 32);
  const signRun = (obj) => {
    const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', Buffer.from(demoKey)).update(body).digest('base64url')}`;
  };
  const unsignRun = (value) => {
    const dot = String(value || '').lastIndexOf('.');
    if (dot < 1) return null;
    const body = String(value).slice(0, dot);
    const given = Buffer.from(String(value).slice(dot + 1));
    const want = Buffer.from(crypto.createHmac('sha256', Buffer.from(demoKey)).update(body).digest('base64url'));
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  };
  const seen = new Map(); // ip -> last start
  const starts = [];

  const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64);

  function mayStart(ip) {
    const now = Date.now();
    while (starts.length && now - starts[0] > 3600_000) starts.shift();
    if (starts.length >= cfg.demoGlobalPerHour) return 'The demo has been busy this hour. Try again later, or watch a replay.';
    const last = seen.get(ip) || 0;
    const wait = cfg.demoPerIpCooldownMs - (now - last);
    if (wait > 0) return `You just started one. You can start another in ${Math.ceil(wait / 60000)} minute(s).`;
    return null;
  }

  const demoOff = (res) => json(res, 503, { error: 'The demo is switched off right now.' });

  router.get('/api/demo/limits', wrap(async (req, res) => {
    if (!upstream || !cfg.demoEnabled) return json(res, 200, { available: false, reason: 'The demo is switched off right now.' });
    let upstreamLimits;
    try {
      // null means 404: the lifecycle API has no demo endpoints deployed.
      upstreamLimits = await upstream.getFresh('/demo/limits');
    } catch (err) {
      log.warn(`[dashboard] demo limits unavailable: ${err.message}`);
      return json(res, 200, { available: false, reason: "The lab's lifecycle API didn't answer. Try again in a minute." });
    }
    if (!upstreamLimits) {
      log.warn('[dashboard] demo endpoints are not deployed on the lifecycle API (404 on /demo/limits)');
      return json(res, 200, { available: false, reason: 'The demo is not switched on for this lab yet.' });
    }
    if (upstreamLimits.enabled === false) return json(res, 200, { available: false, reason: 'The demo is switched off right now.' });
    const mine = mayStart(clientIp(req));
    const { live, maxLive, startedToday, dailyMax, ttlMinutes } = upstreamLimits;
    let why;
    if (upstreamLimits.available === false) {
      if (Number.isFinite(live) && Number.isFinite(maxLive) && live >= maxLive) {
        why = `The demo is busy: ${live} runs are already going. They clear themselves within ${ttlMinutes} minutes.`;
      } else if (Number.isFinite(startedToday) && Number.isFinite(dailyMax) && startedToday >= dailyMax) {
        why = "The demo has hit today's limit. Watch a replay instead, or come back tomorrow.";
      } else {
        why = 'The demo is busy right now. Try again in a few minutes.';
      }
    }
    json(res, 200, { available: upstreamLimits.available === true && !mine, reason: mine || why, ttlMinutes });
  }));

  router.post('/api/demo/start', express.json({ limit: '1kb' }), wrap(async (req, res) => {
    if (!upstream || !cfg.demoEnabled) return demoOff(res);
    const ip = clientIp(req);
    const blocked = mayStart(ip);
    if (blocked) return json(res, 429, { error: blocked });
    const { status, body } = await upstream.post('/demo/hire', {});
    if (status !== 200) return json(res, status === 429 ? 429 : 502, { error: body.error || "The demo could not start. Try again in a minute." });
    seen.set(ip, Date.now());
    starts.push(Date.now());
    const runKey = signRun({ login: body.demo.login, exp: Date.parse(body.demo.expiresAt) });
    log.info(`[dashboard] demo started for ${ip}: ${body.operationId}`);
    json(res, 200, { operation: masker.operation(body, { withSteps: true }), runKey, expiresAt: body.demo.expiresAt });
  }));

  for (const [action, route] of [['transfer', 'move'], ['terminate', 'offboard']]) {
    router.post(`/api/demo/${route}`, express.json({ limit: '1kb' }), wrap(async (req, res) => {
      if (!upstream || !cfg.demoEnabled) return demoOff(res);
      const run = unsignRun(req.body?.runKey);
      if (!run || !run.login) return json(res, 400, { error: 'That demo run is not one this page started.' });
      if (Date.now() > run.exp) return json(res, 410, { error: 'That demo person has already been deleted. Start a new one.' });
      const { status, body } = await upstream.post(`/demo/${action}`, { login: run.login });
      if (status !== 200) return json(res, [404, 409, 410, 429].includes(status) ? status : 502, { error: body.error || 'That did not work. Try again in a minute.' });
      json(res, 200, { operation: masker.operation(body, { withSteps: true }) });
    }));
  }

  // ------------------------------------------------------- readback ----
  // GET so a visitor can open it in another tab and refresh it themselves
  // while the run happens. Same runKey as the demo buttons: only a person this
  // page created can be read, never anyone real.
  const reads = new Map(); // ip -> [times]
  // Demo logins are always demo-<hex>@<demo domain> (functions/src/functions/demo.js).
  const DEMO_LOGIN = /^demo-[0-9a-z]{4,16}@[a-z0-9.-]+$/;
  router.get('/api/demo/state', wrap(async (req, res) => {
    // Without the operator key the runKey signing key falls back to a constant,
    // so a runKey could be forged. The demo is off in that state, and so is this.
    if (!upstream || !cfg.demoEnabled) return demoOff(res);
    const run = unsignRun(req.query.run);
    if (!run || !run.login) return json(res, 400, { error: 'That is not a demo run this page started.' });
    // Belt and braces: even a validly signed key can only ever name a demo person.
    if (!DEMO_LOGIN.test(String(run.login).toLowerCase())) return json(res, 400, { error: 'That is not a demo run this page started.' });
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (reads.get(ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= 60) return json(res, 429, { error: 'Too many reads. Wait a minute.' });
    recent.push(now); reads.set(ip, recent);
    if (reads.size > 1000) reads.delete(reads.keys().next().value);
    try {
      const state = await readback.read(run.login, masker);
      json(res, 200, { ...state, expired: now > run.exp });
    } catch (err) {
      log.warn(`[dashboard] readback unavailable: ${err.message}`);
      json(res, 503, { error: "The Expenses database couldn't be read just now. Try again in a minute." });
    }
  }));

  // Where a replay came from. Recorded = captured from a real run with
  // tools/record-scenario.js; illustrative = hand-written timings. Anything
  // else is shown as unlabelled rather than trusted.
  const PROVENANCE = new Set(['recorded', 'illustrative']);
  const provenance = (s) => {
    const p = s.provenance || {};
    const kind = PROVENANCE.has(p.kind) ? p.kind : 'unlabelled';
    const out = { kind };
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(p.capturedAt || ''))) out.capturedAt = p.capturedAt;
    if (p.note) out.note = masker.scrub(p.note);
    return out;
  };
  const STATUS_OK = new Set(['succeeded', 'failed', 'awaiting_scim', 'running', 'pending']);
  const replayStatus = (s) => (STATUS_OK.has(s.operation?.status) ? s.operation.status : 'unknown');

  router.get('/api/scenarios', wrap(async (req, res) => {
    const list = await scenarios.all();
    json(res, 200, { scenarios: list.map((s) => ({ id: s.id, title: masker.scrub(s.title), description: masker.scrub(s.description), status: replayStatus(s), provenance: provenance(s) })) }, 'public, max-age=300');
  }));

  router.get('/api/scenarios/:id', wrap(async (req, res) => {
    const s = (await scenarios.all()).find((x) => x.id === req.params.id);
    if (!s) return json(res, 404, { error: 'No replay has that id.' });
    json(res, 200, { id: s.id, title: masker.scrub(s.title), description: masker.scrub(s.description), provenance: provenance(s), operation: masker.operation(s.operation, { withSteps: true }) }, 'public, max-age=300');
  }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    const ref = crypto.randomBytes(4).toString('hex');
    log.error(`[dashboard] ${ref} ${req.method} ${req.originalUrl}: ${err.stack || err}`);
    const upstreamDown = err.upstreamStatus || err.name === 'TimeoutError' || err.cause;
    json(res, upstreamDown ? 502 : 500, {
      error: upstreamDown ? "The lab's lifecycle API didn't answer. Try again in a minute." : 'The dashboard hit an error.',
      ref,
    });
  });

  return router;
}

module.exports = { createDashboardRouter };
