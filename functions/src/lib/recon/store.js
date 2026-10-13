'use strict';

/*
 * Where reconciliation results live: a private blob container, `recon`.
 *
 *   recon/latest.json           what the site reads
 *   recon/history/<iso>.json    one per successful run, so drift that appears on
 *                               one run and clears on the next can be shown
 *   recon/run-history.json      every attempt (failed ones too) and each
 *                               finding's first seen / last seen / resolved
 *                               time; see lib/recon/history.js
 *
 * Uses the same storage account and connection the rest of the Functions app
 * already uses (lib/storage.js), so there is no new setting and no new grant.
 * The container is never public: results are unmasked.
 */

const { BlobServiceClient } = require('@azure/storage-blob');
const { connectionString } = require('../storage');

const CONTAINER = () => process.env.RECON_CONTAINER || 'recon';
const LATEST = 'latest.json';
const RUN_HISTORY = 'run-history.json';

let containerPromise;
function container() {
  if (!containerPromise) {
    containerPromise = (async () => {
      const c = BlobServiceClient.fromConnectionString(connectionString()).getContainerClient(CONTAINER());
      await c.createIfNotExists(); // private by default: no access level is passed
      return c;
    })().catch((err) => {
      containerPromise = null;
      throw err;
    });
  }
  return containerPromise;
}

async function save(result) {
  const c = await container();
  const text = JSON.stringify(result);
  const headers = { blobHTTPHeaders: { blobContentType: 'application/json' } };
  const stamp = String(result.generatedAt).replace(/[:.]/g, '-');
  await c.getBlockBlobClient(`history/${stamp}.json`).upload(text, Buffer.byteLength(text), headers);
  // latest.json last, so a reader never sees a latest that has no history entry.
  await c.getBlockBlobClient(LATEST).upload(text, Buffer.byteLength(text), headers);
}

async function latest() {
  const c = await container();
  try {
    const buf = await c.getBlobClient(LATEST).downloadToBuffer();
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function readJson(name) {
  const c = await container();
  try {
    const buf = await c.getBlobClient(name).downloadToBuffer();
    return JSON.parse(buf.toString('utf8'));
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

async function loadHistory() {
  return readJson(RUN_HISTORY);
}

async function saveHistory(history) {
  const c = await container();
  const text = JSON.stringify(history);
  await c.getBlockBlobClient(RUN_HISTORY).upload(text, Buffer.byteLength(text), {
    blobHTTPHeaders: { blobContentType: 'application/json' },
  });
}

module.exports = { save, latest, loadHistory, saveHistory };
