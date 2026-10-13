'use strict';
// The live view of the landing zone. Every section is loaded independently,
// so one failing API shows as "unavailable" instead of breaking the page.
// Nothing identifying leaves this file: no subscription, tenant or principal
// ids, only names that already appear in the public Bicep.

const RULES = {
  'allowed-locations': 'Resources stay in East US 2',
  'require-tag-owner': 'Every resource has an owner tag',
  'require-tag-environment': 'Every resource has an environment tag',
  'no-public-ip': 'No standalone public IP addresses',
  'storage-secure-transport': 'Storage accepts only HTTPS and TLS 1.2',
};
const RULE_ORDER = Object.keys(RULES);
const ASSIGNMENT = 'glasscliff-baseline';

const settle = async (fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err };
  }
};

function createOverview({ arm, managementGroup = 'glasscliff', budgetName = 'glasscliff-monthly', ttlMs = 5 * 60 * 1000, log = console, now = () => Date.now() }) {
  let cache = null;
  let cachedAt = 0;
  let inflight = null;

  async function hierarchy() {
    const [groups, subs] = await Promise.all([
      arm.graph(`resourcecontainers
        | where type =~ 'microsoft.management/managementgroups'
        | project name, displayName = tostring(properties.displayName), parent = tostring(properties.details.parent.name)`, managementGroup),
      arm.graph(`resourcecontainers
        | where type =~ 'microsoft.resources/subscriptions'
        | project subscriptionId, name, parent = tostring(properties.managementGroupAncestorsChain[0].name)`, managementGroup),
    ]);
    const byParent = {};
    for (const g of groups) (byParent[g.parent] ||= []).push({ kind: 'group', name: g.name, label: g.displayName || g.name });
    for (const s of subs) (byParent[s.parent] ||= []).push({ kind: 'subscription', name: s.name, label: s.name, subscriptionId: s.subscriptionId });
    const build = (name) => (byParent[name] || [])
      .sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'group' ? -1 : 1))
      .map((n) => ({ kind: n.kind, label: n.label, children: n.kind === 'group' ? build(n.name) : [] }));
    const top = groups.find((g) => g.name === managementGroup);
    return {
      tree: { kind: 'group', label: top?.displayName || managementGroup, children: build(managementGroup) },
      subscriptionId: subs[0]?.subscriptionId || null, // internal only, never rendered
      subscriptionCount: subs.length,
    };
  }

  async function guardrails() {
    const [assignment, states] = await Promise.all([
      arm.graph(`policyresources
        | where type =~ 'microsoft.authorization/policyassignments' and name =~ '${ASSIGNMENT}'
        | project effect = tostring(properties.parameters.effect.value), enforcement = tostring(properties.enforcementMode)`, managementGroup),
      arm.graph(`policyresources
        | where type =~ 'microsoft.policyinsights/policystates'
        | where tostring(properties.policyAssignmentName) =~ '${ASSIGNMENT}'
        | summarize n = count(), last = max(todatetime(properties.timestamp)) by rule = tostring(properties.policyDefinitionReferenceId), state = tostring(properties.complianceState)`, managementGroup),
    ]);
    const counts = {};
    // How many evaluation records came back, and the newest one. Zero records is
    // not the same as zero breaches: it means Azure Policy has nothing to report
    // for this assignment yet, or this identity can't read the results. The
    // page says which, instead of drawing a table of zeros.
    let evaluated = 0;
    let lastEvaluated = null;
    for (const s of states) {
      evaluated += Number(s.n) || 0;
      const t = Date.parse(s.last);
      if (!Number.isNaN(t) && (lastEvaluated === null || t > lastEvaluated)) lastEvaluated = t;
    }
    for (const s of states) {
      const c = (counts[s.rule] ||= { compliant: 0, nonCompliant: 0 });
      if (/^noncompliant$/i.test(s.state)) c.nonCompliant += Number(s.n) || 0;
      else if (/^compliant$/i.test(s.state)) c.compliant += Number(s.n) || 0;
    }
    return {
      effect: assignment[0]?.effect || 'unknown',
      enforcement: assignment[0]?.enforcement || 'unknown',
      assigned: assignment.length > 0,
      evaluated,
      lastEvaluated: lastEvaluated === null ? null : new Date(lastEvaluated).toISOString(),
      rules: RULE_ORDER.map((id) => ({ id, label: RULES[id], ...(counts[id] || { compliant: 0, nonCompliant: 0 }) })),
    };
  }

  async function tagging() {
    const rows = await arm.graph(`resources
      | summarize total = count(), tagged = countif(isnotempty(tostring(tags['owner'])) and isnotempty(tostring(tags['environment']))) by resourceGroup
      | order by resourceGroup asc`, managementGroup);
    return rows.map((r) => ({ resourceGroup: r.resourceGroup, total: Number(r.total) || 0, tagged: Number(r.tagged) || 0 }));
  }

  async function budget(subscriptionId) {
    if (!subscriptionId) throw new Error('no subscription visible under the management group');
    const b = await arm.call('GET', `/subscriptions/${subscriptionId}/providers/Microsoft.Consumption/budgets/${budgetName}?api-version=2023-11-01`);
    const p = b.properties || {};
    return {
      amount: Number(p.amount) || 0,
      spent: Number(p.currentSpend?.amount) || 0,
      forecast: p.forecastSpend ? Number(p.forecastSpend.amount) || 0 : null,
      unit: p.currentSpend?.unit || '',
      grain: p.timeGrain || 'Monthly',
    };
  }

  async function load() {
    const h = await settle(hierarchy);
    const subscriptionId = h.ok ? h.value.subscriptionId : null;
    const [g, t, b] = await Promise.all([settle(guardrails), settle(tagging), settle(() => budget(subscriptionId))]);
    for (const [name, r] of [['hierarchy', h], ['guardrails', g], ['tagging', t], ['budget', b]]) {
      if (!r.ok) log.warn(`[landing-zone] ${name} unavailable: ${r.error.message}`);
    }
    return {
      loadedAt: new Date(now()).toISOString(),
      hierarchy: h.ok ? { tree: h.value.tree, subscriptionCount: h.value.subscriptionCount } : null,
      guardrails: g.ok ? g.value : null,
      tagging: t.ok ? t.value : null,
      budget: b.ok ? b.value : null,
      subscriptionId, // for the policy check; views never render it
    };
  }

  async function get() {
    if (cache && now() - cachedAt < ttlMs) return cache;
    if (inflight) return inflight;
    inflight = load()
      .then((v) => { cache = v; cachedAt = now(); return v; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  return { get };
}

module.exports = { createOverview, RULES, RULE_ORDER, ASSIGNMENT };
