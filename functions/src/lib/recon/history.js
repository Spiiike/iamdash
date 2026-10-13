'use strict';

/*
 * Run and finding history for the reconciler.
 *
 * latest.json answers "do the directories agree right now?". It can't answer
 * the two questions a reviewer asks next:
 *
 *   1. Is a clean result "no drift", or "the last read failed and this is old"?
 *      A failed run publishes nothing (run.js), which is right, but it also
 *      leaves no trace. Here every attempt is recorded, failed ones included,
 *      with which directory could not be read.
 *
 *   2. How long did a disagreement last? Each actionable finding gets a first
 *      seen, last seen and resolved time, so one problem can be followed across
 *      runs until a clean run shows it fixed.
 *
 * Pure: previous history in, next history out. No clock, no network, no
 * storage. The caller (src/functions/recon.js) loads and saves it.
 *
 * Like latest.json, this is unmasked: finding keys are real join keys. It is
 * only ever served behind the operator key, and the site masks it.
 *
 * Rules that matter:
 *   - Only a COMPLETE run can open or resolve a finding. A failed run changes
 *     nothing about findings; it is recorded in `runs` and nothing else. A
 *     finding is never marked resolved because a directory couldn't be read.
 *   - Accepted exceptions and other info-level findings are not tracked. They
 *     are expected states, not problems with a lifetime.
 *   - A finding that clears and later comes back starts a new episode with a
 *     new first-seen time, rather than pretending it was open all along.
 */

const SCHEMA = 1;
const MAX_RUNS = 60; // 30 days at two runs a day
const KEEP_RESOLVED_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FINDINGS = 200;
const SOURCES = new Set(['okta', 'entra', 'google']);

function empty() {
  return { schema: SCHEMA, runs: [], findings: [] };
}

/** Stable identity of a finding across runs: same person, same rule, same place. */
function findingId(f) {
  const people = f.key ? f.key : (Array.isArray(f.keys) ? [...f.keys].sort().join('+') : '');
  return [people, f.rule || '', f.directory || '', f.attribute || ''].join('|');
}

/** "google: token exchange failed" -> "google". Anything else is dropped. */
function failedSources(failures) {
  const out = [];
  for (const line of Array.isArray(failures) ? failures : []) {
    const name = String(line).split(':')[0].trim().toLowerCase();
    if (SOURCES.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * @param {object|null} prev   previous history (or null on first run)
 * @param {object} run
 * @param {string} run.at                  ISO time the attempt finished
 * @param {'complete'|'failed'} run.outcome
 * @param {object} [run.result]            the raw reconcile result, when complete
 * @param {number} [run.durationMs]
 * @param {string[]} [run.failures]        run.js error.failures, when failed
 * @returns {object} next history
 */
function advance(prev, run) {
  const base = prev && prev.schema === SCHEMA ? prev : empty();
  const at = new Date(run.at).toISOString();
  const atMs = Date.parse(at);

  const runEntry = { at, outcome: run.outcome === 'complete' ? 'complete' : 'failed' };
  if (typeof run.durationMs === 'number') runEntry.durationMs = run.durationMs;

  let findings = base.findings.map((f) => ({ ...f }));

  if (runEntry.outcome === 'complete') {
    const result = run.result || {};
    const actionable = (result.findings || []).filter((f) => f.severity && f.severity !== 'info');
    runEntry.actionable = actionable.length;
    runEntry.people = result.summary ? result.summary.people : undefined;

    const byId = new Map(findings.map((f) => [f.id, f]));
    const seenNow = new Set();

    for (const f of actionable) {
      const id = findingId(f);
      if (seenNow.has(id)) continue;
      seenNow.add(id);
      const existing = byId.get(id);
      if (existing && !existing.resolvedAt) {
        existing.lastSeen = at;
        existing.seenRuns = (existing.seenRuns || 1) + 1;
        existing.severity = f.severity;
      } else {
        // New, or back after being resolved: a new episode.
        const entry = {
          id,
          rule: f.rule,
          severity: f.severity,
          directory: f.directory || null,
          attribute: f.attribute || null,
          firstSeen: at,
          lastSeen: at,
          resolvedAt: null,
          seenRuns: 1,
        };
        if (f.key) entry.key = f.key;
        if (Array.isArray(f.keys)) entry.keys = [...f.keys];
        if (existing) findings = findings.filter((x) => x !== existing);
        findings.push(entry);
        byId.set(id, entry);
      }
    }

    // Open findings that a complete run no longer reports are resolved by it.
    for (const f of findings) {
      if (!f.resolvedAt && !seenNow.has(f.id)) f.resolvedAt = at;
    }
  } else {
    runEntry.failedSources = failedSources(run.failures);
  }

  // Keep open findings, and resolved ones for 30 days; newest first; capped.
  findings = findings
    .filter((f) => !f.resolvedAt || atMs - Date.parse(f.resolvedAt) <= KEEP_RESOLVED_MS)
    .sort((a, b) => {
      if (!a.resolvedAt !== !b.resolvedAt) return a.resolvedAt ? 1 : -1;
      return Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
    })
    .slice(0, MAX_FINDINGS);

  const runs = [runEntry, ...base.runs].slice(0, MAX_RUNS);
  return { schema: SCHEMA, updatedAt: at, runs, findings };
}

module.exports = { advance, empty, findingId, failedSources, SCHEMA, MAX_RUNS };
