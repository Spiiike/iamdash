'use strict';

/*
 * Turns the reconciler's raw output into the object the page renders.
 *
 * This replaces the standalone pseudonymiser the reconciler shipped with: the
 * labels come from dashboard/mask.js instead, so a person carries the same
 * `person-xxxxxx` label here as on the operations dashboard and can be followed
 * across both pages. One masking implementation, one key, one place to audit.
 *
 * The privacy rule is unchanged and worth restating, because it is the part
 * that is easy to lose: every published string is **re-derived** from structured
 * fields, never copied from the reconciler's own detail text. That text
 * legitimately quotes real values ("Okta holds 'Regulator' for title"), and a
 * copy-then-scrub approach fails the first time someone adds a rule and forgets
 * to scrub it. Re-deriving means a new rule publishes nothing until its public
 * wording is written on purpose.
 */

const DIRECTORY = { entra: 'Entra ID', google: 'Google', okta: 'Okta' };
const dir = (d) => DIRECTORY[d] || d || 'the directory';
const aDir = (d) => `${/^[aeiou]/i.test(dir(d)) ? 'an' : 'a'} ${dir(d)}`;
const upperFirst = (s) => s.replace(/^./, (c) => c.toUpperCase());

const PUBLIC_DETAIL = {
  accepted_exception: (f) =>
    `Directory-native ${dir(f.directory)} account, recorded as an accepted exception.`,
  provisioning_pending: (f) =>
    `Okta status is STAGED, so no ${dir(f.directory)} account is expected yet.`,
  missing_downstream: (f) =>
    `Assigned in Okta and expected to be enabled, but no ${dir(f.directory)} account exists.`,
  orphan: (f) =>
    upperFirst(`${aDir(f.directory)} account exists with no Okta identity and no recorded exception.`),
  unmanaged_in_scope: () =>
    'Account sits in the OU that carries the SSO profile but has no Okta identity, so it ' +
    'would be redirected to an identity provider that has never heard of it.',
  access_not_revoked: (f) =>
    `Okta expects this account to be disabled, but ${dir(f.directory)} still has it enabled.`,
  access_not_granted: (f) =>
    `Okta expects this account to be enabled, but ${dir(f.directory)} has it disabled.`,
  anchor_missing: () =>
    'Entra ID account has no immutable anchor, so a federated assertion has nothing to ' +
    'match on even though the account looks healthy in the portal.',
  ou_misplacement: () =>
    'Okta-managed account is outside the OU that the SSO profile is assigned to.',
  attribute_drift: (f) =>
    f.expected
      ? `Mapped attribute "${f.attribute}" differs between Okta and ${dir(f.directory)}.`
      : `Okta holds no "${f.attribute}", so the push should have cleared it in ` +
        `${dir(f.directory)}, but a value is still present.`,
  duplicate_candidate: (f) =>
    `${f.keys.length} ${dir(f.directory)} accounts share one person's name under different ` +
    "addresses, and at least one has no Okta identity — the shape of a failed soft match.",
};

const SAFE_ATTRIBUTE = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;
const SAFE_OU = /^\/[\w /-]{0,60}$/;
const SAFE_STATUS = /^[A-Z_]{1,32}$/;

function publicFinding(f, pseudonym) {
  const render = PUBLIC_DETAIL[f.rule];
  const out = {
    rule: f.rule,
    severity: f.severity,
    directory: f.directory || null,
    section: f.section || null,
    detail: render ? render(f) : `Finding: ${f.rule}.`,
  };
  if (f.rule === 'attribute_drift') {
    // The attribute *name* is published; its value never is.
    out.attribute = SAFE_ATTRIBUTE.test(String(f.attribute || '')) ? f.attribute : 'attribute';
  }
  if (f.rule === 'duplicate_candidate') out.people = f.keys.map(pseudonym);
  return out;
}

/**
 * @param {object} result                reconcile() output
 * @param {object} opts
 * @param {function} opts.pseudonym      from createMasker(secret).pseudonym
 * @param {string}  [opts.generatedAt]
 * @param {number}  [opts.durationMs]
 * @param {boolean} [opts.stale]
 */
const SAFE_SEVERITY = new Set(['critical', 'high', 'medium']);
const SAFE_DIRECTORY = new Set(['okta', 'entra', 'google']);
const isoOrNull = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : undefined);

/**
 * The reconciler's run and finding history (functions/src/lib/recon/history.js),
 * made publishable. Same rule as findings: every field is copied explicitly and
 * every sentence is re-derived from structured fields.
 */
function maskHistory(history, pseudonym) {
  if (!history || !Array.isArray(history.runs) || !Array.isArray(history.findings)) return null;
  const runs = history.runs.slice(0, 60).map((r) => {
    const out = { at: isoOrNull(r.at), outcome: r.outcome === 'complete' ? 'complete' : 'failed' };
    if (typeof r.durationMs === 'number' && r.durationMs >= 0) out.durationMs = r.durationMs;
    if (out.outcome === 'complete') out.actionable = count(r.actionable);
    else out.failedSources = (r.failedSources || []).filter((d) => SAFE_DIRECTORY.has(d));
    return out;
  }).filter((r) => r.at);

  const findings = history.findings.slice(0, 200).map((f) => {
    const rule = Object.prototype.hasOwnProperty.call(PUBLIC_DETAIL, f.rule) ? f.rule : null;
    if (!rule) return null; // a rule with no public wording publishes nothing
    const directory = SAFE_DIRECTORY.has(f.directory) ? f.directory : null;
    const attribute = SAFE_ATTRIBUTE.test(String(f.attribute || '')) ? f.attribute : (rule === 'attribute_drift' ? 'attribute' : null);
    const keys = Array.isArray(f.keys) ? f.keys : null;
    return {
      people: f.key ? [pseudonym(f.key)] : (keys ? keys.map(pseudonym) : []),
      rule,
      severity: SAFE_SEVERITY.has(f.severity) ? f.severity : 'medium',
      directory,
      detail: PUBLIC_DETAIL[rule]({ directory, attribute, expected: true, keys: keys || [] }),
      firstSeen: isoOrNull(f.firstSeen),
      lastSeen: isoOrNull(f.lastSeen),
      resolvedAt: isoOrNull(f.resolvedAt),
      seenRuns: count(f.seenRuns),
    };
  }).filter((f) => f && f.firstSeen);

  return { runs, findings };
}

function maskSnapshot(result, { pseudonym, generatedAt, durationMs, stale = false } = {}) {
  if (typeof pseudonym !== 'function') {
    throw new Error('maskSnapshot needs a pseudonym function from dashboard/mask.js');
  }

  const users = result.users.map((u) => ({
    id: pseudonym(u.key),
    okta: u.okta
      ? {
          status: SAFE_STATUS.test(String(u.okta.status)) ? u.okta.status : 'UNKNOWN',
          expected: u.okta.expected,
        }
      : null,
    entra: u.entra
      ? { present: true, enabled: !!u.entra.enabled, anchored: !!u.entra.anchored }
      : { present: false },
    google: u.google
      ? {
          present: true,
          enabled: !!u.google.enabled,
          // Structural, not personal, and two rules are unreadable without it.
          orgUnitPath: SAFE_OU.test(String(u.google.orgUnitPath || '')) ? u.google.orgUnitPath : '',
        }
      : { present: false },
    worst: u.worst,
    agrees: u.agrees,
    findings: u.findings.map((f) => publicFinding(f, pseudonym)),
  }));

  return {
    schema: 2,
    generatedAt: generatedAt || new Date().toISOString(),
    durationMs,
    stale,
    summary: result.summary,
    users: users.sort((a, b) => {
      if (a.agrees !== b.agrees) return a.agrees ? 1 : -1;
      return a.id.localeCompare(b.id);
    }),
    crossFindings: result.findings.filter((f) => !f.key).map((f) => publicFinding(f, pseudonym)),
    history: maskHistory(result.history, pseudonym),
  };
}

module.exports = { maskSnapshot, maskHistory, PUBLIC_DETAIL };
