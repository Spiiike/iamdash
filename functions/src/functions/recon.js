'use strict';
/*
 * Three-way reconciliation: Okta (source of truth) against Entra ID and Google
 * Cloud Identity.
 *
 *   timer reconcileTimer         06:17 and 18:17 UTC; writes recon/latest.json
 *                                and records the attempt in recon/run-history.json
 *   GET   /api/recon/snapshot    the latest unmasked result, with `history`
 *                                (every attempt, and each finding's lifetime)
 *                                                               (operator key)
 *   POST  /api/recon/run         run now, e.g. right after deploy (operator key)
 *
 * The result holds real logins and attribute values, so both routes sit behind
 * the same operator key as the lifecycle API. Nothing here is public: wetcliff
 * fetches the result server-side and masks it before anyone sees it.
 *
 * Nothing here can write to a directory. Every read uses an identity that can
 * only read: the Function App's managed identity with Graph User.Read.All, a
 * Google service account with a read-only admin role, and the Okta token.
 */
const { app } = require('@azure/functions');
const { authorized } = require('./lifecycle');
const { runReconciliation } = require('../lib/recon/run');
const store = require('../lib/recon/store');
const { advance } = require('../lib/recon/history');

const reply = (status, jsonBody) => ({ status, jsonBody, headers: { 'Cache-Control': 'no-store' } });

const summaryLine = (r) =>
  `verdict=${r.summary.verdict} people=${r.summary.people} agreeing=${r.summary.agreeing} ` +
  `actionable=${r.summary.actionable} worst=${r.summary.worst} durationMs=${r.durationMs}`;

let running = null; // one run at a time per instance, however it was started
let lastManualRun = 0;
const MANUAL_COOLDOWN_MS = 60 * 1000;

// Best effort: history is a record of runs, not part of publishing one. If it
// can't be written, the run still counts and latest.json is still correct.
async function recordRun(run, log) {
  try {
    const prev = await store.loadHistory();
    await store.saveHistory(advance(prev, run));
  } catch (err) {
    log(`history not updated: ${err.message}`);
  }
}

async function runAndSave(log, { now = () => new Date() } = {}) {
  if (running) return running;
  running = (async () => {
    let result;
    try {
      result = await runReconciliation({ log });
    } catch (err) {
      // Nothing is published from a failed read (run.js), but the attempt is
      // recorded, so "clean" can never quietly mean "we stopped looking".
      await recordRun({ at: now().toISOString(), outcome: 'failed', failures: err.failures }, log);
      throw err;
    }
    await store.save(result);
    await recordRun({ at: result.generatedAt, outcome: 'complete', durationMs: result.durationMs, result }, log);
    log(summaryLine(result));
    return result;
  })().finally(() => {
    running = null;
  });
  return running;
}

async function timer(_timer, context) {
  try {
    await runAndSave((m) => context.log(`[recon] ${m}`));
  } catch (err) {
    // Throwing marks the run failed in Application Insights. latest.json is
    // untouched, so the site keeps showing the previous result as stale.
    context.error(`[recon] aborted: ${err.message}`);
    throw err;
  }
}

async function snapshot(request) {
  if (!authorized(request)) return reply(401, { error: 'Missing or invalid operator key' });
  const latest = await store.latest();
  if (!latest) return reply(404, { error: 'No reconciliation has completed yet' });
  let history = null;
  try {
    history = await store.loadHistory();
  } catch {
    // The snapshot is still worth serving without its history.
  }
  return reply(200, history ? { ...latest, history } : latest);
}

async function runNow(request, context) {
  if (!authorized(request)) return reply(401, { error: 'Missing or invalid operator key' });
  if (Date.now() - lastManualRun < MANUAL_COOLDOWN_MS && !running) {
    return reply(429, { error: 'A run finished less than a minute ago. Read /api/recon/snapshot instead.' });
  }
  lastManualRun = Date.now();
  try {
    const result = await runAndSave((m) => context.log(`[recon] ${m}`));
    return reply(200, { generatedAt: result.generatedAt, durationMs: result.durationMs, summary: result.summary });
  } catch (err) {
    context.error(`[recon] manual run aborted: ${err.message}`);
    // The message names which directory failed and why. It carries no user data.
    return reply(502, { error: err.message });
  }
}

app.timer('reconcileTimer', {
  // Deliberately not on the hour: these reads are rate-limited per org, and
  // everything else in the world runs at :00.
  schedule: process.env.RECON_SCHEDULE || '0 17 6,18 * * *',
  runOnStartup: false,
  handler: timer,
});
app.http('reconSnapshot', { authLevel: 'anonymous', methods: ['GET'], route: 'recon/snapshot', handler: snapshot });
app.http('reconRun', { authLevel: 'anonymous', methods: ['POST'], route: 'recon/run', handler: runNow });

module.exports = { timer, snapshot, runNow, runAndSave };
