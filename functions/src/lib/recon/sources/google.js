'use strict';

const { createSign } = require('node:crypto');
const { joinKey } = require('../model');

/**
 * Google Cloud Identity adapter, over the Admin SDK Directory API.
 *
 * Authentication is a service account. Two ways to give it directory read:
 *
 *   1. Preferred: assign the service account a custom admin role (Users: Read)
 *      in the Admin console. No delegation, no impersonation; leave
 *      GOOGLE_ADMIN_SUBJECT unset.
 *   2. Fallback: domain-wide delegation for the one read-only scope below, and
 *      set GOOGLE_ADMIN_SUBJECT to the admin to impersonate.
 *
 * Neither is the Okta connector's grant. The Okta connector
 * holds admin.directory.rolemanagement, which can grant Super Admin (§4); a
 * reconciler has no business holding that. The only scope requested here is
 * admin.directory.user.readonly.
 *
 * The audit trail is the other reason to do it this way: calls made under the
 * service account's own identity appear in Google's admin audit log as that
 * service account, rather than as whichever human's grant was borrowed.
 *
 * The service account's private key lives in Key Vault and is read at runtime.
 * Signing happens here with node:crypto, so there is no Google SDK dependency.
 */

const SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DIRECTORY_URL = 'https://admin.googleapis.com/admin/directory/v1/users';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build and sign a JWT bearer assertion for the service account.
 *
 * `subject` is the super admin to impersonate. Directory reads require an admin
 * context, so this is unavoidable — but it is one named admin, read-only, rather
 * than a tenant-wide delegation.
 */
function signAssertion({ clientEmail, privateKey, subject, now = Math.floor(Date.now() / 1000) }) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
    ...(subject ? { sub: subject } : {}),
  };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256')
    .update(body)
    .sign(privateKey.replace(/\\n/g, '\n'))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${body}.${signature}`;
}

async function getAccessToken({ clientEmail, privateKey, subject, fetchImpl = fetch }) {
  const assertion = signAssertion({ clientEmail, privateKey, subject });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`google: token exchange ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()).access_token;
}

async function fetchGoogle({
  clientEmail,
  privateKey,
  subject,
  customer = 'my_customer',
  token,
  fetchImpl = fetch,
}) {
  const accessToken = token || (await getAccessToken({ clientEmail, privateKey, subject, fetchImpl }));
  const out = [];
  let pageToken = null;
  let guard = 0;

  do {
    if (++guard > 100) throw new Error('google: pagination guard tripped (>100 pages)');
    const params = new URLSearchParams({
      customer,
      maxResults: '500',
      projection: 'full',
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetchImpl(`${DIRECTORY_URL}?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`google: directory ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    const page = await res.json();
    out.push(...(page.users || []));
    pageToken = page.nextPageToken || null;
  } while (pageToken);

  return out.map(normaliseGoogleUser);
}

/**
 * One user by primary address, for the lifecycle verify.google* steps.
 *
 * With a `customer`, this searches the customer's directory rather than fetching
 * users/{address}. The difference matters: an admin that isn't a super admin
 * (which is what a service account with a custom role is) gets 403 "Not
 * Authorized" from users/{address} for an address that doesn't exist, so
 * "not pushed yet" would look exactly like a permission failure. A search
 * answers "no such user" with an empty list, and still 403s if the role is
 * genuinely missing.
 */
async function getGoogleUser(address, { clientEmail, privateKey, subject, customer, token, fetchImpl = fetch }) {
  const accessToken = token || (await getAccessToken({ clientEmail, privateKey, subject, fetchImpl }));
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  const wanted = String(address).toLowerCase();

  if (customer) {
    const params = new URLSearchParams({ customer, query: `email:${wanted}`, projection: 'full', maxResults: '10' });
    const res = await fetchImpl(`${DIRECTORY_URL}?${params}`, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`google: directory ${res.status} ${body.slice(0, 200)}`);
    }
    const users = (await res.json()).users || [];
    // email: also matches aliases; only the primary address is the same person.
    const hit = users.find((u) => String(u.primaryEmail || '').toLowerCase() === wanted);
    return hit ? normaliseGoogleUser(hit) : null;
  }

  const res = await fetchImpl(`${DIRECTORY_URL}/${encodeURIComponent(address)}?projection=full`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`google: directory ${res.status} ${body.slice(0, 200)}`);
  }
  return normaliseGoogleUser(await res.json());
}

/**
 * Google nests title and department inside organizations[], and only one entry
 * is primary. The connector writes the primary one, so that is what to compare.
 */
function normaliseGoogleUser(u) {
  const orgs = Array.isArray(u.organizations) ? u.organizations : [];
  const primary = orgs.find((o) => o.primary) || orgs[0] || {};
  return {
    key: joinKey(u.primaryEmail),
    id: u.id,
    primaryEmail: u.primaryEmail || '',
    enabled: u.suspended !== true,
    suspended: u.suspended === true,
    orgUnitPath: u.orgUnitPath || '',
    isAdmin: u.isAdmin === true,
    givenName: u.name?.givenName || '',
    familyName: u.name?.familyName || '',
    title: primary.title || '',
    department: primary.department || '',
  };
}

module.exports = { fetchGoogle, getGoogleUser, normaliseGoogleUser, signAssertion, getAccessToken, SCOPE };
