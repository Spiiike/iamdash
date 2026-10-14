'use strict';
// The bundled replays, in display order. Adding a replay must not break these tests.
const BUNDLED_IDS = require('../dashboard/scenarios').loadBundled().sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).map((s) => s.id);
// node test/dashboard.test.js  - no Azure needed. Upstream is a fake lifecycle API.
const http = require('http');
const assert = require('assert');
const express = require('express');
const { createDashboardRouter } = require('../dashboard');
const { loadDashboardConfig } = require('../dashboard/config');
const { createScenarioSource, loadBundled } = require('../dashboard/scenarios');

const KEY = 'opk-0123456789abcdef-secret';
// The real terminate status from 2026-09-20, plus fields that must never pass.
const REAL = {
  operationId: '8210082972644-58fba5', type: 'terminate', target: 'TEST.PERSON@EXAMPLE.TEST', status: 'succeeded',
  summary: 'Terminated test.person@example.test; access removed', oktaUserId: '00u1exampleuser0demo',
  firstName: 'Morgan', password: 'hunter2', created: '2026-09-20T15:10:27.355Z', updated: '2026-09-20T15:10:34.906Z',
  steps: [
    { seq: 1, step: 'okta.lookup', outcome: 'succeeded', detail: 'id 00u1exampleuser0demo, status ACTIVE', durationMs: 555, started: '2026-09-20T15:10:27.370Z', userName: 'test.person@example.test' },
    { seq: 4, step: 'verify.expensesAccountDisabled', outcome: 'succeeded', detail: 'SCIM account 3f2b8c1e-9a0d-4e5f-8a7b-1c2d3e4f5a6b is inactive', durationMs: 6036, started: '2026-09-20T15:10:28.845Z' },
    { seq: 5, step: '<img src=x onerror=alert(1)>', outcome: '<b>', detail: '<script>alert(1)</script> assigned to app 0oa1exampleapp0demo9', durationMs: 7, started: 'not a date' },
  ],
  scim: [{ step: 'scim.patchUser', httpStatus: 200, outcome: 'succeeded', at: '2026-09-20T15:10:32.2662616Z', evidenceBlob: 'scim/2026-09-20/2026-09-20T15-10-32-259Z-PATCH-92393c.json', sessionsEnded: 1 }],
};
const HIRE = { operationId: '8210084197900-a1c3e5', type: 'hire', target: 'test.person@example.test', status: 'awaiting_scim', summary: 'Hired test.person@example.test; waiting', created: '2026-09-20T14:50:02.100Z', updated: '2026-09-20T14:50:09.285Z', steps: [], scim: [] };
// "password" is a leak, but PASSWORD_EXPIRED is an Okta account status, not a credential.
const LEAKS = /@|00u1exampleuser|0oa1exampleapp|3f2b8c1e|evidenceBlob|scim\/2026|hunter2|Morgan|password(?!_expired)|oktaUserId|firstName|<script|onerror|opk-/i;

const listen = (app) => new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });

function fakeFetch(state) {
  return async (url, opts) => {
    state.calls.push(url);
    assert.equal(opts.headers['x-lab-operator-key'], KEY, 'operator key is sent upstream');
    if (state.down) throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') });
    if (state.fail) return new Response('{}', { status: 500 });
    await new Promise((r) => setTimeout(r, 20));
    const u = new URL(url);
    if (u.pathname.endsWith('/operations')) return Response.json({ operations: state.ops.map(({ steps, scim, ...v }) => v) });
    const id = decodeURIComponent(u.pathname.split('/').pop());
    const op = state.ops.find((o) => o.operationId === id);
    return op ? Response.json(op) : new Response('{}', { status: 404 });
  };
}

(async () => {
  const state = { calls: [], ops: [REAL, HIRE] };
  let clock = 1_000_000;
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const config = loadDashboardConfig({ LAB_LIFECYCLE_ENDPOINT: 'https://func.example/api/lifecycle', LAB_OPERATOR_KEY: KEY });
  const app = express();
  app.use('/labs/identity', createDashboardRouter({ config, logger, fetchImpl: fakeFetch(state), now: () => clock, scenarios: { all: async () => loadBundled() } }));
  const offCfg = loadDashboardConfig({ LAB_LIFECYCLE_ENDPOINT: 'https://func.example/api/lifecycle', LAB_OPERATOR_KEY: '@Microsoft.KeyVault(SecretUri=x)' });
  app.use('/off', createDashboardRouter({ config: offCfg, logger, scenarios: { all: async () => loadBundled() } }));
  const srv = await listen(app);
  const BASE = `http://127.0.0.1:${srv.address().port}/labs/identity`;
  const get = async (p, base = BASE) => { const r = await fetch(base + p); return { r, text: await r.text() }; };

  let pass = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log(`ok   ${name}`); }
    catch (e) { console.log(`FAIL ${name}\n     ${e.stack}`); console.log(logs.slice(-3).join('\n')); process.exitCode = 1; }
  };
  const tick = (ms) => { clock += ms; };

  await t('list has no emails, Okta ids, UUIDs, evidence paths or extra fields', async () => {
    const { r, text } = await get('/api/operations');
    assert.equal(r.status, 200);
    assert.doesNotMatch(text, LEAKS);
    const { operations } = JSON.parse(text);
    assert.deepEqual(Object.keys(operations[0]).sort(), ['created', 'operationId', 'person', 'status', 'summary', 'type', 'updated']);
  });

  await t('status has no leaks, including hostile step text', async () => {
    const { r, text } = await get('/api/operations/8210082972644-58fba5');
    assert.equal(r.status, 200);
    assert.doesNotMatch(text, LEAKS);
    const op = JSON.parse(text);
    assert.equal(op.steps[0].detail, 'id (hidden), status ACTIVE');
    assert.equal(op.steps[1].detail, 'SCIM account (hidden) is inactive');
    assert.equal(op.steps[2].step, 'step'); assert.equal(op.steps[2].outcome, 'unknown'); assert.equal(op.steps[2].started, undefined);
    assert.equal(op.scim[0].sessionsEnded, 1); assert.equal(op.scim[0].evidenceRecorded, true);
    assert.equal(op.steps[0].userName, undefined);
  });

  await t('one person keeps one pseudonym, whatever the case of their email', async () => {
    const { operations } = JSON.parse((await get('/api/operations')).text);
    const [a, b] = operations;
    assert.match(a.person, /^person-[0-9a-f]{6}$/);
    assert.equal(a.person, b.person);
    assert.equal(a.summary, `Terminated ${a.person}; access removed`);
  });

  await t('operator key never appears in any response', async () => {
    for (const p of ['/', '/api/operations', '/api/operations/8210082972644-58fba5', '/api/scenarios', '/api/scenarios/terminate']) {
      const { r, text } = await get(p);
      assert.ok(!text.includes(KEY), p);
      assert.ok(![...r.headers.values()].some((v) => v.includes(KEY)), `${p} headers`);
    }
  });

  await t('concurrent visitors share one upstream list call; cached for 5 s', async () => {
    tick(10_000); state.calls.length = 0;
    await Promise.all(Array.from({ length: 10 }, () => get('/api/operations')));
    assert.equal(state.calls.filter((u) => u.includes('/operations')).length, 1);
    tick(4000); await get('/api/operations');
    assert.equal(state.calls.filter((u) => u.includes('/operations')).length, 1);
    tick(2000); await get('/api/operations');
    assert.equal(state.calls.filter((u) => u.includes('/operations')).length, 2);
  });

  await t('finished runs are cached for a minute, running ones for 3 s', async () => {
    tick(120_000); state.calls.length = 0;
    await get('/api/operations/8210082972644-58fba5'); await get('/api/operations/8210084197900-a1c3e5');
    tick(4000);
    await get('/api/operations/8210082972644-58fba5'); await get('/api/operations/8210084197900-a1c3e5');
    const status = state.calls.filter((u) => u.includes('/status/'));
    assert.equal(status.filter((u) => u.includes('58fba5')).length, 1, 'succeeded: cached');
    assert.equal(status.filter((u) => u.includes('a1c3e5')).length, 2, 'awaiting_scim: refetched');
  });

  await t('ids outside the recent list are refused without calling status', async () => {
    tick(120_000); state.calls.length = 0;
    const { r } = await get('/api/operations/8210000000000-abcdef');
    assert.equal(r.status, 404);
    assert.equal(state.calls.filter((u) => u.includes('/status/')).length, 0);
  });

  await t('malformed ids are rejected before any upstream call', async () => {
    state.calls.length = 0;
    for (const bad of ['..%2F..%2Fhire', 'abc', '8210082972644-58fba5%3Fx%3D1', '8210082972644-58FBA5']) {
      assert.equal((await get(`/api/operations/${bad}`)).r.status, 400, bad);
    }
    assert.equal(state.calls.length, 0);
  });

  await t('no write routes exist', async () => {
    for (const [m, p] of [['POST', '/api/operations'], ['POST', '/api/hire'], ['POST', '/api/terminate'], ['DELETE', '/api/operations/8210082972644-58fba5']]) {
      const r = await fetch(BASE + p, { method: m });
      assert.equal(r.status, 404, `${m} ${p}`);
    }
  });

  await t('upstream errors become a plain 502 with a reference', async () => {
    tick(120_000); state.fail = true;
    const { r, text } = await get('/api/operations');
    state.fail = false;
    assert.equal(r.status, 502);
    const body = JSON.parse(text);
    assert.match(body.error, /didn't answer/); assert.match(body.ref, /^[0-9a-f]{8}$/);
    assert.doesNotMatch(text, /func\.example|HTTP 500|stack/);
    tick(120_000); state.down = true;
    assert.equal((await get('/api/operations')).r.status, 502);
    state.down = false;
  });

  await t('page sends a strict CSP whose nonce matches the script, with no inline handlers', async () => {
    const { r, text } = await get('/');
    const csp = r.headers.get('content-security-policy');
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)[1];
    assert.ok(text.includes(`<script nonce="${nonce}">`));
    assert.match(csp, /default-src 'none'/); assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(text, /\son[a-z]+=/i, 'no inline event handler attributes');
    assert.doesNotMatch(text, /innerHTML/);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    const second = (await get('/')).r.headers.get('content-security-policy');
    assert.notEqual(second, csp, 'nonce changes per request');
  });

  await t('replays are served and masked too', async () => {
    const list = JSON.parse((await get('/api/scenarios')).text).scenarios;
    assert.deepEqual(list.map((s) => s.id), BUNDLED_IDS);
    for (const s of list) {
      const { r, text } = await get(`/api/scenarios/${s.id}`);
      assert.equal(r.status, 200); assert.doesNotMatch(text, LEAKS);
    }
    assert.equal((await get('/api/scenarios/nope')).r.status, 404);
  });

  await t('unresolved operator key: live is off, replays still work', async () => {
    const OFF = BASE.replace('/labs/identity', '/off');
    const { r, text } = await get('/api/operations', OFF);
    assert.equal(r.status, 503); assert.match(text, /Replays still work/);
    assert.equal((await get('/api/scenarios', OFF)).r.status, 200);
    assert.match((await get('/', OFF)).text, /data-live="false"/);
    assert.ok(logs.some((m) => /Key Vault reference did not resolve/.test(m)));
  });

  await t('blob scenarios are masked, bad blobs skipped, outage falls back to bundled', async () => {
    const blob = (name, body) => ({ name, properties: { contentLength: Buffer.byteLength(body) }, body });
    const make = (blobs, fail) => ({
      async *listBlobsFlat() { if (fail) throw new Error('403 AuthorizationPermissionMismatch'); yield* blobs; },
      getBlobClient: (n) => ({ downloadToBuffer: async () => Buffer.from(blobs.find((b) => b.name === n).body) }),
    });
    const leaky = JSON.stringify({ id: 'custom', title: 'Real run for jane.doe@corp.example', operation: { ...REAL } });
    const src = createScenarioSource({}, { log: logger, containerClient: make([blob('a.json', leaky), blob('b.json', '{not json'), blob('c.txt', 'x')]) });
    const got = await src.all();
    assert.deepEqual(got.map((s) => s.id), ['custom']);
    const fallback = await createScenarioSource({}, { log: logger, containerClient: make([], true) }).all();
    assert.deepEqual(fallback.map((s) => s.id), BUNDLED_IDS);
    // and through the router, the leaky blob comes out clean
    const app2 = express();
    app2.use('/', createDashboardRouter({ config: offCfg, logger, scenarios: src }));
    const s2 = await listen(app2);
    const text = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/scenarios/custom`)).text();
    const listText = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/scenarios`)).text();
    s2.close();
    assert.doesNotMatch(text + listText, LEAKS);
  });

  // ---- demo proxy --------------------------------------------------------
  const demoCalls = [];
  const PASSWORD = 'Kq7m-Rt4x-Bn8p-Wd3h';
  const demoState = { limits: { available: true, ttlMinutes: 30 }, hire: null, fail: null, login: 'demo-abc123@demo.glasscliff.online', password: PASSWORD };
  const demoFetch = async (url, opts = {}) => {
    const u = new URL(url);
    demoCalls.push([opts.method || 'GET', u.pathname, opts.body ? JSON.parse(opts.body) : null]);
    assert.equal(opts.headers['x-lab-operator-key'], KEY);
    if (u.pathname.endsWith('/demo/limits')) return Response.json(demoState.limits);
    if (demoState.fail) return new Response(JSON.stringify({ error: demoState.fail.error }), { status: demoState.fail.status });
    if (u.pathname.endsWith('/demo/hire')) {
      demoState.hire = { ...REAL, operationId: '8210099999999-aaaaaa', type: 'hire', target: demoState.login, summary: `Hired ${demoState.login}`, demo: { login: demoState.login, password: demoState.password, title: 'Designer', department: 'Product', expiresAt: new Date(Date.now() + 1800_000).toISOString(), ttlMinutes: 30 } };
      return Response.json(demoState.hire);
    }
    return Response.json({ ...REAL, demo: { login: 'demo-abc123@demo.glasscliff.online', expiresAt: new Date(Date.now() + 1800_000).toISOString(), ...(u.pathname.endsWith('/demo/transfer') && { title: 'Senior Designer', department: 'Operations' }) } });
  };
  const demoApp = express();
  // What Expenses holds for the demo person, as the readback would find it in
  // the Accounts and Sessions tables. Logins it was asked about are recorded.
  const readState = { account: null, sessions: [], asked: [] };
  const fakeTables = {
    async findAccountByUserName(login) { readState.asked.push(login); return readState.account; },
    async listSessions() { return readState.sessions; },
  };
  const { createReadback } = require('../dashboard/readback');
  demoApp.use('/d', createDashboardRouter({ config: loadDashboardConfig({ LAB_LIFECYCLE_ENDPOINT: 'https://func.example/api/lifecycle', LAB_OPERATOR_KEY: KEY }), logger, fetchImpl: demoFetch, scenarios: { all: async () => loadBundled() }, readback: createReadback({ store: fakeTables, log: logger }) }));
  const dsrv = await listen(demoApp);
  const D = `http://127.0.0.1:${dsrv.address().port}/d`;
  const post = async (p, body, ip = '198.51.100.7') => {
    const r = await fetch(D + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body || {}) });
    return { r, body: await r.json().catch(() => ({})) };
  };

  let runKey;
  await t('starting a demo returns a masked run, an opaque key, and a sign-in for that visitor only', async () => {
    logs.length = 0;
    const { r, body } = await post('/api/demo/start', { name: 'Ada Lovelace', title: 'Designer' });
    assert.equal(r.status, 200);
    runKey = body.runKey;
    assert.ok(runKey);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    // The one place a login is allowed: the sign-in handed to the visitor who started it.
    assert.deepEqual(body.signIn, { login: 'demo-abc123@demo.glasscliff.online', password: PASSWORD });
    assert.deepEqual(body.role, { title: 'Designer', department: 'Product' });
    const rest = JSON.stringify({ ...body, signIn: undefined });
    assert.doesNotMatch(rest, /demo-abc123@|test\.person|00u1exampleuser|Kq7m/, 'nothing else carries the login, ids or password');
    assert.match(body.operation.person, /^person-[0-9a-f]{6}$/);
    const hire = demoCalls.filter((c) => c[1].endsWith('/demo/hire'));
    assert.equal(hire.length, 1);
    assert.deepEqual(hire[0][2], { name: 'Ada Lovelace', title: 'Designer' }, 'only the name and title are forwarded');
    assert.ok(!logs.join('\n').includes(PASSWORD), 'the password is never logged');
    assert.ok(!logs.join('\n').includes('demo-abc123@'), 'nor the login');
  });

  await t('the sign-in never shows up anywhere else', async () => {
    const ops = await (await fetch(D + '/api/operations')).text();
    const state = await (await fetch(`${D}/api/demo/state?run=${encodeURIComponent(runKey)}`, { headers: { 'x-forwarded-for': '203.0.113.31' } })).text();
    for (const text of [ops, state]) {
      assert.ok(!text.includes(PASSWORD));
      assert.doesNotMatch(text, /demo-abc123@/);
    }
  });

  await t('names and titles outside the rules are refused before the lifecycle API is asked', async () => {
    demoCalls.length = 0;
    for (const [i, body] of [{ name: '<img src=x>' }, { name: 'a@b.example' }, { name: 'x'.repeat(41) }, { title: '<b>CEO</b>' }].entries()) {
      const { r } = await post('/api/demo/start', body, `203.0.113.${60 + i}`);
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(demoCalls.filter((c) => c[1].endsWith('/demo/hire')).length, 0);
  });

  await t("the lifecycle API's own refusal comes through as a 400", async () => {
    demoState.fail = { status: 400, error: 'Pick one of the job titles on the list.' };
    const { r, body } = await post('/api/demo/start', { title: 'Astronaut' }, '203.0.113.70');
    demoState.fail = null;
    assert.equal(r.status, 400);
    assert.match(body.error, /job titles/);
  });

  await t('a hire that returns something other than a demo login is not handed to the browser', async () => {
    demoState.login = 'ceo@glasscliff.online';
    const { r, body } = await post('/api/demo/start', {}, '203.0.113.71');
    demoState.login = 'demo-abc123@demo.glasscliff.online';
    assert.equal(r.status, 502);
    assert.equal(body.signIn, undefined);
    assert.doesNotMatch(JSON.stringify(body), /ceo@/);
  });

  await t('an odd password from upstream is dropped rather than shown', async () => {
    demoState.password = 'short';
    const { r, body } = await post('/api/demo/start', {}, '203.0.113.72');
    demoState.password = PASSWORD;
    assert.equal(r.status, 200);
    assert.equal(body.signIn, null);
  });

  await t('limits pass the title list through, and nothing else from it', async () => {
    demoState.limits = { available: true, ttlMinutes: 8, titles: ['Analyst', 'Software Engineer', '<b>x</b>', 42], signIn: true };
    const body = await (await fetch(D + '/api/demo/limits', { headers: { 'x-forwarded-for': '203.0.113.73' } })).json();
    demoState.limits = { available: true, ttlMinutes: 30 };
    assert.deepEqual(body.titles, ['Analyst', 'Software Engineer']);
    assert.equal(body.signIn, true);
  });

  await t('the browser cannot aim a move or an offboard at a real person', async () => {
    demoCalls.length = 0;
    for (const path of ['/api/demo/move', '/api/demo/offboard']) {
      for (const forged of [{ login: 'ajack611@wgu.edu' }, { runKey: 'made.up' }, { runKey: '' }, {}]) {
        const { r } = await post(path, forged);
        assert.equal(r.status, 400, `${path} ${JSON.stringify(forged)}`);
      }
    }
    assert.equal(demoCalls.length, 0, 'nothing reached the lifecycle API');
  });

  await t('a valid run key moves and offboards that demo person only', async () => {
    demoCalls.length = 0;
    const moved = await post('/api/demo/move', { runKey });
    assert.equal(moved.r.status, 200);
    assert.deepEqual(moved.body.role, { title: 'Senior Designer', department: 'Operations' });
    assert.equal(moved.body.signIn, undefined, 'only the start response carries a sign-in');
    assert.equal((await post('/api/demo/offboard', { runKey })).r.status, 200);
    for (const call of demoCalls) assert.equal(call[2].login, 'demo-abc123@demo.glasscliff.online');
  });

  await t('an expired run key is refused without calling upstream', async () => {
    demoCalls.length = 0;
    const { r, body } = await post('/api/demo/move', { runKey: runKey.replace(/^[^.]+/, Buffer.from(JSON.stringify({ login: 'demo-abc123@demo.glasscliff.online', exp: Date.now() - 1000 })).toString('base64url')) });
    assert.equal(r.status, 400); // signature no longer matches the edited body
    assert.equal(demoCalls.length, 0);
    assert.match(body.error, /not one this page started/);
  });

  await t('one visitor cannot start runs back to back', async () => {
    const { r, body } = await post('/api/demo/start');
    assert.equal(r.status, 429);
    assert.match(body.error, /start another in/);
    assert.equal((await post('/api/demo/start', {}, '203.0.113.9')).r.status, 200, 'a different visitor is fine');
  });

  await t('a lab without the demo deployed says so, rather than "busy"', async () => {
    const notDeployed = express();
    notDeployed.use('/n', createDashboardRouter({ config: loadDashboardConfig({ LAB_LIFECYCLE_ENDPOINT: 'https://func.example/api/lifecycle', LAB_OPERATOR_KEY: KEY }), logger, fetchImpl: async () => new Response('{}', { status: 404 }), scenarios: { all: async () => loadBundled() } }));
    const s2 = await listen(notDeployed);
    const body = await (await fetch(`http://127.0.0.1:${s2.address().port}/n/api/demo/limits`)).json();
    s2.close();
    assert.equal(body.available, false);
    assert.match(body.reason, /not switched on for this lab yet/);
  });

  await t('a full demo explains itself with numbers', async () => {
    demoState.limits = { enabled: true, live: 5, maxLive: 5, available: false, ttlMinutes: 30 };
    const body = await (await fetch(D + '/api/demo/limits', { headers: { 'x-forwarded-for': '203.0.113.200' } })).json();
    demoState.limits = { available: true, ttlMinutes: 30 };
    assert.equal(body.available, false);
    assert.match(body.reason, /5 runs are already going/);
    assert.match(body.reason, /30 minutes/);
  });

  await t('upstream limits and errors are passed on in plain words', async () => {
    demoState.limits = { available: false };
    const lim = await (await fetch(D + '/api/demo/limits', { headers: { 'x-forwarded-for': '203.0.113.50' } })).json();
    assert.equal(lim.available, false);
    assert.match(lim.reason, /busy/);
    demoState.limits = { available: true, ttlMinutes: 30 };
    demoState.fail = { status: 429, error: 'The demo is busy: 5 runs are already live.' };
    const { r, body } = await post('/api/demo/start', {}, '203.0.113.77');
    demoState.fail = null;
    assert.equal(r.status, 429);
    assert.match(body.error, /already live/);
  });

  await t('demo routes are gone when the operator key is missing', async () => {
    const off = BASE.replace('/labs/identity', '/off');
    const r = await fetch(off + '/api/demo/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 503);
    const lim = await (await fetch(off + '/api/demo/limits')).json();
    assert.equal(lim.available, false);
  });


  // ---- provenance and the independent readback ---------------------------
  await t('every replay says where it came from', async () => {
    const list = JSON.parse((await get('/api/scenarios')).text).scenarios;
    const byId = Object.fromEntries(list.map((x) => [x.id, x.provenance]));
    assert.deepEqual(byId.hire, { kind: 'illustrative' });
    assert.deepEqual(byId.terminate, { kind: 'recorded', capturedAt: '2026-09-20' });
    assert.equal(byId['three-way-hire'].kind, 'recorded');
    for (const x of list) assert.ok(['succeeded', 'failed', 'awaiting_scim', 'running', 'pending', 'unknown'].includes(x.status));
    const one = JSON.parse((await get('/api/scenarios/terminate')).text);
    assert.equal(one.provenance.kind, 'recorded');
  });

  await t('a replay with no or an invented provenance is shown as unlabelled', async () => {
    const odd = [{ id: 'odd', title: 'x', operation: { ...REAL }, provenance: { kind: 'totally-real', capturedAt: 'yesterday', note: 'by jane.doe@corp.example' } }, { id: 'none', title: 'y', operation: { ...REAL } }];
    const app3 = express();
    app3.use('/', createDashboardRouter({ config: offCfg, logger, scenarios: { all: async () => odd } }));
    const s3 = await listen(app3);
    try {
      const list = (await (await fetch(`http://127.0.0.1:${s3.address().port}/api/scenarios`)).json()).scenarios;
      assert.equal(list[0].provenance.kind, 'unlabelled');
      assert.equal(list[0].provenance.capturedAt, undefined, 'a non-date is dropped');
      assert.doesNotMatch(JSON.stringify(list), /jane\.doe|corp\.example/);
      assert.equal(list[1].provenance.kind, 'unlabelled');
    } finally { s3.close(); }
  });

  const getState = async (key, ip = '198.51.100.50') => {
    const r = await fetch(`${D}/api/demo/state?run=${encodeURIComponent(key)}`, { headers: { 'x-forwarded-for': ip } });
    return { r, body: await r.json().catch(() => ({})) };
  };

  await t('readback reads Expenses directly for the demo person, masked', async () => {
    demoCalls.length = 0;
    readState.account = { active: true, title: 'Analyst', department: 'Finance', userName: 'demo-abc123@demo.glasscliff.online' };
    readState.sessions = [{ simulated: true }];
    const { r, body } = await getState(runKey);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.deepEqual(body.account, { exists: true, active: true, title: 'Analyst', department: 'Finance' });
    assert.deepEqual(body.sessions, { total: 1, simulated: 1 });
    assert.match(body.person, /^person-[0-9a-f]{6}$/);
    assert.match(body.source, /lifecycle API that ran the change is not involved/);
    assert.doesNotMatch(JSON.stringify(body), /demo-abc123|glasscliff\.online/, 'the login never reaches the browser');
    assert.equal(demoCalls.length, 0, 'the lifecycle API is not asked');
    assert.equal(readState.asked.at(-1), 'demo-abc123@demo.glasscliff.online');
  });

  await t('readback is never cached: a read straight after a change sees the change', async () => {
    readState.account = { active: false, title: 'Senior Analyst', department: 'Operations' };
    readState.sessions = [];
    const { body } = await getState(runKey);
    assert.equal(body.account.active, false);
    assert.equal(body.sessions.total, 0);
  });

  await t('readback refuses forged keys and anything that is not a demo person', async () => {
    assert.equal((await getState('nonsense')).r.status, 400);
    const forged = `${Buffer.from(JSON.stringify({ login: 'real.person@corp.example', exp: Date.now() + 1e6 })).toString('base64url')}.${runKey.split('.').pop()}`;
    assert.equal((await getState(forged)).r.status, 400, 'signature does not match');
    // Without the operator key the signing key is a constant, so the route must be off.
    const off = express();
    off.use('/x', createDashboardRouter({ config: offCfg, logger, scenarios: { all: async () => [] }, readback: createReadback({ store: fakeTables, log: logger }) }));
    const s4 = await listen(off);
    try {
      const r = await fetch(`http://127.0.0.1:${s4.address().port}/x/api/demo/state?run=${encodeURIComponent(runKey)}`);
      assert.equal(r.status, 503);
    } finally { s4.close(); }
  });

  await t('readback is rate limited per visitor', async () => {
    let last;
    for (let i = 0; i < 61; i++) last = await getState(runKey, '198.51.100.99');
    assert.equal(last.r.status, 429);
    assert.equal((await getState(runKey, '198.51.100.98')).r.status, 200, 'other visitors are unaffected');
  });

  await t('the page explains what each kind of step proves, and labels every replay', async () => {
    const html = require('../dashboard/page').renderPage({ nonce: 'n', basePath: '/b', liveEnabled: true });
    for (const s of ['What each kind of step proves', 'Okta API call', 'Received by Expenses', 'Readback', 'Check it yourself', 'Recorded run', 'Illustrative', 'id="check"']) assert.ok(html.includes(s), s);
    assert.doesNotMatch(html, /innerHTML/);
  });

  dsrv.close();
  console.log(`\n${pass} passed`);
  srv.close();
})();
