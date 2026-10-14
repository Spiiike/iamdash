'use strict';
/*
 * End-to-end for the lifecycle API with Entra ID and Google checks switched on,
 * and for the reconciler's routes. Storage is real (Azurite on its default
 * ports); Okta, Graph and the Google Directory API are a fake world below that
 * "pushes" accounts a few hundred milliseconds after Okta is told to, the way
 * the real connectors do.
 *
 *   npx azurite --silent &      then      node --test test/lifecycle-downstream.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const RUN = crypto.randomBytes(3).toString('hex'); // keeps reruns apart in Azurite
Object.assign(process.env, {
  STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
  STORAGE_TABLE_ACCOUNTS: `Accounts${RUN}`,
  STORAGE_TABLE_STEPS: `Steps${RUN}`,
  STORAGE_TABLE_SESSIONS: `Sessions${RUN}`,
  STORAGE_TABLE_OPERATIONS: `Operations${RUN}`,
  STORAGE_TABLE_IDEMPOTENCY: `Idem${RUN}`,
  RECON_CONTAINER: `recon${RUN}`,
  API_OPERATOR_KEY: 'operator-key-for-tests',
  OKTA_ORG_URL: 'https://lab.okta.test',
  OKTA_API_TOKEN: 'ssws',
  OKTA_EXPENSES_APP_ID: 'app-expenses',
  OKTA_ENTRA_APP_ID: 'app-entra',
  OKTA_GOOGLE_APP_ID: 'app-google',
  GOOGLE_SA_CLIENT_EMAIL: 'recon@lab.iam.gserviceaccount.com',
  GOOGLE_SA_PRIVATE_KEY: privateKey,
  IDENTITY_ENDPOINT: 'https://identity.test/token',
  IDENTITY_HEADER: 'h',
  AZURE_CLIENT_ID: 'uami-client-id',
  DOWNSTREAM_VERIFY: 'entra,google',
  DOWNSTREAM_VERIFY_TIMEOUT_SECONDS: '2',
  DOWNSTREAM_VERIFY_INTERVAL_SECONDS: '0.05',
  LAB_VERIFY_TIMEOUT_SECONDS: '2',
  LAB_VERIFY_INTERVAL_SECONDS: '0.05',
  RECON_EXCEPTIONS: '[]',
  GOOGLE_CUSTOMER: 'C0test123',
});

const store = require('../src/lib/storage');
const lifecycle = require('../src/functions/lifecycle');
const recon = require('../src/functions/recon');

// ------------------------------------------------------------- fake world
const PUSH_MS = 150;
const world = { okta: new Map(), entra: new Map(), google: new Map(), assigned: { entra: new Set(), google: new Set() }, googleBlocked: false };
const later = (fn, ms = PUSH_MS) => setTimeout(fn, ms);
const res = (status, body, headers = {}) =>
  new Response(body === undefined || status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

async function writeAccount(login, fields) {
  const t = await store.T.accounts();
  await t.upsertEntity({ partitionKey: 'glasscliff-expenses', rowKey: `acct-${Buffer.from(login).toString('hex').slice(0, 20)}`, userNameLower: login, lastModified: new Date().toISOString(), ...fields }, 'Merge');
}

function push(login) {
  const u = [...world.okta.values()].find((x) => x.profile.login === login);
  const enabled = !['SUSPENDED', 'DEPROVISIONED'].includes(u.status);
  if (world.assigned.entra.has(login)) {
    world.entra.set(login, { id: `e-${u.id}`, userPrincipalName: login, accountEnabled: enabled, onPremisesImmutableId: `anchor-${u.id}`, givenName: u.profile.firstName, surname: u.profile.lastName, jobTitle: u.profile.title || null, department: u.profile.department || null });
  }
  if (world.assigned.google.has(login) && !world.googleBlocked) {
    world.google.set(login, { id: `g-${u.id}`, primaryEmail: login, suspended: !enabled, orgUnitPath: '/Okta Users', name: { givenName: u.profile.firstName, familyName: u.profile.lastName }, organizations: [{ primary: true, title: u.profile.title, department: u.profile.department }] });
  }
}

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = (init.method || 'GET').toUpperCase();
  const isJson = typeof init.body === 'string' && init.body.startsWith('{');
  const body = isJson ? JSON.parse(init.body) : undefined;

  if (u.host === 'identity.test') {
    assert.equal(u.searchParams.get('client_id'), 'uami-client-id', 'token must be for the user-assigned identity');
    return res(200, { access_token: 'graph-token' });
  }
  if (u.host === 'oauth2.googleapis.com') return res(200, { access_token: 'google-token' });

  if (u.host === 'graph.microsoft.com') {
    const m = u.pathname.match(/^\/v1\.0\/users\/(.+)$/);
    if (m) {
      const user = world.entra.get(decodeURIComponent(m[1]));
      return user ? res(200, user) : res(404, { error: { code: 'Request_ResourceNotFound' } });
    }
    return res(200, { value: [...world.entra.values()] });
  }

  if (u.host === 'admin.googleapis.com') {
    const m = u.pathname.match(/\/users\/(.+)$/);
    if (m) {
      const user = world.google.get(decodeURIComponent(m[1]));
      return user ? res(200, user) : res(404, { error: { code: 404 } });
    }
    return res(200, { users: [...world.google.values()] });
  }

  if (u.host === 'lab.okta.test') {
    const p = u.pathname;
    if (method === 'POST' && p === '/api/v1/users') {
      const id = `00u${crypto.randomBytes(8).toString('hex')}`;
      const user = { id, status: 'ACTIVE', profile: { ...body.profile } };
      world.okta.set(id, user);
      return res(200, user);
    }
    if (method === 'GET' && p === '/api/v1/users') return res(200, [...world.okta.values()]);
    let m = p.match(/^\/api\/v1\/users\/([^/]+)$/);
    if (m && method === 'GET') {
      const key = decodeURIComponent(m[1]);
      const user = world.okta.get(key) || [...world.okta.values()].find((x) => x.profile.login === key);
      return user ? res(200, user) : res(404, { errorSummary: 'Not found' });
    }
    if (m && method === 'POST') {
      const user = world.okta.get(m[1]);
      Object.assign(user.profile, body.profile);
      later(async () => { push(user.profile.login); await writeAccount(user.profile.login, { lastModified: new Date().toISOString() }); });
      return res(200, user);
    }
    m = p.match(/^\/api\/v1\/apps\/([^/]+)\/users$/);
    if (m && method === 'POST') {
      const user = world.okta.get(body.id);
      const login = user.profile.login;
      if (m[1] === 'app-expenses') later(() => writeAccount(login, { active: true, userName: login }));
      if (m[1] === 'app-entra') { world.assigned.entra.add(login); later(() => push(login)); }
      if (m[1] === 'app-google') { world.assigned.google.add(login); later(() => push(login)); }
      return res(200, {});
    }
    if (m && method === 'GET') {
      const dir = m[1] === 'app-entra' ? 'entra' : 'google';
      return res(200, [...world.assigned[dir]].map((login) => ({ credentials: { userName: login } })));
    }
    if (/\/sessions$/.test(p)) return res(204);
    m = p.match(/^\/api\/v1\/users\/([^/]+)\/lifecycle\/deactivate$/);
    if (m) {
      const user = world.okta.get(m[1]);
      user.status = 'DEPROVISIONED';
      later(async () => { push(user.profile.login); await writeAccount(user.profile.login, { active: false }); });
      return res(200, {});
    }
  }
  throw new Error(`unexpected fetch ${method} ${u}`);
};

// --------------------------------------------------------------- helpers
const KEY = { 'x-lab-operator-key': 'operator-key-for-tests' };
const request = ({ body, headers = KEY, params = {}, query = {} } = {}) => ({
  headers: new Headers(headers),
  params,
  query: new URLSearchParams(query),
  method: 'POST',
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});
const ctx = { log() {}, warn() {}, error() {} };
const stepsOf = (r) => Object.fromEntries(r.jsonBody.steps.map((s) => [s.step, s]));
const login = (name) => `${name}-${RUN}@corp.example`;

// ------------------------------------------------------------------ tests
test('hire with downstream=true lands in all three, verified in parallel', async () => {
  const r = await lifecycle.hire(request({ body: { firstName: 'Ada', lastName: 'Byrne', email: login('ada'), title: 'Analyst', department: 'Finance', downstream: true } }), ctx);
  assert.equal(r.status, 200, JSON.stringify(r.jsonBody));
  const s = stepsOf(r);
  for (const name of ['okta.assignEntra', 'okta.assignGoogle', 'verify.expensesAccountCreated', 'verify.entraAccountCreated', 'verify.googleAccountCreated']) {
    assert.equal(s[name]?.outcome, 'succeeded', name);
  }
  assert.match(s['verify.entraAccountCreated'].detail, /anchor set/);
  assert.match(s['verify.googleAccountCreated'].detail, /\/Okta Users/);
  assert.equal(r.jsonBody.status, 'succeeded');
  assert.match(r.jsonBody.summary, /confirmed in Expenses, Entra ID and Google$/);
  // The three verify steps overlapped in time: they ran in parallel.
  const starts = ['verify.expensesAccountCreated', 'verify.entraAccountCreated', 'verify.googleAccountCreated'].map((n) => Date.parse(s[n].started));
  assert.ok(Math.max(...starts) - Math.min(...starts) < PUSH_MS, 'verify steps should start together');
});

test('hire without downstream behaves exactly as before: Expenses only', async () => {
  const r = await lifecycle.hire(request({ body: { firstName: 'Bo', lastName: 'Lind', email: login('bo') } }), ctx);
  assert.equal(r.jsonBody.status, 'succeeded');
  assert.equal(r.jsonBody.steps.some((x) => /entra|google/i.test(x.step)), false);
  assert.match(r.jsonBody.summary, /confirmed in Expenses$/);
});

test('transfer checks the new title and department arrived in both directories', async () => {
  const r = await lifecycle.transfer(request({ body: { login: login('ada'), title: 'Senior Analyst', department: 'Operations' } }), ctx);
  const s = stepsOf(r);
  assert.equal(s['verify.entraAccountUpdated'].outcome, 'succeeded');
  assert.equal(s['verify.googleAccountUpdated'].outcome, 'succeeded');
  assert.equal(s['verify.entraAccountUpdated'].detail, 'title and department updated');
  assert.equal(r.jsonBody.status, 'succeeded');
});

test('terminate sees Entra disable and Google suspend; directories with no account are skipped', async () => {
  const r = await lifecycle.terminate(request({ body: { login: login('ada') } }), ctx);
  const s = stepsOf(r);
  assert.equal(s['verify.entraAccountDisabled'].detail, 'account disabled');
  assert.equal(s['verify.googleAccountSuspended'].detail, 'account suspended');
  assert.equal(r.jsonBody.status, 'succeeded');

  const bo = await lifecycle.terminate(request({ body: { login: login('bo') } }), ctx);
  const b = stepsOf(bo);
  assert.equal(b['verify.entraAccountDisabled'].outcome, 'skipped');
  assert.equal(b['verify.googleAccountSuspended'].outcome, 'skipped');
  assert.match(bo.jsonBody.summary, /confirmed in Expenses$/);
});

test('a directory that never receives the push leaves the run waiting, and a later status check confirms it', async () => {
  world.googleBlocked = true;
  const r = await lifecycle.hire(request({ body: { firstName: 'Cy', lastName: 'Moss', email: login('cy'), downstream: true } }), ctx);
  const s = stepsOf(r);
  assert.equal(s['verify.entraAccountCreated'].outcome, 'succeeded');
  assert.equal(s['verify.googleAccountCreated'].outcome, 'pending');
  assert.equal(r.jsonBody.status, 'awaiting_scim');
  assert.match(r.jsonBody.summary, /waiting for Google/);

  world.googleBlocked = false;
  push(login('cy'));
  const st = await lifecycle.status(request({ params: { operationId: r.jsonBody.operationId } }), ctx);
  assert.equal(st.jsonBody.status, 'succeeded');
  assert.ok(st.jsonBody.steps.some((x) => x.step === 'verify.recheck' && /Google change confirmed/.test(x.detail)));
});

test('the reconciler routes need the operator key, and serve nothing until a run completes', async () => {
  assert.equal((await recon.snapshot(request({ headers: {} }))).status, 401);
  assert.equal((await recon.runNow(request({ headers: {} }), ctx)).status, 401);
  assert.equal((await recon.snapshot(request())).status, 404);
});

test('a manual run reads all three, saves, and the snapshot route returns it', async () => {
  const run = await recon.runNow(request(), ctx);
  assert.equal(run.status, 200, JSON.stringify(run.jsonBody));
  assert.ok(run.jsonBody.summary.people >= 3);
  const snap = await recon.snapshot(request());
  assert.equal(snap.status, 200);
  assert.equal(snap.jsonBody.generatedAt, run.jsonBody.generatedAt);
  assert.ok(Array.isArray(snap.jsonBody.users));
  // A second run straight away is refused rather than hammering three APIs.
  assert.equal((await recon.runNow(request(), ctx)).status, 429);
});

test('a failed directory read publishes nothing and keeps the previous result', async () => {
  const before = (await recon.snapshot(request())).jsonBody.generatedAt;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).includes('admin.googleapis.com') ? res(403, { error: 'denied' }) : realFetch(url, init));
  try {
    await assert.rejects(() => recon.timer({}, ctx), /nothing published/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal((await recon.snapshot(request())).jsonBody.generatedAt, before);
});
