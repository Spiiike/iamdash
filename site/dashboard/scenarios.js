'use strict';
// Synthetic playback. Scenarios are read from the private `scenarios` blob
// container with wetcliff's identity; the bundled files are the fallback and
// the seed content. Everything still goes through the masker on the way out.
const fs = require('fs');
const path = require('path');

const BUNDLED_DIR = path.join(__dirname, 'scenarios');
const ID = /^[a-z0-9-]{1,40}$/;

function loadBundled() {
  return fs.readdirSync(BUNDLED_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(BUNDLED_DIR, f), 'utf8')));
}

function valid(s) {
  return s && ID.test(String(s.id)) && typeof s.title === 'string' && s.operation && typeof s.operation === 'object';
}

function createScenarioSource(cfg, { log = console, now = () => Date.now(), containerClient } = {}) {
  let cache = null;
  let cachedAt = 0;
  const TTL = 5 * 60 * 1000;

  function client() {
    if (containerClient) return containerClient;
    if (!cfg.scenarioContainerUrl) return null;
    const { ContainerClient } = require('@azure/storage-blob');
    const { DefaultAzureCredential } = require('@azure/identity');
    containerClient = new ContainerClient(cfg.scenarioContainerUrl, new DefaultAzureCredential());
    return containerClient;
  }

  async function fromBlob() {
    const c = client();
    if (!c) return [];
    const out = [];
    for await (const blob of c.listBlobsFlat()) {
      if (!blob.name.endsWith('.json') || (blob.properties.contentLength || 0) > 64 * 1024 || out.length >= 20) continue;
      try {
        const buf = await c.getBlobClient(blob.name).downloadToBuffer();
        const s = JSON.parse(buf.toString('utf8'));
        if (valid(s)) out.push(s);
        else log.warn(`[dashboard] scenario ${blob.name} skipped: needs id, title and operation`);
      } catch (err) {
        log.warn(`[dashboard] scenario ${blob.name} skipped: ${err.message}`);
      }
    }
    return out;
  }

  async function all() {
    if (cache && now() - cachedAt < TTL) return cache;
    let list = [];
    try {
      list = await fromBlob();
    } catch (err) {
      log.warn(`[dashboard] scenarios container unavailable, using bundled scenarios: ${err.message}`);
    }
    if (!list.length) list = loadBundled();
    cache = list.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    cachedAt = now();
    return cache;
  }

  return { all };
}

module.exports = { createScenarioSource, loadBundled };
