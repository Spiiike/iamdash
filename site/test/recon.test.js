'use strict';
// node test/recon.test.js  - no network needed; the reconciler is faked.
const http = require('http');
const assert = require('assert');
const express = require('express');
const { createReconRouter } = require('../recon');
const { maskSnapshot } = require('../recon/mask-snapshot');
const { reconPage, relativeTime } = require('../recon/views');
const { createConfig } = require('../recon/config');
const { createUpstream } = require('../recon/upstream');
const { createMasker } = require('../dashboard/mask');
const { createPage } = require('../layout');

const page = createPage({ cssHref: '/labs/assets/glasscliff.css' });
const masker = createMasker('test-secret-not-the-real-one');
const quiet = { log() {}, warn() {}, error() {} };
const listen = (app) => new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });

// A reconciler result as the Function app emits it: unmasked, real addresses.
const RAW = () => ({
  summary: {
    directories: { okta: 2, entra: 2, google: 3 },
    people: 3, agreeing: 1, actionable: 1, accepted: 1,
    counts: {}, verdict: 'drift', worst: 'critical',
  },
  generatedAt: '2026-10-12T18:17:04.000Z',
  durationMs: 2841,
  users: [
    {
      key: 'jerome.hopfield@users.example',
      okta: { status: 'DEPROVISIONED', expected: 'disabled', id: 'o1' },
      entra: { enabled: false, id: 'e1', anchored: true },
      google: { enabled: true, id: 'g1', orgUnitPath: '/Okta Users' },
      worst: 'critical', agrees: false,
      findings: [{
        rule: 'access_not_revoked', severity: 'critical', directory: 'google', section: '§9',
        key: 'jerome.hopfield@users.example',
        detail: "Okta status DEPROVISIONED should have disabled this account, but it is still enabled in google.",
      }],
    },
    {
      key: 'durell.ewing@users.example',
      okta: { status: 'ACTIVE', expected: 'enabled', id: 'o2' },
      entra: { enabled: true, id: 'e2', anchored: true },
      google: { enabled: true, id: 'g2', orgUnitPath: '/Okta Users' },
      worst: 'none', agrees: true, findings: [],
    },
    {
      key: 'breakglass@primary.example',
      okta: null,
      entra: null,
      google: { enabled: true, id: 'g7', orgUnitPath: '/Breakglass' },
      worst: 'info', agrees: true,
      findings: [{
        rule: 'accepted_exception', severity: 'info', directory: 'google', section: '§6',
        key: 'breakglass@primary.example',
        detail: 'Directory-native account, accepted: break-glass, SSO-exempt by design.',
      }],
    },
  ],
  findings: [{
    rule: 'duplicate_candidate', severity: 'high', directory: 'entra', section: '§2',
    keys: ['antalonj@users.example', 'antalon@users.example'],
    detail: '2 entra accounts share the same first and last name under different addresses.',
  }],
});

const CFG = {
  snapshotEndpoint: 'https://recon.example/api/recon',
  operatorHeader: 'x-operator-key',
  operatorKey: 'secret-key',
  timeoutMs: 2000,
  ttlMs: 60000,
};

(async () => {
  let pass = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log(`ok   ${name}`); } catch (e) { console.log(`FAIL ${name}\n     ${e.stack}`); process.exitCode = 1; }
  };

  // one fake upstream per test, so cache state never leaks between them
  const fakeUpstream = (impl) => {
    const state = { calls: 0, headers: null };
    const fetchImpl = async (url, opts) => {
      state.calls++;
      state.headers = opts.headers;
      return impl(state);
    };
    return { state, client: createUpstream(CFG, { fetchImpl }) };
  };
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const servers = [];
  const mk = async (upstream) => {
    const app = express();
    app.use('/labs/identity/recon', createReconRouter({ page, config: CFG, masker, upstream, log: quiet }));
    const s = await listen(app);
    servers.push(s); // closed in the finally below, so a failed assert can't hang the run
    return { s, B: `http://127.0.0.1:${s.address().port}/labs/identity/recon` };
  };

  // ---- masking -------------------------------------------------------------

  await t('the rendered page contains no address, object id or attribute value', async () => {
    const { client } = fakeUpstream(() => ok(RAW()));
    const { s, B } = await mk(client);
    const html = await (await fetch(`${B}/`)).text();
    // Full addresses and raw values only. Bare first names would collide with
    // the site's own byline in the footer, which is not a leak.
    for (const secret of ['jerome.hopfield@users.example', 'durell.ewing@users.example',
      'antalonj@users.example', 'antalon@users.example', 'breakglass@primary.example',
      '@users.example', '@primary.example', 'test-secret-not-the-real-one',
      'DEPROVISIONED should have disabled']) {
      assert.ok(!html.toLowerCase().includes(secret.toLowerCase()), `leaked "${secret}"`);
    }
    assert.ok(html.includes('person-'), 'and people are shown as pseudonyms');
  });

  await t('people get the same pseudonyms the operations dashboard uses', async () => {
    const masked = maskSnapshot(RAW(), { pseudonym: masker.pseudonym });
    const expected = masker.pseudonym('jerome.hopfield@users.example');
    assert.ok(masked.users.some((u) => u.id === expected), 'pseudonym must match mask.js');
    assert.match(expected, /^person-[0-9a-f]{6}$/);
  });

  await t('the same person keeps one label across runs, and two people differ', async () => {
    const a = maskSnapshot(RAW(), { pseudonym: masker.pseudonym });
    const b = maskSnapshot(RAW(), { pseudonym: masker.pseudonym });
    assert.deepEqual(a.users.map((u) => u.id), b.users.map((u) => u.id));
    assert.equal(new Set(a.users.map((u) => u.id)).size, 3);
  });

  await t('masking refuses to run without a pseudonym function', async () => {
    assert.throws(() => maskSnapshot(RAW(), {}), /needs a pseudonym function/);
  });

  await t('published detail is re-derived, not copied from the raw finding', async () => {
    const raw = RAW();
    raw.users[0].findings[0].detail = 'LEAK jerome.hopfield@users.example holds Regulator';
    const masked = maskSnapshot(raw, { pseudonym: masker.pseudonym });
    const text = JSON.stringify(masked);
    assert.ok(!text.includes('LEAK'), 'raw detail text must never be copied through');
    assert.ok(!text.includes('Regulator'));
    assert.ok(text.includes('Okta expects this account to be disabled'));
  });

  await t('an unknown rule publishes no wording rather than leaking its own', async () => {
    const raw = RAW();
    raw.users[0].findings[0] = { rule: 'brand_new_rule', severity: 'high', directory: 'google',
      key: 'x@y.example', detail: 'secret internal text about x@y.example' };
    const masked = maskSnapshot(raw, { pseudonym: masker.pseudonym });
    assert.equal(masked.users.find((u) => u.findings.length).findings[0].detail, 'Finding: brand_new_rule.');
    assert.ok(!JSON.stringify(masked).includes('secret internal text'));
  });

  await t('an out-of-shape OU or status is dropped rather than rendered', async () => {
    const raw = RAW();
    raw.users[0].google.orgUnitPath = '<script>alert(1)</script>';
    raw.users[0].okta.status = 'not a status';
    const masked = maskSnapshot(raw, { pseudonym: masker.pseudonym });
    assert.equal(masked.users.find((u) => u.google.present && !u.agrees).google.orgUnitPath, '');
    assert.equal(masked.users.find((u) => u.okta).okta.status, 'UNKNOWN');
  });

  // ---- the page ------------------------------------------------------------

  await t('the page shows the verdict, the counts and a row per account', async () => {
    const { client } = fakeUpstream(() => ok(RAW()));
    const { s, B } = await mk(client);
    const r = await fetch(`${B}/`);
    const html = await r.text();
    assert.equal(r.status, 200);
    for (const txt of ['1 disagreement to resolve', 'accounts seen', 'in agreement',
      'Account by account', 'Okta expects this account to be disabled',
      'shape of a failed soft match', 'How to read this']) {
      assert.ok(html.includes(txt), txt);
    }
    assert.equal((html.match(/class="person/g) || []).length, 3);
  });

  await t('an agreeing row says why it is fine rather than just "agrees"', async () => {
    const masked = maskSnapshot(RAW(), { pseudonym: masker.pseudonym });
    const html = reconPage(masked, { now: Date.parse('2026-10-12T18:40:00Z') });
    assert.ok(html.includes('>accepted<'), 'break-glass row should read accepted');
    assert.ok(html.includes('>agrees<'), 'a plain clean row should read agrees');
  });

  await t('runbook sections link to the matching part of the rules page', async () => {
    const masked = maskSnapshot(RAW(), { pseudonym: masker.pseudonym });
    const html = reconPage(masked, { now: Date.parse('2026-10-12T18:40:00Z') });
    assert.match(html, /href="https:\/\/github\.com\/Spiiike\/iamdash\/blob\/main\/functions\/src\/lib\/recon\/README\.md#section-9-presence-and-access">runbook §9<\/a>/);
    assert.match(html, /README\.md#section-2-join-key-and-anchor">runbook §2<\/a>/);
  });

  await t('a clean run says so instead of listing disagreements', async () => {
    const raw = RAW();
    raw.summary = { ...raw.summary, verdict: 'clean', actionable: 0, worst: 'none', agreeing: 3 };
    raw.users = raw.users.filter((u) => u.agrees);
    raw.findings = [];
    const masked = maskSnapshot(raw, { pseudonym: masker.pseudonym });
    const html = reconPage(masked, { now: Date.now() });
    assert.ok(html.includes('All three directories agree'));
    assert.ok(!html.includes('disagreements to resolve'));
    assert.ok(!html.includes('span more than one account'));
  });

  await t('the page escapes anything that reaches it', async () => {
    const raw = RAW();
    raw.users[0].findings[0].attribute = '"><img src=x onerror=alert(1)>';
    raw.users[0].findings[0].rule = 'attribute_drift';
    raw.users[0].findings[0].expected = 'something';
    const masked = maskSnapshot(raw, { pseudonym: masker.pseudonym });
    const html = reconPage(masked, { now: Date.now() });
    assert.ok(!html.includes('<img src=x'), 'no raw markup may reach the page');
  });

  await t('relative time reads in words', async () => {
    const base = Date.parse('2026-10-12T18:00:00Z');
    assert.equal(relativeTime('2026-10-12T17:30:00Z', base), '30 minutes ago');
    assert.equal(relativeTime('2026-10-12T17:00:00Z', base), 'an hour ago');
    assert.equal(relativeTime('2026-10-10T18:00:00Z', base), '2 days ago');
    assert.equal(relativeTime('not a date', base), '');
  });

  // ---- upstream ------------------------------------------------------------

  await t('the operator key is sent upstream and never to the browser', async () => {
    const { state, client } = fakeUpstream(() => ok(RAW()));
    const { s, B } = await mk(client);
    const html = await (await fetch(`${B}/`)).text();
    assert.equal(state.headers['x-operator-key'], 'secret-key');
    assert.ok(!html.includes('secret-key'));
  });

  await t('a successful read is cached, so a busy page is one upstream call', async () => {
    const { state, client } = fakeUpstream(() => ok(RAW()));
    const { s, B } = await mk(client);
    await Promise.all([fetch(`${B}/`), fetch(`${B}/`), fetch(`${B}/`)]);
    assert.equal(state.calls, 1);
  });

  await t('an upstream failure serves the last good snapshot, marked stale', async () => {
    let first = true;
    const { client } = fakeUpstream(() => {
      if (first) { first = false; return ok(RAW()); }
      throw new Error('upstream down');
    });
    const { s, B } = await mk(client);
    await fetch(`${B}/`);                       // warms the cache
    client._peek().at = Date.now() - 10 * 60000; // age it past the TTL
    const r = await fetch(`${B}/`);
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.ok(html.includes("couldn't fetch the latest result"), 'stale notice should be shown');
    assert.ok(html.includes('Account by account'), 'and the previous result kept');
  });

  await t('a cold cache and a failed read says so rather than inventing a result', async () => {
    const { client } = fakeUpstream(() => { throw new Error('upstream down'); });
    const { s, B } = await mk(client);
    const r = await fetch(`${B}/`);
    const html = await r.text();
    assert.equal(r.status, 503);
    assert.ok(html.includes('No reconciliation to show yet'));
    assert.ok(!html.includes('Account by account'));
  });

  await t('a 404 upstream means never run, not an error', async () => {
    const { client } = fakeUpstream(() => ({ ok: false, status: 404 }));
    const { s, B } = await mk(client);
    const r = await fetch(`${B}/`);
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes('No reconciliation to show yet'));
  });

  await t('a body that is not a snapshot is rejected', async () => {
    const { client } = fakeUpstream(() => ok({ hello: 'world' }));
    const { s, B } = await mk(client);
    assert.equal((await fetch(`${B}/`)).status, 503);
  });

  // ---- wiring --------------------------------------------------------------

  await t('the router refuses to start without the layout or a masker', async () => {
    assert.throws(() => createReconRouter({ config: CFG, masker }), /page\(\) layout/);
    assert.throws(() => createReconRouter({ page, config: CFG }), /masker/);
    assert.throws(() => createReconRouter({ page, masker }), /config/);
  });

  await t('config is off until RECON_ENABLED, then reuses the LAB_* settings the site already has', async () => {
    const LAB = { LAB_API_BASE_URL: 'https://func.example', LAB_OPERATOR_KEY: 'lab-key', LAB_OPERATOR_HEADER: 'x-lab-operator-key' };
    assert.throws(() => createConfig(LAB), /RECON_ENABLED/);
    const cfg = createConfig({ ...LAB, RECON_ENABLED: 'true' });
    assert.equal(cfg.snapshotEndpoint, 'https://func.example/api/recon/snapshot');
    assert.equal(cfg.operatorHeader, 'x-lab-operator-key');
    assert.equal(cfg.operatorKey, 'lab-key');
    assert.equal(cfg.maskSecret, 'lab-key', 'same secret the dashboard masks with, so pseudonyms match');
  });

  await t('config names every gap at once, treats an unresolved Key Vault reference as missing, and demands https', async () => {
    assert.throws(
      () => createConfig({ RECON_ENABLED: 'true', LAB_OPERATOR_KEY: '@Microsoft.KeyVault(SecretUri=https://kv/secrets/x)' }),
      /LAB_API_BASE_URL.*LAB_OPERATOR_KEY/
    );
    assert.throws(
      () => createConfig({ RECON_ENABLED: 'true', RECON_SNAPSHOT_ENDPOINT: 'http://x.example', LAB_OPERATOR_KEY: 'k' }),
      /must be https/
    );
  });

  for (const s of servers) s.close();
  // ---- run and finding history --------------------------------------------
  const HISTORY = () => ({
    schema: 1,
    runs: [
      { at: '2026-10-13T06:17:02.000Z', outcome: 'failed', failedSources: ['google', 'evil'] },
      { at: '2026-10-12T18:17:04.000Z', outcome: 'complete', durationMs: 2841, actionable: 1, people: 3 },
      { at: '2026-10-12T06:17:03.000Z', outcome: 'complete', durationMs: 2500, actionable: 2, people: 3 },
    ],
    findings: [
      { id: 'x', key: 'jerome.hopfield@users.example', rule: 'access_not_revoked', severity: 'critical', directory: 'google',
        firstSeen: '2026-10-12T06:17:03.000Z', lastSeen: '2026-10-12T18:17:04.000Z', resolvedAt: null, seenRuns: 2 },
      { id: 'y', key: 'durell.ewing@users.example', rule: 'attribute_drift', severity: 'medium', directory: 'entra', attribute: 'title',
        firstSeen: '2026-10-11T18:17:00.000Z', lastSeen: '2026-10-12T06:17:03.000Z', resolvedAt: '2026-10-12T18:17:04.000Z', seenRuns: 2 },
      { id: 'z', key: 'someone@users.example', rule: 'a_rule_with_no_public_wording', severity: 'high', firstSeen: '2026-10-12T06:17:03.000Z', lastSeen: '2026-10-12T06:17:03.000Z', resolvedAt: null },
    ],
  });
  const withHistory = () => maskSnapshot({ ...RAW(), history: HISTORY() }, {
    pseudonym: masker.pseudonym, generatedAt: RAW().generatedAt, durationMs: RAW().durationMs,
  });

  await t('history is masked: pseudonyms, allowlisted fields, no rule without public wording', async () => {
    const m = withHistory();
    const text = JSON.stringify(m.history);
    for (const leak of ['jerome', 'durell', 'someone@', 'users.example', 'evil']) assert.ok(!text.includes(leak), leak);
    assert.equal(m.history.findings.length, 2, 'the unknown rule publishes nothing');
    assert.deepEqual(m.history.runs[0].failedSources, ['google']);
    assert.equal(m.history.findings[0].people[0], masker.pseudonym('jerome.hopfield@users.example'), 'same pseudonym as the dashboard');
  });

  await t('a failed attempt newer than the result is said out loud', async () => {
    const html = reconPage(withHistory(), { now: Date.parse('2026-10-13T07:00:00Z') });
    assert.match(html, /The latest attempt, at .*13 Oct, 06:17 UTC.*couldn't read Google, so it published nothing/s);
    assert.match(html, /2 complete, 1 failed/);
    assert.match(html, /couldn't read Google; published nothing/);
  });

  await t('finding history shows first seen, last seen, how long, and resolved', async () => {
    const html = reconPage(withHistory(), { now: Date.parse('2026-10-13T07:00:00Z') });
    assert.match(html, /Disagreements over time/);
    assert.match(html, /<span class="state crit">open<\/span>/);
    assert.match(html, /25 hours so far/, 'open: measured to now');
    assert.match(html, /<span class="state ok">resolved<\/span>/);
    assert.match(html, /24 hours</, 'resolved: first seen to resolved');
    assert.doesNotMatch(html, /jerome|durell/);
  });

  await t('no history, no history sections; a clean history says so plainly', async () => {
    const plain = reconPage(maskSnapshot(RAW(), { pseudonym: masker.pseudonym, generatedAt: RAW().generatedAt }), { now: Date.now() });
    assert.doesNotMatch(plain, /Disagreements over time|Every run, including/);
    const clean = maskSnapshot({ ...RAW(), history: { schema: 1, runs: [{ at: '2026-10-12T18:17:04.000Z', outcome: 'complete', actionable: 0 }], findings: [] } },
      { pseudonym: masker.pseudonym, generatedAt: RAW().generatedAt });
    assert.match(reconPage(clean, { now: Date.now() }), /No complete run in the last 30 days found anything to resolve/);
  });

  console.log(`\n${pass} passed`);
})();
