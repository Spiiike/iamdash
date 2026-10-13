'use strict';
/*
 * Public view of lifecycle operations. ALLOWLIST: every field the browser
 * receives is copied here explicitly and validated; nothing is passed through.
 * Free text (summary, step detail, error) is scrubbed of emails, Okta ids and
 * UUIDs. People become stable pseudonyms (HMAC of the lower-case login with a
 * server-side key), so hire -> transfer -> terminate of one person lines up
 * without revealing who it is. A plain hash would not do: common emails could
 * be guessed and hashed to match.
 */
const crypto = require('crypto');

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const OKTA_ID = /\b0[0-9a-z]{2}[0-9A-Za-z]{14,24}\b/g; // 00u…, 0oa…, 00g… (real ones are 20 chars; wider on purpose)
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const TYPES = new Set(['hire', 'transfer', 'terminate']);
const STATUSES = new Set(['running', 'succeeded', 'failed', 'awaiting_scim', 'pending']);
const OUTCOMES = new Set(['succeeded', 'failed', 'skipped', 'pending', 'running']);
const STEP_NAME = /^[a-z][a-zA-Z]*(\.[A-Za-z_]+){1,6}$/;
const OP_ID = /^\d{13}-[0-9a-f]{6}$/;
const MAX_TEXT = 300;

function createMasker(secret) {
  const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(String(secret)), Buffer.alloc(0), 'glasscliff-dashboard-pseudonym-v1', 32));
  const pseudonym = (email) => `person-${crypto.createHmac('sha256', key).update(String(email).toLowerCase()).digest('hex').slice(0, 6)}`;

  const scrub = (text) => {
    if (text === undefined || text === null) return undefined;
    return String(text)
      .replace(EMAIL, (m) => pseudonym(m))
      .replace(OKTA_ID, '(hidden)')
      .replace(UUID, '(hidden)')
      .replace(/[<>]/g, '') // no markup, ever; the page uses textContent but other consumers might not
      .slice(0, MAX_TEXT);
  };
  const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : undefined);
  const pick = (v, set, fallback) => (set.has(v) ? v : fallback);

  function step(s) {
    return {
      seq: num(s.seq),
      step: STEP_NAME.test(String(s.step)) ? s.step : 'step',
      outcome: pick(s.outcome, OUTCOMES, 'unknown'),
      detail: scrub(s.detail),
      durationMs: num(s.durationMs),
      started: iso(s.started),
    };
  }

  function scim(s) {
    return {
      step: STEP_NAME.test(String(s.step)) ? s.step : 'scim.call',
      httpStatus: num(s.httpStatus),
      outcome: pick(s.outcome, OUTCOMES, 'unknown'),
      at: iso(s.at),
      sessionsEnded: num(s.sessionsEnded),
      evidenceRecorded: Boolean(s.evidenceBlob), // the path itself is not shown
    };
  }

  function operation(op, { withSteps = false } = {}) {
    if (!op || !OP_ID.test(String(op.operationId))) return null;
    const out = {
      operationId: op.operationId,
      type: pick(op.type, TYPES, 'operation'),
      person: op.target ? pseudonym(op.target) : undefined,
      status: pick(op.status, STATUSES, 'unknown'),
      summary: scrub(op.summary),
      error: scrub(op.error),
      created: iso(op.created),
      updated: iso(op.updated),
    };
    if (withSteps) {
      out.steps = Array.isArray(op.steps) ? op.steps.slice(0, 50).map(step) : [];
      out.scim = Array.isArray(op.scim) ? op.scim.slice(0, 50).map(scim) : [];
    }
    return out;
  }

  return { operation, pseudonym, scrub };
}

module.exports = { createMasker, OP_ID };
