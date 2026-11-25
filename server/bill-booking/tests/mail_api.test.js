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
// email times inside the 7-day first-check window, whenever the tests run (fixed dates went stale on 12 Nov 2026)
const day0 = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
const T1 = `${day0}T10:00:00Z`, T2 = `${day0}T11:00:00Z`;

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
          { id: 'msgA', internetMessageId: '<a@x>', subject: 'Invoice CC/120 for October', from: { emailAddress: { name: 'Clean Co', address: 'billing@cleanco.in' } }, receivedDateTime: T1, bodyPreview: 'Please find attached' },
          { id: 'msgB', internetMessageId: '<b@x>', subject: 'Lunch plan', from: { emailAddress: { name: 'Friend', address: 'friend@gmail.com' } }, receivedDateTime: T2, bodyPreview: 'menu attached' },
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
  assert.equal(m.cursors.m1.since, T2);

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

async function api(http = fakeGraph()) {
  const env = H.setup();
  await H.seedConfig();
  const router = require('..');
  router.init({ zc: env.zc, lookups: env.lookups, files: env.files, extractFn: H.fakeExtract({ '*': {} }), loadUsers: async () => USERS, http, log: { error() {} } });
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

// ── Microsoft refusing the app (25 Nov 2026: the page showed only "Request failed with status code 401") ──
// axios ≥ 1.7 puts the HTTP status on the error itself, so it must not be mistaken for the module's own messages
const axiosErr = (status, data) => Object.assign(new Error(`Request failed with status code ${status}`), { isAxiosError: true, status, response: { status, data } });
const BAD_SECRET = axiosErr(401, {
  error: 'invalid_client',
  error_description: "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app 'abc'. Trace ID: 1111 Correlation ID: 2222 Timestamp: 2026-11-25 06:00:00Z",
});
function refusingGraph(err = BAD_SECRET) {
  const http = fakeGraph();
  const post = http.post;
  http.bodies = [];
  http.post = async (url, body) => { http.bodies.push(String(body)); if (/oauth2\/v2.0\/token/.test(url)) throw err; return post(url, body); };
  return http;
}

test('mailbox: a refused code exchange says why (Microsoft\'s reason + what to fix), without trace ids', async () => {
  const env = H.setup();
  await H.seedConfig();
  const http = refusingGraph();
  const mail = ML.create({ store: env.store, pipeline: env.pipeline, files: env.files, lookups: env.lookups, http, log: { error() {} } });
  const cfg = C.merge((await env.store.snapshot()).doc('bb_config'));
  const state = new URL(mail.authUrl(cfg.team[0], 'http://localhost:3002/cb', user)).searchParams.get('state');
  await assert.rejects(mail.completeAuth(state, 'code-1', 'http://localhost:3002/cb'), e => {
    assert.equal(e.status, 400); assert.ok(!e.isAxiosError);
    assert.match(e.message, /^Microsoft refused to complete the sign-in: AADSTS7000215: Invalid client secret provided/);
    assert.match(e.message, /BB_MS_CLIENT_SECRET/); assert.match(e.message, /"Value"/);
    assert.ok(!/Trace ID|Correlation/.test(e.message)); assert.ok(!/client-secret-test/.test(e.message), 'the secret itself is never echoed');
    return true;
  });
  assert.equal(C.merge((await env.store.snapshot()).doc('bb_config')).team[0].connection?.status === 'connected', false);
});

test('mailbox: settings pasted with spaces, a line break or quotes are sent clean', async () => {
  const keep = process.env.BB_MS_CLIENT_SECRET;
  process.env.BB_MS_CLIENT_SECRET = '  "client-secret-test"\r\n';
  try {
    const env = H.setup();
    const http = fakeGraph();
    const bodies = [];
    const post = http.post;
    http.post = async (url, body) => { bodies.push(String(body)); return post(url, body); };
    await connectedMember(env, http);
    assert.match(bodies[0], /client_secret=client-secret-test&/);
  } finally { process.env.BB_MS_CLIENT_SECRET = keep; }
});

test('API: the sign-in page shows Microsoft\'s reason for a 401, not "Request failed"', async () => {
  const { server, call, base } = await api(refusingGraph());
  try {
    const { url } = await (await call('1', 'POST', '/config/team/m1/connect')).json();
    const state = new URL(url).searchParams.get('state');
    const r = await fetch(`${base}/oauth/callback?state=${encodeURIComponent(state)}&code=x`);
    const html = await r.text();
    assert.equal(r.status, 400);
    assert.match(html, /AADSTS7000215/); assert.match(html, /BB_MS_CLIENT_SECRET/);
    assert.ok(!/Request failed with status code/.test(html));
  } finally { server.close(); }
});

// ── Vercel's time limit (25 Nov 2026: "Check all now" online ran past 300 s; Vercel's own error crashed the page) ──
test('mailbox: a check with a deadline stops between emails; the next check continues from there', async () => {
  const env = H.setup();
  const http = fakeGraph();
  const mail = await connectedMember(env, http);
  const get = http.get;
  http.get = async (url, cfg) => { if (/msgA\/attachments\/a1\/\$value$/.test(url)) await new Promise(r => setTimeout(r, 120)); return get(url, cfg); };
  const [res] = await mail.pollAll({ deadline: Date.now() + 40 });
  assert.equal(res.more, true);
  assert.equal(res.messages, 1, 'the email started before the deadline is finished, the next one is not started');
  assert.equal(res.ingested, 1); assert.equal(res.skipped, 0);
  assert.equal((await env.store.snapshot()).doc('bb_mail').cursors.m1.since, T1, 'cursor stops at the last handled email');
  assert.equal((await env.store.snapshot()).doc('bb_mail').log[0].more, true);

  const [next] = await mail.pollAll();
  assert.equal(next.more, false); assert.equal(next.existing, 1); assert.equal(next.skipped, 1);
  assert.equal((await env.store.snapshot()).doc('bb_mail').cursors.m1.since, T2);

  const [late] = await mail.pollAll({ deadline: Date.now() - 1 });
  assert.equal(late.not_started, true); assert.equal(late.more, true);
  assert.equal((await env.store.snapshot()).doc('bb_mail').cursors.m1.since, T2, 'a member not started keeps its cursor');
});

// bills as Vercel leaves them when it stops a request before they are read (minutes ago)
async function unreadBills(env, n, { minutesAgo = 6 } = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const r = await env.pipeline.ingest({ buffer: H.pdf(`left-${i}`), name: `left-${i}.pdf`, mime: 'application/pdf', source: 'erp_upload', source_ref: { erp_ref: `L${i}` }, member_id: 'm1', by: 'test' });
    ids.push(r.id);
  }
  await env.pipeline.idle();
  await env.store.tx(async t => {
    ids.forEach((id, i) => {
      const b = t.bill(id);
      delete b.extraction; b.status = 'received';
      b.created_at = b.updated_at = new Date(Date.now() - (minutesAgo * 60000) - (n - i) * 1000).toISOString();
      t.putBill(b);
    });
  });
  return ids;
}
const STALE = 5 * 60000;

test('reading left unfinished by a stopped request is picked up again: one bill at a time, oldest first, with a lease', async () => {
  const env = H.setup();
  await H.seedConfig();
  const [a, b] = await unreadBills(env, 2);
  assert.equal(await env.pipeline.waitingCount(), 2);
  assert.equal(await env.pipeline.readStale({ staleMs: 10 * 60000, until: Date.now() + 120000 }), 0, 'not older than the limit → maybe still being read elsewhere');

  // only one bill's worth of time: the oldest is read, the other keeps waiting untouched
  const n = await env.pipeline.readStale({ staleMs: STALE, until: Date.now() + 1000, minLeftMs: 0 });
  assert.ok(n >= 1);
  const A = await env.store.bill(a);
  assert.notEqual(A.status, 'received', 'the oldest was read'); assert.equal(A.read_attempts, 1); assert.ok(A.read_lease);

  assert.equal(await env.pipeline.readStale({ staleMs: STALE, until: Date.now() + 120000 }), n === 1 ? 1 : 0);
  assert.notEqual((await env.store.bill(b)).status, 'received');
  assert.equal(await env.pipeline.waitingCount(), 0);

  // a call running at the same time does not take a bill another one just leased
  await env.store.tx(async t => { const x = t.bill(b); delete x.extraction; x.status = 'received'; x.updated_at = new Date(0).toISOString(); x.read_lease = new Date().toISOString(); t.putBill(x); });
  assert.equal(await env.pipeline.readStale({ staleMs: STALE, until: Date.now() + 120000 }), 0);
  // no time left → nothing is started
  await env.store.tx(async t => { const x = t.bill(b); delete x.read_lease; t.putBill(x); });
  assert.equal(await env.pipeline.readStale({ staleMs: STALE, until: Date.now() + 30000 }), 0, 'less than the 45 s margin left');
});

test('a bill that never finishes reading is set aside as Failed after 3 tries, so it cannot block the others', async () => {
  const env = H.setup();
  await H.seedConfig();
  const [stuck, other] = await unreadBills(env, 2);
  // the stuck bill has been tried 3 times already (each time Vercel stopped the request)
  await env.store.tx(async t => { const x = t.bill(stuck); x.read_attempts = 3; x.read_lease = new Date(Date.now() - 6 * 60000).toISOString(); t.putBill(x); });
  const n = await env.pipeline.readStale({ staleMs: STALE, until: Date.now() + 120000 });
  assert.equal(n, 1, 'only the other bill is read');
  const S = await env.store.bill(stuck);
  assert.equal(S.status, 'failed'); assert.match(S.processing_error, /did not finish within the online server's time limit \(3 tries\)/);
  assert.equal(S.audit.at(-1).action, 'failed');
  assert.notEqual((await env.store.bill(other)).status, 'received');

  // fewer tries go first: a bill tried twice (and older) waits behind a fresh one
  const order = [];
  const read = H.fakeExtract({ '*': {} });
  const p = require('../lib/pipeline').create({ store: env.store, zc: env.zc, lookups: env.lookups, files: env.files, log: { error() {} },
    extractFn: async (buf, mime, ctx) => { order.push(ctx.fileName); return read(buf, mime, ctx); } });
  const [twice, fresh] = await unreadBills(env, 2);
  await env.store.tx(async t => { const x = t.bill(twice); x.read_attempts = 2; t.putBill(x); });
  assert.equal(await p.readStale({ staleMs: STALE, until: Date.now() + 120000 }), 2);
  assert.deepEqual(order, ['left-1.pdf', 'left-0.pdf'], 'the fresh bill first, although the other is older');
  assert.equal((await env.store.bill(fresh)).read_attempts, 1); assert.equal((await env.store.bill(twice)).read_attempts, 3);

  // Retry clears the tries
  await env.pipeline.action(stuck, 'retry', {}, { name: 'Rev', username: 'rev' });
  const R = await env.store.bill(stuck);
  assert.equal(R.read_attempts, undefined); assert.equal(R.processing_error, undefined);
});

test('Vercel scheduler: checks the mailboxes when due, reads waiting bills, and leaves the mailboxes alone until poll_minutes have passed', async () => {
  const env = H.setup();
  const http = fakeGraph();
  await connectedMember(env, http);
  const ids = await unreadBills(env, 2);
  const router = require('..');
  router.init({ zc: env.zc, lookups: env.lookups, files: env.files, extractFn: H.fakeExtract({ '*': {} }), loadUsers: async () => USERS, http, log: { error() {} }, vercel: true });
  try {
    const r = await router.cronTick();
    assert.equal(r.ok, true);
    assert.equal(r.mail.mailboxes, 1); assert.equal(r.mail.new_bills, 1);
    assert.equal(r.waiting, 0, 'the new bill and the two left unread are all read');
    for (const id of ids) assert.notEqual((await env.store.bill(id)).status, 'received');
    assert.ok((await env.store.snapshot()).doc('bb_mail').last_auto_poll);

    const calls = http.calls.length;
    const r2 = await router.cronTick();
    assert.equal(r2.mail, null, 'checked less than poll_minutes ago → not again');
    assert.equal(http.calls.length, calls, 'Microsoft was not called');
  } finally { router.init({ vercel: false, zc: env.zc, lookups: env.lookups, files: env.files, http }); }
});

test('Vercel scheduler: the route needs the scheduler secret; a check by hand reports what is still waiting', async () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'index.js'), 'utf8');
  assert.match(src, /'GET \/api\/cron\/bill-booking'/, 'listed as a scheduler route (no dashboard login)');
  assert.match(src, /app\.get\('\/api\/cron\/bill-booking', cronAuth, billBooking\.cron\)/, 'guarded by CRON_SECRET');
  const crons = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', '..', 'vercel.json'), 'utf8')).crons;
  assert.equal(crons.find(c => c.path === '/api/cron/bill-booking')?.schedule, '*/5 * * * *');

  const { env, server, call, router } = await api();
  try {
    router.init({ zc: env.zc, lookups: env.lookups, files: env.files, extractFn: H.fakeExtract({ '*': {} }), loadUsers: async () => USERS, http: fakeGraph(), log: { error() {} }, vercel: true });
    await unreadBills(env, 1);
    const x = await (await call('3', 'POST', '/mail/poll', {})).json();
    assert.equal(x.waiting, 0, 'the bill left unread was read during the check');
  } finally { router.init({ vercel: false, zc: env.zc, lookups: env.lookups, files: env.files }); server.close(); }
});

test('Vercel scheduler: also checks again the bills checked under older rules; the report says how many are left', async () => {
  const { env, server, call, router } = await api();
  try {
    router.init({ zc: env.zc, lookups: env.lookups, files: env.files, extractFn: H.fakeExtract({ '*': {} }), loadUsers: async () => USERS, http: fakeGraph(), log: { error() {} }, vercel: true });
    const r0 = await env.pipeline.ingest({ buffer: H.pdf('old-rules'), name: 'old.pdf', mime: 'application/pdf', source: 'erp_upload', source_ref: { erp_ref: 'O1' }, member_id: 'm1', by: 'test' });
    await env.pipeline.idle();
    await env.store.tx(async t => { const b = t.bill(r0.id); delete b.rules_v; t.putBill(b); });
    assert.equal((await (await call('1', 'GET', '/bills')).json()).rechecking, 1);
    const x = await (await call('3', 'POST', '/mail/poll', {})).json();
    assert.ok(x.results, 'a check by hand does not wait for re-checks');
    const r = await router.cronTick();
    assert.equal(r.rechecking, 0);
    assert.equal((await env.store.bill(r0.id)).rules_v, env.pipeline.RULES_V);
    assert.equal((await (await call('1', 'GET', '/bills')).json()).rechecking, 0);
  } finally { router.init({ vercel: false, zc: env.zc, lookups: env.lookups, files: env.files }); server.close(); }
});

test('API: an outside service\'s 401 is never passed on as 401 (the dashboard would sign the user out)', async () => {
  const { env, server, call } = await api();
  try {
    env.zc.checkAccess = async () => { throw axiosErr(401, { code: 57, message: 'You are not authorized to perform this operation' }); };
    const r = await call('1', 'POST', '/zoho/check', { company: 'devx' });
    assert.notEqual(r.status, 401);
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /not authorized to perform this operation/);
  } finally { server.close(); }
});
