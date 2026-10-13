'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');

const { runReconciliation } = require('../../src/lib/recon/run');
const { reconConfig } = require('../../src/lib/recon/config');
const { signAssertion } = require('../../src/lib/recon/sources/google');
const { getManagedIdentityToken } = require('../../src/lib/recon/sources/entra');

/** A real RSA key, so the service-account assertion is genuinely signed. */
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const ENV = {
  OKTA_ORG_URL: 'https://example.okta.com',
  OKTA_API_TOKEN: 'ssws-token',
  OKTA_ENTRA_APP_ID: 'app-entra',
  OKTA_GOOGLE_APP_ID: 'app-google',
  GOOGLE_SA_CLIENT_EMAIL: 'recon@project.iam.gserviceaccount.com',
  GOOGLE_SA_PRIVATE_KEY: privateKey,
  // Required since the service-account (no delegation) route: it can't resolve my_customer.
  GOOGLE_CUSTOMER: 'C0test123',
  RECON_MANAGED_OU: '/Okta Users',
  RECON_EXCEPTIONS: JSON.stringify([{ directory: 'google', key: 'breakglass@primary.example', reason: 'break-glass' }]),
  IDENTITY_ENDPOINT: 'https://identity.local/token',
  IDENTITY_HEADER: 'identity-header',
  AZURE_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
};

const json = (body, headers = {}) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function stubFetch({ failGoogle = false, expectSubject } = {}) {
  const seen = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    seen.push(href);
    if (href.startsWith('https://identity.local/token')) return json({ access_token: 'entra-token' });
    if (href.startsWith('https://oauth2.googleapis.com/token')) {
      if (failGoogle) return { ok: false, status: 403, statusText: 'Forbidden', text: async () => 'not authorized' };
      const assertion = new URLSearchParams(options.body).get('assertion');
      const decoded = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8'));
      assert.equal(decoded.iss, ENV.GOOGLE_SA_CLIENT_EMAIL);
      assert.equal(decoded.sub, expectSubject);
      assert.match(decoded.scope, /admin\.directory\.user\.readonly$/);
      return json({ access_token: 'google-token' });
    }
    if (href.includes('/api/v1/apps/app-entra/users')) return json([{ credentials: { userName: 'clean@users.example' } }]);
    if (href.includes('/api/v1/apps/app-google/users')) return json([{ credentials: { userName: 'clean@users.example' } }]);
    if (href.includes('/api/v1/users')) {
      return json([{ id: 'okta-1', status: 'ACTIVE', profile: { login: 'Clean@Users.Example', firstName: 'Clean', lastName: 'Case', title: 'Engineer', department: 'Platform' } }]);
    }
    if (href.startsWith('https://graph.microsoft.com')) {
      return json({ value: [{ id: 'entra-guid', userPrincipalName: 'clean@users.example', accountEnabled: true, onPremisesImmutableId: 'anchor', givenName: 'Clean', surname: 'Case', jobTitle: 'Engineer', department: 'Platform' }] });
    }
    if (href.startsWith('https://admin.googleapis.com')) {
      return json({
        users: [
          { id: 'google-id', primaryEmail: 'clean@users.example', suspended: false, orgUnitPath: '/Okta Users', name: { givenName: 'Clean', familyName: 'Case' }, organizations: [{ title: 'Engineer', department: 'Platform', primary: true }] },
          { id: 'bg-id', primaryEmail: 'breakglass@primary.example', suspended: false, orgUnitPath: '/Breakglass', name: { givenName: 'Break', familyName: 'Glass' } },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  return { seen, fetchImpl };
}

test('config names every gap at once, and an unresolved Key Vault reference counts as missing', () => {
  assert.throws(
    () => reconConfig({ OKTA_ORG_URL: 'https://x.okta.com', OKTA_API_TOKEN: '@Microsoft.KeyVault(SecretUri=https://kv/secrets/x)' }),
    /OKTA_API_TOKEN.*OKTA_ENTRA_APP_ID.*OKTA_GOOGLE_APP_ID.*GOOGLE_SA_CLIENT_EMAIL/
  );
});

test('a dedicated read-only Okta token is preferred over the lifecycle token', () => {
  const cfg = reconConfig({ ...ENV, RECON_OKTA_API_TOKEN: 'read-only' });
  assert.equal(cfg.okta.token, 'read-only');
  assert.equal(reconConfig(ENV).okta.token, 'ssws-token');
});

test('a full run reads all three directories and returns the raw comparison', async () => {
  const { seen, fetchImpl } = stubFetch();
  const result = await runReconciliation({ env: ENV, fetchImpl });
  assert.ok(seen.some((u) => u.includes('example.okta.com/api/v1/users')));
  assert.ok(seen.some((u) => u.startsWith('https://graph.microsoft.com')));
  assert.ok(seen.some((u) => u.startsWith('https://admin.googleapis.com')));
  // The mixed-case Okta login was lowercased, so all three matched one person.
  assert.equal(result.summary.people, 2); // the person plus break-glass
  assert.equal(result.summary.verdict, 'clean');
  assert.equal(result.summary.accepted, 1);
  assert.equal(result.schema, 1);
  assert.ok(typeof result.durationMs === 'number' && result.generatedAt);
  // Raw on purpose: the site masks it. Keys are real logins here.
  assert.ok(result.users.some((u) => u.key === 'clean@users.example'));
});

test('the managed identity token is requested for the user-assigned identity', async () => {
  const { seen, fetchImpl } = stubFetch();
  await getManagedIdentityToken({ fetchImpl, env: ENV });
  assert.match(seen[0], /client_id=11111111-2222-3333-4444-555555555555/);
});

test('Google without GOOGLE_ADMIN_SUBJECT signs no sub claim (admin role on the service account)', async () => {
  const { fetchImpl } = stubFetch({ expectSubject: undefined });
  await runReconciliation({ env: ENV, fetchImpl });
});

test('Google with GOOGLE_ADMIN_SUBJECT impersonates that admin (domain-wide delegation route)', async () => {
  const { fetchImpl } = stubFetch({ expectSubject: 'admin@primary.example' });
  await runReconciliation({ env: { ...ENV, GOOGLE_ADMIN_SUBJECT: 'admin@primary.example' }, fetchImpl });
});

test('a single directory failure aborts the run and returns nothing', async () => {
  const { fetchImpl } = stubFetch({ failGoogle: true });
  await assert.rejects(
    () => runReconciliation({ env: ENV, fetchImpl }),
    (error) => {
      assert.match(error.message, /nothing published/);
      assert.ok(error.failures.some((f) => f.startsWith('google:')));
      return true;
    }
  );
});

test('the service-account assertion is a well-formed RS256 JWT', () => {
  const token = signAssertion({ clientEmail: 'recon@project.iam.gserviceaccount.com', privateKey, now: 1_760_000_000 });
  const [header, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(decoded.exp - decoded.iat, 3600);
  assert.equal('sub' in decoded, false);
  assert.ok(signature.length > 300);
  assert.equal(/[+/=]/.test(token), false, 'must be base64url, not base64');
});

test('a separate federated tenant is read with an app registration there, not the managed identity', async () => {
  const { getGraphToken, graphAuthMode } = require('../../src/lib/recon/sources/entra');
  const env = { ...ENV, ENTRA_TENANT_ID: 'federated-tenant', ENTRA_CLIENT_ID: 'app-id', ENTRA_CLIENT_SECRET: 'shh' };
  assert.equal(graphAuthMode(env), 'app-registration');
  // An unresolved Key Vault reference falls back to the managed identity rather than sending it as a secret.
  assert.equal(graphAuthMode({ ...env, ENTRA_CLIENT_SECRET: '@Microsoft.KeyVault(SecretUri=https://kv/x)' }), 'managed-identity');
  const seen = [];
  const token = await getGraphToken({
    env,
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), body: new URLSearchParams(init.body) });
      return json({ access_token: 'tenant-token' });
    },
  });
  assert.equal(token, 'tenant-token');
  assert.equal(seen[0].url, 'https://login.microsoftonline.com/federated-tenant/oauth2/v2.0/token');
  assert.equal(seen[0].body.get('grant_type'), 'client_credentials');
  assert.equal(seen[0].body.get('scope'), 'https://graph.microsoft.com/.default');
});
