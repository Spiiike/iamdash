'use strict';
// "Try to break the rules": asks Azure Policy whether a proposed resource
// would be allowed, without deploying anything.
//
// Nothing a visitor types reaches Azure. Every field is picked from the fixed
// menus below and the request body is built here, so the full set of possible
// checks is small and finite (see COMBINATIONS), and each answer is cached.
const { RULES, ASSIGNMENT } = require('./overview');

const KINDS = {
  storage: 'Storage account',
  publicip: 'Public IP address',
};
const REGIONS = {
  eastus2: 'East US 2',
  westus2: 'West US 2',
  westeurope: 'West Europe',
  centralus: 'Central US',
};
const TLS = { TLS1_2: 'TLS 1.2', TLS1_0: 'TLS 1.0' };

// Default choice: a request that breaks several rules at once, so the first
// click shows the guardrails doing something.
const DEFAULTS = { kind: 'storage', region: 'westeurope', owner: false, environment: true, https: true, tls: 'TLS1_0' };

function normalize(input = {}) {
  const on = (v) => v === true || v === 'on' || v === '1' || v === 'true';
  return {
    kind: Object.hasOwn(KINDS, input.kind) ? input.kind : DEFAULTS.kind,
    region: Object.hasOwn(REGIONS, input.region) ? input.region : DEFAULTS.region,
    owner: on(input.owner),
    environment: on(input.environment),
    https: on(input.https),
    tls: Object.hasOwn(TLS, input.tls) ? input.tls : DEFAULTS.tls,
  };
}

const keyOf = (c) => [c.kind, c.region, +c.owner, +c.environment, c.kind === 'storage' ? `${+c.https}${c.tls}` : '-'].join('|');

function requestBody(c) {
  const tags = {};
  if (c.owner) tags.owner = 'visitor';
  if (c.environment) tags.environment = 'demo';
  const resourceContent = c.kind === 'storage'
    ? {
      type: 'Microsoft.Storage/storageAccounts',
      location: c.region,
      tags,
      kind: 'StorageV2',
      sku: { name: 'Standard_LRS' },
      properties: { supportsHttpsTrafficOnly: c.https, minimumTlsVersion: c.tls },
    }
    : {
      type: 'Microsoft.Network/publicIPAddresses',
      location: c.region,
      tags,
      sku: { name: 'Standard' },
      properties: { publicIPAllocationMethod: 'Static' },
    };
  return {
    resourceDetails: { resourceContent, apiVersion: c.kind === 'storage' ? '2023-05-01' : '2023-09-01' },
    includeAuditEffect: true,
  };
}

// Reads Azure's answer defensively: only this lab's own assignment counts,
// and only fields documented for the Policy Restrictions API are used.
function interpret(raw) {
  const mine = (info = {}) => String(info.policyAssignmentId || '').toLowerCase().endsWith(`/${ASSIGNMENT}`);
  const findings = new Map();
  for (const e of raw?.contentEvaluationResult?.policyEvaluations || []) {
    if (!mine(e.policyInfo)) continue;
    if (!/noncompliant/i.test(e.evaluationResult || '')) continue;
    const id = e.policyInfo.policyDefinitionReferenceId;
    findings.set(id, { id, label: RULES[id] || id, effect: e.effectDetails?.policyEffect || 'unknown' });
  }
  for (const f of raw?.fieldRestrictions || []) {
    for (const r of f.restrictions || []) {
      if (!mine(r.policy) || !/deny/i.test(r.result || '')) continue;
      const id = r.policy.policyDefinitionReferenceId;
      if (!findings.has(id)) findings.set(id, { id, label: RULES[id] || id, effect: 'Deny' });
    }
  }
  const list = [...findings.values()];
  return { denied: list.some((f) => /deny/i.test(f.effect)), findings: list };
}

function createChecker({ arm, subscriptionId: fixedSub, getSubscriptionId, log = console, ttlMs = 10 * 60 * 1000, now = () => Date.now() }) {
  const cache = new Map();

  async function check(input) {
    const choice = normalize(input);
    const key = keyOf(choice);
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return { choice, ...hit.value, cached: true };
    const sub = fixedSub || (await getSubscriptionId());
    if (!sub) throw Object.assign(new Error('no subscription visible to check against'), { status: 503 });
    const raw = await arm.call('POST', `/subscriptions/${sub}/providers/Microsoft.PolicyInsights/checkPolicyRestrictions?api-version=2023-03-01`, requestBody(choice));
    const value = interpret(raw);
    cache.set(key, { at: now(), value });
    log.info?.(`[landing-zone] policy check ${key}: ${value.denied ? 'denied' : 'allowed'} (${value.findings.map((f) => f.id).join(', ') || 'no findings'})`);
    return { choice, ...value, cached: false };
  }

  return { check };
}

const COMBINATIONS = Object.keys(REGIONS).length * 2 * 2 * (1 + 2 * Object.keys(TLS).length);

module.exports = { createChecker, normalize, requestBody, interpret, KINDS, REGIONS, TLS, DEFAULTS, COMBINATIONS };
