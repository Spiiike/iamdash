'use strict';
// Operations = one row per hire/transfer/terminate request (newest first).
// Lifecycle steps live in OperationSteps with PartitionKey = operationId.
// SCIM steps (written by scim.js) live in OperationSteps under a date
// partition and are linked to an operation by userName + time window.

const crypto = require('node:crypto');
const store = require('./storage');

const OPS_PK = 'op';
const MAX_TS = 9_999_999_999_999;

const opsTable = () => store.T.operations();
const idemTable = () => store.T.idempotency();

function newOperationId() {
  // Inverted timestamp so a plain table scan returns newest first.
  return `${String(MAX_TS - Date.now()).padStart(13, '0')}-${crypto.randomBytes(3).toString('hex')}`;
}

async function create(type, target, input) {
  const now = new Date().toISOString();
  const op = {
    partitionKey: OPS_PK,
    rowKey: newOperationId(),
    type,
    target,
    status: 'running',
    input: JSON.stringify(store.sanitize(input || {})),
    created: now,
    updated: now,
    summary: '',
    error: '',
    oktaUserId: '',
    stepCount: 0,
  };
  await (await opsTable()).createEntity(op);
  return op;
}

async function update(op, fields) {
  Object.assign(op, fields, { updated: new Date().toISOString() });
  await (await opsTable()).updateEntity(op, 'Replace');
  return op;
}

// Runs one named step, records outcome + duration, and rethrows on failure.
async function step(op, name, fn) {
  const started = Date.now();
  const seq = ++op.stepCount;
  const row = { partitionKey: op.rowKey, rowKey: String(seq).padStart(3, '0'), step: name, source: 'lifecycle', started: new Date(started).toISOString() };
  const steps = await store.T.steps();
  try {
    const result = await fn();
    const outcome = result?.outcome || 'succeeded';
    await steps.upsertEntity({ ...row, outcome, detail: result?.detail || '', durationMs: Date.now() - started });
    return result;
  } catch (err) {
    await steps.upsertEntity({
      ...row,
      outcome: 'failed',
      detail: err.message,
      httpStatus: err.status || 500,
      durationMs: Date.now() - started,
    });
    throw err;
  }
}

async function get(operationId) {
  try {
    return await (await opsTable()).getEntity(OPS_PK, operationId);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function steps(op) {
  const table = await store.T.steps();
  const out = [];
  for await (const s of table.listEntities({ queryOptions: { filter: store.odata`PartitionKey eq ${op.rowKey}` } })) {
    out.push({ seq: Number(s.rowKey), step: s.step, outcome: s.outcome, detail: s.detail, durationMs: s.durationMs, started: s.started });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

// SCIM calls Okta made for this user since the operation started.
async function scimActivity(op) {
  if (!op.target) return [];
  const table = await store.T.steps();
  const days = new Set([op.created.slice(0, 10), new Date().toISOString().slice(0, 10)]);
  const out = [];
  for (const day of days) {
    const filter = store.odata`PartitionKey eq ${day} and userNameLower eq ${op.target.toLowerCase()} and Timestamp ge ${new Date(op.created)}`;
    for await (const s of table.listEntities({ queryOptions: { filter } })) {
      out.push({ step: s.step, httpStatus: s.httpStatus, outcome: s.outcome, at: s.timestamp, evidenceBlob: s.evidenceBlob, sessionsEnded: s.sessionsEnded });
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

async function list(limit = 20) {
  const table = await opsTable();
  const out = [];
  for await (const op of table.listEntities({ queryOptions: { filter: store.odata`PartitionKey eq ${OPS_PK}` } })) {
    out.push(publicView(op));
    if (out.length >= limit) break;
  }
  return out;
}

function publicView(op) {
  return {
    operationId: op.rowKey,
    type: op.type,
    target: op.target,
    status: op.status,
    summary: op.summary,
    error: op.error || undefined,
    oktaUserId: op.oktaUserId || undefined,
    created: op.created,
    updated: op.updated,
  };
}

// ---------------------------------------------------------- idempotency
async function findIdempotent(key) {
  if (!key) return null;
  try {
    const row = await (await idemTable()).getEntity('lifecycle', key);
    return get(row.operationId);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function rememberIdempotent(key, op) {
  if (!key) return;
  await (await idemTable()).upsertEntity({ partitionKey: 'lifecycle', rowKey: key, operationId: op.rowKey, created: op.created });
}

module.exports = { create, update, step, get, steps, scimActivity, list, publicView, findIdempotent, rememberIdempotent };
