/**
 * Team mailboxes: connecting (OAuth — no mailbox passwords), and collecting bill attachments.
 *
 * Providers (app credentials in .env / Vercel settings — see server/bill-booking/README.md):
 *   microsoft      Microsoft 365 / Outlook, each team member signs in once (delegated Mail.Read).
 *   microsoft_app  Microsoft 365 via the company's app registration (application Mail.Read granted by
 *                  the tenant admin, ideally limited to the finance mailboxes) — no per-member sign-in.
 *   gmail          Google Workspace / Gmail, each member signs in once (gmail.readonly).
 * Mail access is read-only: nothing is moved, flagged, marked read or sent.
 */

'use strict';

const C = require('./config');
const SEC = require('./secrets');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BILL_WORDS = /\b(invoice|invoices|inv|bill|bills|tax\s*invoice|gst|debit\s*note|credit\s*note|payment\s*due|amount\s*due|dues|statement|soa|receipt|proforma|pro-forma|quotation|quote|rent|cam|maintenance|amc)\b/i;
const MAX_MESSAGES = 200;           // per mailbox per poll
const MIN_IMAGE_BYTES = 30 * 1024;  // smaller images are logos / signatures
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const env = k => process.env[k] || '';
const providers = {
  microsoft: { label: 'Microsoft 365 (each member signs in)', configured: () => !!(env('BB_MS_CLIENT_ID') && env('BB_MS_CLIENT_SECRET')) },
  microsoft_app: { label: 'Microsoft 365 (company app access)', configured: () => !!(env('BB_MS_CLIENT_ID') && env('BB_MS_CLIENT_SECRET') && env('BB_MS_TENANT_ID')) },
  gmail: { label: 'Google / Gmail', configured: () => !!(env('BB_GOOGLE_CLIENT_ID') && env('BB_GOOGLE_CLIENT_SECRET')) },
};

function create({ store, pipeline, files, http = require('axios'), lookups, log = console }) {
  const msTenant = () => env('BB_MS_TENANT_ID') || 'organizations';
  const form = o => new URLSearchParams(o).toString();
  const FORM = { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 };

  // ── OAuth ──────────────────────────────────────────────────────────────────
  function authUrl(member, redirectUri, user) {
    const state = SEC.signState({ m: member.id, u: user.id, p: member.provider });
    if (member.provider === 'microsoft') {
      return `https://login.microsoftonline.com/${msTenant()}/oauth2/v2.0/authorize?${form({
        client_id: env('BB_MS_CLIENT_ID'), response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
        scope: 'offline_access openid email User.Read Mail.Read', state, prompt: 'select_account', login_hint: member.email,
      })}`;
    }
    if (member.provider === 'gmail') {
      return `https://accounts.google.com/o/oauth2/v2/auth?${form({
        client_id: env('BB_GOOGLE_CLIENT_ID'), redirect_uri: redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent',
        scope: 'openid email https://www.googleapis.com/auth/gmail.readonly', state, login_hint: member.email,
      })}`;
    }
    throw Object.assign(new Error('This mailbox type has no sign-in step'), { status: 400 });
  }

  async function exchange(provider, code, redirectUri) {
    if (provider === 'microsoft') {
      const r = await http.post(`https://login.microsoftonline.com/${msTenant()}/oauth2/v2.0/token`, form({
        client_id: env('BB_MS_CLIENT_ID'), client_secret: env('BB_MS_CLIENT_SECRET'), grant_type: 'authorization_code',
        code, redirect_uri: redirectUri, scope: 'offline_access User.Read Mail.Read',
      }), FORM);
      const me = await http.get(`${GRAPH}/me`, { headers: { Authorization: `Bearer ${r.data.access_token}` }, params: { $select: 'mail,userPrincipalName' }, timeout: 30000 });
      return tokenBox(provider, r.data, (me.data.mail || me.data.userPrincipalName || '').toLowerCase());
    }
    const r = await http.post('https://oauth2.googleapis.com/token', form({
      client_id: env('BB_GOOGLE_CLIENT_ID'), client_secret: env('BB_GOOGLE_CLIENT_SECRET'), grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    }), FORM);
    const me = await http.get(`${GMAIL}/profile`, { headers: { Authorization: `Bearer ${r.data.access_token}` }, timeout: 30000 });
    return tokenBox(provider, r.data, String(me.data.emailAddress || '').toLowerCase());
  }

  const tokenBox = (provider, t, account, prev = {}) => ({
    provider, account: account || prev.account, refresh_token: t.refresh_token || prev.refresh_token,
    access_token: t.access_token, expires_at: Date.now() + ((t.expires_in || 3600) - 120) * 1000,
  });

  /** Completes the sign-in started by authUrl → the member's connection */
  async function completeAuth(state, code, redirectUri) {
    const st = SEC.readState(state);
    if (!st) throw Object.assign(new Error('The sign-in link has expired — start again from Team & Mailboxes'), { status: 400 });
    const cfg = C.merge((await store.snapshot()).doc('bb_config'));
    const member = cfg.team.find(m => m.id === st.m);
    if (!member || member.provider !== st.p) throw Object.assign(new Error('The team member was changed — start again'), { status: 400 });
    const box = await exchange(member.provider, code, redirectUri);
    if (!box.refresh_token) throw Object.assign(new Error('The provider did not grant offline access — sign in again and accept the requested access'), { status: 400 });
    const mismatch = box.account && box.account !== member.email;
    await store.tx(async t => {
      const secrets = { ...(t.doc('bb_secrets') || {}) };
      secrets[member.id] = SEC.seal(box);
      t.setDoc('bb_secrets', secrets);
      const c = C.merge(t.doc('bb_config'));
      const m = c.team.find(x => x.id === member.id);
      m.connection = { status: 'connected', account: box.account, connected_at: new Date().toISOString(), connected_by: st.u,
        warning: mismatch ? `Signed in as ${box.account}, not ${member.email}` : '' };
      t.setDoc('bb_config', c);
      const mail = { ...(t.doc('bb_mail') || {}) };
      mail.cursors = { ...(mail.cursors || {}) };
      if (!mail.cursors[member.id]) mail.cursors[member.id] = { since: new Date(Date.now() - c.settings.mail_lookback_days * 86400000).toISOString() };
      t.setDoc('bb_mail', mail);
    });
    await store.audit({ by: st.u, action: 'mailbox_connected', detail: `${member.name} <${member.email}> connected (${providers[member.provider].label})${mismatch ? ` — signed in as ${box.account}` : ''}` });
    return { member: member.name, account: box.account, mismatch };
  }

  /** microsoft_app needs no sign-in: check the app can read this mailbox, then mark it connected */
  async function connectApp(member, user) {
    const token = await appToken();
    await http.get(`${GRAPH}/users/${encodeURIComponent(member.email)}/messages`, { headers: { Authorization: `Bearer ${token}` }, params: { $top: 1, $select: 'id' }, timeout: 30000 });
    await store.tx(async t => {
      const c = C.merge(t.doc('bb_config'));
      const m = c.team.find(x => x.id === member.id);
      m.connection = { status: 'connected', account: member.email, connected_at: new Date().toISOString(), connected_by: user.id, warning: '' };
      t.setDoc('bb_config', c);
      const mail = { ...(t.doc('bb_mail') || {}) };
      mail.cursors = { ...(mail.cursors || {}) };
      if (!mail.cursors[member.id]) mail.cursors[member.id] = { since: new Date(Date.now() - c.settings.mail_lookback_days * 86400000).toISOString() };
      t.setDoc('bb_mail', mail);
    });
    await store.audit({ by: user.name || user.username, action: 'mailbox_connected', detail: `${member.name} <${member.email}> connected (company app access)` });
  }

  let _app = null;
  async function appToken() {
    if (_app && _app.expires_at > Date.now()) return _app.token;
    const r = await http.post(`https://login.microsoftonline.com/${env('BB_MS_TENANT_ID')}/oauth2/v2.0/token`, form({
      client_id: env('BB_MS_CLIENT_ID'), client_secret: env('BB_MS_CLIENT_SECRET'), grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default',
    }), FORM);
    _app = { token: r.data.access_token, expires_at: Date.now() + ((r.data.expires_in || 3600) - 120) * 1000 };
    return _app.token;
  }

  async function disconnect(memberId, user) {
    await store.tx(async t => {
      const secrets = { ...(t.doc('bb_secrets') || {}) };
      delete secrets[memberId];
      t.setDoc('bb_secrets', secrets);
      const c = C.merge(t.doc('bb_config'));
      const m = c.team.find(x => x.id === memberId);
      if (m) m.connection = { status: m.provider === 'none' ? 'not_applicable' : 'not_connected', disconnected_at: new Date().toISOString(), disconnected_by: user.name || user.username };
      t.setDoc('bb_config', c);
    });
    await store.audit({ by: user.name || user.username, action: 'mailbox_disconnected', detail: memberId });
  }

  /** A usable access token for the member (refreshed and re-sealed when needed) */
  async function accessToken(member) {
    if (member.provider === 'microsoft_app') return appToken();
    const sealed = (await store.snapshot()).doc('bb_secrets')?.[member.id];
    const box = SEC.open(sealed);
    if (!box?.refresh_token) throw Object.assign(new Error('Mailbox not connected — sign in again'), { reconnect: true });
    if (box.access_token && box.expires_at > Date.now()) return box.access_token;
    let r;
    try {
      r = member.provider === 'microsoft'
        ? await http.post(`https://login.microsoftonline.com/${msTenant()}/oauth2/v2.0/token`, form({
          client_id: env('BB_MS_CLIENT_ID'), client_secret: env('BB_MS_CLIENT_SECRET'), grant_type: 'refresh_token', refresh_token: box.refresh_token, scope: 'offline_access User.Read Mail.Read',
        }), FORM)
        : await http.post('https://oauth2.googleapis.com/token', form({
          client_id: env('BB_GOOGLE_CLIENT_ID'), client_secret: env('BB_GOOGLE_CLIENT_SECRET'), grant_type: 'refresh_token', refresh_token: box.refresh_token,
        }), FORM);
    } catch (e) {
      const code = e.response?.data?.error;
      throw Object.assign(new Error(code === 'invalid_grant' ? 'The mailbox sign-in has expired or was revoked — reconnect it' : `Token refresh failed (${code || e.message})`), { reconnect: code === 'invalid_grant' });
    }
    const next = tokenBox(member.provider, r.data, box.account, box);
    await store.tx(async t => { const s = { ...(t.doc('bb_secrets') || {}) }; s[member.id] = SEC.seal(next); t.setDoc('bb_secrets', s); });
    return next.access_token;
  }

  // ── Reading messages ───────────────────────────────────────────────────────
  async function graphMessages(member, token, since) {
    const base = member.provider === 'microsoft_app' ? `${GRAPH}/users/${encodeURIComponent(member.email)}` : `${GRAPH}/me`;
    const H = { headers: { Authorization: `Bearer ${token}` }, timeout: 60000 };
    let url = `${base}/messages?${form({
      $filter: `receivedDateTime ge ${since} and hasAttachments eq true`, $orderby: 'receivedDateTime asc', $top: '25',
      $select: 'id,internetMessageId,subject,from,receivedDateTime,bodyPreview,conversationId',
    })}`;
    const out = [];
    while (url && out.length < MAX_MESSAGES) {
      const r = await http.get(url, H);
      for (const m of r.data.value || []) {
        out.push({
          id: m.id, internet_id: m.internetMessageId, conversation_id: m.conversationId, subject: m.subject || '',
          from: m.from?.emailAddress?.name ? `${m.from.emailAddress.name} <${m.from.emailAddress.address}>` : (m.from?.emailAddress?.address || ''),
          from_address: String(m.from?.emailAddress?.address || '').toLowerCase(), received_at: m.receivedDateTime, body: m.bodyPreview || '',
          attachments: async () => {
            const a = await http.get(`${base}/messages/${m.id}/attachments`, { ...H, params: { $select: 'id,name,contentType,size,isInline' } });
            return (a.data.value || []).filter(x => x['@odata.type'] === '#microsoft.graph.fileAttachment').map(x => ({
              id: x.id, name: x.name, type: x.contentType, size: x.size, inline: !!x.isInline,
              content: async () => Buffer.from((await http.get(`${base}/messages/${m.id}/attachments/${x.id}/$value`, { ...H, responseType: 'arraybuffer' })).data),
            }));
          },
        });
      }
      url = r.data['@odata.nextLink'] || null;
    }
    return out;
  }

  async function gmailMessages(member, token, since) {
    const H = { headers: { Authorization: `Bearer ${token}` }, timeout: 60000 };
    const after = Math.floor(Date.parse(since) / 1000);
    const ids = [];
    let pageToken;
    do {
      const r = await http.get(`${GMAIL}/messages`, { ...H, params: { q: `has:attachment after:${after} -in:sent -in:chats`, maxResults: 100, pageToken } });
      ids.push(...(r.data.messages || []).map(m => m.id));
      pageToken = r.data.nextPageToken;
    } while (pageToken && ids.length < MAX_MESSAGES);
    const out = [];
    for (const id of ids.slice(0, MAX_MESSAGES)) {
      const m = (await http.get(`${GMAIL}/messages/${id}`, { ...H, params: { format: 'full' } })).data;
      const hdr = n => (m.payload?.headers || []).find(h => h.name.toLowerCase() === n)?.value || '';
      const parts = [];
      const walk = p => { if (!p) return; if (p.filename && p.body?.attachmentId) parts.push(p); (p.parts || []).forEach(walk); };
      walk(m.payload);
      const from = hdr('from');
      out.push({
        id, internet_id: hdr('message-id'), conversation_id: m.threadId, subject: hdr('subject'), from,
        from_address: ((from.match(/<([^>]+)>/) || [])[1] || from).toLowerCase().trim(),
        received_at: new Date(Number(m.internalDate)).toISOString(), body: m.snippet || '',
        attachments: async () => parts.map(p => ({
          id: p.body.attachmentId, name: p.filename, type: p.mimeType, size: p.body.size || 0,
          inline: (p.headers || []).some(h => h.name.toLowerCase() === 'content-disposition' && /inline/i.test(h.value)),
          content: async () => Buffer.from((await http.get(`${GMAIL}/messages/${id}/attachments/${p.body.attachmentId}`, H)).data.data, 'base64url'),
        })),
      });
    }
    return out.sort((a, b) => a.received_at.localeCompare(b.received_at));
  }

  // ── Poll ───────────────────────────────────────────────────────────────────
  let polling = null;
  function pollAll(opts = {}) {
    if (!polling) polling = _pollAll(opts).finally(() => { polling = null; });
    return polling;
  }

  async function _pollAll({ memberId = null, by = 'system' } = {}) {
    const cfg = C.merge((await store.snapshot()).doc('bb_config'));
    const members = cfg.team.filter(m => m.active && m.connection?.status === 'connected' && providers[m.provider]?.configured() && (!memberId || m.id === memberId));
    const results = [];
    for (const m of members) results.push(await pollMember(m, cfg, by));
    return results;
  }

  async function vendorEmails(member) {
    const set = new Set();
    for (const co of member.companies || []) {
      try { for (const v of await lookups.vendors(co)) if (v.email) set.add(String(v.email).toLowerCase()); } catch (_) {}
    }
    return set;
  }

  async function pollMember(member, cfg, by) {
    const started = new Date().toISOString();
    const res = { member_id: member.id, member: member.name, at: started, messages: 0, attachments: 0, ingested: 0, skipped: 0, existing: 0, error: '' };
    const mailDoc = (await store.snapshot()).doc('bb_mail') || {};
    const since = mailDoc.cursors?.[member.id]?.since || new Date(Date.now() - cfg.settings.mail_lookback_days * 86400000).toISOString();
    let latest = since;
    const skipped = [];
    try {
      const token = await accessToken(member);
      const msgs = member.provider === 'gmail' ? await gmailMessages(member, token, since) : await graphMessages(member, token, since);
      const vendorsMail = cfg.settings.mail_scope === 'likely_bills' ? await vendorEmails(member) : new Set();
      for (const msg of msgs) {
        res.messages++;
        if (msg.received_at > latest) latest = msg.received_at;
        if (msg.from_address && msg.from_address === member.email) continue;   // sent by the member
        let atts = [];
        try { atts = await msg.attachments(); } catch (e) { res.error = `Attachments of "${msg.subject}" could not be read: ${e.message}`; continue; }
        for (const a of atts) {
          const mime = files.mimeOf(a.name, a.type);
          if (!files.ACCEPTED.has(mime)) continue;
          if (mime.startsWith('image/') && (a.inline || a.size < MIN_IMAGE_BYTES)) continue;
          res.attachments++;
          const ref = { mailbox: member.email, member_id: member.id, provider: member.provider, message_id: msg.id, internet_message_id: msg.internet_id,
            conversation_id: msg.conversation_id, received_at: msg.received_at, from: msg.from, from_address: msg.from_address, subject: msg.subject,
            body_preview: String(msg.body).slice(0, 2000), attachment_id: a.id };
          const likely = BILL_WORDS.test(msg.subject) || BILL_WORDS.test(a.name) || BILL_WORDS.test(msg.body) || vendorsMail.has(msg.from_address);
          if (cfg.settings.mail_scope === 'likely_bills' && !likely) {
            skipped.push({ key: `${member.id}:${msg.id}:${a.id}`.slice(0, 400), ...ref, name: a.name, size: a.size, type: mime, at: started, reason: 'No bill words in the subject, file name or text, and the sender is not a Zoho vendor' });
            res.skipped++;
            continue;
          }
          if (a.size > MAX_FILE_BYTES) {
            skipped.push({ key: `${member.id}:${msg.id}:${a.id}`.slice(0, 400), ...ref, name: a.name, size: a.size, type: mime, at: started, reason: 'File larger than 25 MB' });
            res.skipped++;
            continue;
          }
          const buffer = await a.content();
          const r = await pipeline.ingest({ buffer, name: a.name, mime, source: 'email', source_ref: ref, member_id: member.id, by: 'mailbox' });
          if (r.existed) res.existing++; else res.ingested++;
        }
      }
    } catch (e) {
      res.error = e.message;
      log.error(`[bill-booking] mailbox ${member.email}: ${e.message}`);
      if (e.reconnect) {
        await store.tx(async t => {
          const c = C.merge(t.doc('bb_config'));
          const m = c.team.find(x => x.id === member.id);
          if (m) m.connection = { ...m.connection, status: 'error', last_error: e.message, error_at: started };
          t.setDoc('bb_config', c);
        });
      }
    }
    await store.tx(async t => {
      const mail = { cursors: {}, log: [], skipped: [], ...(t.doc('bb_mail') || {}) };
      mail.cursors = { ...mail.cursors, [member.id]: { since: res.error && !res.messages ? since : latest, last_poll: started, last_error: res.error } };
      mail.log = [res, ...(mail.log || [])].slice(0, 300);
      const known = new Set((mail.skipped || []).map(s => s.key));
      mail.skipped = [...skipped.filter(s => !known.has(s.key)), ...(mail.skipped || [])].slice(0, 1000);
      t.setDoc('bb_mail', mail);
      const c = C.merge(t.doc('bb_config'));
      const m = c.team.find(x => x.id === member.id);
      if (m && m.connection?.status === 'connected') { m.connection = { ...m.connection, last_poll: started, last_error: res.error }; t.setDoc('bb_config', c); }
    });
    return res;
  }

  /** A skipped attachment the team wants read after all */
  async function processSkipped(key, user) {
    const mail = (await store.snapshot()).doc('bb_mail') || {};
    const s = (mail.skipped || []).find(x => x.key === key);
    if (!s) throw Object.assign(new Error('That skipped attachment is no longer listed'), { status: 404 });
    const cfg = C.merge((await store.snapshot()).doc('bb_config'));
    const member = cfg.team.find(m => m.id === s.member_id);
    if (!member) throw Object.assign(new Error('The team member no longer exists'), { status: 400 });
    const token = await accessToken(member);
    let buffer;
    if (member.provider === 'gmail') {
      buffer = Buffer.from((await http.get(`${GMAIL}/messages/${s.message_id}/attachments/${s.attachment_id}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 60000 })).data.data, 'base64url');
    } else {
      const base = member.provider === 'microsoft_app' ? `${GRAPH}/users/${encodeURIComponent(member.email)}` : `${GRAPH}/me`;
      buffer = Buffer.from((await http.get(`${base}/messages/${s.message_id}/attachments/${s.attachment_id}/$value`, { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer', timeout: 60000 })).data);
    }
    const { key: _k, name, size: _s, type, at: _a, reason: _r, ...ref } = s;
    const r = await pipeline.ingest({ buffer, name, mime: type, source: 'email', source_ref: ref, member_id: member.id, by: user.name || user.username });
    await store.tx(async t => {
      const m = { ...(t.doc('bb_mail') || {}) };
      m.skipped = (m.skipped || []).filter(x => x.key !== key);
      t.setDoc('bb_mail', m);
    });
    return r;
  }

  return { providers, authUrl, completeAuth, connectApp, disconnect, pollAll, pollMember, processSkipped };
}

module.exports = { create, providers };
