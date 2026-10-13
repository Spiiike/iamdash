'use strict';
// SCIM 2.0 endpoint for the mock "Glasscliff Expenses" app.
// Okta (the provisioning client) calls:  https://<func>/api/scim/v2/...
//   GET    /ServiceProviderConfig, /ResourceTypes, /Schemas
//   GET    /Users?filter=userName eq "x"&startIndex=1&count=100
//   GET    /Users/{id}
//   POST   /Users                 (create)
//   PUT    /Users/{id}            (full profile update)
//   PATCH  /Users/{id}            (e.g. {active:false} on deactivation)
//   DELETE /Users/{id}
//   GET    /Groups                (empty list; group push not implemented yet)

const crypto = require('node:crypto');
const { app } = require('@azure/functions');
const store = require('../lib/storage');

const SCIM_CT = 'application/scim+json';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const APP = () => process.env.SCIM_APP_NAME || 'glasscliff-expenses';
const MAX_RESULTS = 200;

// ------------------------------------------------------------------ helpers
const respond = (status, body) =>
  body === undefined ? { status } : { status, headers: { 'Content-Type': SCIM_CT }, jsonBody: body };

const scimError = (status, detail, scimType) =>
  respond(status, { schemas: [ERROR_SCHEMA], status: String(status), detail, ...(scimType ? { scimType } : {}) });

function authorized(request) {
  const expected = process.env.SCIM_BEARER_TOKEN || '';
  if (!expected || store.isUnresolvedKeyVaultRef(expected)) return false;
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  if (!match) return false;
  const given = Buffer.from(match[1].trim());
  const want = Buffer.from(expected);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function baseUrl(request) {
  const url = new URL(request.url);
  return `${url.origin}/api/scim/v2`;
}

async function readBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Request body is not valid JSON.'), { status: 400, scimType: 'invalidSyntax' });
  }
}

function toResource(entity, request) {
  const resource = JSON.parse(entity.resource);
  return {
    ...resource,
    schemas: resource.schemas || [USER_SCHEMA],
    id: entity.rowKey,
    active: entity.active,
    meta: {
      resourceType: 'User',
      created: entity.created,
      lastModified: entity.lastModified,
      location: `${baseUrl(request)}/Users/${entity.rowKey}`,
    },
  };
}

// Never persist passwords or client-supplied id/meta.
function cleanIncoming(body) {
  const { password, id, meta, ...rest } = body; // eslint-disable-line no-unused-vars
  return rest;
}

function toEntity(id, resource, created) {
  const now = new Date().toISOString();
  return {
    partitionKey: APP(),
    rowKey: id,
    userName: resource.userName,
    userNameLower: String(resource.userName).toLowerCase(),
    externalId: resource.externalId || '',
    displayName: resource.displayName || [resource.name?.givenName, resource.name?.familyName].filter(Boolean).join(' '),
    email: (resource.emails || []).find((e) => e.primary)?.value || resource.emails?.[0]?.value || '',
    active: resource.active !== false,
    resource: JSON.stringify(resource),
    created: created || now,
    lastModified: now,
  };
}

async function findByUserName(userName) {
  const accounts = await store.T.accounts();
  const rows = accounts.listEntities({
    queryOptions: { filter: store.odata`PartitionKey eq ${APP()} and userNameLower eq ${String(userName).toLowerCase()}` },
  });
  for await (const row of rows) return row;
  return null;
}

async function getById(id) {
  const accounts = await store.T.accounts();
  try {
    return await accounts.getEntity(APP(), id);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

// Supports what Okta sends: userName eq "x" / externalId eq "x" / id eq "x"
function parseFilter(filter) {
  if (!filter) return null;
  const m = /^\s*(userName|externalId|id)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) throw Object.assign(new Error(`Unsupported filter: ${filter}`), { status: 400, scimType: 'invalidFilter' });
  return { attr: m[1].toLowerCase(), value: m[2].replace(/\\(.)/g, '$1') };
}

// Set a simple dotted path like "name.givenName" or "active".
function setPath(target, path, value) {
  if (/[\[\]]/.test(path)) {
    // Filtered paths (e.g. emails[type eq "work"].value) — handle the common
    // emails/phoneNumbers case by replacing the matching entry's field.
    const m = /^(\w+)\[(\w+)\s+eq\s+"([^"]*)"\]\.?(\w+)?$/.exec(path);
    if (!m) throw Object.assign(new Error(`Unsupported PATCH path: ${path}`), { status: 400, scimType: 'invalidPath' });
    const [, attr, key, keyValue, sub] = m;
    const list = Array.isArray(target[attr]) ? target[attr] : (target[attr] = []);
    let entry = list.find((e) => String(e[key]) === keyValue);
    if (!entry) list.push((entry = { [key]: keyValue }));
    if (sub) entry[sub] = value;
    else Object.assign(entry, value);
    return;
  }
  const parts = path.replace(new RegExp(`^${USER_SCHEMA}:`), '').split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) node = node[part] ??= {};
  node[parts.at(-1)] = value;
}

function removePath(target, path) {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!node[part]) return;
    node = node[part];
  }
  delete node[parts.at(-1)];
}

function applyPatch(resource, body) {
  const ops = body.Operations || body.operations;
  if (!Array.isArray(ops)) throw Object.assign(new Error('PATCH body must contain Operations.'), { status: 400, scimType: 'invalidSyntax' });
  for (const op of ops) {
    const kind = String(op.op || '').toLowerCase();
    if (kind === 'remove') {
      if (!op.path) throw Object.assign(new Error('remove requires a path'), { status: 400, scimType: 'noTarget' });
      removePath(resource, op.path);
    } else if (kind === 'add' || kind === 'replace') {
      if (op.path) setPath(resource, op.path, op.value);
      else if (op.value && typeof op.value === 'object') {
        for (const [k, v] of Object.entries(op.value)) setPath(resource, k, v);
      }
    } else {
      throw Object.assign(new Error(`Unsupported op: ${op.op}`), { status: 400, scimType: 'invalidSyntax' });
    }
  }
  if (typeof resource.active === 'string') resource.active = resource.active.toLowerCase() === 'true';
  delete resource.password;
  return resource;
}

// ------------------------------------------------------------- user handlers
async function listUsers(request) {
  const filter = parseFilter(request.query.get('filter'));
  const startIndex = Math.max(1, parseInt(request.query.get('startIndex') || '1', 10) || 1);
  const count = Math.min(MAX_RESULTS, Math.max(0, parseInt(request.query.get('count') || String(MAX_RESULTS), 10) || 0));

  const accounts = await store.T.accounts();
  let query = store.odata`PartitionKey eq ${APP()}`;
  if (filter?.attr === 'username') query = store.odata`PartitionKey eq ${APP()} and userNameLower eq ${filter.value.toLowerCase()}`;
  if (filter?.attr === 'externalid') query = store.odata`PartitionKey eq ${APP()} and externalId eq ${filter.value}`;
  if (filter?.attr === 'id') query = store.odata`PartitionKey eq ${APP()} and RowKey eq ${filter.value}`;

  const all = [];
  for await (const row of accounts.listEntities({ queryOptions: { filter: query } })) all.push(row);
  const page = all.slice(startIndex - 1, startIndex - 1 + count);

  return respond(200, {
    schemas: [LIST_SCHEMA],
    totalResults: all.length,
    startIndex,
    itemsPerPage: page.length,
    Resources: page.map((e) => toResource(e, request)),
  });
}

async function getUser(request, id) {
  const entity = await getById(id);
  return entity ? respond(200, toResource(entity, request)) : scimError(404, `User ${id} not found`);
}

async function createUser(request, body) {
  if (!body.userName) return scimError(400, 'userName is required', 'invalidValue');
  if (await findByUserName(body.userName)) return scimError(409, `User ${body.userName} already exists`, 'uniqueness');

  const id = crypto.randomUUID();
  const resource = { schemas: [USER_SCHEMA], ...cleanIncoming(body), active: body.active !== false };
  const entity = toEntity(id, resource);
  await (await store.T.accounts()).createEntity(entity);
  return { response: respond(201, toResource(entity, request)), wasActive: false, entity };
}

async function replaceUser(request, id, body) {
  const existing = await getById(id);
  if (!existing) return scimError(404, `User ${id} not found`);
  if (!body.userName) return scimError(400, 'userName is required', 'invalidValue');

  const other = await findByUserName(body.userName);
  if (other && other.rowKey !== id) return scimError(409, `userName ${body.userName} is taken`, 'uniqueness');

  const resource = { schemas: [USER_SCHEMA], ...cleanIncoming(body), active: body.active !== false };
  const entity = toEntity(id, resource, existing.created);
  await (await store.T.accounts()).updateEntity(entity, 'Replace');
  return { response: respond(200, toResource(entity, request)), wasActive: existing.active, entity };
}

async function patchUser(request, id, body) {
  const existing = await getById(id);
  if (!existing) return scimError(404, `User ${id} not found`);

  const resource = applyPatch(JSON.parse(existing.resource), body);
  const entity = toEntity(id, resource, existing.created);
  await (await store.T.accounts()).updateEntity(entity, 'Replace');
  return { response: respond(200, toResource(entity, request)), wasActive: existing.active, entity };
}

async function deleteUser(id) {
  const existing = await getById(id);
  if (!existing) return scimError(404, `User ${id} not found`);
  await (await store.T.accounts()).deleteEntity(APP(), id);
  return { response: respond(204), wasActive: existing.active, entity: { ...existing, active: false } };
}

// ------------------------------------------------------- request pipeline
// Wraps every SCIM call: auth, error mapping, evidence + OperationSteps,
// and the offboarding rule (active -> inactive ends all sessions).
async function handle(request, context, action, work) {
  const started = Date.now();
  let body;
  let result;
  let sessionsEnded = 0;

  if (!authorized(request)) {
    return scimError(401, 'Missing or invalid bearer token');
  }

  try {
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) body = await readBody(request);
    result = await work(body);
  } catch (err) {
    context.error(`SCIM ${action} failed`, err);
    result = scimError(err.status || 500, err.message || 'Internal error', err.scimType);
  }

  const response = result.response || result;
  const entity = result.entity;

  if (entity && result.wasActive && entity.active === false) {
    try {
      sessionsEnded = await store.invalidateSessions(entity.userName);
    } catch (err) {
      context.error('Session invalidation failed', err);
    }
  }

  // Evidence + step log are best-effort: never fail Okta's call because of them.
  try {
    const url = new URL(request.url);
    const evidenceBlob = await store.writeEvidence({
      app: APP(),
      action,
      request: {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        userAgent: request.headers.get('user-agent') || '',
        body,
      },
      response: { status: response.status, body: response.jsonBody },
      durationMs: Date.now() - started,
      sessionsEnded,
    });
    await store.recordStep({
      source: 'okta',
      step: `scim.${action}`,
      app: APP(),
      userName: entity?.userName || body?.userName || '',
      userNameLower: String(entity?.userName || body?.userName || '').toLowerCase(),
      accountId: entity?.rowKey || '',
      httpStatus: response.status,
      outcome: response.status < 400 ? 'succeeded' : 'failed',
      sessionsEnded,
      evidenceBlob,
      durationMs: Date.now() - started,
    });
  } catch (err) {
    context.warn('Could not write evidence/step', err);
  }

  return response;
}

// ------------------------------------------------------------------ routes
async function usersRoute(request, context) {
  const id = request.params.id;
  switch (request.method) {
    case 'GET':
      return id ? handle(request, context, 'getUser', () => getUser(request, id)) : handle(request, context, 'listUsers', () => listUsers(request));
    case 'POST':
      return id ? scimError(405, 'POST not allowed on a user resource') : handle(request, context, 'createUser', (b) => createUser(request, b));
    case 'PUT':
      return id ? handle(request, context, 'replaceUser', (b) => replaceUser(request, id, b)) : scimError(405, 'PUT requires a user id');
    case 'PATCH':
      return id ? handle(request, context, 'patchUser', (b) => patchUser(request, id, b)) : scimError(405, 'PATCH requires a user id');
    case 'DELETE':
      return id ? handle(request, context, 'deleteUser', () => deleteUser(id)) : scimError(405, 'DELETE requires a user id');
    default:
      return scimError(405, `Method ${request.method} not allowed`);
  }
}

async function groupsRoute(request) {
  if (!authorized(request)) return scimError(401, 'Missing or invalid bearer token');
  if (request.method === 'GET' && !request.params.id) {
    return respond(200, { schemas: [LIST_SCHEMA], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] });
  }
  if (request.method === 'GET') return scimError(404, 'Group not found');
  return scimError(501, 'Group provisioning is not implemented in this lab yet');
}

async function serviceProviderConfig(request) {
  if (!authorized(request)) return scimError(401, 'Missing or invalid bearer token');
  return respond(200, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: 'https://datatracker.ietf.org/doc/html/rfc7644',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      { type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'Static bearer token stored in Key Vault', primary: true },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: `${baseUrl(request)}/ServiceProviderConfig` },
  });
}

async function resourceTypes(request) {
  if (!authorized(request)) return scimError(401, 'Missing or invalid bearer token');
  return respond(200, {
    schemas: [LIST_SCHEMA],
    totalResults: 1,
    Resources: [
      { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER_SCHEMA },
    ],
  });
}

async function schemas(request) {
  if (!authorized(request)) return scimError(401, 'Missing or invalid bearer token');
  return respond(200, {
    schemas: [LIST_SCHEMA],
    totalResults: 1,
    Resources: [{ id: USER_SCHEMA, name: 'User', description: 'Glasscliff Expenses user', attributes: [] }],
  });
}

const common = { authLevel: 'anonymous' }; // auth is the SCIM bearer token, checked above
app.http('scimUsers', { ...common, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], route: 'scim/v2/Users/{id?}', handler: usersRoute });
app.http('scimGroups', { ...common, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], route: 'scim/v2/Groups/{id?}', handler: groupsRoute });
app.http('scimServiceProviderConfig', { ...common, methods: ['GET'], route: 'scim/v2/ServiceProviderConfig', handler: serviceProviderConfig });
app.http('scimResourceTypes', { ...common, methods: ['GET'], route: 'scim/v2/ResourceTypes', handler: resourceTypes });
app.http('scimSchemas', { ...common, methods: ['GET'], route: 'scim/v2/Schemas', handler: schemas });

module.exports = { usersRoute, groupsRoute, serviceProviderConfig, applyPatch, parseFilter };
