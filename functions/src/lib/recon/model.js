'use strict';

/**
 * Canonical identity model shared by all three directory adapters.
 *
 * Every adapter returns records in this shape so that reconcile.js never has to
 * know which vendor a record came from. The join key is the lowercased primary
 * address, which is the whole point of the identity model: Okta's app username
 * expression is String.toLowerCase(user.login) on both downstream apps, so the
 * key is identical in all three directories by construction.
 */

/**
 * Okta's `status` tracks the state of the user's *password credential*, not
 * whether the person can authenticate. Users holding only a passkey sign in
 * successfully while PASSWORD_EXPIRED, and PROVISIONED users have an enabled
 * downstream account. Only SUSPENDED and DEPROVISIONED actually disable the
 * targets.
 *
 * Getting this table wrong is the single easiest way to build a reconciler that
 * reports drift which does not exist.
 */
const OKTA_STATUS = {
  ACTIVE: 'enabled',
  PROVISIONED: 'enabled',
  PASSWORD_EXPIRED: 'enabled',
  LOCKED_OUT: 'enabled',
  RECOVERY: 'enabled',
  SUSPENDED: 'disabled',
  DEPROVISIONED: 'disabled',
  // STAGED users have never been activated, so no downstream account is
  // expected to exist yet. This is 'pending', not 'enabled' or 'disabled'.
  STAGED: 'pending',
};

/** Map an Okta status string to the state its downstream accounts should hold. */
function expectedDownstreamState(status) {
  return OKTA_STATUS[String(status || '').toUpperCase()] || 'unknown';
}

/** Normalise a value for comparison: null, undefined and '' are all "absent". */
function norm(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/** Lowercase join key. Returns '' for anything unusable. */
function joinKey(address) {
  return norm(address).toLowerCase();
}

/** Split an address into local part and domain. */
function splitAddress(address) {
  const key = joinKey(address);
  const at = key.lastIndexOf('@');
  if (at < 1) return { local: key, domain: '' };
  return { local: key.slice(0, at), domain: key.slice(at + 1) };
}

module.exports = { OKTA_STATUS, expectedDownstreamState, norm, joinKey, splitAddress };
