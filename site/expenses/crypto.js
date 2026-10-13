'use strict';
const crypto = require('crypto');

// Both keys are derived from the webapp01 client secret, so no fifth secret is
// added to the deployment. Rotating that secret signs everyone out, which is fine.
function deriveKeys(secret) {
  const ikm = Buffer.from(secret, 'utf8');
  const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, 32));
  return {
    sign: derive('glasscliff-expenses-cookie-v1'),
    enc: derive('glasscliff-expenses-tokens-v1'),
  };
}

function sign(key, obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const mac = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(key, value) {
  if (typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const body = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(crypto.createHmac('sha256', key).update(body).digest('base64url'));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// AES-256-GCM so refresh and ID tokens are never stored in the table in the clear.
function encrypt(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

function decrypt(key, value) {
  try {
    const buf = Buffer.from(value, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

const random = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { deriveKeys, sign, unsign, encrypt, decrypt, random, pkceChallenge, safeEqual };
