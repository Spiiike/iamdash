'use strict';
// GET /api/lifecycle/health — anonymous smoke test.
// Reports whether each Key Vault reference resolved and whether storage is
// reachable. Never returns secret values, only true/false.

const { app } = require('@azure/functions');
const store = require('../lib/storage');
const okta = require('../lib/okta');

const KEY_VAULT_SETTINGS = [
  'SCIM_BEARER_TOKEN',
  'API_OPERATOR_KEY',
  'OKTA_API_TOKEN',
  'OIDC_CLIENT_SECRET',
  'STORAGE_CONNECTION_STRING',
];

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'lifecycle/health',
  handler: async (request, context) => {
    const keyVaultReferences = {};
    for (const name of KEY_VAULT_SETTINGS) {
      const value = process.env[name];
      keyVaultReferences[name] = !value ? 'missing' : store.isUnresolvedKeyVaultRef(value) ? 'UNRESOLVED' : value.startsWith('SET-ME-') ? 'placeholder' : 'ok';
    }

    let storage = 'ok';
    try {
      const accounts = await store.T.accounts();
      for await (const _ of accounts.listEntities({ queryOptions: { select: ['RowKey'] } })) break; // eslint-disable-line no-unused-vars
    } catch (err) {
      context.error('Storage check failed', err);
      storage = 'error';
    }

    const healthy = storage === 'ok' && keyVaultReferences.SCIM_BEARER_TOKEN === 'ok';
    return {
      status: healthy ? 200 : 503,
      jsonBody: {
        status: healthy ? 'ok' : 'degraded',
        time: new Date().toISOString(),
        app: process.env.SCIM_APP_NAME || 'glasscliff-expenses',
        storage,
        oktaApiConfigured: okta.configured(),
        expensesAppIdSet: Boolean(process.env.OKTA_EXPENSES_APP_ID),
        keyVaultReferences,
      },
    };
  },
});
