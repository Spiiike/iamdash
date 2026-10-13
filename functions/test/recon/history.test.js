'use strict';
// node --test test/recon/history.test.js — run and finding history (pure), and
// how src/functions/recon.js records successful and failed runs.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { advance, findingId, failedSources } = require('../../src/lib/recon/history');

const T = (h) => new Date(Date.UTC(2026, 9, 1, h)).toISOString(); // hours after 1 Oct 2026 00:00
const drift = (key, extra = {}) => ({ key, rule: 'attribute_drift', severity: 'medium', directory: 'entra', attribute: 'title', ...extra });
const result = (findings, people = 5) => ({ findings, summary: { people } });

test('a complete run opens findings; info-level findings are not tracked', () => {
  const h = advance(null, {
    at: T(6), outcome: 'complete', durationMs: 600,
    result: result([drift('a@x.test'), { key: 'bg@x.test', rule: 'accepted_exception', severity: 'info', directory: 'google' }]),
  });
  assert.equal(h.runs.length, 1);
  assert.deepEqual(h.runs[0], { at: T(6), outcome: 'complete', durationMs: 600, actionable: 1, people: 5 });
  assert.equal(h.findings.length, 1);
  assert.equal(h.findings[0].firstSeen, T(6));
  assert.equal(h.findings[0].resolvedAt, null);
});

test('a finding seen again keeps its first-seen time and counts runs', () => {
  let h = advance(null, { at: T(6), outcome: 'complete', result: result([drift('a@x.test')]) });
  h = advance(h, { at: T(18), outcome: 'complete', result: result([drift('a@x.test', { severity: 'high' })]) });
  const f = h.findings[0];
  assert.equal(f.firstSeen, T(6));
  assert.equal(f.lastSeen, T(18));
  assert.equal(f.seenRuns, 2);
  assert.equal(f.severity, 'high', 'severity follows the latest run');
});

test('a complete run without the finding resolves it', () => {
  let h = advance(null, { at: T(6), outcome: 'complete', result: result([drift('a@x.test')]) });
  h = advance(h, { at: T(18), outcome: 'complete', result: result([]) });
  assert.equal(h.findings[0].resolvedAt, T(18));
  assert.equal(h.runs[0].actionable, 0);
});

test('a failed run never resolves anything, and records which directory failed', () => {
  let h = advance(null, { at: T(6), outcome: 'complete', result: result([drift('a@x.test')]) });
  h = advance(h, { at: T(18), outcome: 'failed', failures: ['google: token exchange failed (HTTP 400)', 'not-a-source: x'] });
  assert.equal(h.findings[0].resolvedAt, null, 'still open: nothing was read');
  assert.equal(h.findings[0].lastSeen, T(6), 'not seen by a run that read nothing');
  assert.deepEqual(h.runs[0], { at: T(18), outcome: 'failed', failedSources: ['google'] });
  assert.equal(h.runs.length, 2, 'newest first');
});

test('a finding that comes back after resolving starts a new episode', () => {
  let h = advance(null, { at: T(6), outcome: 'complete', result: result([drift('a@x.test')]) });
  h = advance(h, { at: T(18), outcome: 'complete', result: result([]) });
  h = advance(h, { at: T(30), outcome: 'complete', result: result([drift('a@x.test')]) });
  assert.equal(h.findings.length, 1);
  assert.equal(h.findings[0].firstSeen, T(30));
  assert.equal(h.findings[0].resolvedAt, null);
});

test('resolved findings are kept for 30 days; runs are capped', () => {
  let h = advance(null, { at: T(0), outcome: 'complete', result: result([drift('a@x.test')]) });
  h = advance(h, { at: T(1), outcome: 'complete', result: result([]) });
  h = advance(h, { at: T(1 + 24 * 31), outcome: 'complete', result: result([]) });
  assert.equal(h.findings.length, 0);
  for (let i = 0; i < 80; i++) h = advance(h, { at: T(800 + i), outcome: 'failed', failures: [] });
  assert.equal(h.runs.length, 60);
});

test('cross-account findings are tracked by the set of people, in any order', () => {
  const dup = (keys) => ({ rule: 'duplicate_candidate', severity: 'high', directory: 'entra', keys });
  assert.equal(findingId(dup(['b@x', 'a@x'])), findingId(dup(['a@x', 'b@x'])));
  let h = advance(null, { at: T(6), outcome: 'complete', result: result([dup(['b@x', 'a@x'])]) });
  h = advance(h, { at: T(18), outcome: 'complete', result: result([dup(['a@x', 'b@x'])]) });
  assert.equal(h.findings.length, 1);
  assert.equal(h.findings[0].seenRuns, 2);
});

test('failedSources keeps only the three directory names', () => {
  assert.deepEqual(failedSources(['okta: 401', 'entra: x', 'okta: again', 'evil<script>: y']), ['okta', 'entra']);
  assert.deepEqual(failedSources(undefined), []);
});

// ---- src/functions/recon.js: the attempt is recorded either way -------------
function loadReconWith({ runImpl }) {
  const saved = { latest: null, history: null };
  const store = {
    save: async (r) => { saved.latest = r; },
    latest: async () => saved.latest,
    loadHistory: async () => saved.history,
    saveHistory: async (h) => { saved.history = h; },
  };
  const lib = path.join(__dirname, '../../src/lib/recon');
  const fn = path.join(__dirname, '../../src/functions/recon.js');
  require.cache[require.resolve(path.join(lib, 'store.js'))] = { exports: store, loaded: true, id: 'store' };
  require.cache[require.resolve(path.join(lib, 'run.js'))] = { exports: { runReconciliation: runImpl }, loaded: true, id: 'run' };
  delete require.cache[require.resolve(fn)];
  return { recon: require(fn), saved };
}

test('runAndSave records a failed attempt and still throws', async () => {
  const { recon, saved } = loadReconWith({
    runImpl: async () => { throw Object.assign(new Error('directory read failed'), { failures: ['entra: 403'] }); },
  });
  await assert.rejects(() => recon.runAndSave(() => {}, { now: () => new Date(T(6)) }), /directory read failed/);
  assert.equal(saved.latest, null, 'nothing published');
  assert.deepEqual(saved.history.runs[0], { at: T(6), outcome: 'failed', failedSources: ['entra'] });
});

test('runAndSave publishes, then records the complete run', async () => {
  const { recon, saved } = loadReconWith({
    runImpl: async () => ({ generatedAt: T(18), durationMs: 700, ...result([drift('a@x.test')]), summary: { people: 3, verdict: 'drift', agreeing: 2, actionable: 1, worst: 'medium' } }),
  });
  await recon.runAndSave(() => {});
  assert.equal(saved.latest.generatedAt, T(18));
  assert.equal(saved.history.runs[0].outcome, 'complete');
  assert.equal(saved.history.findings[0].key, 'a@x.test');
});
