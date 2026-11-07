/**
 * Mailbox tokens at rest: AES-256-GCM. Key = BB_TOKEN_KEY (64 hex characters), or — when it is not
 * set — derived from JWT_SECRET (changing JWT_SECRET then means reconnecting the mailboxes).
 * Tokens never leave the server: no route returns them and errors are logged without them.
 */

'use strict';

const crypto = require('crypto');

function key() {
  const k = process.env.BB_TOKEN_KEY;
  if (k && /^[0-9a-f]{64}$/i.test(k)) return Buffer.from(k, 'hex');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET (or BB_TOKEN_KEY) must be set to store mailbox tokens');
  return Buffer.from(crypto.hkdfSync('sha256', process.env.JWT_SECRET, 'bill-booking', 'mailbox-token-key', 32));
}

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function open(box) {
  if (!box || box.v !== 1) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
  } catch (_) { return null; }
}

/** Signed, short-lived OAuth `state` (member + who started it) — the callback trusts nothing else */
function signState(payload, ttlMs = 15 * 60 * 1000) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  const sig = crypto.createHmac('sha256', key()).update(`state:${body}`).digest('base64url');
  return `${body}.${sig}`;
}
function readState(state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', key()).update(`state:${body}`).digest('base64url');
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p.exp > Date.now() ? p : null; } catch (_) { return null; }
}

module.exports = { seal, open, signState, readState };
