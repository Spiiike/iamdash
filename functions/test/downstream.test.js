'use strict';
// Unit tests for lib/downstream.js: what each check concludes from what the
// directory says. No storage, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const dsm = require('../src/lib/downstream');

const fast = { timeoutMs: 50, intervalMs: 5 };
/** A reader that returns a scripted sequence of reads per directory. */
function scripted(seq) {
  const calls = { entra: 0, google: 0 };
  return {
    calls,
    async read(dir) {
      const list = seq[dir];
      const v = list[Math.min(calls[dir], list.length - 1)];
      calls[dir]++;
      if (v instanceof Error) throw v;
      return v;
    },
  };
}
const entra = (over = {}) => ({ enabled: true, immutableId: 'anchor', jobTitle: 'Analyst', department: 'Finance', ...over });
const google = (over = {}) => ({ suspended: false, orgUnitPath: '/Okta Users', title: 'Analyst', department: 'Finance', ...over });

test('targets come only from DOWNSTREAM_VERIFY, in a fixed order', () => {
  assert.deepEqual(dsm.targets({}), []);
  assert.deepEqual(dsm.targets({ DOWNSTREAM_VERIFY: 'google, Entra' }), ['entra', 'google']);
  assert.deepEqual(dsm.targets({ DOWNSTREAM_VERIFY: 'ldap' }), []);
});

test('created waits for the push, then reports the anchor', async () => {
  const r = scripted({ entra: [null, null, entra()] });
  const out = await dsm.created(r, 'entra', 'x@y.example', fast);
  assert.equal(out.ok, true);
  assert.match(out.detail, /anchor set/);
  assert.equal(r.calls.entra, 3);
});

test('an Entra account without an anchor is created but says sign-in will fail', async () => {
  const out = await dsm.created(scripted({ entra: [entra({ immutableId: '' })] }), 'entra', 'x', fast);
  assert.equal(out.ok, true);
  assert.match(out.detail, /no federation anchor/);
});

test('created that never arrives is pending, not failed', async () => {
  const out = await dsm.created(scripted({ google: [null] }), 'google', 'x', fast);
  assert.equal(out.pending, true);
  assert.equal(out.outcome, 'pending');
});

test('a suspended Google account is not "created"', async () => {
  const out = await dsm.created(scripted({ google: [google({ suspended: true })] }), 'google', 'x', fast);
  assert.equal(out.pending, true);
  assert.match(out.detail, /not enabled yet/);
});

test('updated compares only the attributes that changed, per directory naming', async () => {
  const r = scripted({ entra: [entra(), entra(), entra({ jobTitle: 'Senior Analyst', department: 'Operations' })] });
  const out = await dsm.updated(r, 'entra', 'x', { title: 'Senior Analyst', department: 'Operations' }, fast);
  assert.equal(out.ok, true);
  assert.equal(out.detail, 'title and department updated');
  const g = await dsm.updated(scripted({ google: [google(), google({ title: 'Senior Analyst' })] }), 'google', 'x', { title: 'Senior Analyst' }, fast);
  assert.equal(g.ok, true);
});

test('updated with no account downstream is skipped', async () => {
  const out = await dsm.updated(scripted({ google: [null] }), 'google', 'x', { title: 'A' }, fast);
  assert.equal(out.skipped, true);
});

test('disabled accepts a disabled, suspended or removed account', async () => {
  assert.equal((await dsm.disabled(scripted({ entra: [entra(), entra({ enabled: false })] }), 'entra', 'x', true, fast)).detail, 'account disabled');
  assert.equal((await dsm.disabled(scripted({ google: [google({ suspended: true })] }), 'google', 'x', true, fast)).detail, 'account suspended');
  assert.equal((await dsm.disabled(scripted({ google: [null] }), 'google', 'x', true, fast)).detail, 'account removed');
});

test('disabled when there was never an account is skipped, not a false "removed"', async () => {
  const out = await dsm.disabled(scripted({ entra: [null] }), 'entra', 'x', false, fast);
  assert.equal(out.skipped, true);
});

test('an account still enabled after the timeout is pending', async () => {
  const out = await dsm.disabled(scripted({ entra: [entra()] }), 'entra', 'x', true, fast);
  assert.equal(out.pending, true);
  assert.match(out.detail, /still enabled/);
});

test('guarded turns a read failure into a failed step with a plain reason', async () => {
  const out = await dsm.guarded('entra', () => dsm.created(scripted({ entra: [new Error('graph 403 Authorization_RequestDenied')] }), 'entra', 'x', fast))();
  assert.equal(out.failed, true);
  assert.match(out.detail, /^could not read Entra ID: graph 403/);
});

test('presence marks an unreadable directory as unknown rather than absent', async () => {
  const out = await dsm.presence(scripted({ entra: [entra()], google: [new Error('boom')] }), ['entra', 'google'], 'x');
  assert.deepEqual(out, { entra: true, google: undefined });
});

test('details never carry the login', async () => {
  const login = 'secret.person@corp.example';
  const outs = [
    await dsm.created(scripted({ google: [google()] }), 'google', login, fast),
    await dsm.updated(scripted({ entra: [entra(), entra({ jobTitle: 'B' })] }), 'entra', login, { title: 'B' }, fast),
    await dsm.disabled(scripted({ entra: [null] }), 'entra', login, true, fast),
  ];
  for (const o of outs) assert.equal(o.detail.includes('secret.person'), false);
});
