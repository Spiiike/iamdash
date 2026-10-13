'use strict';
// Operator lifecycle API. Every route needs the operator key header
// (API_OPERATOR_HEADER, default x-lab-operator-key = API_OPERATOR_KEY).
//
//   POST /api/lifecycle/hire         create Okta user + assign Glasscliff Expenses
//   POST /api/lifecycle/transfer     change department / title / manager
//   POST /api/lifecycle/terminate    end sessions + deactivate in Okta
//   GET  /api/lifecycle/status/{id}  one operation, its steps, linked SCIM calls
//   GET  /api/lifecycle/operations   recent operations, newest first
//   GET|POST /api/lifecycle/events/okta   Okta Event Hook receiver
//
// Flow: this API changes Okta; Okta provisions the Expenses app over SCIM
// (scim.js); the "verify.*" steps then check the Accounts/Sessions tables to
// prove the downstream change actually happened.

const crypto = require('node:crypto');
const { app } = require('@azure/functions');
const store = require('../lib/storage');
const okta = require('../lib/okta');
const ops = require('../lib/operations');
const dsm = require('../lib/downstream');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ helpers
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function authorized(request) {
  const expected = process.env.API_OPERATOR_KEY || '';
  if (!expected || store.isUnresolvedKeyVaultRef(expected)) return false;
  const header = (process.env.API_OPERATOR_HEADER || 'x-lab-operator-key').toLowerCase();
  const given = Buffer.from(request.headers.get(header) || '');
  const want = Buffer.from(expected);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

const reply = (status, jsonBody) => ({ status, jsonBody });

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Body must be JSON');
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function expensesAppId() {
  const id = process.env.OKTA_EXPENSES_APP_ID || '';
  if (!id) throw new ApiError(503, 'OKTA_EXPENSES_APP_ID is not set; set oktaExpensesAppId in the Bicep parameters and redeploy');
  return id;
}

// Polls the Accounts table (written by the SCIM endpoint) until `check`
// passes or the timeout ends. Okta provisions asynchronously.
async function waitForAccount(userName, check) {
  const timeoutMs = 1000 * Number(process.env.LAB_VERIFY_TIMEOUT_SECONDS || 45);
  const intervalMs = 1000 * Number(process.env.LAB_VERIFY_INTERVAL_SECONDS || 3);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const account = await store.findAccount(userName);
    if (account && check(account)) return account;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

async function result(op, httpStatus) {
  return reply(httpStatus, { ...ops.publicView(op), steps: await ops.steps(op), scim: await ops.scimActivity(op) });
}

// Shared wrapper: auth, idempotency, failure bookkeeping.
function operation(type, run) {
  return async (request, context) => {
    if (!authorized(request)) return reply(401, { error: 'Missing or invalid operator key' });

    const idemKey = str(request.headers.get('idempotency-key')).slice(0, 200).replace(/[\\/#?]/g, '_');
    const previous = await ops.findIdempotent(idemKey);
    if (previous) return result(previous, 200);

    let body;
    try {
      body = await readJson(request);
    } catch (err) {
      return reply(err.status, { error: err.message });
    }

    let op;
    try {
      const validated = run.validate(body);
      op = await ops.create(type, validated.target, body);
      await ops.rememberIdempotent(idemKey, op);
      await run.execute(op, validated);
      return result(op, op.status === 'succeeded' ? 200 : 202);
    } catch (err) {
      if (!(err instanceof ApiError)) context.error(`${type} failed`, err);
      const status = err instanceof okta.OktaError ? (err.status === 503 ? 503 : err.status === 404 ? 404 : 502) : err.status || 500;
      const message = err instanceof okta.OktaError && err.body?.errorCauses?.length
        ? `${err.message}: ${err.body.errorCauses.map((c) => c.errorSummary).join('; ')}`
        : err.message;
      if (!op) return reply(status, { error: message });
      await ops.update(op, { status: 'failed', error: message });
      return result(op, status);
    }
  };
}

// ------------------------------------------------- Entra ID and Google steps
// Only when DOWNSTREAM_VERIFY names them, and only when the call asked for it:
// the public demo never does, because its invented logins aren't in a domain
// either directory accepts.

function downstreamDirs(wanted) {
  return wanted ? dsm.targets() : [];
}

// Hire: put the person where the downstream apps are assigned. A group assigned
// to both apps (OKTA_DOWNSTREAM_GROUP_ID) is how most tenants do it; otherwise
// each app is assigned directly.
async function assignDownstream(op, userId, target, dirs) {
  // The groups your Office 365 and Google Workspace apps are *already* assigned
  // to: one id, or two separated by a comma when each app has its own group.
  // Joining them is how a real hire gets access, so it's what the lab does.
  const groupIds = String(process.env.OKTA_DOWNSTREAM_GROUP_ID || '').split(',').map((g) => g.trim()).filter(Boolean);
  if (groupIds.length) {
    await ops.step(op, 'okta.addToGroup', async () => {
      for (const g of groupIds) await okta.addToGroup(g, userId);
      const n = groupIds.length === 1 ? 'the group' : `the ${groupIds.length} groups`;
      return { detail: `added to ${n} assigned to ${dirs.map((d) => dsm.LABEL[d]).join(' and ')}` };
    });
    return;
  }
  const appIds = { entra: process.env.OKTA_ENTRA_APP_ID || '', google: process.env.OKTA_GOOGLE_APP_ID || '' };
  for (const d of dirs) {
    if (!appIds[d]) throw new ApiError(503, `${d === 'entra' ? 'OKTA_ENTRA_APP_ID' : 'OKTA_GOOGLE_APP_ID'} is not set`);
    await ops.step(op, d === 'entra' ? 'okta.assignEntra' : 'okta.assignGoogle', async () => {
      await okta.assignToApp(appIds[d], userId, target);
      return { detail: `assigned the ${d === 'entra' ? 'Office 365' : 'Google Workspace'} app` };
    });
  }
}

// Runs the verify step for each directory in parallel, so the three lanes on the
// dashboard move at the same time, exactly as the pushes do.
function downstreamSteps(op, type, dirs, check) {
  if (!dirs.length) return [];
  const reader = dsm.createReader();
  const opts = dsm.settings();
  return dirs.map((d) => ops.step(op, dsm.STEP[type][d], dsm.guarded(d, () => check(reader, d, opts))));
}

// One place that turns "Expenses done?" plus the downstream results into the
// operation's status and summary.
async function settle(op, { verb, target, expensesOk, expensesSkipped = false, dirs = [], results = [], expect }) {
  const failed = dirs.filter((_, i) => results[i]?.failed);
  const pending = dirs.filter((_, i) => results[i]?.pending);
  const names = (list) => list.map((d) => dsm.LABEL[d]).join(' and ');
  const fields = {
    expensesPending: !(expensesOk || expensesSkipped),
    downstreamPending: pending.join(','),
    downstreamExpect: expect ? JSON.stringify(expect) : '',
  };
  if (failed.length) {
    return ops.update(op, { ...fields, status: 'failed', error: `Could not verify ${names(failed)}`, summary: `${verb} ${target} in Okta; ${names(failed)} check failed` });
  }
  const waiting = [...(fields.expensesPending ? ['Expenses'] : []), ...pending.map((d) => dsm.LABEL[d])];
  if (waiting.length) {
    return ops.update(op, { ...fields, status: 'awaiting_scim', summary: `${verb} ${target} in Okta; waiting for ${waiting.join(' and ')} (check status later)` });
  }
  const where = [
    ...(expensesSkipped ? [] : ['Expenses']),
    ...dirs.filter((_, i) => !results[i]?.skipped).map((d) => dsm.LABEL[d]),
  ];
  const confirmed = where.length ? `; confirmed in ${where.join(', ').replace(/, ([^,]*)$/, ' and $1')}` : ' in Okta';
  return ops.update(op, { ...fields, status: 'succeeded', summary: `${verb} ${target}${confirmed}` });
}

// --------------------------------------------------------------- operations
const hire = {
  validate(body) {
    const firstName = str(body.firstName);
    const lastName = str(body.lastName);
    const email = str(body.email).toLowerCase();
    if (!firstName || !lastName) throw new ApiError(400, 'firstName and lastName are required');
    if (!EMAIL.test(email)) throw new ApiError(400, 'A valid email is required');
    const login = str(body.login).toLowerCase() || email;
    if (!EMAIL.test(login)) throw new ApiError(400, 'login must be email-shaped');
    expensesAppId();
    return {
      target: login,
      downstream: body.downstream === true,
      profile: {
        firstName,
        lastName,
        email,
        login,
        ...(str(body.department) && { department: str(body.department) }),
        ...(str(body.title) && { title: str(body.title) }),
        ...(str(body.manager) && { manager: str(body.manager) }),
      },
    };
  },
  async execute(op, { target, profile, downstream }) {
    const appId = expensesAppId();
    const dirs = downstreamDirs(downstream);
    await ops.step(op, 'okta.lookup', async () => {
      if (await okta.getUser(target)) throw new ApiError(409, `${target} already exists in Okta`);
      return { detail: 'not found, ok to create' };
    });
    const user = await ops.step(op, 'okta.createUser', async () => {
      const u = await okta.createUser(profile);
      return { ...u, detail: `id ${u.id}, status ${u.status}` };
    });
    await ops.update(op, { oktaUserId: user.id });
    await ops.step(op, 'okta.assignExpenses', async () => {
      await okta.assignToApp(appId, user.id, target);
      return { detail: `assigned to app ${appId}` };
    });
    if (dirs.length) await assignDownstream(op, user.id, target, dirs);
    const [account, ...results] = await Promise.all([
      ops.step(op, 'verify.expensesAccountCreated', async () => {
        const a = await waitForAccount(target, (row) => row.active === true);
        return a ? { account: a, detail: `SCIM account ${a.rowKey} is active` } : { outcome: 'pending', detail: 'Okta has not provisioned the account yet' };
      }),
      ...downstreamSteps(op, 'hire', dirs, (reader, d, opts) => dsm.created(reader, d, target, opts)),
    ]);
    await settle(op, { verb: 'Hired', target, expensesOk: Boolean(account.account), dirs, results });
  },
};

const transfer = {
  validate(body) {
    const login = str(body.login).toLowerCase();
    if (!login) throw new ApiError(400, 'login is required');
    const profile = {};
    for (const k of ['department', 'title', 'manager']) if (str(body[k])) profile[k] = str(body[k]);
    if (!Object.keys(profile).length) throw new ApiError(400, 'Provide at least one of department, title, manager');
    return { target: login, profile, downstream: body.downstream !== false };
  },
  async execute(op, { target, profile, downstream }) {
    const dirs = downstreamDirs(downstream);
    const user = await ops.step(op, 'okta.lookup', async () => {
      const u = await okta.getUser(target);
      if (!u) throw new ApiError(404, `${target} not found in Okta`);
      return { ...u, detail: `id ${u.id}, status ${u.status}` };
    });
    await ops.update(op, { oktaUserId: user.id });
    await ops.step(op, 'okta.updateProfile', async () => {
      await okta.updateProfile(user.id, profile);
      return { detail: `set ${Object.keys(profile).join(', ')}` };
    });
    const [verified, ...results] = await Promise.all([
      ops.step(op, 'verify.expensesAccountUpdated', async () => {
        if (!(await store.findAccount(target))) return { outcome: 'skipped', skipped: true, detail: 'user has no Expenses account' };
        const a = await waitForAccount(target, (row) => row.lastModified > op.created);
        return a ? { ok: true, detail: 'SCIM update received' } : { outcome: 'pending', detail: 'no SCIM update yet; check the attribute is mapped in Okta (Provisioning > To App mappings)' };
      }),
      ...downstreamSteps(op, 'transfer', dirs, (reader, d, opts) => dsm.updated(reader, d, target, profile, opts)),
    ]);
    await settle(op, {
      verb: 'Transferred', target, expensesOk: Boolean(verified.ok), expensesSkipped: Boolean(verified.skipped), dirs, results,
      expect: { title: profile.title, department: profile.department },
    });
  },
};

const terminate = {
  validate(body) {
    const login = str(body.login).toLowerCase();
    if (!login) throw new ApiError(400, 'login is required');
    return { target: login, downstream: body.downstream !== false };
  },
  async execute(op, { target, downstream }) {
    const dirs = downstreamDirs(downstream);
    const user = await ops.step(op, 'okta.lookup', async () => {
      const u = await okta.getUser(target);
      if (!u) throw new ApiError(404, `${target} not found in Okta`);
      return { ...u, detail: `id ${u.id}, status ${u.status}` };
    });
    await ops.update(op, { oktaUserId: user.id });
    // Read before deactivating, so "gone afterwards" can be told apart from
    // "was never there". Not a step: it changes nothing and proves nothing yet.
    const had = dirs.length ? await dsm.presence(dsm.createReader(), dirs, target) : {};
    const already = user.status === 'DEPROVISIONED';
    await ops.step(op, 'okta.clearSessions', async () => {
      if (already) return { outcome: 'skipped', detail: 'user already deactivated' };
      await okta.clearSessions(user.id);
      return { detail: 'Okta sessions ended, OAuth tokens revoked' };
    });
    await ops.step(op, 'okta.deactivate', async () => {
      if (already) return { outcome: 'skipped', detail: 'user already deactivated' };
      await okta.deactivate(user.id);
      return { detail: 'status DEPROVISIONED' };
    });
    const [account, ...results] = await Promise.all([
      ops.step(op, 'verify.expensesAccountDisabled', async () => {
        if (!(await store.findAccount(target))) return { outcome: 'skipped', skipped: true, detail: 'user has no Expenses account' };
        const a = await waitForAccount(target, (row) => row.active === false);
        return a ? { ok: true, detail: 'SCIM account is inactive' } : { outcome: 'pending', detail: 'Okta has not deactivated the account yet' };
      }),
      ...downstreamSteps(op, 'terminate', dirs, (reader, d, opts) => dsm.disabled(reader, d, target, had[d], opts)),
    ]);
    await ops.step(op, 'verify.expensesSessionsEnded', async () => {
      const left = await store.countSessions(target);
      if (!left) return { detail: 'no live Expenses sessions' };
      const removed = await store.invalidateSessions(target); // safety net
      return { detail: `removed ${removed} leftover session(s)` };
    });
    await settle(op, { verb: 'Terminated', target, expensesOk: Boolean(account.ok), expensesSkipped: Boolean(account.skipped), dirs, results });
  },
};

// ------------------------------------------------------------ read routes
async function status(request, context) {
  if (!authorized(request)) return reply(401, { error: 'Missing or invalid operator key' });
  const op = await ops.get(request.params.operationId);
  if (!op) return reply(404, { error: 'Operation not found' });

  // One cheap re-check for operations still waiting on Okta's push.
  if (op.status === 'awaiting_scim') {
    try {
      await recheck(op);
    } catch (err) {
      context.warn('recheck failed', err);
    }
  }
  return result(op, 200);
}

// Expenses and each still-pending directory get one read, no waiting. Operations
// recorded before downstream checks existed have no expensesPending field and
// behave exactly as they always did.
async function recheck(op) {
  const legacy = op.expensesPending === undefined;
  let expensesDone = true;
  if (legacy || op.expensesPending) {
    const account = await store.findAccount(op.target);
    expensesDone =
      (op.type === 'hire' && account?.active === true) ||
      (op.type === 'transfer' && account && account.lastModified > op.created) ||
      (op.type === 'terminate' && account?.active === false);
    if (expensesDone) await ops.step(op, 'verify.recheck', async () => ({ detail: 'SCIM change confirmed on status check' }));
  }

  const pending = String(op.downstreamPending || '').split(',').filter((d) => dsm.DIRECTORIES.includes(d));
  const still = [];
  if (pending.length) {
    const reader = dsm.createReader();
    const once = { timeoutMs: 0, intervalMs: 0 };
    const expect = op.downstreamExpect ? JSON.parse(op.downstreamExpect) : {};
    for (const d of pending) {
      const r =
        op.type === 'hire' ? await dsm.created(reader, d, op.target, once)
        : op.type === 'transfer' ? await dsm.updated(reader, d, op.target, expect, once)
        : await dsm.disabled(reader, d, op.target, undefined, once);
      if (r.ok) await ops.step(op, 'verify.recheck', async () => ({ detail: `${dsm.LABEL[d]} change confirmed on status check` }));
      else still.push(d);
    }
  }

  if (expensesDone && !still.length) {
    await ops.update(op, { status: 'succeeded', expensesPending: false, downstreamPending: '', summary: op.summary.replace(/;.*$/, '; confirmed on status check') });
  } else {
    await ops.update(op, { expensesPending: !expensesDone, downstreamPending: still.join(',') });
  }
}

async function listOperations(request) {
  if (!authorized(request)) return reply(401, { error: 'Missing or invalid operator key' });
  const limit = Math.min(100, Math.max(1, parseInt(request.query.get('limit') || '20', 10) || 20));
  return reply(200, { operations: await ops.list(limit) });
}

// Okta Event Hook: one-time GET verification, then POSTed event batches.
// Configure the hook's auth header as x-lab-operator-key = operator key.
async function oktaEvents(request, context) {
  if (!authorized(request)) return reply(401, { error: 'Missing or invalid operator key' });
  if (request.method === 'GET') {
    return reply(200, { verification: request.headers.get('x-okta-verification-challenge') || '' });
  }
  const body = await readJson(request).catch(() => ({}));
  const events = body?.data?.events || [];
  for (const e of events) {
    const user = (e.target || []).find((t) => t.type === 'User');
    try {
      await store.recordStep({
        source: 'okta-event-hook',
        step: `okta.event.${e.eventType}`,
        userName: user?.alternateId || '',
        userNameLower: String(user?.alternateId || '').toLowerCase(),
        outcome: e.outcome?.result === 'FAILURE' ? 'failed' : 'succeeded',
        detail: e.displayMessage || '',
        oktaEventId: e.uuid || '',
      });
    } catch (err) {
      context.warn('event record failed', err);
    }
  }
  return { status: 200 };
}

const common = { authLevel: 'anonymous' }; // auth = operator key header, checked above
app.http('lifecycleHire', { ...common, methods: ['POST'], route: 'lifecycle/hire', handler: operation('hire', hire) });
app.http('lifecycleTransfer', { ...common, methods: ['POST'], route: 'lifecycle/transfer', handler: operation('transfer', transfer) });
app.http('lifecycleTerminate', { ...common, methods: ['POST'], route: 'lifecycle/terminate', handler: operation('terminate', terminate) });
app.http('lifecycleStatus', { ...common, methods: ['GET'], route: 'lifecycle/status/{operationId}', handler: status });
app.http('lifecycleOperations', { ...common, methods: ['GET'], route: 'lifecycle/operations', handler: listOperations });
app.http('lifecycleOktaEvents', { ...common, methods: ['GET', 'POST'], route: 'lifecycle/events/okta', handler: oktaEvents });

module.exports = {
  hire: operation('hire', hire),
  transfer: operation('transfer', transfer),
  terminate: operation('terminate', terminate),
  status,
  listOperations,
  oktaEvents,
  // Used by the public demo (src/functions/demo.js), which builds its own
  // identities and so calls execute() directly instead of validate().
  runners: { hire, transfer, terminate },
  authorized,
  expensesAppId,
};
