/**
 * Microsoft sign-in for the OneDrive folder engine (OAuth 2.0 authorisation code flow, delegated permissions).
 *
 * The company's Microsoft 365 administrator registers ONE app (it can be the same registration as the email reminders /
 * Bill Collection mailboxes) and puts its details in the environment — never in a chat, a task or the code:
 *   C2_MS_TENANT_ID / C2_MS_CLIENT_ID / C2_MS_CLIENT_SECRET   (falls back to MAIL_MS_* and then BB_MS_* if those are set)
 * Permissions (delegated): offline_access, Files.ReadWrite, User.Read — the signed-in person's own OneDrive only.
 * Redirect URI to register: <dashboard address>/api/compliance2/onedrive/callback (http://localhost:3002/… on the office PC).
 *
 * After the one sign-in, only a REFRESH TOKEN is kept — encrypted (AES-256-GCM) in the module's store. No password is ever
 * asked for or stored. If the sign-in is revoked (password change, admin action, "sign out everywhere"), the engine stops
 * and the screen asks for a new sign-in.
 */

'use strict';

const crypto = require('crypto');

const NAMES = {
  tenant: ['C2_MS_TENANT_ID', 'MAIL_MS_TENANT_ID', 'BB_MS_TENANT_ID'],
  id: ['C2_MS_CLIENT_ID', 'MAIL_MS_CLIENT_ID', 'BB_MS_CLIENT_ID'],
  secret: ['C2_MS_CLIENT_SECRET', 'MAIL_MS_CLIENT_SECRET', 'BB_MS_CLIENT_SECRET'],
};
const SCOPES = 'offline_access Files.ReadWrite User.Read';

function create({ env = process.env, http = require('axios') } = {}) {
  const conf = () => Object.fromEntries(Object.entries(NAMES).map(([k, names]) => [k, String(names.map(n => env[n]).find(Boolean) || '').trim()]));
  /** What the screen shows: whether the app registration is configured — never a credential */
  function status() {
    const c = conf();
    return { configured: !!(c.tenant && c.id && c.secret), missing: Object.entries(NAMES).filter(([k]) => !c[k]).map(([, n]) => n[0]), scopes: SCOPES };
  }
  const key = () => {
    const base = /^[0-9a-f]{64}$/i.test(env.C2_FILE_KEY || '') ? Buffer.from(env.C2_FILE_KEY, 'hex') : env.JWT_SECRET;
    if (!base) throw new Error('C2_FILE_KEY or JWT_SECRET must be set to keep a Microsoft sign-in');
    return Buffer.from(crypto.hkdfSync('sha256', base, 'compliance2', 'onedrive-refresh-token', 32));
  };
  function seal(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return { v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  function open(box) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(box.iv, 'base64'));
      d.setAuthTag(Buffer.from(box.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
    } catch (_) { return null; }
  }
  const stateKey = () => Buffer.from(crypto.hkdfSync('sha256', env.JWT_SECRET || 'x', 'compliance2', 'onedrive-oauth-state', 32));
  function signState(payload, ttlMs = 15 * 60000) {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', stateKey()).update(body).digest('base64url')}`;
  }
  function readState(s) {
    const [body, sig] = String(s || '').split('.');
    if (!body || !sig) return null;
    const want = crypto.createHmac('sha256', stateKey()).update(body).digest('base64url');
    if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
    try { const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); return p.exp > Date.now() ? p : null; } catch (_) { return null; }
  }
  function authorizeUrl({ redirectUri, state }) {
    const c = conf();
    const q = new URLSearchParams({ client_id: c.id, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query', scope: SCOPES, state, prompt: 'select_account' });
    return `https://login.microsoftonline.com/${encodeURIComponent(c.tenant)}/oauth2/v2.0/authorize?${q}`;
  }
  async function token(form) {
    const c = conf();
    try {
      const r = await http.post(`https://login.microsoftonline.com/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`,
        new URLSearchParams({ client_id: c.id, client_secret: c.secret, scope: SCOPES, ...form }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
      return r.data;
    } catch (e) {
      const d = e.response?.data || {};
      const err = new Error(`Microsoft sign-in: ${d.error_description?.split('\r\n')[0] || d.error || e.message}`);
      err.code = d.error || '';
      if (['invalid_grant', 'interaction_required', 'consent_required'].includes(d.error)) err.revoked = true;
      throw err;
    }
  }
  const exchangeCode = ({ code, redirectUri }) => token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const refresh = refreshToken => token({ grant_type: 'refresh_token', refresh_token: refreshToken });

  /**
   * An access-token getter backed by the stored (encrypted) refresh token. io: { read(), save(patch) }.
   * Microsoft may rotate the refresh token: the new one is stored. A revoked sign-in marks the connection "revoked".
   */
  function tokenGetter(io) {
    let cached = null;
    return async function getToken() {
      if (cached && cached.exp > Date.now() + 60000) return cached.token;
      const doc = await io.read();
      if (!doc?.sealed || doc.status === 'revoked') throw Object.assign(new Error('OneDrive is not connected (sign in again in Document Folders)'), { revoked: true, status: 401 });
      const rt = open(doc.sealed);
      if (!rt) throw Object.assign(new Error('The stored Microsoft sign-in cannot be read (the key changed?) — sign in again'), { revoked: true, status: 401 });
      try {
        const t = await refresh(rt);
        cached = { token: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
        if (t.refresh_token && t.refresh_token !== rt) await io.save({ sealed: seal(t.refresh_token), refreshed_at: new Date().toISOString() });
        return cached.token;
      } catch (e) {
        if (e.revoked) await io.save({ status: 'revoked', revoked_at: new Date().toISOString(), last_error: e.message });
        throw Object.assign(e, { status: 401 });
      }
    };
  }

  return { status, seal, open, signState, readState, authorizeUrl, exchangeCode, refresh, tokenGetter, SCOPES };
}

module.exports = { create, NAMES, SCOPES };
