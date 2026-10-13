'use strict';
// node test/landingzone.test.js  - no Azure needed; ARM is faked.
const http = require('http');
const assert = require('assert');
const express = require('express');
const { createLandingZoneRouter } = require('../landingzone');
const { normalize, requestBody, interpret, COMBINATIONS } = require('../landingzone/check');

const SUB = '7e1d2c3b-4a5f-4e6d-8c7b-9a0f1e2d3c4b';
const TENANT = '0ad6bf39-5055-438a-8d53-ce64746ea521';
const MY = `/providers/Microsoft.Management/managementGroups/glasscliff/providers/Microsoft.Authorization/policyAssignments/glasscliff-baseline`;
const ASC = `/subscriptions/${SUB}/providers/Microsoft.Authorization/policyAssignments/SecurityCenterBuiltIn`;

function fakeArm(state) {
  return {
    async graph(q) {
      state.graphCalls++;
      if (state.failGraph && q.includes(state.failGraph)) throw Object.assign(new Error('boom'), { status: 500 });
      if (q.includes("microsoft.management/managementgroups")) return [
        { name: 'glasscliff', displayName: 'Glasscliff', parent: TENANT },
        { name: 'glasscliff-platform', displayName: 'Platform', parent: 'glasscliff' },
        { name: 'glasscliff-landingzones', displayName: 'Landing Zones', parent: 'glasscliff' },
        { name: 'glasscliff-online', displayName: 'Online', parent: 'glasscliff-landingzones' },
        { name: 'glasscliff-sandbox', displayName: 'Sandbox', parent: 'glasscliff' },
        { name: 'glasscliff-decommissioned', displayName: 'Decommissioned', parent: 'glasscliff' },
      ];
      if (q.includes("microsoft.resources/subscriptions")) return [{ subscriptionId: SUB, name: 'Azure for Students', parent: 'glasscliff-online' }];
      if (q.includes('policyassignments')) return [{ effect: 'Deny', enforcement: 'Default' }];
      if (q.includes('policystates') && state.emptyStates) return [];
      if (q.includes('policystates')) return [
        { rule: 'require-tag-owner', state: 'Compliant', n: 20 },
        { rule: 'require-tag-owner', state: 'NonCompliant', n: 1 },
        { rule: 'allowed-locations', state: 'Compliant', n: 21 },
      ];
      if (q.includes('summarize total')) return [{ resourceGroup: 'rg-basic-webapp', total: 4, tagged: 4 }, { resourceGroup: 'rg-glasscliff-lab', total: 9, tagged: 9 }];
      return [];
    },
    async call(method, path, body) {
      state.calls.push({ method, path, body });
      if (path.includes('/budgets/')) return { properties: { amount: 30, timeGrain: 'Monthly', currentSpend: { amount: 4.12, unit: 'USD' }, forecastSpend: { amount: 9.5, unit: 'USD' } } };
      if (path.includes('checkPolicyRestrictions')) {
        if (state.checkStatus) throw Object.assign(new Error('nope'), { status: state.checkStatus });
        const c = body.resourceDetails.resourceContent;
        const evals = [];
        const add = (ref, assignment = MY, effect = 'Deny') => evals.push({ policyInfo: { policyAssignmentId: assignment, policyDefinitionReferenceId: ref }, evaluationResult: 'NonCompliant', effectDetails: { policyEffect: effect } });
        if (c.location !== 'eastus2') add('allowed-locations');
        if (!c.tags.owner) add('require-tag-owner');
        if (!c.tags.environment) add('require-tag-environment');
        if (c.type.includes('publicIPAddresses')) add('no-public-ip');
        if (c.type.includes('storageAccounts') && (!c.properties.supportsHttpsTrafficOnly || c.properties.minimumTlsVersion !== 'TLS1_2')) add('storage-secure-transport');
        add('some-defender-rule', ASC, 'Audit'); // another assignment: must be ignored
        return { fieldRestrictions: [], contentEvaluationResult: { policyEvaluations: evals } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

const listen = (app) => new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
const page = (title, body) => `<!doctype html><title>${title}</title><main>${body}</main>`;

(async () => {
  const quiet = { info() {}, warn() {}, error() {} };
  let pass = 0;
  const t = async (name, fn) => {
    try { await fn(); pass++; console.log(`ok   ${name}`); } catch (e) { console.log(`FAIL ${name}\n     ${e.stack}`); process.exitCode = 1; }
  };
  const mk = async (state, opts = {}) => {
    const app = express();
    app.use('/labs/landing-zone', createLandingZoneRouter({ page, arm: fakeArm(state), log: quiet, ...opts }));
    const s = await listen(app);
    return { s, B: `http://127.0.0.1:${s.address().port}/labs/landing-zone` };
  };
  const post = (B, form, ip = '198.51.100.1') => fetch(`${B}/check`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip }, body: new URLSearchParams(form).toString() });

  const state = { graphCalls: 0, calls: [] };
  const { s, B } = await mk(state);

  await t('no policy results reads as "no data", never as a table of zeros', async () => {
    const st = { graphCalls: 0, calls: [], emptyStates: true };
    const { s: s2, B: B2 } = await mk(st);
    try {
      const html = await (await fetch(`${B2}/`)).text();
      assert.match(html, /No compliance results came back/);
      assert.match(html, /does not mean every resource passes/);
      assert.doesNotMatch(html, /<th class="n">Compliant<\/th>/, 'no table of zeros');
      assert.match(html, /Every resource has an owner tag/, 'the rules are still listed');
    } finally { s2.close(); }
  });

  await t('policy counts say how many results they rest on', async () => {
    const html = await (await fetch(`${B}/`)).text();
    assert.match(html, /\(\d+ results\)/);
  });

  await t('live view shows the tree, guardrails, tags and spend', async () => {
    const r = await fetch(`${B}/`); const html = await r.text();
    assert.equal(r.status, 200);
    for (const txt of ['Glasscliff', 'Landing Zones', 'Online', 'Azure for Students', 'Deny: new resources that break a rule are refused', 'Every resource has an owner tag', 'rg-glasscliff-lab', '9 of 9', 'Fully tagged', '$4.12 spent of a $30.00 monthly budget (14%)']) assert.ok(html.includes(txt), txt);
    assert.ok(html.indexOf('Landing Zones') < html.indexOf('Online'), 'Online nested under Landing Zones');
  });

  await t('no subscription or tenant id reaches the page', async () => {
    const html = await (await fetch(`${B}/`)).text();
    assert.ok(!html.includes(SUB)); assert.ok(!html.includes(TENANT));
    const r = await post(B, { kind: 'storage', region: 'westeurope' }); const h2 = await r.text();
    assert.ok(!h2.includes(SUB)); assert.ok(!h2.includes(TENANT));
  });

  await t('the overview is cached, not re-read on every visit', async () => {
    const before = state.graphCalls;
    await fetch(`${B}/`); await fetch(`${B}/`);
    assert.equal(state.graphCalls, before);
  });

  await t('one failing section does not take the page down', async () => {
    const st = { graphCalls: 0, calls: [], failGraph: 'policystates' };
    const { s: s2, B: B2 } = await mk(st);
    const html = await (await fetch(`${B2}/`)).text(); s2.close();
    assert.match(html, /policy status isn't available right now/);
    assert.ok(html.includes('Landing Zones') && html.includes('9 of 9'), 'other sections still render');
  });

  await t('a rule-breaking storage account is refused, with the reasons', async () => {
    const html = await (await post(B, { kind: 'storage', region: 'westeurope', environment: 'on', https: 'on', tls: 'TLS1_0' })).text();
    assert.match(html, /Azure would refuse this\./);
    assert.match(html, /storage account in West Europe/, 'resource type lowercased, region name kept');
    for (const r of ['Resources stay in East US 2', 'Every resource has an owner tag', 'Storage accepts only HTTPS and TLS 1.2']) assert.ok(html.includes(r), r);
    assert.ok(!html.includes('some-defender-rule'), "another assignment's findings are ignored");
    const verdict = html.slice(html.indexOf('class="answer'), html.indexOf('</div>', html.indexOf('class="verdict')));
    assert.ok(!verdict.includes('environment tag'), 'environment was set, so not listed in the verdict');
  });

  await t('a compliant storage account is allowed', async () => {
    const html = await (await post(B, { kind: 'storage', region: 'eastus2', owner: 'on', environment: 'on', https: 'on', tls: 'TLS1_2' })).text();
    assert.match(html, /Azure would allow this\./);
  });

  await t('a public IP is refused even when everything else is right', async () => {
    const html = await (await post(B, { kind: 'publicip', region: 'eastus2', owner: 'on', environment: 'on' })).text();
    assert.match(html, /Azure would refuse this\./); assert.ok(html.includes('No standalone public IP addresses'));
  });

  await t('visitor input cannot shape the Azure request', async () => {
    state.calls.length = 0;
    await post(B, { kind: '<script>x</script>', region: 'mars', tls: 'TLS0_9', owner: 'yes please', name: 'evil', 'properties[x]': '1' });
    const body = state.calls.find((c) => c.path.includes('checkPolicyRestrictions'))?.body;
    const expected = requestBody(normalize({}));
    if (body) assert.deepEqual(body, expected, 'hostile values fell back to fixed defaults');
    const json = JSON.stringify(body || expected);
    for (const bad of ['script', 'mars', 'TLS0_9', 'evil', 'yes please']) assert.ok(!json.includes(bad), bad);
  });

  await t('each distinct check hits Azure once, then comes from cache', async () => {
    const form = { kind: 'storage', region: 'centralus', owner: 'on', https: 'on', tls: 'TLS1_2' };
    state.calls.length = 0;
    await post(B, form, '203.0.113.5'); await post(B, form, '203.0.113.6'); await post(B, form, '203.0.113.7');
    assert.equal(state.calls.filter((c) => c.path.includes('checkPolicyRestrictions')).length, 1);
    assert.ok(COMBINATIONS <= 100, `only ${COMBINATIONS} checks are possible at all`);
  });

  await t('the check is called at the subscription scope', async () => {
    state.calls.length = 0;
    await post(B, { kind: 'publicip', region: 'westus2' }, '203.0.113.9');
    const c = state.calls.find((x) => x.path.includes('checkPolicyRestrictions'));
    assert.ok(c.path.startsWith(`/subscriptions/${SUB}/providers/Microsoft.PolicyInsights/checkPolicyRestrictions?api-version=`));
    assert.equal(c.method, 'POST'); assert.equal(c.body.includeAuditEffect, true);
  });

  await t('a missing permission is explained, not leaked', async () => {
    const st = { graphCalls: 0, calls: [], checkStatus: 403 };
    const { s: s3, B: B3 } = await mk(st);
    const r = await post(B3, { kind: 'storage', region: 'eastus2' }); const html = await r.text(); s3.close();
    assert.equal(r.status, 502);
    assert.match(html, /isn(&#39;|')t allowed to ask Azure Policy yet/);
    assert.ok(!/nope|stack|AuthorizationFailed/.test(html));
  });

  await t('one visitor is rate limited', async () => {
    const st = { graphCalls: 0, calls: [] };
    const { s: s4, B: B4 } = await mk(st, { perIpLimit: 3 });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(B4, { kind: 'storage', region: 'eastus2' }, '192.0.2.44')).status);
    s4.close();
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200]); assert.equal(codes[4], 429);
  });

  await t('oversized form posts are refused', async () => {
    const r = await fetch(`${B}/check`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'kind=' + 'a'.repeat(5000) });
    assert.equal(r.status, 413);
  });

  await t('the case study page loads', async () => {
    const r = await fetch(`${B}/about`); const html = await r.text();
    assert.equal(r.status, 200); assert.match(html, /About this landing zone/); assert.match(html, /17 problems across 12 resources/);
  });

  await t('interpret ignores other assignments and non-denials', async () => {
    const out = interpret({ contentEvaluationResult: { policyEvaluations: [
      { policyInfo: { policyAssignmentId: ASC, policyDefinitionReferenceId: 'x' }, evaluationResult: 'NonCompliant', effectDetails: { policyEffect: 'Deny' } },
      { policyInfo: { policyAssignmentId: MY, policyDefinitionReferenceId: 'no-public-ip' }, evaluationResult: 'Compliant', effectDetails: { policyEffect: 'Deny' } },
    ] } });
    assert.deepEqual(out, { denied: false, findings: [] });
  });

  s.close();
  console.log(`\n${pass} passed`);
})();
