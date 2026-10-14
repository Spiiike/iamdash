'use strict';

const { joinKey } = require('../model');

/**
 * Okta adapter. Reads users and the app-assignment sets for the two downstream
 * apps, because assignment to the app is the allow-list for the directory behind
 * it — a user who is not assigned is not expected to have a downstream account,
 * and reporting that as drift would be wrong.
 *
 * Pagination note: Okta's collection endpoints page with a Link header, not an
 * offset. Reading only the first page is the quiet way to under-report, which is
 * the same trap the System Log API sets with `limit` returning the *earliest* N.
 */

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  // link: <https://org/api/v1/users?after=...>; rel="next"
  for (const part of linkHeader.split(',')) {
    const [urlPart, ...params] = part.split(';');
    if (params.some((p) => /rel\s*=\s*"?next"?/.test(p))) {
      const m = urlPart.match(/<(.+)>/);
      if (m) return m[1];
    }
  }
  return null;
}

async function getAllPages(url, token, { fetchImpl = fetch } = {}) {
  const out = [];
  let next = url;
  let guard = 0;
  while (next) {
    if (++guard > 100) throw new Error('okta: pagination guard tripped (>100 pages)');
    const res = await fetchImpl(next, {
      headers: {
        Authorization: `SSWS ${token}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`okta: ${res.status} ${res.statusText} for ${next.split('?')[0]}`);
    }
    const page = await res.json();
    out.push(...(Array.isArray(page) ? page : []));
    next = parseNextLink(res.headers.get('link'));
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.orgUrl       e.g. https://example.okta.com
 * @param {string} opts.token        API token (SSWS), from Key Vault
 * @param {string} opts.entraAppId   Okta app instance id for the Office 365 app
 * @param {string} opts.googleAppId  Okta app instance id for the Google app
 */
async function fetchOkta({ orgUrl, token, entraAppId, googleAppId, fetchImpl = fetch }) {
  if (!orgUrl || !token) throw new Error('okta: orgUrl and token are required');
  const base = orgUrl.replace(/\/$/, '');

  // Okta's plain user list leaves out DEPROVISIONED users, which is what every
  // person I offboard becomes. Without the second query a leaver looks like they
  // never existed in Okta: access_not_revoked can't fire for them, and their
  // disabled Entra and Google accounts get reported as orphans instead.
  const deprovisioned = encodeURIComponent('status eq "DEPROVISIONED"');
  const [listed, gone, entraAssigned, googleAssigned] = await Promise.all([
    getAllPages(`${base}/api/v1/users?limit=200`, token, { fetchImpl }),
    getAllPages(`${base}/api/v1/users?limit=200&filter=${deprovisioned}`, token, { fetchImpl }),
    entraAppId
      ? getAllPages(`${base}/api/v1/apps/${entraAppId}/users?limit=200`, token, { fetchImpl })
      : Promise.resolve([]),
    googleAppId
      ? getAllPages(`${base}/api/v1/apps/${googleAppId}/users?limit=200`, token, { fetchImpl })
      : Promise.resolve([]),
  ]);

  const entraSet = new Set(entraAssigned.map((au) => joinKey(au.credentials?.userName || au.externalId)));
  const googleSet = new Set(googleAssigned.map((au) => joinKey(au.credentials?.userName || au.externalId)));

  // The two lists shouldn't overlap, but a user deactivated between the two
  // requests could appear in both, so I keep one record per Okta id.
  const users = [...new Map([...listed, ...gone].map((u) => [u.id, u])).values()];
  return users.map((u) => normaliseOktaUser(u, { entraSet, googleSet }));
}

function normaliseOktaUser(u, { entraSet = new Set(), googleSet = new Set() } = {}) {
  const key = joinKey(u.profile?.login);
  return {
    key,
    id: u.id,
    login: u.profile?.login || '',
    email: u.profile?.email || '',
    status: u.status || '',
    firstName: u.profile?.firstName || '',
    lastName: u.profile?.lastName || '',
    title: u.profile?.title || '',
    department: u.profile?.department || '',
    assignedEntra: entraSet.has(key),
    assignedGoogle: googleSet.has(key),
  };
}

module.exports = { fetchOkta, normaliseOktaUser, parseNextLink };
