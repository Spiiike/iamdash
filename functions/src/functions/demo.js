'use strict';
/*
 * Public demo: a visitor creates a throwaway person, signs in to Glasscliff
 * Expenses as them, changes their title, and watches offboarding end the
 * session they are actually using.
 *
 * The visitor chooses a display name and a job title from a fixed list. The
 * login is always invented here (demo-<hex>@DEMO_EMAIL_DOMAIN), never taken
 * from the visitor, so the demo can't be aimed at a real mailbox: Okta mails
 * the profile email address for activations and notifications, and that
 * address is always one with no mailbox. Every demo user is deleted when it
 * expires.
 *
 * The password is generated here, sent to Okta once, and returned once in the
 * hire response for wetcliff to show the visitor who started the run. It is
 * never logged and never written to the operations, steps or demo tables.
 *
 *   POST lifecycle/demo/hire        { name?, title? } -> person + one-time password
 *   POST lifecycle/demo/transfer    title change for a live demo person
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
  ttlMinutes: num(process.env.DEMO_TTL_MINUTES, 8),
  maxLive: num(process.env.DEMO_MAX_LIVE, 3),
  dailyMax: num(process.env.DEMO_DAILY_MAX, 30),
  // The Okta group demo people are created in. Assign Expenses to it and give it
  // its own sign-on rule (docs/visitor-sign-in.md). Optional, but without it a
  // demo person falls under whatever policy covers Everyone.
  groupId: String(process.env.DEMO_OKTA_GROUP_ID || '').trim(),
});

const PARTITION = 'demo';
const COUNTER = 'demo-daily';
const FIRST = ['Robin', 'Alex', 'Sam', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Quinn', 'Avery', 'Rowan'];
const LAST = ['Ellis', 'Hart', 'Nolan', 'Reyes', 'Shaw', 'Vance', 'Weeks', 'Okafor', 'Bright', 'Lund'];
// Job titles a visitor can pick, and the department each one lands in. A fixed
// list rather than free text: the title is shown back in Expenses and pushed
// through Okta, and a list can't carry anything unpleasant into either.
const TITLES = {
  Analyst: 'Finance',
  Accountant: 'Finance',
  'Software Engineer': 'Engineering',
  'Support Engineer': 'Engineering',
  'Product Manager': 'Product',
  Designer: 'Product',
  Recruiter: 'People',
  'Sales Representative': 'Sales',
};
const START = { title: 'Analyst', department: 'Finance' };

// A role change: one step up in title, and a move to a different department.
function nextRole(title, department) {
  const base = String(title || START.title);
  const next = /^Lead /.test(base) ? base.replace(/^Lead /, 'Principal ') : /^Senior /.test(base) ? base.replace(/^Senior /, 'Lead ') : `Senior ${base}`;
  return { title: next, department: department === 'Operations' ? 'Finance' : 'Operations' };
}

// Letters (any script), spaces, hyphens and apostrophes; 1-40 characters.
const NAME = /^[\p{L}][\p{L}\p{M}' -]{0,39}$/u;
function parseName(raw) {
  const name = String(raw || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name) return { firstName: pick(FIRST), lastName: pick(LAST) };
  if (!NAME.test(name)) return null;
  const [firstName, ...rest] = name.split(' ');
  return { firstName, lastName: rest.join(' ') || pick(LAST) };
}

// Readable, and always has upper case, lower case, a digit and a symbol, so any
// reasonable Okta password policy accepts it: four groups like "Kq7m", joined
// with hyphens. About 52 bits, for an account that lives a few minutes.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT = '23456789';
function newPassword() {
  const c = (set) => set[crypto.randomInt(set.length)];
  return Array.from({ length: 4 }, () => c(UPPER) + c(LOWER) + c(DIGIT) + c(LOWER)).join('-');
}

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
    titles: Object.keys(TITLES),
    signIn: true, // this version hands the visitor a password to sign in with
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

  let body = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) || {} : {};
  } catch {
    return reply(400, { error: 'Body must be JSON' });
  }
  const names = parseName(body.name);
  if (!names) return reply(400, { error: 'Use letters, spaces, hyphens or apostrophes for the name, up to 40 characters.' });
  const title = body.title === undefined || body.title === '' ? START.title : String(body.title);
  if (!Object.hasOwn(TITLES, title)) return reply(400, { error: 'Pick one of the job titles on the list.' });
  const department = TITLES[title];

  const state = await limits();
  if (state.live >= cfg.maxLive) {
    return reply(429, { error: `The demo is busy: ${state.live} runs are already live. They clear themselves within ${cfg.ttlMinutes} minutes.` });
  }
  if (state.startedToday >= cfg.dailyMax) {
    return reply(429, { error: "The demo has hit today's limit. Watch a replay instead, or come back tomorrow." });
  }
  await bumpDailyCount();

  const login = `demo-${crypto.randomBytes(4).toString('hex')}@${cfg.domain}`;
  const profile = { ...names, email: login, login, title, department, manager: 'Glasscliff Lab' };
  // A password means Okta activates the user without emailing the address.
  const password = newPassword();
  const credentials = { password: { value: password } };
  const groupIds = cfg.groupId ? [cfg.groupId] : [];
  const expiresAt = new Date(Date.now() + cfg.ttlMinutes * 60000).toISOString();

  const view = await withOperation('hire', login, (op) => lifecycle.runners.hire.execute(op, { target: login, profile, credentials, groupIds }), { expiresAt });

  // No session row is written here any more. The visitor signs in to Expenses
  // with the password below, and that sign-in writes a real one.
  const t = await table();
  await t.upsertEntity({
    partitionKey: PARTITION,
    rowKey: login,
    oktaUserId: view.oktaUserId || '',
    state: 'live',
    createdAt: new Date().toISOString(),
    expiresAt,
    hireOperationId: view.operationId,
    title,
    department,
  }, 'Replace');
  context.log(`[demo] hired ${login}, expires ${expiresAt}`); // never the password
  return reply(200, { ...view, demo: { login, password, expiresAt, ttlMinutes: cfg.ttlMinutes, title, department } });
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
    let after = {};
    const view = await withOperation(type, row.rowKey, async (op) => { after = (await run(op, row)) || {}; }, { expiresAt: row.expiresAt });
    return reply(200, { ...view, demo: { login: row.rowKey, expiresAt: row.expiresAt, ...after } });
  };
}

const demoTransfer = demoAction('transfer', async (op, row) => {
  const profile = nextRole(row.title || START.title, row.department || START.department);
  await lifecycle.runners.transfer.execute(op, { target: row.rowKey, profile });
  const t = await table();
  await t.updateEntity({ partitionKey: PARTITION, rowKey: row.rowKey, ...profile }, 'Merge');
  return profile;
});

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
// Every minute: with an 8-minute lifetime, a 5-minute sweep could let a person
// live for 13.
app.timer('demoCleanup', { schedule: process.env.DEMO_CLEANUP_SCHEDULE || '0 * * * * *', handler: cleanup });

module.exports = { demoHire, demoTransfer, demoTerminate, demoLimits, cleanup, limits, parseName, newPassword, nextRole, TITLES };
