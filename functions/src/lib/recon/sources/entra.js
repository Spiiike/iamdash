'use strict';

const { joinKey } = require('../model');

/**
 * Entra ID adapter, over Microsoft Graph.
 *
 * Authentication is the Function App's own managed identity, granted the Graph
 * application permission User.Read.All — read-only, and no stored credential
 * anywhere. This is deliberately *not* the Okta connector's service principal:
 * that one holds RoleManagement.ReadWrite.Directory and is a standing path to
 * Global Admin (§3). A reconciler only ever needs to read, so it gets its own
 * identity with its own, much smaller grant.
 *
 * The attributes selected are exactly the ones the connector maps, plus the
 * anchor. onPremisesImmutableId is the one people forget to look at, and it is
 * the one that decides whether federation can match the account at all.
 */

const GRAPH = 'https://graph.microsoft.com';
const SELECT = [
  'id',
  'userPrincipalName',
  'accountEnabled',
  'onPremisesImmutableId',
  'givenName',
  'surname',
  'jobTitle',
  'department',
].join(',');

/**
 * Acquire a token from the managed identity endpoint. Azure Functions and App
 * Service expose IDENTITY_ENDPOINT + IDENTITY_HEADER; VMs use IMDS. Both are
 * handled so the same code runs locally against IMDS and in the Function App.
 */
async function getManagedIdentityToken({ resource = GRAPH, fetchImpl = fetch, env = process.env } = {}) {
  const { IDENTITY_ENDPOINT, IDENTITY_HEADER, MSI_ENDPOINT, MSI_SECRET } = env;
  // This Function App runs as a *user-assigned* identity (main.bicep), and the
  // token endpoint returns nothing for one unless asked for it by client id.
  // AZURE_CLIENT_ID is already set by main.bicep for exactly this reason.
  const clientId = env.AZURE_CLIENT_ID ? `&client_id=${encodeURIComponent(env.AZURE_CLIENT_ID)}` : '';

  if (IDENTITY_ENDPOINT && IDENTITY_HEADER) {
    const url = `${IDENTITY_ENDPOINT}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01${clientId}`;
    const res = await fetchImpl(url, { headers: { 'X-IDENTITY-HEADER': IDENTITY_HEADER } });
    if (!res.ok) throw new Error(`entra: managed identity token failed (${res.status})`);
    return (await res.json()).access_token;
  }

  if (MSI_ENDPOINT && MSI_SECRET) {
    const url = `${MSI_ENDPOINT}?resource=${encodeURIComponent(resource)}&api-version=2017-09-01${clientId.replace('client_id', 'clientid')}`;
    const res = await fetchImpl(url, { headers: { Secret: MSI_SECRET } });
    if (!res.ok) throw new Error(`entra: MSI token failed (${res.status})`);
    return (await res.json()).access_token;
  }

  const url =
    `http://169.254.169.254/metadata/identity/oauth2/token` +
    `?api-version=2018-02-01&resource=${encodeURIComponent(resource)}${clientId}`;
  const res = await fetchImpl(url, { headers: { Metadata: 'true' } });
  if (!res.ok) throw new Error(`entra: IMDS token failed (${res.status})`);
  return (await res.json()).access_token;
}

/**
 * A managed identity can only be granted Graph permissions in the tenant that
 * holds the Azure subscription. When the federated Entra tenant is a different
 * one, the reconciler reads it with an app registration *in that tenant*
 * instead: ENTRA_TENANT_ID + ENTRA_CLIENT_ID + ENTRA_CLIENT_SECRET (Key Vault),
 * granted the same single application permission, User.Read.All.
 */
const usableSecret = (v) => Boolean(v) && !String(v).startsWith('@Microsoft.KeyVault(') && !String(v).startsWith('SET-ME-');

async function getClientCredentialsToken({ env, fetchImpl }) {
  const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(env.ENTRA_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.ENTRA_CLIENT_ID,
      client_secret: env.ENTRA_CLIENT_SECRET,
      scope: `${GRAPH}/.default`,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`entra: client credentials token failed (${res.status}) ${body.slice(0, 160)}`);
  }
  return (await res.json()).access_token;
}

/** Which way this deployment reads Entra ID. */
function graphAuthMode(env = process.env) {
  return env.ENTRA_TENANT_ID && env.ENTRA_CLIENT_ID && usableSecret(env.ENTRA_CLIENT_SECRET) ? 'app-registration' : 'managed-identity';
}

async function getGraphToken({ fetchImpl = fetch, env = process.env } = {}) {
  return graphAuthMode(env) === 'app-registration'
    ? getClientCredentialsToken({ env, fetchImpl })
    : getManagedIdentityToken({ fetchImpl, env });
}

async function fetchEntra({ token, fetchImpl = fetch, env = process.env } = {}) {
  const accessToken = token || (await getGraphToken({ fetchImpl, env }));
  const out = [];
  let next = `${GRAPH}/v1.0/users?$select=${SELECT}&$top=999`;
  let guard = 0;

  while (next) {
    if (++guard > 100) throw new Error('entra: pagination guard tripped (>100 pages)');
    const res = await fetchImpl(next, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`entra: graph ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    const page = await res.json();
    out.push(...(page.value || []));
    next = page['@odata.nextLink'] || null;
  }

  return out.map(normaliseEntraUser);
}

function normaliseEntraUser(u) {
  return {
    key: joinKey(u.userPrincipalName),
    id: u.id,
    upn: u.userPrincipalName || '',
    enabled: u.accountEnabled !== false,
    immutableId: u.onPremisesImmutableId || '',
    givenName: u.givenName || '',
    surname: u.surname || '',
    jobTitle: u.jobTitle || '',
    department: u.department || '',
  };
}

/**
 * One user, by UPN. Used by the lifecycle verify.entra* steps, which need to
 * know about a single person seconds after Okta pushed them, not the whole
 * directory. Returns null when Graph says 404.
 */
async function getEntraUser(upn, { token, fetchImpl = fetch, env = process.env } = {}) {
  const accessToken = token || (await getGraphToken({ fetchImpl, env }));
  const res = await fetchImpl(`${GRAPH}/v1.0/users/${encodeURIComponent(upn)}?$select=${SELECT}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`entra: graph ${res.status} ${body.slice(0, 200)}`);
  }
  return normaliseEntraUser(await res.json());
}

module.exports = { fetchEntra, getEntraUser, normaliseEntraUser, getManagedIdentityToken, getGraphToken, graphAuthMode };
