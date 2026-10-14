'use strict';
const { KINDS, REGIONS, TLS } = require('./check');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const unavailable = (what) => `<p class="muted">The ${esc(what)} isn't available right now. It's read live from Azure; try again in a few minutes.</p>`;

// Drawn as a directory listing, like the home page: "|-- " and "`-- " stems.
function treeLines(node, prefix = '', last = true, root = true) {
  const label = esc(node.label);
  const text = node.kind === 'subscription' ? `${label}  <span class="sub">subscription</span>` : label;
  const line = root ? text : `${prefix}${last ? '`-- ' : '|-- '}${text}`;
  const next = root ? '' : prefix + (last ? '    ' : '|   ');
  const kids = node.children || [];
  return [line, ...kids.flatMap((c, i) => treeLines(c, next, i === kids.length - 1, false))];
}

function hierarchySection(h) {
  if (!h) return unavailable('management group tree');
  return `<pre class="tree" aria-label="Management groups and subscriptions, nested">${treeLines(h.tree).join('\n')}</pre>
<p class="muted">Every subscription under Glasscliff inherits the policies below. The identity lab's subscription sits under Landing Zones / Online.</p>`;
}

function policiesection(g) {
  if (!g) return unavailable('policy status');
  const mode = /deny/i.test(g.effect) ? 'Deny: new resources that break a rule are refused' : `${esc(g.effect)}: breaches are reported, not blocked`;
  const modeLine = g.assigned === false
    ? '<p class="bad">The glasscliff-baseline assignment was not found, so nothing is being enforced or evaluated.</p>'
    : `<p>Mode: <strong>${mode}</strong>.</p>`;
  // Zero evaluation records is "no data", not "no breaches". Drawing a table of
  // zeros would claim a clean bill of health nobody measured.
  if (!g.evaluated) {
    const rules = g.rules.map((r) => `<li>${esc(r.label)}</li>`).join('');
    return `${modeLine}
<ul class="prose">${rules}</ul>
<p class="stale">No compliance results came back for this assignment, so there are no counts to show. That means Azure Policy hasn't finished evaluating the existing resources, or this page's read-only identity can't see the results. It does not mean every resource passes. The rules above are still enforced on new deployments. You can test that below.</p>`;
  }
  const rows = g.rules.map((r) => `<tr><td>${esc(r.label)}</td><td class="n">${r.compliant}</td><td class="n ${r.nonCompliant ? 'bad' : ''}">${r.nonCompliant}</td></tr>`).join('');
  const when = g.lastEvaluated ? ` Latest evaluation ${esc(new Date(g.lastEvaluated).toUTCString())}.` : '';
  return `${modeLine}
<table class="table"><thead><tr><th>Rule</th><th class="n">Compliant</th><th class="n">Non-compliant</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted">Counts come from Azure Policy's latest evaluation of every existing resource (${g.evaluated} results).${when} Non-compliant resources that already existed are reported, not removed: Deny only stops new ones.</p>`;
}

function taggingSection(t) {
  if (!t) return unavailable('tag coverage');
  if (!t.length) return '<p class="muted">No resources found.</p>';
  const rows = t.map((r) => `<tr><td>${esc(r.resourceGroup)}</td><td class="n">${r.tagged} of ${r.total}</td></tr>`).join('');
  return `<table class="table"><thead><tr><th>Resource group</th><th class="n">Fully tagged</th></tr></thead><tbody>${rows}</tbody></table>
<p class="muted">Fully tagged means both an owner and an environment tag.</p>`;
}

function budgetSection(b) {
  if (!b) return unavailable('budget');
  const money = (n) => `${b.unit === 'USD' || !b.unit ? '$' : ''}${n.toFixed(2)}${b.unit && b.unit !== 'USD' ? ` ${esc(b.unit)}` : ''}`;
  const pct = b.amount ? Math.round((b.spent / b.amount) * 100) : 0;
  return `<p>${money(b.spent)} spent of a ${money(b.amount)} ${esc(b.grain.toLowerCase())} budget (${pct}%)${b.forecast !== null ? `, forecast ${money(b.forecast)}` : ''}.</p>
<p class="muted">Alerts go out at 50% and 80% of actual spend, and at 100% of forecast.</p>`;
}

function tryForm(choice, basePath) {
  const opt = (map, sel) => Object.entries(map).map(([v, l]) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const box = (name, label, checked) => `<label><input type="checkbox" name="${name}" value="on"${checked ? ' checked' : ''}> ${esc(label)}</label>`;
  return `<form class="try" method="post" action="${esc(basePath)}/check#try">
<fieldset><legend>Resource</legend><select name="kind">${opt(KINDS, choice.kind)}</select></fieldset>
<fieldset><legend>Region</legend><select name="region">${opt(REGIONS, choice.region)}</select></fieldset>
<fieldset><legend>Tags</legend>${box('owner', 'owner', choice.owner)}${box('environment', 'environment', choice.environment)}</fieldset>
<fieldset><legend>Storage settings (storage accounts only)</legend>${box('https', 'HTTPS only', choice.https)} <label>Minimum TLS <select name="tls">${opt(TLS, choice.tls)}</select></label></fieldset>
<button type="submit">Ask Azure Policy</button>
</form>`;
}

function verdict(result) {
  if (!result) return '';
  if (result.error) return `<div class="answer"><p>${esc(result.error)}</p></div>`;
  const what = `${KINDS[result.choice.kind].toLowerCase()} in ${REGIONS[result.choice.region]}`;
  if (!result.findings.length) {
    return `<div class="answer allowed"><p class="ok">Azure would allow this.</p><p>A ${esc(what)} with these settings passes every Glasscliff policy.</p></div>`;
  }
  const items = result.findings.map((f) => `<li>${esc(f.label)} <span class="muted">(${esc(f.effect)})</span></li>`).join('');
  return `<div class="answer ${result.denied ? 'denied' : ''}"><p class="${result.denied ? 'bad' : ''}">${result.denied ? 'Azure would refuse this.' : 'Azure would allow this, but report it.'}</p>
<p>Deploying a ${esc(what)} with these settings breaks:</p><ul>${items}</ul></div>`;
}

function landingZonePage({ overview, basePath, choice, result }) {
  return `<section class="hero">
<h1>Azure landing zone</h1>
<p>Before anything runs in Azure, there's a platform underneath it: where subscriptions sit, what they're allowed to do, where their logs go and what they're allowed to cost. This is a miniature version of that, governing the identity lab next door.</p>
<p class="byline"><a href="${esc(basePath)}/about">About this landing zone</a> · <a href="https://github.com/Spiiike/iamdash/tree/main/glasscliff-landing-zone">Bicep source</a></p>
</section>

<section class="section">
<h2>The hierarchy</h2>
${hierarchySection(overview.hierarchy)}
</section>

<section class="section">
<h2>Policies</h2>
${policiesection(overview.guardrails)}
</section>

<section class="section">
<h2 id="try">Try to break the rules</h2>
<p>Describe a resource and Azure Policy will say whether it could be deployed here. Nothing is created. Azure checks the proposal against the real policies and answers.</p>
${tryForm(choice, basePath)}
${verdict(result)}
</section>

<section class="section">
<h2>Tag coverage</h2>
${taggingSection(overview.tagging)}
</section>

<section class="section">
<h2>Spend</h2>
${budgetSection(overview.budget)}
<p class="muted">Read live from Azure with a read-only identity. Last read ${esc(new Date(overview.loadedAt).toUTCString())}.</p>
</section>`;
}

module.exports = { landingZonePage, esc };
