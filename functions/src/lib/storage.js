'use strict';
// Storage helpers for the lab: Table Storage (Accounts, OperationSteps,
// Sessions) and the 'evidence' blob container.

const crypto = require('node:crypto');
const { TableClient, odata } = require('@azure/data-tables');
const { BlobServiceClient } = require('@azure/storage-blob');

// An app setting that still starts with "@Microsoft.KeyVault(" means the
// Key Vault reference did NOT resolve (missing role, typo, not yet propagated).
function isUnresolvedKeyVaultRef(value) {
  return typeof value === 'string' && value.startsWith('@Microsoft.KeyVault(');
}

function connectionString() {
  const primary = process.env.STORAGE_CONNECTION_STRING;
  if (primary && !isUnresolvedKeyVaultRef(primary)) return primary;
  // Same account; the host setting is a plain connection string.
  const fallback = process.env.AzureWebJobsStorage;
  if (fallback) return fallback;
  throw new Error('No storage connection string available (STORAGE_CONNECTION_STRING / AzureWebJobsStorage).');
}

const tableCache = new Map();
async function table(name) {
  if (!tableCache.has(name)) {
    const client = TableClient.fromConnectionString(connectionString(), name, {
      allowInsecureConnection: connectionString().includes('UseDevelopmentStorage') || connectionString().includes('127.0.0.1'),
    });
    await client.createTable(); // no-op if it already exists (Bicep creates them)
    tableCache.set(name, client);
  }
  return tableCache.get(name);
}

let containerClient;
async function evidenceContainer() {
  if (!containerClient) {
    const service = BlobServiceClient.fromConnectionString(connectionString());
    containerClient = service.getContainerClient(process.env.STORAGE_CONTAINER_EVIDENCE || 'evidence');
    await containerClient.createIfNotExists();
  }
  return containerClient;
}

const T = {
  accounts: () => table(process.env.STORAGE_TABLE_ACCOUNTS || 'Accounts'),
  steps: () => table(process.env.STORAGE_TABLE_STEPS || 'OperationSteps'),
  sessions: () => table(process.env.STORAGE_TABLE_SESSIONS || 'Sessions'),
  operations: () => table(process.env.STORAGE_TABLE_OPERATIONS || 'Operations'),
  idempotency: () => table(process.env.STORAGE_TABLE_IDEMPOTENCY || 'Idempotency'),
  demoUsers: () => table(process.env.STORAGE_TABLE_DEMO_USERS || 'DemoUsers'),
};

// Account row the SCIM endpoint keeps for a user (or null).
async function findAccount(userName) {
  const accounts = await T.accounts();
  const app = process.env.SCIM_APP_NAME || 'glasscliff-expenses';
  const rows = accounts.listEntities({
    queryOptions: { filter: odata`PartitionKey eq ${app} and userNameLower eq ${String(userName).toLowerCase()}` },
  });
  for await (const row of rows) return row;
  return null;
}

async function countSessions(userName) {
  const sessions = await T.sessions();
  let n = 0;
  for await (const _ of sessions.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${userName.toLowerCase()}` } })) n++; // eslint-disable-line no-unused-vars
  return n;
}

// ------------------------------------------------------------------ evidence
const SENSITIVE_KEYS = new Set(['password', 'authorization', 'token', 'secret', 'client_secret', 'access_token', 'refresh_token']);

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : sanitize(v);
    }
    return out;
  }
  return value;
}

async function writeEvidence(record) {
  const doSanitize = (process.env.SCIM_SANITIZE_EVIDENCE || 'true') !== 'false';
  const body = doSanitize ? sanitize(record) : record;
  const now = new Date();
  const name = `scim/${now.toISOString().slice(0, 10)}/${now.toISOString().replace(/[:.]/g, '-')}-${record.request.method}-${crypto.randomBytes(3).toString('hex')}.json`;
  const container = await evidenceContainer();
  const text = JSON.stringify(body, null, 2);
  await container.getBlockBlobClient(name).upload(text, Buffer.byteLength(text), {
    blobHTTPHeaders: { blobContentType: 'application/json' },
  });
  return name;
}

// ------------------------------------------------------------ operation log
async function recordStep(step) {
  const now = new Date();
  const steps = await T.steps();
  await steps.createEntity({
    partitionKey: now.toISOString().slice(0, 10),
    rowKey: `${now.getTime()}-${crypto.randomBytes(4).toString('hex')}`,
    ...step,
  });
}

// ----------------------------------------------------- offboarding sessions
// Sessions rows are keyed by lower-case userName (PartitionKey). When an
// account is deactivated every live session row for that user is removed.
async function invalidateSessions(userName) {
  const sessions = await T.sessions();
  let count = 0;
  const rows = sessions.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${userName.toLowerCase()}` } });
  for await (const row of rows) {
    await sessions.deleteEntity(row.partitionKey, row.rowKey);
    count++;
  }
  return count;
}

module.exports = { T, odata, findAccount, countSessions, writeEvidence, recordStep, invalidateSessions, sanitize, isUnresolvedKeyVaultRef, connectionString };
