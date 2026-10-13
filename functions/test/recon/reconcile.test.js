'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcile } = require('../../src/lib/recon/reconcile');
const { expectedDownstreamState } = require('../../src/lib/recon/model');
const { normaliseGoogleUser } = require('../../src/lib/recon/sources/google');
const { normaliseEntraUser } = require('../../src/lib/recon/sources/entra');
const { parseNextLink } = require('../../src/lib/recon/sources/okta');

const CONFIG = {
  managedGoogleOu: '/Okta Users',
  expectedExceptions: [
    { directory: 'google', key: 'breakglass@primary.example', reason: 'break-glass, SSO-exempt by design' },
    { directory: 'google', key: 'sa-okta@primary.example', reason: 'provisioning connector identity' },
    { directory: 'entra', key: 'breakglass@tenant.onmicrosoft.com', reason: 'break-glass, cannot be federated' },
  ],
};

/** Builders, so each test states only what it is actually about. */
const okta = (over = {}) => ({
  key: 'clean@users.example',
  id: 'okta-1',
  login: 'clean@users.example',
  status: 'ACTIVE',
  firstName: 'Clean',
  lastName: 'Case',
  title: 'Engineer',
  department: 'Platform',
  assignedEntra: true,
  assignedGoogle: true,
  ...over,
});

const entra = (over = {}) => ({
  key: 'clean@users.example',
  id: 'entra-1',
  upn: 'clean@users.example',
  enabled: true,
  immutableId: 'okta-app-user-id',
  givenName: 'Clean',
  surname: 'Case',
  jobTitle: 'Engineer',
  department: 'Platform',
  ...over,
});

const google = (over = {}) => ({
  key: 'clean@users.example',
  id: 'google-1',
  primaryEmail: 'clean@users.example',
  enabled: true,
  orgUnitPath: '/Okta Users',
  givenName: 'Clean',
  familyName: 'Case',
  title: 'Engineer',
  department: 'Platform',
  ...over,
});

const run = (input) => reconcile({ config: CONFIG, ...input });
const rules = (result) => result.findings.map((f) => f.rule).sort();
const rulesFor = (result, rule) => result.findings.filter((f) => f.rule === rule);

test('a fully agreeing person produces no findings and a clean verdict', () => {
  const result = run({ okta: [okta()], entra: [entra()], google: [google()] });
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.verdict, 'clean');
  assert.equal(result.summary.people, 1);
  assert.equal(result.summary.agreeing, 1);
});

test('PASSWORD_EXPIRED is an enabled state, not drift', () => {
  // The subtle one. Okta status tracks the password credential, not whether the
  // person can authenticate — passkey users sign in fine while PASSWORD_EXPIRED.
  // A reconciler that treats this as "should be disabled" invents drift.
  const result = run({
    okta: [okta({ status: 'PASSWORD_EXPIRED' })],
    entra: [entra()],
    google: [google()],
  });
  assert.deepEqual(result.findings, []);
  assert.equal(expectedDownstreamState('PASSWORD_EXPIRED'), 'enabled');
  assert.equal(expectedDownstreamState('PROVISIONED'), 'enabled');
  assert.equal(expectedDownstreamState('SUSPENDED'), 'disabled');
  assert.equal(expectedDownstreamState('DEPROVISIONED'), 'disabled');
  assert.equal(expectedDownstreamState('STAGED'), 'pending');
});

test('a deprovisioned person disabled everywhere is clean', () => {
  const result = run({
    okta: [okta({ status: 'DEPROVISIONED' })],
    entra: [entra({ enabled: false })],
    google: [google({ enabled: false })],
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.summary.verdict, 'clean');
});

test('access that was not revoked is critical, per directory', () => {
  const result = run({
    okta: [okta({ status: 'DEPROVISIONED' })],
    entra: [entra({ enabled: false })],
    google: [google({ enabled: true })], // suspend never landed
  });
  const found = rulesFor(result, 'access_not_revoked');
  assert.equal(found.length, 1);
  assert.equal(found[0].directory, 'google');
  assert.equal(found[0].severity, 'critical');
  assert.equal(result.summary.verdict, 'drift');
  assert.equal(result.summary.worst, 'critical');
  // and the per-user rollup must advance past its seed too
  assert.equal(result.users[0].worst, 'critical');
  assert.equal(result.users[0].agrees, false);
});

test('two Google accounts for different people with the same name are not duplicates by accident', () => {
  // Guards the duplicate rule against the accepted-exception accounts, which are
  // directory-native by design and would otherwise pair with each other.
  const result = run({
    okta: [],
    google: [
      google({ key: 'breakglass@primary.example', primaryEmail: 'breakglass@primary.example', orgUnitPath: '/Breakglass' }),
      google({ key: 'sa-okta@primary.example', primaryEmail: 'sa-okta@primary.example', orgUnitPath: '/Service Accounts' }),
    ],
  });
  assert.equal(rulesFor(result, 'duplicate_candidate').length, 0);
  assert.equal(result.summary.verdict, 'clean');
});

test('an assigned, enabled user with no downstream account is missing_downstream', () => {
  const result = run({ okta: [okta()], entra: [entra()], google: [] });
  const found = rulesFor(result, 'missing_downstream');
  assert.equal(found.length, 1);
  assert.equal(found[0].directory, 'google');
  assert.equal(found[0].severity, 'high');
});

test('an unassigned user with no downstream account is not a finding', () => {
  // Assignment to the app is the allow-list. Not assigned means no account is
  // expected, and reporting that as drift would bury the real findings.
  const result = run({
    okta: [okta({ assignedGoogle: false })],
    entra: [entra()],
    google: [],
  });
  assert.deepEqual(result.findings, []);
});

test('STAGED users are pending, not missing', () => {
  const result = run({ okta: [okta({ status: 'STAGED' })], entra: [], google: [] });
  assert.deepEqual(rules(result), ['provisioning_pending', 'provisioning_pending']);
  assert.equal(result.summary.verdict, 'clean'); // info only
});

test('a downstream account with no Okta identity is an orphan', () => {
  const result = run({
    okta: [],
    entra: [entra({ key: 'ghost@users.example', upn: 'ghost@users.example' })],
    google: [],
  });
  const found = rulesFor(result, 'orphan');
  assert.equal(found.length, 1);
  assert.equal(found[0].directory, 'entra');
  assert.equal(found[0].severity, 'high');
});

test('an unmanaged account inside the SSO-scoped OU is critical, not merely an orphan', () => {
  // This is the one that would have locked people out: four accounts with no
  // Okta identity were sitting in the OU about to be assigned the SSO profile.
  const result = run({
    okta: [],
    google: [google({ key: 'native@users.example', primaryEmail: 'native@users.example', orgUnitPath: '/Okta Users' })],
  });
  const found = rulesFor(result, 'unmanaged_in_scope');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'critical');
  assert.equal(rulesFor(result, 'orphan').length, 0);
});

test('break-glass and connector accounts are accepted exceptions, not orphans', () => {
  const result = run({
    okta: [],
    google: [
      google({ key: 'breakglass@primary.example', primaryEmail: 'breakglass@primary.example', orgUnitPath: '/Breakglass', givenName: 'Break', familyName: 'Glass' }),
      google({ key: 'sa-okta@primary.example', primaryEmail: 'sa-okta@primary.example', orgUnitPath: '/Service Accounts', givenName: 'Okta', familyName: 'Connector' }),
    ],
    entra: [entra({ key: 'breakglass@tenant.onmicrosoft.com', upn: 'breakglass@tenant.onmicrosoft.com', givenName: 'Break', surname: 'Glass' })],
  });
  assert.equal(rulesFor(result, 'accepted_exception').length, 3);
  assert.equal(rulesFor(result, 'orphan').length, 0);
  assert.equal(result.summary.verdict, 'clean');
  assert.equal(result.summary.accepted, 3);
});

test('an Entra account with no immutable anchor is flagged even though it looks healthy', () => {
  const result = run({ okta: [okta()], entra: [entra({ immutableId: '' })], google: [google()] });
  const found = rulesFor(result, 'anchor_missing');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'high');
  assert.equal(found[0].section, '§2');
});

test('attribute drift is reported per attribute and per directory', () => {
  const result = run({
    okta: [okta({ title: 'Promotion' })],
    entra: [entra({ jobTitle: 'Regulator' })],
    google: [google({ title: 'Regulator' })],
  });
  const found = rulesFor(result, 'attribute_drift');
  assert.equal(found.length, 2);
  assert.deepEqual([...new Set(found.map((f) => f.attribute))], ['title']);
  assert.deepEqual(found.map((f) => f.directory).sort(), ['entra', 'google']);
});

test('a value Okta does not hold should have been cleared downstream', () => {
  // The destructive-ownership case: Okta holds no title, so the push should have
  // removed Google's. A surviving value means the mapping is not being enforced.
  const result = run({
    okta: [okta({ title: '' })],
    entra: [entra({ jobTitle: '' })],
    google: [google({ title: 'Soulja' })],
  });
  const found = rulesFor(result, 'attribute_drift');
  assert.equal(found.length, 1);
  assert.equal(found[0].directory, 'google');
  assert.equal(found[0].expected, '');
  assert.equal(found[0].actual, 'Soulja');
  assert.match(found[0].detail, /should have cleared it/);
});

test('empty, null and undefined are the same value for comparison', () => {
  const result = run({
    okta: [okta({ title: '', department: null })],
    entra: [entra({ jobTitle: null, department: undefined })],
    google: [google({ title: undefined, department: '' })],
  });
  assert.equal(rulesFor(result, 'attribute_drift').length, 0);
});

test('an Okta-managed Google account outside the managed OU is flagged', () => {
  const result = run({ okta: [okta()], entra: [entra()], google: [google({ orgUnitPath: '/' })] });
  const found = rulesFor(result, 'ou_misplacement');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'medium');
});

test('two accounts for one person under different addresses are a duplicate candidate', () => {
  // The real case: Okta login antalonj@, pre-existing Entra account antalon@.
  // One character apart, so soft match failed and a second account was created.
  const result = run({
    okta: [okta({ key: 'antalonj@users.example', login: 'antalonj@users.example', firstName: 'Antalon', lastName: 'Jackson', title: '', department: '' })],
    entra: [
      entra({ key: 'antalonj@users.example', upn: 'antalonj@users.example', givenName: 'Antalon', surname: 'Jackson', jobTitle: '', department: '' }),
      entra({ key: 'antalon@users.example', upn: 'antalon@users.example', id: 'entra-2', givenName: 'Antalon', surname: 'Jackson', jobTitle: '', department: '', immutableId: 'legacy-anchor' }),
    ],
    google: [],
  });
  const dup = rulesFor(result, 'duplicate_candidate');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].keys.length, 2);
  assert.equal(dup[0].severity, 'high');
  // and the second account is also an orphan in its own right
  assert.equal(rulesFor(result, 'orphan').length, 1);
});

test('identical names with Okta identities on both sides are not duplicates', () => {
  const result = run({
    okta: [
      okta({ key: 'a.smith@users.example', login: 'a.smith@users.example', firstName: 'Alex', lastName: 'Smith', assignedGoogle: false }),
      okta({ key: 'alex.smith@users.example', login: 'alex.smith@users.example', id: 'okta-2', firstName: 'Alex', lastName: 'Smith', assignedGoogle: false }),
    ],
    entra: [
      entra({ key: 'a.smith@users.example', upn: 'a.smith@users.example', givenName: 'Alex', surname: 'Smith' }),
      entra({ key: 'alex.smith@users.example', upn: 'alex.smith@users.example', id: 'entra-2', givenName: 'Alex', surname: 'Smith' }),
    ],
    google: [],
  });
  assert.equal(rulesFor(result, 'duplicate_candidate').length, 0);
});

test('summary counts every directory and classifies the worst severity', () => {
  const result = run({
    okta: [okta(), okta({ key: 'b@users.example', login: 'b@users.example', status: 'DEPROVISIONED' })],
    entra: [entra(), entra({ key: 'b@users.example', upn: 'b@users.example', enabled: true, id: 'entra-2' })],
    google: [google()],
  });
  assert.equal(result.summary.directories.okta, 2);
  assert.equal(result.summary.directories.entra, 2);
  assert.equal(result.summary.directories.google, 1);
  assert.equal(result.summary.worst, 'critical');
  // Exactly one actionable finding: user b is still enabled in Entra. The
  // absent Google account for b is *not* a finding, because a deprovisioned
  // user is not expected to have one.
  assert.equal(result.summary.actionable, 1);
  assert.equal(result.summary.people, 2);
  assert.equal(result.summary.agreeing, 1);
});

// ---- vendor payload normalisation -----------------------------------------

test('Google title and department come from the primary organizations entry', () => {
  const record = normaliseGoogleUser({
    primaryEmail: 'Person@Users.Example',
    id: '1234',
    suspended: false,
    orgUnitPath: '/Okta Users',
    name: { givenName: 'Person', familyName: 'Example' },
    organizations: [
      { title: 'Stale', department: 'Old', primary: false },
      { title: 'Current', department: 'Platform', primary: true },
    ],
  });
  assert.equal(record.key, 'person@users.example'); // lowercased join key
  assert.equal(record.title, 'Current');
  assert.equal(record.department, 'Platform');
  assert.equal(record.enabled, true);
});

test('a suspended Google account normalises to disabled', () => {
  const record = normaliseGoogleUser({ primaryEmail: 'x@y.example', suspended: true, name: {} });
  assert.equal(record.enabled, false);
  assert.equal(record.suspended, true);
});

test('Entra accountEnabled absent is treated as enabled, and the anchor is preserved', () => {
  const record = normaliseEntraUser({
    userPrincipalName: 'Mixed.Case@Users.Example',
    id: 'guid',
    onPremisesImmutableId: 'anchor',
  });
  assert.equal(record.key, 'mixed.case@users.example');
  assert.equal(record.enabled, true);
  assert.equal(record.immutableId, 'anchor');
});

test('Okta Link header pagination finds the next page and stops at the last', () => {
  const next = parseNextLink(
    '<https://org/api/v1/users?limit=200>; rel="self", <https://org/api/v1/users?after=abc>; rel="next"'
  );
  assert.equal(next, 'https://org/api/v1/users?after=abc');
  assert.equal(parseNextLink('<https://org/api/v1/users?limit=200>; rel="self"'), null);
  assert.equal(parseNextLink(null), null);
});

// ---- the privacy boundary --------------------------------------------------
