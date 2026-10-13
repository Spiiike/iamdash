'use strict';
/*
 * Entra ID and Google checks for one person, used by the lifecycle verify.*
 * steps. The Expenses checks read the SCIM endpoint's own table; these read the
 * real directories, with the same read-only identities the reconciler uses:
 *
 *   Entra ID   the Function App's managed identity, Graph User.Read.All (or an
 *              app registration in the federated tenant: see sources/entra.js)
 *   Google     the reconciler's service account, admin.directory.user.readonly
 *
 * Opt-in with DOWNSTREAM_VERIFY=entra,google. Unset, the lifecycle behaves
 * exactly as before, so an Expenses-only lab is unchanged.
 */

const { googleSettings } = require('./recon/config');
const { getEntraUser, getGraphToken } = require('./recon/sources/entra');
const { getGoogleUser, getAccessToken } = require('./recon/sources/google');

const DIRECTORIES = ['entra', 'google'];
const LABEL = { entra: 'Entra ID', google: 'Google' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Which directories this deployment verifies, in a fixed order. */
function targets(env = process.env) {
  const wanted = String(env.DOWNSTREAM_VERIFY || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());
  return DIRECTORIES.filter((d) => wanted.includes(d));
}

function settings(env = process.env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);
  return {
    timeoutMs: 1000 * n(env.DOWNSTREAM_VERIFY_TIMEOUT_SECONDS, 90),
    intervalMs: 1000 * n(env.DOWNSTREAM_VERIFY_INTERVAL_SECONDS, 4),
  };
}

/**
 * A reader with its access tokens cached for 50 minutes, so polling one person
 * every few seconds doesn't mean a token exchange every few seconds.
 */
function createReader({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const tokens = {};
  async function token(dir) {
    const hit = tokens[dir];
    if (hit && now() - hit.at < 50 * 60 * 1000) return hit.value;
    let value;
    if (dir === 'entra') {
      value = await getGraphToken({ fetchImpl, env });
    } else {
      const g = googleSettings(env);
      if (!g) throw new Error('Google is not configured (GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY)');
      value = await getAccessToken({ ...g, fetchImpl });
    }
    tokens[dir] = { at: now(), value };
    return value;
  }
  return {
    async read(dir, login) {
      const t = await token(dir);
      return dir === 'entra'
        ? getEntraUser(login, { token: t, fetchImpl, env })
        : getGoogleUser(login, { token: t, fetchImpl, customer: googleSettings(env)?.customer });
    },
  };
}

/** Poll until `check(user)` passes or the timeout ends. Returns the last user read. */
async function waitFor(reader, dir, login, check, { timeoutMs, intervalMs, sleepFn = sleep, now = () => Date.now() }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const user = await reader.read(dir, login);
    if (check(user)) return { ok: true, user };
    if (now() >= deadline) return { ok: false, user };
    await sleepFn(intervalMs);
  }
}

// ----------------------------------------------------- what each check means
// Each returns a step result: { outcome?, detail, ok?, pending? }. Details are
// written for the public dashboard: no addresses, no object ids, no values a
// person typed — the masker scrubs those anyway, but there is nothing to scrub.

const enabledOf = (dir, u) => (dir === 'entra' ? u.enabled : !u.suspended);
const titleOf = (dir, u) => (dir === 'entra' ? u.jobTitle : u.title);

async function created(reader, dir, login, opts) {
  const r = await waitFor(reader, dir, login, (u) => Boolean(u) && enabledOf(dir, u), opts);
  if (!r.ok) {
    return r.user
      ? { outcome: 'pending', pending: true, detail: `${LABEL[dir]} account exists but is not enabled yet` }
      : { outcome: 'pending', pending: true, detail: `Okta has not pushed the ${LABEL[dir]} account yet` };
  }
  if (dir === 'entra') {
    return { ok: true, detail: r.user.immutableId ? 'account enabled, federation anchor set' : 'account enabled, but no federation anchor: sign-in will fail' };
  }
  return { ok: true, detail: `account active in ${r.user.orgUnitPath || '/'}` };
}

async function updated(reader, dir, login, profile, opts) {
  const before = await reader.read(dir, login);
  if (!before) return { outcome: 'skipped', skipped: true, detail: `no ${LABEL[dir]} account to update` };
  const wants = [];
  if (profile.title !== undefined) wants.push(['title', (u) => (titleOf(dir, u) || '') === profile.title]);
  if (profile.department !== undefined) wants.push(['department', (u) => (u.department || '') === profile.department]);
  if (!wants.length) return { outcome: 'skipped', skipped: true, detail: `nothing ${LABEL[dir]} receives was changed` };
  const r = await waitFor(reader, dir, login, (u) => Boolean(u) && wants.every(([, ok]) => ok(u)), opts);
  const names = wants.map(([n]) => n).join(' and ');
  return r.ok
    ? { ok: true, detail: `${names} updated` }
    : { outcome: 'pending', pending: true, detail: `${names} not updated yet; check the attribute is mapped in Okta's push` };
}

async function disabled(reader, dir, login, hadAccount, opts) {
  if (hadAccount === false) return { outcome: 'skipped', skipped: true, detail: `had no ${LABEL[dir]} account` };
  const r = await waitFor(reader, dir, login, (u) => !u || !enabledOf(dir, u), opts);
  if (!r.ok) return { outcome: 'pending', pending: true, detail: `${LABEL[dir]} account is still enabled` };
  if (!r.user) return { ok: true, detail: 'account removed' };
  return { ok: true, detail: dir === 'entra' ? 'account disabled' : 'account suspended' };
}

const STEP = {
  hire: { entra: 'verify.entraAccountCreated', google: 'verify.googleAccountCreated' },
  transfer: { entra: 'verify.entraAccountUpdated', google: 'verify.googleAccountUpdated' },
  terminate: { entra: 'verify.entraAccountDisabled', google: 'verify.googleAccountSuspended' },
};

/**
 * Wraps a check so a read failure becomes a failed *step* with a plain reason,
 * instead of an exception that abandons the other directory's check halfway.
 */
function guarded(dir, fn) {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      return { outcome: 'failed', failed: true, detail: `could not read ${LABEL[dir]}: ${err.message}` };
    }
  };
}

/**
 * Who has an account where, read *before* a change. Terminate uses this so that
 * "absent afterwards" can tell "Okta removed it" from "there was never one".
 * A failed read is `undefined`: unknown, so the check still runs.
 */
async function presence(reader, dirs, login) {
  const out = {};
  await Promise.all(
    dirs.map(async (d) => {
      try {
        out[d] = Boolean(await reader.read(d, login));
      } catch {
        out[d] = undefined;
      }
    })
  );
  return out;
}

module.exports = { targets, settings, createReader, waitFor, created, updated, disabled, presence, guarded, STEP, LABEL, DIRECTORIES };
