'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchOkta } = require('../../src/lib/recon/sources/okta');
const { reconcile } = require('../../src/lib/recon/reconcile');

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const active = { id: 'okta-active', status: 'ACTIVE', profile: { login: 'stays@users.example', firstName: 'Stays', lastName: 'Here' } };
const leaver = { id: 'okta-leaver', status: 'DEPROVISIONED', profile: { login: 'left@users.example', firstName: 'Has', lastName: 'Left' } };

// This fake behaves like Okta: the plain list leaves DEPROVISIONED users out,
// and only the filtered query returns them.
function fakeOkta(seen = []) {
  return async (url) => {
    const href = String(url);
    seen.push(href);
    if (href.includes('/api/v1/apps/')) return json([]);
    if (href.includes('/api/v1/users')) {
      const filter = new URL(href).searchParams.get('filter');
      if (filter === 'status eq "DEPROVISIONED"') return json([leaver]);
      if (filter) throw new Error(`unexpected filter: ${filter}`);
      return json([active]);
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
}

test('deprovisioned users are read, not just the default list', async () => {
  const seen = [];
  const users = await fetchOkta({ orgUrl: 'https://example.okta.com', token: 't', fetchImpl: fakeOkta(seen) });
  assert.deepEqual(users.map((u) => [u.key, u.status]).sort(), [
    ['left@users.example', 'DEPROVISIONED'],
    ['stays@users.example', 'ACTIVE'],
  ]);
  assert.ok(seen.some((u) => new URL(u).searchParams.get('filter') === 'status eq "DEPROVISIONED"'));
});

test('a user returned by both queries is kept once', async () => {
  const both = async (url) => {
    const href = String(url);
    if (href.includes('/api/v1/apps/')) return json([]);
    return json([leaver]);
  };
  const users = await fetchOkta({ orgUrl: 'https://example.okta.com', token: 't', fetchImpl: both });
  assert.equal(users.length, 1);
});

test('an offboarded person with disabled accounts is not reported as an orphan', async () => {
  const okta = await fetchOkta({ orgUrl: 'https://example.okta.com', token: 't', fetchImpl: fakeOkta() });
  const entra = [{ key: 'left@users.example', enabled: false, immutableId: 'anchor', givenName: 'Has', surname: 'Left' }];
  const { findings } = reconcile({ okta, entra });
  assert.equal(findings.some((f) => f.rule === 'orphan'), false, JSON.stringify(findings));
  assert.equal(findings.some((f) => f.rule === 'access_not_revoked'), false);
});

test('an offboarded person whose account is still enabled is critical, not an orphan', async () => {
  const okta = await fetchOkta({ orgUrl: 'https://example.okta.com', token: 't', fetchImpl: fakeOkta() });
  const entra = [{ key: 'left@users.example', enabled: true, immutableId: 'anchor', givenName: 'Has', surname: 'Left' }];
  const { findings } = reconcile({ okta, entra });
  assert.equal(findings.some((f) => f.rule === 'orphan'), false);
  const critical = findings.find((f) => f.rule === 'access_not_revoked');
  assert.ok(critical, JSON.stringify(findings));
  assert.equal(critical.severity, 'critical');
  assert.equal(critical.directory, 'entra');
});
