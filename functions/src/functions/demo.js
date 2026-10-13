'use strict';
/*
 * Public demo: a visitor starts a hire, a role change and an offboarding
 * against throwaway identities this file invents. Nothing a visitor sends is
 * used to build the identity, so the demo can never be aimed at someone's
 * real mailbox, and every demo user is deleted when it expires.
 *
 *   POST lifecycle/demo/hire        creates a demo person and hires them
 *   POST lifecycle/demo/transfer    role change for a live demo person
 *   POST lifecycle/demo/terminate   offboards them now
 *   GET  lifecycle/demo/limits      what the demo will currently allow
 *   timer demoCleanup               offboards and deletes expired demo users
 *
 * The operator key is still required: wetcliff calls these server-side and
 * adds its own per-visitor rate limiting.
 */
const crypto = require('crypto');
const { app } = require('@azure/functions');
const lifecycle = require('./lifecycle');
const ops = require('../lib/operations');
const store = require('../lib/storage');
const okta = require('../lib/okta');

const num = (v, fallback) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : fallback);
const CFG = () => ({
  enabled: (process.env.DEMO_ENABLED || 'true').toLowerCase() === 'true',
  domain: (process.env.DEMO_EMAIL_DOMAIN || 'demo.glasscliff.online').replace(/^@/, ''),
  ttlMinutes: num(process.env.DEMO_TTL_MINUTES, 30),
  maxLive: num(process.env.DEMO_MAX_LIVE, 5),
  dailyMax: num(process.env.DEMO_DAILY_MAX, 50),
});

const PARTITION = 'demo';
const COUNTER = 'demo-daily';
const FIRST = ['Robin', 'Alex', 'Sam', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Quinn', 'Avery', 'Rowan'];
const LAST = ['Ellis', 'Hart', 'Nolan', 'Reyes', 'Shaw', 'Vance', 'Weeks', 'Okafor', 'Bright', 'Lund'];
const START = { title: 'Analyst', department: 'Finance' };
const MOVE = { title: 'Senior Analyst', department: 'Operations' };

const reply = (status, body) => ({ status, jsonBody: body, headers: { 'Cache-Control': 'no-store' } });
const pick = (list) => list[crypto.randomInt(list.length)];
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

async function table() {
  const t = await store.T.demoUsers();
  return t;
}

async function rowsIn(partition) {
  const t = await table();
  const out = [];
  for await (const e of t.listEntities({ queryOptions: { filter: store.odata`PartitionKey eq ${partition}` } })) out.push(e);
  return out;
}
const liveRows = () => rowsIn(PARTITION);

async function countedToday() {
  const t = await table();
  try {
    const row = await t.getEntity(COUNTER, dayKey());
    return { count: Number(row.count) || 0, etag: row.etag };
  } catch (err) {
    if (err.statusCode === 404) return { count: 0, etag: null };
    throw err;
  }
}

async function bumpDailyCount() {
  const t = await table();
  for (let attempt = 0; attempt < 3; attempt++) {
    const { count, etag } = await countedToday();
    const entity = { partitionKey: COUNTER, rowKey: dayKey(), count: count + 1 };
    try {
      if (etag) await t.updateEntity(entity, 'Merge', { etag });
      else await t.createEntity(entity);
      return count + 1;
    } catch (err) {
      if (![409, 412].includes(err.statusCode)) throw err; // someone else bumped it; re-read
    }
  }
  return null;
}

async function limits() {
  const cfg = CFG();
  const [rows, today] = await Promise.all([liveRows(), countedToday()]);
  const live = rows.filter((r) => r.state === 'live');
  return {
    enabled: cfg.enabled,
    live: live.length,
    maxLive: cfg.maxLive,
    startedToday: today.count,
    dailyMax: cfg.dailyMax,
    ttlMinutes: cfg.ttlMinutes,
    available: cfg.enabled && live.length < cfg.maxLive && today.count < cfg.dailyMax,
  };
}

function guard(request) {
  if (!lifecycle.authorized(request)) return reply(401, { error: 'Missing or invalid operator key' });
  if (!CFG().enabled) return reply(503, { error: 'The demo is switched off right now.' });
  return null;
}

async function withOperation(type, target, runner, extra = {}) {
  const op = await ops.create(type, target, { demo: true, ...extra });
  try {
    await runner(op);
  } catch (err) {
    await ops.update(op, { status: 'failed', error: err.message });
    throw err;
  }
  return { ...ops.publicView(op), steps: await ops.steps(op), scim: await ops.scimActivity(op) };
}

// --------------------------------------------------------------------- hire
async function demoHire(request, context) {
  const blocked = guard(request);
  if (blocked) return blocked;
  const cfg = CFG();
  const state = await limits();
  if (state.live >= cfg.maxLive) {
    return reply(429, { error: `The demo is busy: ${state.live} runs are already live. They clear themselves within ${cfg.ttlMinutes} minutes.` });
  }
  if (state.startedToday >= cfg.dailyMax) {
    return reply(429, { error: "The demo has hit today's limit. Watch a replay instead, or come back tomorrow." });
  }
  await bumpDailyCount();

  const firstName = pick(FIRST);
  const lastName = pick(LAST);
  const login = `demo-${crypto.randomBytes(4).toString('hex')}@${cfg.domain}`;
  const profile = { firstName, lastName, email: login, login, ...START, manager: 'Glasscliff Lab' };
  // A password means Okta activates the user without emailing the address.
  const credentials = { password: { value: `Demo!${crypto.randomBytes(18).toString('base64url')}` } };
  const expiresAt = new Date(Date.now() + cfg.ttlMinutes * 60000).toISOString();

  const view = await withOperation('hire', login, (op) => lifecycle.runners.hire.execute(op, { target: login, profile, credentials }), { expiresAt });

  // Demo people never sign in, so without this there would be no session for
  // offboarding to end. The row is marked simulated; everything that happens
  // to it afterwards is real: Okta's SCIM deactivation deletes it, and
  // verify.expensesSessionsEnded checks it is gone.
  const sessions = await store.T.sessions();
  await sessions.upsertEntity({
    partitionKey: login.toLowerCase(),
    rowKey: `sim-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    app: 'expenses',
    userName: login,
    simulated: true,
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  }, 'Replace');

  const t = await table();
  await t.upsertEntity({
    partitionKey: PARTITION,
    rowKey: login,
    oktaUserId: view.oktaUserId || '',
    state: 'live',
    createdAt: new Date().toISOString(),
    expiresAt,
    hireOperationId: view.operationId,
  }, 'Replace');
  context.log(`[demo] hired ${login}, expires ${expiresAt}`);
  return reply(200, { ...view, demo: { login, expiresAt, ttlMinutes: cfg.ttlMinutes } });
}

// ------------------------------------------------------- transfer/terminate
async function demoRow(login) {
  if (!login) return null;
  const t = await table();
  try {
    return await t.getEntity(PARTITION, String(login).toLowerCase());
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

function demoAction(type, run) {
  return async (request, context) => {
    const blocked = guard(request);
    if (blocked) return blocked;
    let body = {};
    try {
      body = (await request.json()) || {};
    } catch {
      return reply(400, { error: 'Body must be JSON' });
    }
    const row = await demoRow(body.login);
    // Only this file's own demo users can be touched here, never a real person.
    if (!row) return reply(404, { error: 'That demo run has already been cleaned up. Start a new one.' });
    if (type === 'transfer' && row.state !== 'live') return reply(409, { error: 'That demo person has already been offboarded.' });
    const view = await withOperation(type, row.rowKey, (op) => run(op, row), { expiresAt: row.expiresAt });
    return reply(200, { ...view, demo: { login: row.rowKey, expiresAt: row.expiresAt } });
  };
}

const demoTransfer = demoAction('transfer', (op, row) =>
  lifecycle.runners.transfer.execute(op, { target: row.rowKey, profile: { ...MOVE } }));

const demoTerminate = demoAction('terminate', async (op, row) => {
  await lifecycle.runners.terminate.execute(op, { target: row.rowKey });
  const t = await table();
  await t.updateEntity({ partitionKey: PARTITION, rowKey: row.rowKey, state: 'offboarded' }, 'Merge');
});

async function demoLimits(request) {
  if (!lifecycle.authorized(request)) return reply(401, { error: 'Missing or invalid operator key' });
  return reply(200, await limits());
}

// ------------------------------------------------------------------ cleanup
// Expiry is enforced here, not in the browser: visitors close tabs.
async function cleanup(timer, context) {
  const cfg = CFG();
  const t = await table();
  const now = Date.now();
  let removed = 0;
  for (const row of await liveRows()) {
    if (!row.expiresAt || Date.parse(row.expiresAt) > now) continue;
    try {
      if (row.state === 'live') {
        await withOperation('terminate', row.rowKey, (op) => lifecycle.runners.terminate.execute(op, { target: row.rowKey }), { expiresAt: row.expiresAt, auto: true });
      }
      const user = await okta.getUser(row.rowKey);
      if (user) await okta.deleteUser(user.id);
      await t.deleteEntity(PARTITION, row.rowKey);
      removed++;
    } catch (err) {
      context.error(`[demo] cleanup failed for ${row.rowKey}: ${err.message}`);
    }
  }
  // Keep yesterday's counters from piling up.
  for (const row of await rowsIn(COUNTER)) {
    if (row.rowKey < dayKey()) await t.deleteEntity(COUNTER, row.rowKey).catch(() => {});
  }
  if (removed) context.log(`[demo] cleaned up ${removed} expired demo user(s)`);
}

const common = { authLevel: 'anonymous' };
app.http('lifecycleDemoHire', { ...common, methods: ['POST'], route: 'lifecycle/demo/hire', handler: demoHire });
app.http('lifecycleDemoTransfer', { ...common, methods: ['POST'], route: 'lifecycle/demo/transfer', handler: demoTransfer });
app.http('lifecycleDemoTerminate', { ...common, methods: ['POST'], route: 'lifecycle/demo/terminate', handler: demoTerminate });
app.http('lifecycleDemoLimits', { ...common, methods: ['GET'], route: 'lifecycle/demo/limits', handler: demoLimits });
app.timer('demoCleanup', { schedule: process.env.DEMO_CLEANUP_SCHEDULE || '0 */5 * * * *', handler: cleanup });

module.exports = { demoHire, demoTransfer, demoTerminate, demoLimits, cleanup, limits };
