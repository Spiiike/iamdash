'use strict';
// Read-only Azure Resource Manager client, authenticated as wetcliff's
// system-assigned managed identity (Reader at the Glasscliff management group).
const ARM = 'https://management.azure.com';

function createArmClient({ credential, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  let cred = credential;
  const token = async () => {
    if (!cred) {
      const { DefaultAzureCredential } = require('@azure/identity');
      cred = new DefaultAzureCredential();
    }
    return (await cred.getToken(`${ARM}/.default`)).token;
  };

  async function call(method, path, body) {
    const res = await fetchImpl(`${ARM}${path}`, {
      method,
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`${method} ${path.split('?')[0]} returned HTTP ${res.status}: ${json.error?.code || 'unknown'}`);
      err.status = res.status;
      err.code = json.error?.code;
      throw err;
    }
    return json;
  }

  // Azure Resource Graph: one read-only query language for resources,
  // resource containers (management groups, subscriptions) and policy data.
  async function graph(query, managementGroup) {
    const out = await call('POST', '/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01', {
      query,
      managementGroups: [managementGroup],
      options: { resultFormat: 'objectArray', $top: 1000 },
    });
    return Array.isArray(out.data) ? out.data : [];
  }

  return { call, graph };
}

module.exports = { createArmClient };
