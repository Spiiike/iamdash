'use strict';
// node test/replays.test.js — the recorder and the three-lane replay path.
// The operation below is test input shaped like a /status response; it is not a
// replay and is never written to dashboard/scenarios.
const http = require('http');
const assert = require('assert');
const express = require('express');
const { toScenario } = require('../tools/record-scenario');
const { createDashboardRouter } = require('../dashboard');
const { renderPage } = require('../dashboard/page');

const LOGIN = 'real.person@corp.example';
const OP = {
  operationId: '8208154549355-c5b822',
  type: 'hire',
  target: LOGIN,
  status: 'succeeded',
  summary: `Hired ${LOGIN}; confirmed in Expenses, Entra ID and Google`,
  oktaUserId: '00u17aexample00demo1',
  created: '2026-10-12T22:50:50.644Z',
  updated: '2026-10-12T22:51:20.881Z',
  steps: [
    { seq: 1, step: 'okta.lookup', outcome: 'succeeded', detail: 'not found, ok to create', durationMs: 300, started: '2026-10-12T22:50:50.680Z' },
    { seq: 2, step: 'okta.createUser', outcome: 'succeeded', detail: 'id 00u17aexample00demo1, status ACTIVE', durationMs: 600, started: '2026-10-12T22:50:51.000Z' },
    { seq: 3, step: 'okta.assignExpenses', outcome: 'succeeded', detail: 'assigned to app 0oa1exampleapp0demo9', durationMs: 400, started: '2026-10-12T22:50:51.700Z' },
    { seq: 4, step: 'okta.addToGroup', outcome: 'succeeded', detail: 'added to the group assigned to Entra ID and Google', durationMs: 350, started: '2026-10-12T22:50:52.150Z' },
    { seq: 5, step: 'verify.expensesAccountCreated', outcome: 'succeeded', detail: 'SCIM account 3f2b8c1e-aaaa-bbbb-cccc-111122223333 is active', durationMs: 5200, started: '2026-10-12T22:50:52.550Z' },
    { seq: 6, step: 'verify.entraAccountCreated', outcome: 'succeeded', detail: 'account enabled, federation anchor set', durationMs: 14000, started: '2026-10-12T22:50:52.551Z' },
    { seq: 7, step: 'verify.googleAccountCreated', outcome: 'succeeded', detail: 'account active in /Okta Users', durationMs: 9000, started: '2026-10-12T22:50:52.552Z' },
  ],
  scim: [
    { step: 'scim.createUser', httpStatus: 201, outcome: 'succeeded', at: '2026-10-12T22:50:56.100Z', evidenceBlob: 'scim/2026-10-12/x.json' },
  ],
};

(async () => {
  let pass = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log(`ok   ${name}`); } catch (e) { console.log(`FAIL ${name}\n     ${e.stack}`); process.exitCode = 1; }
  };

  await t('the recorder keeps real timings and strips the person, Okta ids, row ids and evidence paths', async () => {
    const s = toScenario(OP, { id: 'three-way-hire', title: 'Someone joins, everywhere', order: 4 });
    const text = JSON.stringify(s);
    for (const leak of ['real.person', 'corp.example', '00u17aexample', '0oa1exampleapp', '3f2b8c1e', 'evidenceBlob', 'scim/2026']) {
      assert.ok(!text.includes(leak), leak);
    }
    assert.equal(s.operation.target, 'replay.person@example.test');
    assert.equal(s.operation.steps[5].durationMs, 14000, 'timings are untouched');
    assert.equal(s.operation.steps[4].detail, 'SCIM account is active');
  });

  await t('the recorder stamps provenance: recorded, the run date, and its real outcome', async () => {
    const s = toScenario(OP, { id: 'three-way-hire', title: 'x' });
    assert.deepEqual(s.provenance, { kind: 'recorded', capturedAt: '2026-10-12', outcome: 'succeeded' });
    const stuck = toScenario({ ...OP, status: 'awaiting_scim' }, { id: 'scim-never-arrived', title: 'x', allowUnfinished: true });
    assert.equal(stuck.provenance.outcome, 'awaiting_scim', 'a partial failure is recorded as one');
    assert.equal(stuck.operation.status, 'awaiting_scim');
  });

  await t('the recorder refuses an unfinished run unless told otherwise', async () => {
    assert.throws(() => toScenario({ ...OP, status: 'awaiting_scim' }, { id: 'x', title: 'x' }), /replays are of finished runs/);
    assert.ok(toScenario({ ...OP, status: 'awaiting_scim' }, { id: 'x', title: 'x', allowUnfinished: true }));
    assert.throws(() => toScenario(OP, { id: 'Bad Id', title: 'x' }), /--id/);
  });

  await t('a three-way replay is served with its Entra ID and Google steps intact, and masked', async () => {
    const scenario = toScenario(OP, { id: 'three-way-hire', title: 'Someone joins, everywhere', order: 4 });
    const app = express();
    app.use('/d', createDashboardRouter({
      config: { liveEnabled: false, liveProblems: ['off in tests'], operatorKey: 'k' },
      scenarios: { all: async () => [scenario] },
      logger: { warn() {}, error() {}, log() {} },
    }));
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${server.address().port}/d`;
      const body = await (await fetch(`${base}/api/scenarios/three-way-hire`)).json();
      const names = body.operation.steps.map((s) => s.step);
      for (const n of ['okta.addToGroup', 'verify.entraAccountCreated', 'verify.googleAccountCreated']) assert.ok(names.includes(n), n);
      assert.match(body.operation.person, /^person-[0-9a-f]{6}$/);
      assert.ok(!JSON.stringify(body).includes('replay.person'), 'placeholder login is pseudonymised too');
    } finally {
      server.close();
    }
  });

  await t('the dashboard client knows the new lanes and labels', async () => {
    const html = renderPage({ nonce: 'n', basePath: '/d', liveEnabled: false });
    for (const s of ["key: 'entra', name: 'Entra ID', optional: true", "key: 'google', name: 'Google', optional: true", "'verify.entraAccountCreated'", "'verify.googleAccountSuspended'", '.f-entra', '.f-google']) {
      assert.ok(html.includes(s), s);
    }
  });

  console.log(`\n${pass} passed`);
})();
