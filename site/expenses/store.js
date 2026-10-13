'use strict';
/*
 * Accounts and Sessions, matching glasscliff-functions/src/lib/storage.js
 * and src/functions/scim.js:
 *
 *  Accounts  PartitionKey = EXPENSES_APP_NAME ('glasscliff-expenses'),
 *            RowKey = SCIM id, userNameLower, active, displayName,
 *            resource = the SCIM user JSON (title, enterprise department/manager).
 *  Sessions  PartitionKey = lower-case userName, RowKey = session id.
 *            A session is live while its row EXISTS. SCIM deactivation
 *            (invalidateSessions) deletes the rows, and the terminate check
 *            (countSessions) counts every row in the partition, so Expenses
 *            also ends a session by deleting its row, never by flagging it.
 */
const { TableClient, odata } = require('@azure/data-tables');

const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const asBool = (v) => v === true || v === 'true' || v === 'True';

function normalizeAccount(e) {
  let r = {};
  try {
    r = JSON.parse(e.resource || '{}');
  } catch {
    /* keep defaults */
  }
  const ent = r[ENTERPRISE] || {};
  return {
    id: e.rowKey,
    userName: e.userName,
    active: asBool(e.active),
    displayName: e.displayName || [r.name?.givenName, r.name?.familyName].filter(Boolean).join(' ') || e.userName,
    title: r.title || null,
    department: ent.department || null,
    manager: ent.manager?.displayName || ent.manager?.value || null,
  };
}

const notFound = (err) => err && err.statusCode === 404;

function createTableStore(cfg) {
  let accounts;
  let sessions;
  if (cfg.tablesConnectionString) {
    const opts = { allowInsecureConnection: true };
    accounts = TableClient.fromConnectionString(cfg.tablesConnectionString, cfg.accountsTable, opts);
    sessions = TableClient.fromConnectionString(cfg.tablesConnectionString, cfg.sessionsTable, opts);
  } else {
    // wetcliff's system-assigned identity: Table Data Reader on Accounts,
    // Table Data Contributor on Sessions (main.bicep).
    const { DefaultAzureCredential } = require('@azure/identity');
    const credential = new DefaultAzureCredential();
    const endpoint = `https://${cfg.storageAccount}.table.core.windows.net`;
    accounts = new TableClient(endpoint, cfg.accountsTable, credential);
    sessions = new TableClient(endpoint, cfg.sessionsTable, credential);
  }

  async function findAccountByUserName(userName) {
    const filter = odata`PartitionKey eq ${cfg.appName} and userNameLower eq ${String(userName).toLowerCase()}`;
    for await (const e of accounts.listEntities({ queryOptions: { filter } })) return normalizeAccount(e);
    return null;
  }

  async function createSession(entity) {
    await sessions.createEntity(entity);
    return { ...entity };
  }

  async function getSession(partitionKey, rowKey) {
    try {
      return await sessions.getEntity(partitionKey, rowKey);
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  }

  // Merge with If-Match: * so a row SCIM just deleted is never re-created.
  // Returns false when the row is gone.
  async function updateSession(partitionKey, rowKey, patch) {
    try {
      await sessions.updateEntity({ partitionKey, rowKey, ...patch }, 'Merge');
      return true;
    } catch (err) {
      if (notFound(err)) return false;
      throw err;
    }
  }

  async function deleteSession(partitionKey, rowKey) {
    try {
      await sessions.deleteEntity(partitionKey, rowKey);
    } catch (err) {
      if (!notFound(err)) throw err;
    }
  }

  // Every live session row for one person: real sign-ins, and the demo's
  // simulated ones (simulated: true), told apart. Read-only.
  async function listSessions(userName) {
    const filter = odata`PartitionKey eq ${String(userName).toLowerCase()}`;
    const out = [];
    for await (const e of sessions.listEntities({ queryOptions: { filter, select: ['simulated'] } })) {
      out.push({ simulated: e.simulated === true || e.simulated === 'true' });
      if (out.length >= 50) break;
    }
    return out;
  }

  return { findAccountByUserName, createSession, getSession, updateSession, deleteSession, listSessions };
}

module.exports = { createTableStore, normalizeAccount };
