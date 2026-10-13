'use strict';

/*
 * Settings for the reconciliation page.
 *
 * Almost nothing new: the site already holds what it needs, because main.bicep
 * merges the lab's LAB_* settings into wetcliff for the dashboard.
 *
 *   endpoint   LAB_API_BASE_URL + /api/recon/snapshot  (override: RECON_SNAPSHOT_ENDPOINT)
 *   key        LAB_OPERATOR_KEY                        (override: RECON_OPERATOR_KEY)
 *   header     LAB_OPERATOR_HEADER                     (override: RECON_OPERATOR_HEADER)
 *   masking    LAB_OPERATOR_KEY — the same secret the dashboard masks with, so one
 *              person carries the same person-xxxxxx label on both pages
 *
 * The one new setting is RECON_ENABLED=true, set once the reconciler has
 * completed its first run. Until then the site says "not deployed yet" rather
 * than promising a schedule that isn't running.
 */

const DEFAULTS = {
  snapshotEndpoint: '',
  operatorHeader: 'x-lab-operator-key',
  operatorKey: '',
  maskSecret: '',
  timeoutMs: 6000,
  ttlMs: 2 * 60 * 1000, // the reconciler runs twice a day; two minutes is plenty
};

const usable = (v) => Boolean(v) && !String(v).startsWith('@Microsoft.KeyVault') && !String(v).startsWith('SET-ME-');

function createConfig(env = process.env) {
  if ((env.RECON_ENABLED || '').toLowerCase() !== 'true') {
    throw new Error('recon: RECON_ENABLED is not true (set it once the reconciler has completed a run)');
  }
  const base = (env.LAB_API_BASE_URL || '').replace(/\/+$/, '');
  const cfg = {
    ...DEFAULTS,
    snapshotEndpoint: env.RECON_SNAPSHOT_ENDPOINT || (base ? `${base}/api/recon/snapshot` : ''),
    operatorHeader: (env.RECON_OPERATOR_HEADER || env.LAB_OPERATOR_HEADER || DEFAULTS.operatorHeader).toLowerCase(),
    operatorKey: env.RECON_OPERATOR_KEY || env.LAB_OPERATOR_KEY || '',
    // Same secret dashboard/index.js hands to createMasker(), on purpose.
    maskSecret: env.RECON_MASK_SECRET || env.LAB_OPERATOR_KEY || '',
    timeoutMs: Number(env.RECON_TIMEOUT_MS) || DEFAULTS.timeoutMs,
    ttlMs: Number(env.RECON_TTL_MS) || DEFAULTS.ttlMs,
  };

  const missing = [];
  if (!cfg.snapshotEndpoint) missing.push('LAB_API_BASE_URL (or RECON_SNAPSHOT_ENDPOINT)');
  if (!usable(cfg.operatorKey)) missing.push('LAB_OPERATOR_KEY (or RECON_OPERATOR_KEY), resolved');
  if (!usable(cfg.maskSecret)) missing.push('LAB_OPERATOR_KEY (or RECON_MASK_SECRET), resolved');
  if (missing.length) {
    throw new Error(`recon: missing required settings: ${missing.join(', ')}`);
  }
  if (!/^https:\/\//.test(cfg.snapshotEndpoint)) {
    throw new Error('recon: the snapshot endpoint must be https');
  }
  return cfg;
}

module.exports = { createConfig, DEFAULTS };
