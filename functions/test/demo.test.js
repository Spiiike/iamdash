'use strict';
// node --test test/demo.test.js - the public demo, with Okta, storage and the
// lifecycle runners replaced by fakes. No cloud or Azurite needed.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const SRC = path.join(__dirname, '../src');
const stub = (rel, exports) => {
  const file = require.resolve(path.join(SRC, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};

// ---------------------------------------------------------------- fakes
function fakeTable() {
  const rows = new Map();
  const key = (pk, rk) => `${pk}\u0000${rk}`;
  return {
    rows,
    async upsertEntity(e) { rows.set(key(e.partitionKey, e.rowKey), { ...e }); },
    async createEntity(e) { if (rows.has(key(e.partitionKey, e.rowKey))) throw Object.assign(new Error('exists'), { statusCode: 409 }); rows.set(key(e.partitionKey, e.rowKey), { ...e }); },
    async updateEntity(e) { const k = key(e.partitionKey, e.rowKey); rows.set(k, { ...(rows.get(k) || {}), ...e }); },
    async getEntity(pk, rk) { const r = rows.get(key(pk, rk)); if (!r) throw Object.assign(new Error('nf'), { statusCode: 404 }); return { ...r }; },
    async deleteEntity(pk, rk) { rows.delete(key(pk, rk)); },
    async *listEntities({ queryOptions }) {
      const pk = /'(.*)'/.exec(queryOptions.filter)[1];
      for (const r of rows.values()) if (r.partitionKey === pk) yield { ...r };
    },
  };
}

function loadDemo(env = {}) {
  Object.assign(process.env, { DEMO_ENABLED: 'true', DEMO_TTL_MINUTES: '', DEMO_MAX_LIVE: '', DEMO_DAILY_MAX: '', DEMO_OKTA_GROUP_ID: '', ...env });
  const world = { demo: fakeTable(), sessions: fakeTable(), runs: [], created: [], logs: [], deleted: [] };
  stub('../node_modules/@azure/functions', { app: { http() {}, timer() {} } });
  stub('lib/storage', {
    T: { demoUsers: async () => world.demo, sessions: async () => world.sessions },
    odata: (strings, ...values) => strings.reduce((out, s, i) => out + s + (i < values.length ? `'${values[i]}'` : ''), ''),
  });
  let n = 0;
  stub('lib/operations', {
    async create(type, target, input) { world.created.push({ type, target, input }); return { operationId: `820000000000${n++}-abcdef`, type, target }; },
    async update() {},
    publicView: (op) => ({ operationId: op.operationId, type: op.type, target: op.target, status: 'succeeded', oktaUserId: '00u1exampleuser0demo' }),
    async steps() { return []; },
    async scimActivity() { return []; },
  });
  stub('lib/okta', {
    async getUser(login) { return { id: `id-${login}` }; },
    async deleteUser(id) { world.deleted.push(id); },
  });
  const runner = (type) => ({ async execute(op, args) { world.runs.push({ type, args }); } });
  stub('functions/lifecycle', {
    authorized: () => true,
    runners: { hire: runner('hire'), transfer: runner('transfer'), terminate: runner('terminate') },
  });
  const file = require.resolve(path.join(SRC, 'functions/demo.js'));
  delete require.cache[file];
  return { demo: require(file), world };
}

const req = (body) => ({ text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body });
const ctx = (world) => ({ log: (m) => world.logs.push(String(m)), error: (m) => world.logs.push(String(m)) });

// ---------------------------------------------------------------- tests
test('a hire takes a name and a listed title, and hands back a one-time password', async () => {
  const { demo, world } = loadDemo({ DEMO_OKTA_GROUP_ID: '00g1exampledemogrp1' });
  const r = await demo.demoHire(req({ name: 'Ada Lovelace', title: 'Product Manager' }), ctx(world));
  assert.equal(r.status, 200);
  const { login, password, title, department, ttlMinutes } = r.jsonBody.demo;
  assert.match(login, /^demo-[0-9a-f]{8}@demo\.glasscliff\.online$/, 'the login is invented, never taken from the visitor');
  assert.match(password, /^([A-Z][a-z][2-9][a-z]-){3}[A-Z][a-z][2-9][a-z]$/);
  assert.deepEqual([title, department, ttlMinutes], ['Product Manager', 'Product', 8]);

  const hire = world.runs.find((x) => x.type === 'hire').args;
  assert.equal(hire.credentials.password.value, password, 'the password Okta gets is the one the visitor gets');
  assert.deepEqual(hire.groupIds, ['00g1exampledemogrp1']);
  assert.equal(hire.profile.firstName, 'Ada');
  assert.equal(hire.profile.email, login, 'Okta only ever mails the invented address');
  assert.equal(hire.profile.title, 'Product Manager');
});

test('the password is never logged or stored', async () => {
  const { demo, world } = loadDemo();
  const r = await demo.demoHire(req({}), ctx(world));
  const { password } = r.jsonBody.demo;
  const stored = JSON.stringify([...world.demo.rows.values(), ...world.sessions.rows.values(), world.created]);
  assert.ok(!stored.includes(password), 'not in any table or operation record');
  assert.ok(!world.logs.join('\n').includes(password), 'not in the log');
});

test('no simulated session is written: the visitor signs in for real', async () => {
  const { demo, world } = loadDemo();
  await demo.demoHire(req({}), ctx(world));
  assert.equal(world.sessions.rows.size, 0);
});

test('an empty body gets a random name and the default title', async () => {
  const { demo, world } = loadDemo();
  const r = await demo.demoHire(req(undefined), ctx(world));
  assert.equal(r.status, 200);
  assert.equal(r.jsonBody.demo.title, 'Analyst');
  assert.ok(world.runs[0].args.profile.firstName);
});

test('names and titles outside the rules are refused before anything is created', async () => {
  const { demo, world } = loadDemo();
  for (const body of [{ name: '<script>' }, { name: 'a@b.example' }, { name: 'x'.repeat(41) }, { title: 'Chief Everything Officer' }, { title: 'constructor' }]) {
    const r = await demo.demoHire(req(body), ctx(world));
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(world.runs.length, 0);
  assert.equal(world.demo.rows.size, 0, 'nothing counted against the daily limit either');
});

test('limits report the title list and the new defaults', async () => {
  const { demo } = loadDemo();
  const l = await demo.limits();
  assert.deepEqual([l.ttlMinutes, l.maxLive, l.dailyMax, l.signIn], [8, 3, 30, true]);
  assert.ok(l.titles.includes('Software Engineer'));
});

test('the demo stops at the live cap', async () => {
  const { demo, world } = loadDemo({ DEMO_MAX_LIVE: '2' });
  assert.equal((await demo.demoHire(req({}), ctx(world))).status, 200);
  assert.equal((await demo.demoHire(req({}), ctx(world))).status, 200);
  assert.equal((await demo.demoHire(req({}), ctx(world))).status, 429);
});

test('a role change moves the title up and the department across, and is remembered', async () => {
  const { demo, world } = loadDemo();
  const login = (await demo.demoHire(req({ title: 'Recruiter' }), ctx(world))).jsonBody.demo.login;
  const r = await demo.demoTransfer(req({ login }), ctx(world));
  assert.equal(r.status, 200);
  assert.deepEqual([r.jsonBody.demo.title, r.jsonBody.demo.department], ['Senior Recruiter', 'Operations']);
  assert.deepEqual(world.runs.find((x) => x.type === 'transfer').args.profile, { title: 'Senior Recruiter', department: 'Operations' });
  const row = await world.demo.getEntity('demo', login);
  assert.equal(row.title, 'Senior Recruiter');
  assert.equal(r.jsonBody.demo.password, undefined, 'the password is only ever in the hire response');
});

test('only demo people this file created can be moved or offboarded', async () => {
  const { demo, world } = loadDemo();
  const r = await demo.demoTerminate(req({ login: 'someone.real@glasscliff.online' }), ctx(world));
  assert.equal(r.status, 404);
  assert.equal(world.runs.length, 0);
});

test('cleanup offboards and deletes expired people only', async () => {
  const { demo, world } = loadDemo();
  const a = (await demo.demoHire(req({}), ctx(world))).jsonBody.demo.login;
  const b = (await demo.demoHire(req({}), ctx(world))).jsonBody.demo.login;
  await world.demo.updateEntity({ partitionKey: 'demo', rowKey: a, expiresAt: new Date(Date.now() - 1000).toISOString() });
  await demo.cleanup({}, ctx(world));
  assert.deepEqual(world.deleted, [`id-${a}`]);
  assert.equal(world.runs.filter((x) => x.type === 'terminate').length, 1);
  await assert.rejects(world.demo.getEntity('demo', a));
  assert.ok(await world.demo.getEntity('demo', b));
});

test('role changes keep climbing', () => {
  const { demo } = loadDemo();
  assert.deepEqual(demo.nextRole('Senior Designer', 'Operations'), { title: 'Lead Designer', department: 'Finance' });
  assert.equal(demo.nextRole('Lead Designer', 'Finance').title, 'Principal Designer');
});

test("lifecycle's hire passes the demo's password and group to Okta in the create call", async () => {
  const calls = [];
  stub('../node_modules/@azure/functions', { app: { http() {}, timer() {} } });
  stub('lib/storage', { isUnresolvedKeyVaultRef: () => false, findAccount: async () => ({ active: true, rowKey: 'acct-1' }) });
  stub('lib/okta', {
    OktaError: class extends Error {},
    async getUser() { return null; },
    async createUser(...args) { calls.push(args); return { id: '00u1exampleuser0demo', status: 'ACTIVE' }; },
    async assignToApp() {},
  });
  const steps = [];
  stub('lib/operations', { async step(op, name, fn) { const r = await fn(); steps.push([name, r.detail]); return r; }, async update() {} });
  stub('lib/downstream', { targets: () => [], LABEL: {} });
  process.env.OKTA_EXPENSES_APP_ID = 'app-expenses';
  const file = require.resolve(path.join(SRC, 'functions/lifecycle.js'));
  delete require.cache[file];
  const lifecycle = require(file);
  const credentials = { password: { value: 'Ab2c-Ab2c-Ab2c-Ab2c' } };
  await lifecycle.runners.hire.execute({ created: new Date().toISOString() }, { target: 'demo-1@x.test', profile: { login: 'demo-1@x.test' }, credentials, groupIds: ['00g1exampledemogrp1'] });
  assert.deepEqual(calls[0], [{ login: 'demo-1@x.test' }, credentials, ['00g1exampledemogrp1']]);
  assert.match(steps.find((s) => s[0] === 'okta.createUser')[1], /added to its group/);
  assert.ok(!JSON.stringify(steps).includes('Ab2c-Ab2c'), 'the password is not in any step detail');

  // The operator route never forwards credentials, whatever the body says.
  const v = lifecycle.runners.hire.validate({ firstName: 'A', lastName: 'B', email: 'a.b@x.test', credentials, groupIds: ['x'] });
  assert.equal(v.credentials, undefined);
  assert.equal(v.groupIds, undefined);
});

test('okta.createUser sends groupIds and credentials only when given', async () => {
  stub('lib/storage', { isUnresolvedKeyVaultRef: () => false });
  Object.assign(process.env, { OKTA_ORG_URL: 'https://lab.okta.test', OKTA_API_TOKEN: 'ssws-test', OKTA_AUTH_MODE: 'SSWS' });
  const file = require.resolve(path.join(SRC, 'lib/okta.js'));
  delete require.cache[file];
  const okta = require(file);
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { bodies.push([String(url), JSON.parse(init.body)]); return new Response(JSON.stringify({ id: 'u', status: 'ACTIVE' }), { status: 200 }); };
  try {
    await okta.createUser({ login: 'a@x.test' });
    await okta.createUser({ login: 'b@x.test' }, { password: { value: 'p' } }, ['g1']);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(bodies[0][0], /\/api\/v1\/users\?activate=true$/);
  assert.deepEqual(bodies[0][1], { profile: { login: 'a@x.test' } });
  assert.deepEqual(bodies[1][1], { profile: { login: 'b@x.test' }, credentials: { password: { value: 'p' } }, groupIds: ['g1'] });
});
