'use strict';
/*
 * Independent readback for the "Run one yourself" demo.
 *
 * The lifecycle API reports its own verification steps. A visitor has no
 * reason to trust those: they come from the same system that did the work.
 * This reads the downstream app directly instead — the Expenses Accounts and
 * Sessions tables, with this site's own managed identity (Table Data Reader on
 * Accounts, Table Data Contributor on Sessions; see main.bicep) — and never
 * calls the lifecycle API at all. Two separate components, two separate
 * identities, the same answer: that is the check.
 *
 * Only demo people can be read: the caller must hold a runKey this site signed
 * when it started the run (dashboard/index.js). What comes back is the state
 * Expenses holds, masked: pseudonym, active, title, department, and how many
 * session rows exist, real and simulated counted separately.
 */
const { loadConfig } = require('../expenses/config');
const { createTableStore } = require('../expenses/store');

const SOURCE =
  'Read by this site directly from the Glasscliff Expenses database (Accounts and Sessions tables) ' +
  "with the site's own read-only identity. The lifecycle API that ran the change is not involved.";

function createReadback({ store, log = console, now = () => Date.now() } = {}) {
  let tables = store || null;
  const getStore = () => {
    if (!tables) {
      const cfg = loadConfig();
      if (!cfg.storageAccount && !cfg.tablesConnectionString) throw new Error('LAB_STORAGE_ACCOUNT is not set');
      tables = createTableStore(cfg);
    }
    return tables;
  };
  // No cache, on purpose: the page reads once before an action and once after,
  // and a cached "before" served as "after" would report a working run as
  // broken. The route's per-visitor rate limit is what protects the tables.

  /**
   * @param {string} login         demo login, from a verified runKey
   * @param {object} masker        dashboard/mask.js masker
   */
  async function read(login, masker) {
    const s = getStore();
    const [account, sessions] = await Promise.all([s.findAccountByUserName(login), s.listSessions(login)]);
    const short = (v) => (v === null || v === undefined ? null : masker.scrub(String(v)).slice(0, 80));
    const value = {
      person: masker.pseudonym(login),
      readAt: new Date(now()).toISOString(),
      source: SOURCE,
      account: account
        ? { exists: true, active: Boolean(account.active), title: short(account.title), department: short(account.department) }
        : { exists: false },
      sessions: {
        total: sessions.length,
        simulated: sessions.filter((x) => x.simulated).length,
      },
    };
    log.info?.(`[dashboard] readback for ${value.person}: account ${account ? (account.active ? 'active' : 'inactive') : 'absent'}, ${sessions.length} session(s)`);
    return value;
  }

  return { read };
}

module.exports = { createReadback, SOURCE };
