'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const H = require('./helpers');
const C = require('../lib/config');
const ML = require('../lib/mail');

process.env.BB_MS_CLIENT_ID = 'client-id-test';
process.env.BB_MS_CLIENT_SECRET = 'client-secret-test';

const user = { id: '1', username: 'admin', name: 'Admin A' };

/** Microsoft Graph stand-in: two emails — a vendor's bill (PDF + signature logo) and an unrelated PDF */
function fakeGraph() {
  const calls = [];
  let refreshFails = false;
  const http = {
    calls,
    failRefresh() { refreshFails = true; },
    async post(url, body) {
      calls.push(`POST ${url.split('?')[0]}`);
      if (/oauth2\/v2.0\/token/.test(url)) {
        if (String(body).includes('grant_type=refresh_token') && refreshFails) throw Object.assign(new Error('400'), { response: { data: { error: 'invalid_grant' } } });
        return { data: { access_token: 'at-' + calls.length, refresh_token: 'rt-secret-value', expires_in: 3600 } };
      }
      throw new Error(`unexpected POST ${url}`);
    },
    async get(url, cfg = {}) {
      calls.push(`GET ${url.split('?')[0]}`);
      if (url.endsWith('/me')) return { data: { mail: 'asha@devx.work' } };
      if (/\/me\/messages\?/.test(url)) {
        return { data: { value: [
          { id: 'msgA', internetMessageId: '<a@x>', subject: 'Invoice CC/120 for October', from: { emailAddress: { name: 'Clean Co', address: 'billing@cleanco.in' } }, receivedDateTime: '2026-11-05T10:00:00Z', bodyPreview: 'Please find attached' },
          { id: 'msgB', internetMessageId: '<b@x>', subject: 'Lunch plan', from: { emailAddress: { name: 'Friend', address: 'friend@gmail.com' } }, receivedDateTime: '2026-11-05T11:00:00Z', bodyPreview: 'menu attached' },
        ] } };
      }
      const att = url.match(/\/messages\/(msg\w)\/attachments$/);
      if (att) {
        return { data: { value: att[1] === 'msgA'
          ? [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'CC-120.pdf', contentType: 'application/pdf', size: 50000, isInline: false },
             { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a2', name: 'logo.png', contentType: 'image/png', size: 4000, isInline: true }]
          : [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'b1', name: 'menu.pdf', contentType: 'application/pdf', size: 30000, isInline: false }] } };
      }
      const val = url.match(/\/messages\/(msg\w)\/attachments\/(\w+)\/\$value$/);
      if (val) return { data: H.pdf(`${val[1]}-${val[2]}`) };
      throw new Error(`unexpected GET ${url}`);
    },
  };
  return http;
}

async function connectedMember(env, http) {
  await H.seedConfig();
  const mail = ML.create({ store: env.store, pipeline: env.pipeline, files: env.files, lookups: env.lookups, http, log: { error() {} } });
  const cfg = C.merge((await env.store.snapshot()).doc('bb_config'));
  const url = mail.authUrl(cfg.team[0], 'http://localhost:3002/api/bill-booking/oauth/callback', user);
  assert.match(url, /client_id=client-id-test/); assert.match(url, /Mail.Read/); assert.ok(!/client-secret/.test(url));
  const state = new URL(url).searchParams.get('state');
  const r = await mail.completeAuth(state, 'code-1', 'http://localhost:3002/api/bill-booking/oauth/callback');
  assert.equal(r.account, 'asha@devx.work');
  return mail;
}

test('mailbox: sign-in stores only a sealed token; polling collects the bill and lists what it skipped', async () => {
  const env = H.setup();
  const http = fakeGraph();
  const mail = await connectedMember(env, http);
  const snap = await env.store.snapshot();
  assert.ok(!JSON.stringify(snap.doc('bb_secrets')).includes('rt-secret-value'), 'refresh token is encrypted at rest');
  assert.equal(C.merge(snap.doc('bb_config')).team[0].connection.status, 'connected');

  const [res] = await mail.pollAll();
  await env.pipeline.idle();
  assert.equal(res.ingested, 1); assert.equal(res.skipped, 1); assert.equal(res.error, '');
  const bills = (await env.store.snapshot()).bills;
  assert.equal(bills.length, 1);
  assert.equal(bills[0].source, 'email'); assert.equal(bills[0].source_ref.mailbox, 'asha@devx.work');
  assert.equal(bills[0].source_ref.subject, 'Invoice CC/120 for October'); assert.equal(bills[0].member_id, 'm1');
  assert.equal(bills[0].status, 'ready');
  const m = (await env.store.snapshot()).doc('bb_mail');
  assert.equal(m.skipped[0].name, 'menu.pdf'); assert.match(m.skipped[0].reason, /No bill words/);
  assert.equal(m.cursors.m1.since, '2026-11-05T11:00:00Z');

  // the next check sees the same emails again (inclusive cursor): nothing is added twice
  const [res2] = await mail.pollAll();
  assert.equal(res2.ingested, 0); assert.equal(res2.existing, 1);
  assert.equal((await env.store.snapshot()).bills.length, 1);

  // a skipped attachment can still be processed on request
  await mail.processSkipped(m.skipped[0].key, user);
  await env.pipeline.idle();
  assert.equal((await env.store.snapshot()).bills.length, 2);
  assert.equal((await env.store.snapshot()).doc('bb_mail').skipped.length, 0);
  assert.ok(!JSON.stringify((await env.store.snapshot()).doc('bb_mail')).includes('rt-secret-value'));
});

test('mailbox: a revoked sign-in shows as an error to reconnect, not a silent stop', async () => {
  const env = H.setup();
  const http = fakeGraph();
  const mail = await connectedMember(env, http);
  // expire the stored access token so the next poll must refresh
  const SEC = require('../lib/secrets');
  await env.store.tx(async t => {
    const s = { ...t.doc('bb_secrets') };
    const box = SEC.open(s.m1); box.expires_at = 0; s.m1 = SEC.seal(box);
    t.setDoc('bb_secrets', s);
  });
  http.failRefresh();
  const [res] = await mail.pollAll();
  assert.match(res.error, /reconnect/);
  const m = C.merge((await env.store.snapshot()).doc('bb_config')).team[0];
  assert.equal(m.connection.status, 'error'); assert.match(m.connection.last_error, /reconnect/);
});

// ── API: rights, upload, files, errors ───────────────────────────────────────
const USERS = [
  { id: '1', username: 'admin', name: 'Admin A', role: 'admin', active: true },
  { id: '2', username: 'viewer', name: 'Vee', role: 'user', active: true, permissions: { bill_booking: { enabled: true, sections: {} } } },
  { id: '3', username: 'rev', name: 'Rev', role: 'user', active: true, permissions: { bill_booking: { enabled: true, sections: { bb_review: true } } } },
  { id: '4', username: 'none', name: 'No', role: 'user', active: true, permissions: { sales: { enabled: true, sections: {} } } },
];

async function api() {
  const env = H.setup();
  await H.seedConfig();
  const router = require('..');
  router.init({ zc: env.zc, lookups: env.lookups, files: env.files, extractFn: H.fakeExtract({ '*': {} }), loadUsers: async () => USERS, http: fakeGraph(), log: { error() {} } });
  const app = express();
  app.use(express.json());
  app.use('/api/bill-booking', (req, res, next) => { if (req.headers['x-user']) req.user = { id: req.headers['x-user'] }; next(); }, router);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/bill-booking`;
  const call = (who, method, path, body) => fetch(base + path, {
    method, headers: { 'x-user': who, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  return { env, server, call, base, router };
}

test('API: rights per user, upload, original file, edits and drafts', async () => {
  const { env, server, call } = await api();
  try {
    assert.equal((await call('4', 'GET', '/meta')).status, 403, 'module not ticked → no access (even though old users default to "allowed")');
    const meta = await (await call('2', 'GET', '/meta')).json();
    assert.equal(meta.rights.review, false); assert.equal(meta.team[0].email, 'asha@devx.work');
    assert.ok(!JSON.stringify(meta).includes('client-secret-test'), 'no app secret in the response');

    const fd = new FormData();
    fd.append('company', 'devx');
    fd.append('member_id', 'm1');
    fd.append('erp_ref', 'ERP-77');
    fd.append('files', new Blob([H.pdf('erp')], { type: 'application/pdf' }), 'erp-bill.pdf');
    fd.append('files', new Blob(['hello'], { type: 'text/plain' }), 'notes.txt');
    assert.equal((await call('2', 'POST', '/upload', fd)).status, 403, 'viewers cannot upload');
    const up = await (await call('3', 'POST', '/upload', fd)).json();
    assert.equal(up.files.length, 2);
    assert.ok(up.files[0].id); assert.match(up.files[1].error, /only PDF and image/);
    await env.pipeline.idle();

    const list = await (await call('2', 'GET', '/bills')).json();
    assert.equal(list.rows.length, 1);
    const row = list.rows[0];
    assert.equal(row.source, 'erp_upload'); assert.equal(row.source_ref, 'ERP-77'); assert.equal(row.status, 'ready');
    assert.equal(row.account, 'Housekeeping Expenses'); assert.match(row.account_basis, /Similar to/);

    const f = await call('2', 'GET', `/file/${row.id}`);
    assert.equal(f.status, 200); assert.equal(f.headers.get('content-type'), 'application/pdf');
    assert.match(Buffer.from(await f.arrayBuffer()).toString(), /%PDF/);

    assert.equal((await call('2', 'PUT', `/bills/${row.id}`, { fields: { due_date: '2026-12-01' } })).status, 403);
    const ed = await (await call('3', 'PUT', `/bills/${row.id}`, { fields: { due_date: '01/12/2026' } })).json();
    assert.equal(ed.bill.fields.due_date, '2026-12-01');
    assert.equal(ed.bill.audit.at(-1).by, 'Rev');
    const badEdit = await call('3', 'PUT', `/bills/${row.id}`, { fields: { vendor_gstin: 'NOTAGSTIN' } });
    assert.equal(badEdit.status, 400); assert.match((await badEdit.json()).error, /not a valid GSTIN/);

    assert.equal((await call('3', 'POST', `/bills/${row.id}/draft`)).status, 403, 'reviewers need the draft right');
    assert.equal((await call('3', 'POST', '/zoho/draft-test', { company: 'devx', vendor_id: 'v_hk', account_id: 'acc_hk' })).status, 403);
    const blocked = await call('1', 'POST', `/bills/${row.id}/draft`);
    assert.equal(blocked.status, 409); assert.match((await blocked.json()).error, /draft test/);
    const t = await (await call('1', 'POST', '/zoho/draft-test', { company: 'devx', vendor_id: 'v_hk', account_id: 'acc_hk' })).json();
    assert.equal(t.verified, true);
    const d = await (await call('1', 'POST', `/bills/${row.id}/draft`)).json();
    assert.equal(d.row.status, 'draft_created'); assert.ok(d.row.zoho_url);

    const cat = await call('1', 'PUT', '/config/categories', { categories: [{ name: 'X', fields: [{ label: 'Y', type: 'dropdown', options: [] }] }] });
    assert.equal(cat.status, 400);
    const team = await call('1', 'POST', '/config/team', { name: 'Ravi', email: 'ravi@devx.work', provider: 'gmail', companies: ['devx'], categories: ['amc'] });
    const ravi = (await team.json()).member;
    assert.equal(ravi.connection.status, 'not_connected');
    const conn = await call('1', 'POST', `/config/team/${ravi.id}/connect`);
    assert.equal(conn.status, 409); assert.match((await conn.json()).error, /not set up on the server/);
    const ms = await (await call('1', 'POST', '/config/team/m1/connect')).json();
    assert.match(ms.url, /^https:\/\/login\.microsoftonline\.com\//);
  } finally { server.close(); }
});

test('API: the mailbox sign-in callback rejects a forged state', async () => {
  const { server, base } = await api();
  try {
    const r = await fetch(`${base}/oauth/callback?state=forged.state&code=x`);
    assert.equal(r.status, 400);
    assert.match(await r.text(), /expired/);
  } finally { server.close(); }
});
