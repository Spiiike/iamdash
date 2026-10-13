'use strict';
// The bundled replays, in display order. Adding a replay must not break these tests.
const BUNDLED_IDS = require('../dashboard/scenarios').loadBundled().sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).map((s) => s.id);
// node test/smoke.js  - site routes, no Azure or Okta needed.
const assert = require('assert');
process.env.EXPENSES_OIDC_POST_LOGOUT_REDIRECT_URI ||= 'https://wetcliff.example/labs/identity/expenses';
const quiet = console.warn; console.warn = () => {}; const quietErr = console.error; console.error = () => {};
const app = require('../server');

const s = app.listen(0, async () => {
  const b = `http://127.0.0.1:${s.address().port}`;
  const get = async (p, headers = {}) => { const r = await fetch(b + p, { redirect: 'manual', headers: { 'x-forwarded-host': 'wetcliff.example', ...headers } }); return { r, text: await r.text() }; };
  let pass = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log(`ok   ${name}`); } catch (e) { console.log(`FAIL ${name}\n     ${e.stack}`); process.exitCode = 1; }
  };

  await t('home page is the lab directory', async () => {
    const { r, text } = await get('/');
    assert.equal(r.status, 200);
    assert.match(text, /href="\/labs\/landing-zone\/"/);
    assert.match(text, /href="\/labs\/identity"/);
    assert.match(text, /Azure landing zone/); assert.match(text, /Okta identity lifecycle/);
  });
  await t('lab landing links both apps, marked live', async () => {
    const { r, text } = await get('/labs/identity');
    assert.equal(r.status, 200);
    assert.match(text, /href="\/labs\/identity\/dashboard\/"/); assert.match(text, /href="\/labs\/identity\/expenses\/"/);
    assert.doesNotMatch(text, /Coming soon/);
    assert.equal((text.match(/class="n-state live">live</g) || []).length, 2, 'expenses and dashboard are live; recon is not configured here');
  });
  await t('dashboard page is served with its CSP and a link back', async () => {
    const { r, text } = await get('/labs/identity/dashboard/');
    assert.equal(r.status, 200); assert.match(text, /<h1>Operations dashboard<\/h1>/);
    assert.match(text, /data-base="\/labs\/identity\/dashboard"/);
    assert.match(text, /class="back"><a href="\/labs\/identity">/);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  });
  await t('dashboard without trailing slash works too', async () => { assert.equal((await get('/labs/identity/dashboard')).r.status, 200); });
  await t('dashboard replays load (bundled, no Azure)', async () => {
    const { r, text } = await get('/labs/identity/dashboard/api/scenarios');
    assert.equal(r.status, 200); assert.deepEqual(JSON.parse(text).scenarios.map((x) => x.id), BUNDLED_IDS);
  });
  await t('dashboard live API says unavailable when the operator key is not set', async () => {
    assert.equal((await get('/labs/identity/dashboard/api/operations')).r.status, 503);
  });
  await t('Expenses is still mounted and unaffected', async () => {
    const { r } = await get('/labs/identity/expenses/');
    assert.ok([200, 503].includes(r.status), `status ${r.status}`); // 503 = not configured locally
  });
  await t('Expenses on another host is sent to the configured host', async () => {
    const { r } = await get('/labs/identity/expenses/', { 'x-forwarded-host': 'other.example' });
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), 'https://wetcliff.example/labs/identity/expenses/');
  });
  await t('home page links both case studies and names who built it', async () => {
    const { text } = await get('/');
    assert.match(text, /href="\/labs\/landing-zone\/about"/);
    assert.match(text, /href="\/labs\/identity\/about"/);
    assert.match(text, /Antalon Jackson Jr/);
    assert.match(text, /linkedin\.com\/in\/antalon-jackson-jr/); assert.match(text, /github\.com\/Spiiike\/iamdash/);
  });

  await t('landing zone page still renders when Azure is unreachable', async () => {
    const started = Date.now();
    const { r, text } = await get('/labs/landing-zone/');
    assert.equal(r.status, 200);
    assert.match(text, /Azure landing zone/);
    assert.match(text, /isn't available right now|isn&#39;t available right now/);
    assert.match(text, /Try to break the rules/);
    assert.ok(Date.now() - started < 30000, 'fails fast rather than hanging');
  });

  await t('landing zone case study loads', async () => {
    const { r, text } = await get('/labs/landing-zone/about');
    assert.equal(r.status, 200); assert.match(text, /About this landing zone/);
  });

  await t('about page loads with the case study', async () => {
    const { r, text } = await get('/labs/identity/about');
    assert.equal(r.status, 200);
    assert.match(text, /<h1>About this project<\/h1>/);
    assert.match(text, /no_matching_policy/);
  });
  await t('every page carries the footer links', async () => {
    for (const p of ['/', '/labs/identity', '/labs/identity/about']) {
      const { text } = await get(p);
      assert.match(text, /class="foot"/, p);
    }
  });
  await t('the shared stylesheet is served, and every page links it', async () => {
    const css = await get('/labs/assets/glasscliff.css');
    assert.equal(css.r.status, 200); assert.match(css.r.headers.get('content-type'), /text\/css/);
    for (const p of ['/', '/labs/identity', '/labs/identity/about', '/labs/identity/federation', '/labs/identity/dashboard/', '/labs/identity/expenses/']) {
      const { text } = await get(p);
      assert.match(text, /href="\/labs\/assets\/glasscliff\.css"/, p);
      assert.doesNotMatch(text, /fonts\.googleapis\.com/, `${p} no longer pulls Google Fonts`);
    }
  });
  await t('dashboard CSP lets the shared stylesheet load and nothing else external', async () => {
    const { r } = await get('/labs/identity/dashboard/');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /style-src 'self' 'nonce-/); assert.doesNotMatch(csp, /googleapis|gstatic/);
  });
  await t('federation page says the reconciler is not deployed while it is not configured', async () => {
    const { r, text } = await get('/labs/identity/federation');
    assert.equal(r.status, 200); assert.match(text, /One source of truth, two directories/);
    assert.match(text, /not deployed yet/); assert.doesNotMatch(text, /href="\/labs\/identity\/recon"/);
  });
  await t('recon page without a reconciler is an honest placeholder, not a crash', async () => {
    const { r, text } = await get('/labs/identity/recon');
    assert.equal(r.status, 200); assert.match(text, /reconciler isn&#39;t deployed yet|reconciler isn't deployed yet/);
    const home = (await get('/')).text;
    assert.match(home, /class="n-state soon">soon</, 'home marks recon soon rather than live');
  });
  await t('healthz is liveness only for the public', async () => {
    process.env.EXPENSES_OIDC_CLIENT_SECRET = 'a-test-secret-value';
    process.env.EXPENSES_OIDC_CLIENT_ID = '0oapublicclientid000';
    const { r, text } = await get('/healthz');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['status', 'time']);
    assert.doesNotMatch(text, /0oapublicclientid|fingerprint|secret/i);
    delete process.env.EXPENSES_OIDC_CLIENT_SECRET; delete process.env.EXPENSES_OIDC_CLIENT_ID;
  });
  await t('healthz gives the operator a secret fingerprint, never the secret', async () => {
    process.env.LAB_OPERATOR_KEY = 'op-key-for-tests';
    process.env.EXPENSES_OIDC_CLIENT_SECRET = 'a-test-secret-value';
    const wrong = JSON.parse((await get('/healthz', { 'x-lab-operator-key': 'nope' })).text);
    assert.equal(wrong.oidc, undefined, 'a wrong key gets the public view');
    const { r, text } = await get('/healthz', { 'x-lab-operator-key': 'op-key-for-tests' });
    assert.equal(r.status, 200);
    const body = JSON.parse(text);
    assert.equal(body.status, 'ok');
    assert.equal(body.oidc.secretSource, 'resolved');
    assert.equal(body.oidc.secretLength, 'a-test-secret-value'.length);
    const expected = require('crypto').createHash('sha256').update('a-test-secret-value').digest('hex').slice(0, 8);
    assert.equal(body.oidc.secretFingerprint, expected);
    assert.ok(!text.includes('a-test-secret-value'), 'the value itself never appears');
    process.env.EXPENSES_OIDC_CLIENT_SECRET = '@Microsoft.KeyVault(SecretUri=x)';
    const unresolved = JSON.parse((await get('/healthz', { 'x-lab-operator-key': 'op-key-for-tests' })).text);
    assert.equal(unresolved.oidc.secretSource, 'unresolved-keyvault-reference');
    assert.equal(unresolved.oidc.secretFingerprint, null);
    delete process.env.EXPENSES_OIDC_CLIENT_SECRET; delete process.env.LAB_OPERATOR_KEY;
  });
  await t('unknown paths get the site 404, including under the dashboard', async () => {
    assert.equal((await get('/nope')).r.status, 404);
    const { r, text } = await get('/labs/identity/dashboard/nope');
    assert.equal(r.status, 404); assert.match(text, /Page not found/);
  });

  console.log(`\n${pass} passed`);
  console.warn = quiet; console.error = quietErr;
  s.close();
});
