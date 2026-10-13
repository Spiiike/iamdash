#!/usr/bin/env node
'use strict';
/*
 * Turns one real lifecycle run into a dashboard replay.
 *
 * A failed or unfinished run is worth recording too (--allow-unfinished): the
 * dashboard shows its real status, so a replay of provisioning that never
 * arrived is evidence of how the lab reports a partial failure.
 *
 * Replays only ever come from real runs: this reads an operation you have just
 * run (hire, transfer or terminate) from the lifecycle API and writes it out as
 * a scenario file with its real timings. Nothing is invented. What it does
 * change, before the file exists anywhere:
 *
 *   - the login becomes a placeholder (--person), the same one for every file
 *     you record, so the replays read as one person joining, moving and leaving
 *   - Okta ids, emails and GUIDs in step details are replaced
 *   - SCIM evidence blob paths are dropped
 *
 * The dashboard's masker runs over it again when it is served, so this is the
 * first of two passes, not the only one.
 *
 *   LAB_LIFECYCLE_ENDPOINT=https://<function>.azurewebsites.net/api/lifecycle \
 *   LAB_OPERATOR_KEY=... \
 *   node tools/record-scenario.js <operationId> --id three-way-hire --order 4 \
 *     --title "Someone joins, everywhere" --description "..." [--out dashboard/scenarios]
 *
 * Then either redeploy the site (bundled scenarios) or upload the file to the
 * private `scenarios` container, which the dashboard prefers when it has files.
 */

const fs = require('node:fs');
const path = require('node:path');

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const OKTA_ID = /\b0[0-9a-z]{2}[0-9A-Za-z]{14,24}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SCIM_ROW = /\bSCIM account \S+ is active\b/g;
const ID = /^[a-z0-9-]{1,40}$/;

function clean(text, person) {
  if (text === undefined || text === null) return text;
  return String(text)
    .replace(EMAIL, person)
    .replace(OKTA_ID, '(hidden)')
    .replace(UUID, '(hidden)')
    .replace(SCIM_ROW, 'SCIM account is active');
}

/** Pure: operation from the API -> scenario file contents. */
function toScenario(op, { id, title, description, order, person = 'replay.person@example.test', allowUnfinished = false }) {
  if (!ID.test(String(id))) throw new Error('--id must be lower-case letters, digits and dashes, at most 40');
  if (!title) throw new Error('--title is required');
  if (!op || !op.operationId || !Array.isArray(op.steps)) throw new Error('that is not an operation from /status');
  if (!allowUnfinished && op.status !== 'succeeded') {
    throw new Error(`operation status is "${op.status}"; replays are of finished runs (use --allow-unfinished to record it anyway)`);
  }
  return {
    id,
    ...(order !== undefined ? { order: Number(order) } : {}),
    title,
    description: description || '',
    // Shown on the dashboard as "Recorded run, <date>". Only this tool writes
    // kind: recorded; a hand-written replay must say illustrative.
    provenance: { kind: 'recorded', capturedAt: String(op.created || '').slice(0, 10), outcome: op.status },
    recordedAt: new Date().toISOString(),
    operation: {
      operationId: op.operationId,
      type: op.type,
      target: person,
      status: op.status,
      summary: clean(op.summary, person),
      ...(op.error ? { error: clean(op.error, person) } : {}),
      created: op.created,
      updated: op.updated,
      steps: op.steps.map((s) => ({
        seq: s.seq,
        step: s.step,
        outcome: s.outcome,
        detail: clean(s.detail, person),
        durationMs: s.durationMs,
        started: s.started,
      })),
      scim: (op.scim || []).map((c) => ({
        step: c.step,
        httpStatus: c.httpStatus,
        outcome: c.outcome,
        at: c.at,
        ...(c.sessionsEnded ? { sessionsEnded: c.sessionsEnded } : {}),
      })),
    },
  };
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--allow-unfinished') out.allowUnfinished = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  const operationId = a._[0];
  const endpoint = (process.env.LAB_LIFECYCLE_ENDPOINT || '').replace(/\/+$/, '');
  const key = process.env.LAB_OPERATOR_KEY || '';
  const header = process.env.LAB_OPERATOR_HEADER || 'x-lab-operator-key';
  if (!operationId || !endpoint || !key) {
    console.error('usage: LAB_LIFECYCLE_ENDPOINT=... LAB_OPERATOR_KEY=... node tools/record-scenario.js <operationId> --id <id> --title <title> [--description ..] [--order n] [--person ..] [--out dir]');
    process.exit(2);
  }
  const res = await fetch(`${endpoint}/status/${encodeURIComponent(operationId)}`, { headers: { [header]: key, accept: 'application/json' } });
  if (!res.ok) throw new Error(`lifecycle API returned HTTP ${res.status}`);
  const scenario = toScenario(await res.json(), a);
  const dir = a.out || path.join(__dirname, '..', 'dashboard', 'scenarios');
  const file = path.join(dir, `${scenario.order ?? 9}-${scenario.id}.json`);
  fs.writeFileSync(file, `${JSON.stringify(scenario, null, 2)}\n`);
  const lanes = new Set(scenario.operation.steps.map((s) => s.step.split('.')[1]).filter((n) => /^(entra|google)/.test(n)).map((n) => n.replace(/Account.*/, '')));
  console.log(`wrote ${file}: ${scenario.operation.steps.length} steps, ${scenario.operation.scim.length} SCIM calls${lanes.size ? `, lanes: ${[...lanes].join(', ')}` : ''}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { toScenario, clean };
