'use strict';

const { expectedDownstreamState, norm, joinKey } = require('./model');

/**
 * Three-way reconciliation across Okta (source of truth), Entra ID and Google
 * Cloud Identity.
 *
 * This file is pure: directory records in, findings out. No network, no clock,
 * no credentials. That is deliberate — every rule below is a claim the runbook
 * makes about how these connectors behave, and a pure function is the only way
 * to hold those claims still long enough to test them.
 *
 * Each rule carries the runbook section it comes from, so a finding on the
 * dashboard can be traced to the measurement that justifies the check.
 */

// `none` must be present and worst, or the reducers below compare against
// undefined and silently never advance past their seed.
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, info: 3, none: 99 };

/** Okta attribute -> downstream attribute, per connector, per the mapped list. */
const ATTRIBUTE_MAP = {
  entra: { firstName: 'givenName', lastName: 'surname', title: 'jobTitle', department: 'department' },
  google: { firstName: 'givenName', lastName: 'familyName', title: 'title', department: 'department' },
};

const DEFAULT_CONFIG = {
  /** Google OU that Okta-provisioned users are pushed into. */
  managedGoogleOu: '/Okta Users',
  /**
   * Accounts that are *supposed* to exist downstream with no Okta identity:
   * break-glass, the provisioning connector's own service admin, and any
   * directory-native administrator. A reconciler that flags these is noise, and
   * noise is how real drift gets ignored.
   */
  expectedExceptions: [],
  /** Attributes to compare. Narrow this to what the connector actually maps. */
  compare: {
    entra: ['firstName', 'lastName', 'title', 'department'],
    // employeeNumber is deliberately absent: the Google connector does not
    // expose externalIds, so there is nothing to compare against. See §10.
    google: ['firstName', 'lastName', 'title', 'department'],
  },
};

function indexBy(records, keyName = 'key') {
  const map = new Map();
  for (const record of records || []) {
    const k = joinKey(record[keyName]);
    if (!k) continue;
    if (!map.has(k)) map.set(k, record);
  }
  return map;
}

function exceptionFor(config, directory, key) {
  return (config.expectedExceptions || []).find(
    (e) => e.directory === directory && joinKey(e.key) === joinKey(key)
  );
}

/**
 * Detect two downstream accounts that are probably the same human under
 * different addresses — the duplicate that a one-character username mismatch
 * produces when soft match fails. Conservative on purpose: it only fires when
 * the names match exactly and at least one of the two has no Okta identity.
 * See §2.
 */
function duplicateCandidates(records, oktaIndex, directory, cfg) {
  const byName = new Map();
  for (const record of records) {
    // Break-glass and connector identities are directory-native by design. They
    // have no Okta counterpart and never will, so including them here would
    // report every one of them as half of a duplicate pair.
    if (exceptionFor(cfg, directory, record.key)) continue;
    const first = norm(record.givenName).toLowerCase();
    const last = norm(record.surname || record.familyName).toLowerCase();
    if (!first || !last) continue;
    const nameKey = `${last}|${first}`;
    if (!byName.has(nameKey)) byName.set(nameKey, []);
    byName.get(nameKey).push(record);
  }

  const findings = [];
  for (const [nameKey, group] of byName) {
    const keys = [...new Set(group.map((r) => joinKey(r.key)))];
    if (keys.length < 2) continue;
    const anyUnmatched = keys.some((k) => !oktaIndex.has(k));
    if (!anyUnmatched) continue;
    findings.push({
      rule: 'duplicate_candidate',
      severity: 'high',
      directory,
      keys,
      nameKey,
      section: '§2',
      detail:
        `${keys.length} ${directory} accounts share the same first and last name under ` +
        `different addresses. One of them has no Okta identity, which is what a failed ` +
        `soft match looks like: the join key differed, so Okta created a second account ` +
        `instead of linking the existing one.`,
    });
  }
  return findings;
}

/**
 * @param {object} input
 * @param {Array} input.okta    canonical Okta records
 * @param {Array} input.entra   canonical Entra records
 * @param {Array} input.google  canonical Google records
 * @param {object} [input.config]
 */
function reconcile({ okta = [], entra = [], google = [], config = {} } = {}) {
  const cfg = {
    ...DEFAULT_CONFIG,
    ...config,
    compare: { ...DEFAULT_CONFIG.compare, ...(config.compare || {}) },
  };

  const oktaIndex = indexBy(okta);
  const entraIndex = indexBy(entra);
  const googleIndex = indexBy(google);

  const allKeys = new Set([...oktaIndex.keys(), ...entraIndex.keys(), ...googleIndex.keys()]);
  const findings = [];
  const users = [];

  for (const key of [...allKeys].sort()) {
    const o = oktaIndex.get(key) || null;
    const e = entraIndex.get(key) || null;
    const g = googleIndex.get(key) || null;

    const expected = o ? expectedDownstreamState(o.status) : null;
    const userFindings = [];

    const add = (f) => {
      const finding = { ...f, key };
      userFindings.push(finding);
      findings.push(finding);
    };

    // ---- Accounts with no Okta identity -------------------------------------
    if (!o) {
      for (const [directory, record] of [['entra', e], ['google', g]]) {
        if (!record) continue;
        const accepted = exceptionFor(cfg, directory, key);
        if (accepted) {
          add({
            rule: 'accepted_exception',
            severity: 'info',
            directory,
            section: '§6',
            detail: `Directory-native account, accepted: ${accepted.reason}.`,
          });
          continue;
        }

        // A Google account sitting inside the OU that carries the SSO profile,
        // with no Okta identity behind it, is the §8 failure mode: assigning the
        // profile redirects it to an IdP that has never heard of it.
        if (directory === 'google' && norm(record.orgUnitPath) === norm(cfg.managedGoogleOu)) {
          add({
            rule: 'unmanaged_in_scope',
            severity: 'critical',
            directory,
            section: '§8',
            detail:
              `Account is in ${cfg.managedGoogleOu}, which carries the Okta SSO profile, ` +
              `but has no Okta identity. It cannot authenticate through the IdP it is ` +
              `about to be redirected to.`,
          });
          continue;
        }

        add({
          rule: 'orphan',
          severity: 'high',
          directory,
          section: '§9',
          detail:
            `${directory} account exists with no Okta identity and no recorded exception. ` +
            `Either it predates the integration or its access was never revoked.`,
        });
      }
    }

    // ---- Okta identity present ----------------------------------------------
    if (o) {
      for (const [directory, record, assigned] of [
        ['entra', e, o.assignedEntra !== false],
        ['google', g, o.assignedGoogle !== false],
      ]) {
        // Presence
        if (!record) {
          if (expected === 'pending') {
            add({
              rule: 'provisioning_pending',
              severity: 'info',
              directory,
              section: '§5',
              detail: `Okta status is STAGED, so no ${directory} account is expected yet.`,
            });
          } else if (assigned && expected === 'enabled') {
            add({
              rule: 'missing_downstream',
              severity: 'high',
              directory,
              section: '§5',
              detail:
                `Assigned in Okta and expected enabled, but no ${directory} account exists. ` +
                `Provisioning either failed or was never run for this user.`,
            });
          }
          continue;
        }

        // State agreement
        const actual = record.enabled ? 'enabled' : 'disabled';
        if (expected === 'disabled' && actual === 'enabled') {
          add({
            rule: 'access_not_revoked',
            severity: 'critical',
            directory,
            section: '§9',
            detail:
              `Okta status ${o.status} should have disabled this account, but it is still ` +
              `enabled in ${directory}. This is the failure mode offboarding exists to prevent.`,
          });
        } else if (expected === 'enabled' && actual === 'disabled') {
          add({
            rule: 'access_not_granted',
            severity: 'high',
            directory,
            section: '§9',
            detail: `Okta status ${o.status} expects an enabled account, but ${directory} has it disabled.`,
          });
        }

        // Entra's federation anchor. Without it, a federated assertion has
        // nothing to match on, even though every console view looks healthy.
        if (directory === 'entra' && !norm(record.immutableId)) {
          add({
            rule: 'anchor_missing',
            severity: 'high',
            directory,
            section: '§2',
            detail:
              `Entra account has no onPremisesImmutableId. Federation matches on that anchor, ` +
              `so this account cannot be signed into through Okta regardless of how healthy ` +
              `it looks in the portal.`,
          });
        }

        // Google OU placement, which is what scopes the SSO profile.
        if (directory === 'google' && norm(record.orgUnitPath) !== norm(cfg.managedGoogleOu)) {
          add({
            rule: 'ou_misplacement',
            severity: 'medium',
            directory,
            section: '§4',
            detail:
              `Okta-managed account is in ${record.orgUnitPath || '(root)'} rather than ` +
              `${cfg.managedGoogleOu}, so the SSO profile assigned to that OU does not cover it.`,
          });
        }

        // Mapped attributes. Okta owns every one of these, including the ones
        // where it holds no value — an empty Okta attribute should have cleared
        // the downstream value, not left it in place. See §4.
        for (const oktaAttr of cfg.compare[directory] || []) {
          const targetAttr = ATTRIBUTE_MAP[directory][oktaAttr];
          if (!targetAttr) continue;
          const want = norm(o[oktaAttr]);
          const got = norm(record[targetAttr]);
          if (want === got) continue;
          add({
            rule: 'attribute_drift',
            severity: 'medium',
            directory,
            section: '§4',
            attribute: oktaAttr,
            expected: want,
            actual: got,
            detail: want
              ? `Okta holds "${want}" for ${oktaAttr}; ${directory} has "${got || '(empty)'}".`
              : `Okta holds no ${oktaAttr}, so the push should have cleared it, but ` +
                `${directory} still has "${got}".`,
          });
        }
      }
    }

    const worst = userFindings.reduce(
      (acc, f) => (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[acc] ? f.severity : acc),
      'none'
    );

    users.push({
      key,
      okta: o ? { status: o.status, expected, id: o.id } : null,
      entra: e ? { enabled: !!e.enabled, id: e.id, anchored: !!norm(e.immutableId) } : null,
      google: g ? { enabled: !!g.enabled, id: g.id, orgUnitPath: g.orgUnitPath || '' } : null,
      findings: userFindings,
      worst,
      agrees: userFindings.every((f) => f.severity === 'info'),
    });
  }

  // Cross-record rules, which cannot be decided one key at a time.
  findings.push(...duplicateCandidates(entra, oktaIndex, 'entra', cfg));
  findings.push(...duplicateCandidates(google, oktaIndex, 'google', cfg));

  const counts = findings.reduce((acc, f) => {
    acc[f.rule] = (acc[f.rule] || 0) + 1;
    acc[`severity:${f.severity}`] = (acc[`severity:${f.severity}`] || 0) + 1;
    return acc;
  }, {});

  const actionable = findings.filter((f) => f.severity !== 'info');

  return {
    users,
    findings,
    summary: {
      directories: { okta: oktaIndex.size, entra: entraIndex.size, google: googleIndex.size },
      people: users.length,
      agreeing: users.filter((u) => u.agrees).length,
      actionable: actionable.length,
      accepted: findings.filter((f) => f.rule === 'accepted_exception').length,
      counts,
      verdict: actionable.length === 0 ? 'clean' : 'drift',
      worst: actionable.reduce(
        (acc, f) => (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[acc] ? f.severity : acc),
        'none'
      ),
    },
  };
}

module.exports = { reconcile, ATTRIBUTE_MAP, DEFAULT_CONFIG, SEVERITY_ORDER };
