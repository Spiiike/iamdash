'use strict';

/*
 * One reconciliation: read all three directories, compare, return the raw result.
 *
 * The one rule that matters here: **a partial read is never returned.** If the
 * Google token exchange fails and we compared anyway, every Okta user would look
 * like they were missing a Google account and the public page would report a
 * catastrophe that did not happen. A reconciler's failure mode isn't "misses
 * drift", it's "invents drift". So all three reads succeed or the run throws and
 * the previous result stays in place with its own timestamp.
 *
 * The result is *unmasked* — it holds real logins and attribute values — so it
 * is only ever served behind the operator key (src/functions/recon.js). The site
 * masks it with dashboard/mask.js, the same pseudonyms the dashboard uses.
 */

const { reconConfig } = require('./config');
const { fetchOkta } = require('./sources/okta');
const { fetchEntra } = require('./sources/entra');
const { fetchGoogle } = require('./sources/google');
const { reconcile } = require('./reconcile');

const SCHEMA = 1;

async function runReconciliation({ env = process.env, now = () => new Date(), log = () => {}, fetchImpl = fetch } = {}) {
  const cfg = reconConfig(env);
  const startedAt = now();

  const results = await Promise.allSettled([
    fetchOkta({ ...cfg.okta, fetchImpl }),
    fetchEntra({ env, fetchImpl }),
    fetchGoogle({ ...cfg.google, fetchImpl }),
  ]);

  const names = ['okta', 'entra', 'google'];
  const failures = results
    .map((r, i) => (r.status === 'rejected' ? `${names[i]}: ${r.reason?.message || r.reason}` : null))
    .filter(Boolean);
  if (failures.length) {
    const error = new Error(`directory read failed, nothing published — ${failures.join('; ')}`);
    error.failures = failures;
    throw error;
  }

  const [okta, entra, google] = results.map((r) => r.value);
  log(`read okta=${okta.length} entra=${entra.length} google=${google.length}`);

  const result = reconcile({ okta, entra, google, config: cfg.reconcile });
  const finishedAt = now();
  return {
    schema: SCHEMA,
    generatedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ...result,
  };
}

module.exports = { runReconciliation, SCHEMA };
