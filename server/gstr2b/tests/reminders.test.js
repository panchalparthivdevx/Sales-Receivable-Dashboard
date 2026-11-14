/**
 * Email reminders to the owners of open rows: who is told what and when, what is never emailed, failures and retries, the email at the
 * moment of assignment, the managers' summary, the settings and their rights, the scheduler's call — and the sender itself (Microsoft
 * 365 through Microsoft Graph), against a stand-in for the HTTP calls. No email leaves this machine: the router gets a mailer that
 * only records. SYNTHETIC data; every address is under example.test.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { tempDir, rm, FAST_SYNC } = require('./helpers');
const F = require('./fakeZoho');
const { stmt, inv, sup } = require('./fixtures');
const store = require('../lib/store');
const files = require('../lib/files');
const books = require('../lib/booksStore');
const C = require('../lib/canonBooks');
const RM = require('../lib/reminders');
const MAIL = require('../lib/reminderMail');
const MAILER = require('../lib/mailer');

const USERS = [
  { id: '1', username: 'admin', name: 'Admin', role: 'admin', active: true, permissions: {} },
  { id: '2', username: 'asha', name: 'Asha Mehta', role: 'user', active: true, permissions: { gstr2b: { enabled: true, sections: { g2b_prepare: true } } } },
  { id: '3', username: 'bhautik', name: 'Bhautik Z', role: 'user', active: true, permissions: { gstr2b: { enabled: true, sections: { g2b_prepare: true } } } },
  { id: '4', username: 'reader', name: 'Reader', role: 'user', active: true, permissions: { gstr2b: { enabled: true, sections: {} } } },
  { id: '5', username: 'nobody', name: 'No access', role: 'user', active: true, permissions: { gstr2b: { enabled: false } } },
];
const EMAILS = { 2: 'asha@example.test', 3: 'bhautik@example.test', 4: 'reader@example.test' };
const COMPANY = { id: 'devx', name: 'Test Co', short: 'T', org_id: F.ORG, invoice_date_field: 'cf_vendor_bill_date', credit_date_field: 'cf_bill_date', credit_number_field: 'vendor_credit_number', registrations: [{ gstin: F.REC_A, label: 'GJ', branch_ids: ['br_a'] }, { gstin: F.REC_B, label: 'MH', branch_ids: ['br_b'] }] };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A Monday, 10:30 in India, at least a day ahead of the real clock: the weekday and the time of day are fixed, the dates are counted from it
const MONDAY = (() => { for (let t = Date.now() + 86400000; ; t += 86400000) { const ist = new Date(t + 330 * 60000); if (ist.getUTCDay() === 1) return Date.parse(`${ist.toISOString().slice(0, 10)}T10:30:00+05:30`); } })();
const DAY = 86400000;
const dateOf = (n, base = MONDAY) => new Date(base + 330 * 60000 + n * DAY).toISOString().slice(0, 10);

/** A mailer that only records. `failFor` address → how many times to fail; `failAll` = every send fails ({ code, message }) */
function fakeMailer({ configured = true } = {}) {
  const m = {
    sent: [], configured, failFor: new Map(), failAll: null,
    status: () => ({ provider: 'microsoft', label: 'Microsoft 365', configured: m.configured, from: 'finance@example.test', missing: m.configured ? [] : ['MAIL_FROM', 'MAIL_MS_CLIENT_SECRET'] }),
    send: async msg => {
      if (m.failAll) throw Object.assign(new Error(m.failAll.message), { code: m.failAll.code });
      const to = [].concat(msg.to), left = m.failFor.get(to[0]) || 0;
      if (left > 0) { m.failFor.set(to[0], left - 1); throw new Error('mailbox full'); }
      m.sent.push({ ...msg, to });
      return { ok: true };
    },
  };
  return m;
}

/** The real router with a recording mailer, one company and five reconciliation rows: exact, 2 × mismatched, Books only, GSTR-2B only */
async function boot(tc, { mailer = fakeMailer() } = {}) {
  const dir = tempDir();
  store.configure({ dir: dir + '/data', useDb: false });
  files.configure({ dir: dir + '/files', blob: null });
  await store.write('config', { sync: FAST_SYNC });
  const router = require('../index');
  const zr = F.makeFake();
  Object.assign(zr, { listOrganizations: async () => [], listBranches: async () => F.BRANCHES, checkAccess: async () => ({ ok: true, results: [] }) });
  const ctx = router.init({ zr, loadUsers: async () => USERS, mailer, log: { error() {} } });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || '1' }; next(); });
  app.use('/api/gstr2b', router);
  const server = await new Promise(r => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/gstr2b`;
  const call = async (method, path, { user = '1', body, form } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'x-user': user, ...(body ? { 'content-type': 'application/json' } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (_) { json = text; }
    return { status: res.status, body: json };
  };
  let closed = false;
  const close = async () => { if (closed) return; closed = true; router.stopScheduler(); server.closeAllConnections && server.closeAllConnections(); await new Promise(r => server.close(r)); rm(dir); };
  if (tc && tc.after) tc.after(close);

  assert.equal((await call('PUT', '/config/companies', { body: { companies: [COMPANY] } })).status, 200);
  const co = (await call('GET', '/meta')).body.companies[0];
  const cctx = { company: co, branches: new Map(F.BRANCHES.map(b => [b.id, { name: b.name, gstin: b.gstin, state: b.state_code }])), vendors: new Map() };
  const mk = s => { const x = F.bill(s); return C.fromDetail(x.detail, x.row, cctx, 'bill'); };
  await books.upsertMany('devx', [mk({ id: 'b1', no: 'INV/001', date: '2026-10-05', taxable: 1000 }), mk({ id: 'b2', no: 'INV/002', date: '2026-10-06', taxable: 2000 }),
    mk({ id: 'b3', no: 'XYZ-77', date: '2026-10-07', taxable: 500 }), mk({ id: 'b4', no: 'INV/004', date: '2026-10-08', taxable: 3000 })]);
  const buf = stmt({ b2b: [sup(F.SUP_GJ, [inv('INV/001', '05-10-2026', 1000, 90), inv('INV/002', '06-10-2026', 2000, 190), inv('INV/004', '08-10-2026', 3000, 300), inv('QQ-1', '08-10-2026', 700, 63)])] });
  const fd = new FormData(); fd.append('file', new Blob([buf]), 'GSTR2B.json');
  const pv = (await call('POST', '/import/preview', { form: fd })).body;
  assert.equal((await call('POST', '/import/commit', { body: { preview_id: pv.preview_id } })).status, 200);
  const rows = (await call('GET', '/recon/rows?company=devx')).body.rows;
  const key = no => rows.find(r => [...r.b, ...r.p].some(v => v.no === no)).key;
  assert.deepEqual(['INV/001', 'INV/002', 'XYZ-77', 'INV/004', 'QQ-1'].map(no => rows.find(r => r.key === key(no)).status), ['exact', 'mismatched', 'books_only', 'mismatched', 'portal_only']);

  const assign = (no, body, user = '1') => call('POST', '/recon/assign', { user, body: { keys: [].concat(no).map(key), ...body } });
  const settings = (body, user = '1') => call('PUT', '/reminders', { user, body });
  const on = (extra = {}) => settings({ enabled: true, time: '10:00', emails: EMAILS, app_url: 'https://dash.example.test', ...extra });
  const state = () => ctx.reminders.load();
  return { call, key, assign, settings, on, state, mailer, router, rem: ctx.reminders, close };
}
const to = (mailer, address) => mailer.sent.filter(m => m.to.includes(address));
const audit = async t => (await t.call('GET', '/audit')).body.entries;

test('nothing goes out while reminders are switched off, before the time of day, on a day that is not ticked, or while email is not set up', async tc => {
  const t = await boot(tc);
  await t.assign('INV/002', { owner_id: '2', due: dateOf(-3) });
  assert.deepEqual(await t.rem.tick({ now: MONDAY }), { ran: false, why: 'off' }, 'off until somebody switches it on');
  assert.equal((await t.on()).status, 200);
  assert.deepEqual(await t.rem.tick({ now: MONDAY - 31 * 60000 }), { ran: false, why: 'not_due' }, '09:59: not yet');
  assert.deepEqual(await t.rem.tick({ now: MONDAY - DAY }), { ran: false, why: 'not_due' }, 'Sunday is not a sending day');
  t.mailer.configured = false;
  assert.deepEqual(await t.rem.tick({ now: MONDAY }), { ran: false, why: 'mail_not_set_up' });
  assert.equal(t.mailer.sent.length, 0);
  t.mailer.configured = true;
  assert.equal((await t.rem.tick({ now: MONDAY })).sent, 1);
  // time helpers
  assert.equal(RM.dueNow({ days: [1], time: '10:30' }, MONDAY), true); assert.equal(RM.dueNow({ days: [1], time: '10:31' }, MONDAY), false);
  assert.equal(RM.nextAt({ days: [1, 2], time: '10:00' }, MONDAY), new Date(MONDAY + DAY - 30 * 60000).toISOString(), 'Monday\'s 10:00 has passed: Tuesday 10:00');
  assert.equal(RM.nextAt({ days: [1], time: '11:00' }, MONDAY), new Date(MONDAY + 30 * 60000).toISOString());
  assert.equal(RM.nextAt({ days: [1], time: '10:00' }, MONDAY), new Date(MONDAY + 7 * DAY - 30 * 60000).toISOString(), 'next Monday');
});

test('the daily email: each owner gets one, with their overdue, due-today, due-soon and newly assigned rows; nobody is told about nothing; once a day', async tc => {
  const t = await boot(tc);
  await t.assign('INV/002', { owner_id: '2', workflow: 'vendor_followup', next_action: 'Ask for a corrected invoice', due: dateOf(-3) });
  await t.assign('XYZ-77', { owner_id: '2', due: dateOf(0) });
  await t.assign('INV/004', { owner_id: '3', due: dateOf(2) });
  await t.assign('QQ-1', { owner_id: '4', due: dateOf(10) });
  await t.on();                                                    // switched on after the rows were given out, so no "assigned to you" email is in the way
  assert.deepEqual(await t.rem.tick({ now: MONDAY }), { ran: true, sent: 3, failed: 0, no_email: 0, left: 0 });
  assert.equal(t.mailer.sent.length, 3);
  const asha = to(t.mailer, 'asha@example.test')[0];
  assert.equal(asha.subject, 'GSTR-2B Reco: 1 overdue, 1 due today — 2 open rows with you');
  for (const s of ['Hello Asha Mehta', 'Overdue (1)', 'Due today (1)', 'INV/002', 'XYZ-77', 'overdue by 3 days', 'Ask for a corrected invoice', 'Vendor follow-up', 'Mismatched', 'Books only', F.REC_A,
    'Books ₹360.00', 'GSTR-2B ₹380.00', 'Difference +₹20.00', 'Books ₹90.00', 'href="https://dash.example.test/?open=gstr2b&amp;g2b=mine"']) assert.ok(asha.html.includes(s), `Asha's email has "${s}"`);
  assert.ok(!asha.html.includes('INV/004') && !asha.html.includes('QQ-1'), 'nobody else\'s rows');
  const bhautik = to(t.mailer, 'bhautik@example.test')[0];
  assert.equal(bhautik.subject, 'GSTR-2B Reco: 1 due soon — 1 open row with you'); assert.ok(bhautik.html.includes('Due in the next 2 days (1)') && bhautik.html.includes('in 2 days'));
  const reader = to(t.mailer, 'reader@example.test')[0];
  assert.equal(reader.subject, 'GSTR-2B Reco: 1 newly assigned — 1 open row with you'); assert.ok(reader.html.includes('Newly assigned to you (1)') && reader.html.includes('QQ-1') && reader.html.includes('GSTR-2B ₹126.00'));
  // the same day again: nothing
  assert.deepEqual(await t.rem.tick({ now: MONDAY + 3600000 }), { ran: false, why: 'done' });
  assert.equal(t.mailer.sent.length, 3);
  const day1 = (await t.state()).days[dateOf(0)];
  assert.equal(day1.owners['2'].status, 'sent'); assert.equal(day1.owners['2'].to, 'asha@example.test'); assert.equal(day1.owners['2'].counts.overdue, 1); assert.ok(day1.finished_at);
  // Tuesday: Asha's two rows are both overdue now, Bhautik's is due tomorrow, and Reader — nothing new, nothing due — gets no email
  assert.deepEqual(await t.rem.tick({ now: MONDAY + DAY }), { ran: true, sent: 2, failed: 0, no_email: 0, left: 0 });
  assert.equal(to(t.mailer, 'asha@example.test')[1].subject, 'GSTR-2B Reco: 2 overdue — 2 open rows with you');
  assert.ok(to(t.mailer, 'asha@example.test')[1].html.includes('overdue by 4 days') && to(t.mailer, 'asha@example.test')[1].html.includes('overdue by 1 day<'));
  assert.ok(to(t.mailer, 'bhautik@example.test')[1].html.includes('in 1 day<'));
  assert.equal(to(t.mailer, 'reader@example.test').length, 1);
  // the settings page shows it, and it is in the audit trail
  const v = (await t.call('GET', '/reminders')).body;
  const p = Object.fromEntries(v.people.map(x => [x.name, x]));
  assert.deepEqual([p['Asha Mehta'].open, p['Asha Mehta'].email, p['Asha Mehta'].last.status], [2, 'asha@example.test', 'sent']);
  assert.equal(p.Reader.open, 1); assert.equal(p.Reader.last.status, 'sent'); assert.equal(p.Admin.open, 0); assert.equal(p['No access'], undefined);
  assert.equal(v.log.filter(e => e.kind === 'digest' && e.ok).length, 5); assert.equal(v.log[0].by, 'schedule');
  assert.ok((await audit(t)).some(e => e.action === 'reminders.sent' && /3 reminder email\(s\) sent/.test(e.detail)));
});

test('rows without a due date are listed once a week (or every day, or never); a row given long ago is not "new" again', async tc => {
  const t = await boot(tc);
  await t.assign('XYZ-77', { owner_id: '2' });
  await t.on();
  assert.equal((await t.rem.tick({ now: MONDAY })).sent, 1);
  assert.equal(t.mailer.sent[0].subject, 'GSTR-2B Reco: 1 newly assigned — 1 open row with you', 'the first email: the row is new to its owner');
  assert.equal((await t.rem.tick({ now: MONDAY + DAY })).sent, 0, 'Tuesday: nothing new, nothing due, not the weekly day');
  assert.equal((await t.rem.tick({ now: MONDAY + 7 * DAY })).sent, 1, 'the next Monday: the weekly list of rows without a due date');
  assert.equal(t.mailer.sent[1].subject, 'GSTR-2B Reco: 1 open row without a due date — 1 open row with you');
  assert.ok(t.mailer.sent[1].html.includes('Open, without a due date (1)') && t.mailer.sent[1].html.includes('No due date'));
  await t.settings({ undated: 'daily' });
  assert.equal((await t.rem.tick({ now: MONDAY + 8 * DAY })).sent, 1);
  await t.settings({ undated: 'never' });
  assert.equal((await t.rem.tick({ now: MONDAY + 9 * DAY })).sent, 0);
});

test('never emailed: rows that are matched, accepted or resolved, the demo company, a GSTIN the owner may not see — and every owner who cannot be emailed is named', async tc => {
  const t = await boot(tc);
  await t.assign('INV/001', { owner_id: '2', due: dateOf(-5) });                                   // exact matched
  await t.assign('INV/002', { owner_id: '2', due: dateOf(-1), workflow: 'resolved' });              // resolved (the admin has the Review right)
  await t.assign('XYZ-77', { owner: 'Ramesh (auditor)', due: dateOf(-1) });                          // a name that is not a user
  await t.assign('INV/004', { owner_id: '3', due: dateOf(-2) });
  await t.call('PUT', '/config/access', { body: { access: { 3: { companies: ['devx'], gstins: [F.REC_B] } } } });   // Bhautik may only see the other GSTIN
  await t.assign('QQ-1', { owner_id: '4', due: dateOf(-1) });
  const demo = (await t.call('POST', '/demo/load')).body;
  assert.equal(demo.company, 'demo');
  const demoRow = (await t.call('GET', '/recon/rows?company=demo&status=mismatched')).body.rows[0];
  assert.equal((await t.call('POST', '/recon/assign', { body: { keys: [demoRow.key], owner_id: '2', due: dateOf(-9) } })).status, 200);
  await t.on({ emails: { 2: EMAILS[2], 3: EMAILS[3] } });                                           // Reader has no address
  const p = await t.rem.plan({ now: MONDAY });
  assert.deepEqual(p.recipients.map(r => [r.user.name, r.counts.open, r.email]), [['Reader', 1, '']]);
  assert.deepEqual(p.problems.map(x => `${x.who} ${x.why}: ${x.rows}`).sort(), [
    `Bhautik Z is not allowed to see GSTIN ${F.REC_A}: 1`, 'Ramesh (auditor) is not a dashboard user: 1', 'Reader has no email address in Settings → Email reminders: 1']);
  assert.deepEqual(await t.rem.tick({ now: MONDAY }), { ran: true, sent: 0, failed: 0, no_email: 1, left: 0 });
  assert.equal(t.mailer.sent.length, 0);
  assert.ok((await t.state()).days[dateOf(0)].finished_at, 'nothing to wait for: today is done');
  assert.equal((await t.call('GET', '/reminders')).body.problems.length, 3, 'the settings page lists them');
});

test('a failed email is tried again at the next call, three times a day at most; a mailbox that refuses stops the run and is reported', async tc => {
  const t = await boot(tc);
  await t.assign('INV/002', { owner_id: '2', due: dateOf(-3) });
  await t.assign('INV/004', { owner_id: '3', due: dateOf(-3) });
  await t.on();
  t.mailer.failFor.set('asha@example.test', 1);
  assert.deepEqual(await t.rem.tick({ now: MONDAY }), { ran: true, sent: 1, failed: 1, no_email: 0, left: 0 });
  let day = (await t.state()).days[dateOf(0)];
  assert.deepEqual([day.owners['2'].status, day.owners['2'].attempts, day.owners['2'].error, day.owners['3'].status, day.finished_at], ['failed', 1, 'mailbox full', 'sent', undefined]);
  assert.deepEqual(await t.rem.tick({ now: MONDAY + 15 * 60000 }), { ran: true, sent: 1, failed: 0, no_email: 0, left: 0 }, 'only the one that failed is sent');
  assert.equal(to(t.mailer, 'bhautik@example.test').length, 1); assert.equal(to(t.mailer, 'asha@example.test').length, 1);
  assert.ok((await t.state()).days[dateOf(0)].finished_at);
  // Tuesday: Asha's mailbox keeps failing — three attempts, then the day is closed with the failure on record
  t.mailer.failFor.set('asha@example.test', 9);
  for (let i = 0; i < 3; i++) assert.equal((await t.rem.tick({ now: MONDAY + DAY + i * 15 * 60000 })).failed, 1);
  day = (await t.state()).days[dateOf(1)];
  assert.deepEqual([day.owners['2'].status, day.owners['2'].attempts, !!day.finished_at], ['failed', 3, true]);
  assert.deepEqual(await t.rem.tick({ now: MONDAY + DAY + 3600000 }), { ran: false, why: 'done' });
  assert.equal((await t.call('GET', '/reminders')).body.people.find(x => x.name === 'Asha Mehta').last.status, 'failed');
  // Wednesday: Microsoft 365 refuses the mailbox — nobody is charged an attempt, the reason is shown, and after three calls the day is given up
  t.mailer.failFor.clear();
  t.mailer.failAll = { code: 'mail_forbidden', message: 'Microsoft 365 does not allow the app to send from finance@example.test' };
  const out = await t.rem.tick({ now: MONDAY + 2 * DAY });
  assert.equal(out.sent, 0); assert.equal(out.failed, 0); assert.ok(out.left >= 1); assert.match(out.error, /does not allow the app to send/);
  day = (await t.state()).days[dateOf(2)];
  assert.deepEqual([Object.keys(day.owners).length, day.connection_error.attempts, day.finished_at], [0, 1, undefined]);
  assert.match((await t.rem.view({ now: MONDAY + 2 * DAY })).today.connection_error.message, /does not allow the app to send/, 'the settings page shows why');
  await t.rem.tick({ now: MONDAY + 2 * DAY + 15 * 60000 }); await t.rem.tick({ now: MONDAY + 2 * DAY + 30 * 60000 });
  day = (await t.state()).days[dateOf(2)];
  assert.equal(day.connection_error.attempts, 3); assert.ok(day.finished_at);
  assert.ok((await audit(t)).some(e => e.action === 'reminders.sent' && /stopped: Microsoft 365 does not allow/.test(e.detail)));
  // once it works again, "send now" gets today's emails out
  t.mailer.failAll = null;
  const now = await t.rem.tick({ now: MONDAY + 2 * DAY + 3600000, force: true, by: 'Admin' });
  assert.equal(now.sent, 2); assert.equal((await t.state()).days[dateOf(2)].connection_error, undefined);
});

test('on assignment the new owner is emailed at once — not when the owner did not change, not for rows people give themselves, not when it is switched off', async tc => {
  const t = await boot(tc);
  await t.on();
  const settle = async n => { for (let i = 0; i < 100 && t.mailer.sent.length < n; i++) await sleep(10); await sleep(60); return t.mailer.sent.length; };
  assert.equal((await t.assign('INV/002', { owner_id: '3', next_action: 'Call the vendor', due: dateOf(5, Date.now()) }, '2')).status, 200);
  assert.equal(await settle(1), 1);
  const m = t.mailer.sent[0];
  assert.deepEqual(m.to, ['bhautik@example.test']); assert.equal(m.subject, 'GSTR-2B Reco: 1 row assigned to you by Asha Mehta');
  for (const s of ['Hello Bhautik Z', '<b>Asha Mehta</b> has assigned this GSTR-2B reconciliation row to you', 'INV/002', 'Call the vendor', 'in 5 days']) assert.ok(m.html.includes(s), s);
  await t.assign('INV/002', { owner_id: '3' }, '2');                           // the same owner again
  await t.assign('INV/002', { due: dateOf(6, Date.now()) }, '2');              // only the due date
  await t.assign('XYZ-77', { owner_id: '2' }, '2');                            // Asha takes a row herself
  assert.equal(await settle(2), 1, 'none of these is a new assignment to somebody else');
  await t.assign(['INV/004', 'QQ-1'], { owner_id: '4' }, '2');                 // two rows in one go: one email
  assert.equal(await settle(2), 2);
  assert.equal(t.mailer.sent[1].subject, 'GSTR-2B Reco: 2 rows assigned to you by Asha Mehta'); assert.ok(t.mailer.sent[1].html.includes('INV/004') && t.mailer.sent[1].html.includes('QQ-1'));
  await t.assign('XYZ-77', { owner: 'bhautik z' }, '2');                       // a typed name, in small letters: the same person
  assert.equal(await settle(3), 3); assert.deepEqual(t.mailer.sent[2].to, ['bhautik@example.test']);
  await t.assign('QQ-1', { owner: 'Ramesh (auditor)' }, '2');                  // not a user: nobody to email
  await t.settings({ on_assign: false });
  await t.assign('INV/004', { owner_id: '3' }, '2');
  assert.equal(await settle(4), 3);
  const log = (await t.call('GET', '/reminders')).body.log;
  assert.equal(log.filter(e => e.kind === 'assigned' && e.ok).length, 3); assert.equal(log[0].by, 'Asha Mehta');
  // the next daily email does not repeat as "newly assigned" what the assignment email already told; a row given while that email was off is new
  const bh = (await t.rem.plan()).recipients.find(r => r.user.name === 'Bhautik Z');
  assert.deepEqual(bh.items.map(i => i.doc_no).sort(), ['INV/002', 'INV/004', 'XYZ-77']);
  assert.deepEqual(bh.sections.fresh.map(i => i.doc_no), ['INV/004']);
});

test('the managers\' summary: one email with every owner\'s numbers and the overdue and due-today rows, to the addresses set', async tc => {
  const t = await boot(tc);
  await t.assign('INV/002', { owner_id: '2', due: dateOf(-3) });
  await t.assign('XYZ-77', { owner_id: '3', due: dateOf(0) });
  await t.assign('INV/004', { owner_id: '3', due: dateOf(20) });
  await t.assign('QQ-1', { owner: 'Ramesh (auditor)', due: dateOf(-1) });
  await t.on({ summary_to: 'cfo@example.test, Head@Example.test' });
  assert.equal((await t.rem.tick({ now: MONDAY })).sent, 3, 'Asha, Bhautik and the summary');
  const s = t.mailer.sent[2];
  assert.deepEqual(s.to, ['cfo@example.test', 'head@example.test']); assert.equal(s.subject, 'GSTR-2B Reco follow-ups: 1 overdue, 1 due today');
  for (const x of ['By owner', 'Asha Mehta', 'Bhautik Z', 'INV/002', 'XYZ-77', 'Ramesh (auditor) (is not a dashboard user, 1 row)', 'href="https://dash.example.test/?open=gstr2b"']) assert.ok(s.html.includes(x), x);
  assert.ok(!s.html.includes('INV/004'), 'a row due in three weeks is counted, not listed');
  assert.equal((await t.state()).days[dateOf(0)].summary.status, 'sent');
  assert.equal((await t.rem.tick({ now: MONDAY + DAY })).sent, 3, 'Tuesday: both owners have an overdue row, and the summary says so');
  assert.equal(t.mailer.sent[5].subject, 'GSTR-2B Reco follow-ups: 2 overdue, 0 due today');
  // Wednesday: the summary fails once — the day is not closed while it is owed, and the next call sends it (and nothing twice)
  t.mailer.failFor.set('cfo@example.test', 1);
  assert.deepEqual(await t.rem.tick({ now: MONDAY + 2 * DAY }), { ran: true, sent: 2, failed: 1, no_email: 0, left: 0 });
  assert.equal((await t.state()).days[dateOf(2)].finished_at, undefined);
  assert.deepEqual(await t.rem.tick({ now: MONDAY + 2 * DAY + 15 * 60000 }), { ran: true, sent: 1, failed: 0, no_email: 0, left: 0 });
  const wed = (await t.state()).days[dateOf(2)];
  assert.deepEqual([wed.summary.status, wed.summary.attempts, !!wed.finished_at], ['sent', 2, true]);
  assert.equal(t.mailer.sent.length, 9);
});

test('settings: validated, changed only with the Configure right, audited; a test email proves the connection; preview and "send now"', async tc => {
  const t = await boot(tc);
  const today = dateOf(0, Date.now());
  assert.equal((await t.settings({ time: '09:00' }, '2')).status, 403); assert.equal((await t.call('GET', '/reminders', { user: '2' })).status, 403);
  for (const [bad, why] of [[{ time: '25:00' }, /not a time/], [{ days: [] }, /at least one day/], [{ days: [9] }, /at least one day/], [{ soon_days: 99 }, /between 0 and 14/], [{ undated: 'monthly' }, /never, weekly or daily/],
    [{ emails: { 2: 'not-an-address' } }, /not an email address \(Asha Mehta\)/], [{ emails: { 99: 'x@example.test' } }, /Unknown user 99/], [{ summary_to: 'a@example.test, bad' }, /"bad" is not an email address/], [{ app_url: 'ftp://x' }, /must start with https/]]) {
    const r = await t.settings(bad); assert.equal(r.status, 400, JSON.stringify(bad)); assert.match(r.body.error, why);
  }
  // while email is not set up, reminders cannot be switched on — but everything else can be saved
  t.mailer.configured = false;
  assert.match((await t.settings({ enabled: true })).body.error, /cannot be switched on yet: email sending is not set up \(missing: MAIL_FROM, MAIL_MS_CLIENT_SECRET\)/);
  const saved = (await t.settings({ time: '09:15', days: [5, 1, 1, 3], soon_days: 3, emails: { 2: ' Asha@Example.test ', 3: EMAILS[3] }, summary_to: ['cfo@example.test'], app_url: 'https://dash.example.test/' })).body.reminders;
  assert.deepEqual([saved.enabled, saved.time, saved.days, saved.soon_days, saved.emails, saved.summary_to, saved.app_url], [false, '09:15', [1, 3, 5], 3, { 2: 'asha@example.test', 3: EMAILS[3] }, ['cfo@example.test'], 'https://dash.example.test']);
  assert.deepEqual((await t.settings({ emails: { 3: '' } })).body.reminders.emails, { 2: 'asha@example.test' }, 'an emptied box removes the address; the others stay');
  let v = (await t.call('GET', '/reminders')).body;
  assert.equal(v.mail.configured, false); assert.equal(v.next_at, null); assert.equal(JSON.stringify(v).includes('secret'), false);
  assert.equal((await t.call('POST', '/reminders/test', { body: { to: 'me@example.test' } })).status, 400); assert.equal((await t.call('POST', '/reminders/send', { body: {} })).status, 400);
  t.mailer.configured = true;
  assert.equal((await t.settings({ enabled: true })).body.reminders.enabled, true);
  v = (await t.call('GET', '/reminders')).body;
  assert.equal(v.mail.from, 'finance@example.test'); assert.ok(Date.parse(v.next_at) > Date.now());
  // a test email
  assert.equal((await t.call('POST', '/reminders/test', { user: '2', body: { to: 'me@example.test' } })).status, 403);
  assert.equal((await t.call('POST', '/reminders/test', { body: { to: 'nonsense' } })).status, 400);
  assert.deepEqual((await t.call('POST', '/reminders/test', { body: { to: 'me@example.test' } })).body, { ok: true, to: 'me@example.test', from: 'finance@example.test' });
  assert.equal(t.mailer.sent[0].subject, 'GSTR-2B Reco: test email'); assert.ok(t.mailer.sent[0].html.includes('sent by Admin from the mailbox finance@example.test'));
  t.mailer.failAll = { code: 'mail_forbidden', message: 'Microsoft 365 does not allow the app to send from finance@example.test' };
  const refused = await t.call('POST', '/reminders/test', { body: { to: 'me@example.test' } });
  assert.equal(refused.status, 502); assert.match(refused.body.error, /does not allow the app to send/);
  t.mailer.failAll = null;
  // preview and "send now" (whatever the time of day)
  await t.settings({ on_assign: false, summary_to: [] });
  await t.assign('INV/002', { owner_id: '2', due: today });
  const pv = (await t.call('GET', '/reminders/preview?user=2')).body;
  assert.equal(pv.empty, false); assert.equal(pv.to, 'asha@example.test'); assert.match(pv.subject, /1 due today/); assert.ok(pv.html.includes('INV/002'));
  assert.deepEqual((await t.call('GET', '/reminders/preview?user=4')).body, { empty: true });
  assert.equal((await t.call('POST', '/reminders/send', { user: '2', body: {} })).status, 403);
  const before = t.mailer.sent.length;
  assert.equal((await t.call('POST', '/reminders/send', { body: {} })).body.sent, 1);
  assert.equal((await t.call('POST', '/reminders/send', { body: {} })).body.sent, 0, 'not twice on one day');
  assert.equal((await t.call('POST', '/reminders/send', { body: { user: '2', again: true } })).body.sent, 1, 'unless it is asked for one person again');
  assert.equal(t.mailer.sent.length, before + 2);
  const actions = (await audit(t)).map(e => e.action);
  for (const a of ['config.reminders', 'reminders.test', 'reminders.sent']) assert.ok(actions.includes(a), a);
  assert.equal((await t.call('GET', '/audit/verify')).body.ok, true);
});

test('the scheduler: the 15-minute call sends the day\'s emails once their time has come, and only once', async tc => {
  const t = await boot(tc);
  await t.assign('INV/002', { owner_id: '2', due: dateOf(-1, Date.now()) });
  await t.on({ time: '00:00', days: [0, 1, 2, 3, 4, 5, 6] });
  const a = await t.router.cronTick({ source: 'Vercel\'s scheduler' });
  assert.deepEqual(a.reminders, { sent: 1, failed: 0 }); assert.equal(a.ok, true);
  assert.equal(t.mailer.sent.length, 1); assert.match(t.mailer.sent[0].subject, /1 overdue/);
  const b = await t.router.cronTick();
  assert.equal(b.reminders, undefined, 'the second call of the day has nothing to send'); assert.equal(t.mailer.sent.length, 1);
  // a mailer that throws something unexpected never stops the sync part of the call
  t.rem.tick = async () => { throw new Error('boom'); };
  assert.equal((await t.router.cronTick()).ok, true);
});

// ── The sender: Microsoft 365 through Microsoft Graph ─────────────────────────
const ENV = { MAIL_FROM: 'finance@example.test', MAIL_MS_TENANT_ID: 'tenant-1', MAIL_MS_CLIENT_ID: 'app-1', MAIL_MS_CLIENT_SECRET: 'secret-1' };
const refusal = (status, code, message, headers = {}) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error: { code, message } }, headers } });
/** A stand-in for axios: the sign-in always answers a token (unless `token` is an error); each send takes the next entry of `sends` (an error = refused) */
function fakeHttp({ token = null, sends = [] } = {}) {
  const h = { calls: [], post: async (url, body, opts) => {
    h.calls.push({ url, body, opts });
    if (/login\.microsoftonline\.com/.test(url)) { if (token) throw token; return { data: { access_token: `tok${h.calls.filter(c => /login/.test(c.url)).length}`, expires_in: 3600 } }; }
    const next = sends.shift();
    if (next) throw next;
    return { status: 202, data: '' };
  } };
  return h;
}

test('the sender signs in to Microsoft 365 with the app\'s credentials and posts the email to Microsoft Graph from the one mailbox', async () => {
  const h = fakeHttp();
  const m = MAILER.create({ http: h, env: ENV });
  assert.deepEqual(m.status(), { provider: 'microsoft', label: 'Microsoft 365', configured: true, from: 'finance@example.test', missing: [] });
  assert.equal(JSON.stringify(m.status()).includes('secret-1'), false, 'the settings page is never told a credential');
  const r = await m.send({ to: 'asha@example.test', cc: ['cfo@example.test'], subject: 'Hello', html: '<p>Hi</p>' });
  assert.deepEqual(r, { ok: true, from: 'finance@example.test', to: ['asha@example.test'] });
  assert.equal(h.calls[0].url, 'https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
  const form = new URLSearchParams(h.calls[0].body);
  assert.deepEqual([form.get('client_id'), form.get('client_secret'), form.get('grant_type'), form.get('scope')], ['app-1', 'secret-1', 'client_credentials', 'https://graph.microsoft.com/.default']);
  assert.equal(h.calls[1].url, 'https://graph.microsoft.com/v1.0/users/finance%40example.test/sendMail');
  assert.equal(h.calls[1].opts.headers.Authorization, 'Bearer tok1');
  assert.deepEqual(h.calls[1].body, { message: { subject: 'Hello', body: { contentType: 'HTML', content: '<p>Hi</p>' }, toRecipients: [{ emailAddress: { address: 'asha@example.test' } }], ccRecipients: [{ emailAddress: { address: 'cfo@example.test' } }] }, saveToSentItems: true });
  await m.send({ to: ['a@example.test', 'b@example.test', 'a@example.test'], subject: 'Two', html: 'x' });
  assert.equal(h.calls.filter(c => /login/.test(c.url)).length, 1, 'the sign-in is reused');
  assert.equal(h.calls[2].body.message.toRecipients.length, 2, 'an address given twice is written once');
  // one app registration can serve this module and Bill Collection & Booking
  const shared = MAILER.create({ http: fakeHttp(), env: { MAIL_FROM: 'finance@example.test', BB_MS_TENANT_ID: 't', BB_MS_CLIENT_ID: 'c', BB_MS_CLIENT_SECRET: 's' } });
  assert.equal(shared.status().configured, true);
});

test('the sender says plainly what is missing or refused, waits when Microsoft asks it to, and signs in again when a sign-in has expired', async () => {
  const none = MAILER.create({ http: fakeHttp(), env: {} });
  assert.deepEqual(none.status().missing, ['MAIL_FROM', 'MAIL_MS_TENANT_ID', 'MAIL_MS_CLIENT_ID', 'MAIL_MS_CLIENT_SECRET']);
  await assert.rejects(none.send({ to: 'a@example.test', subject: 's', html: 'h' }), e => e.code === 'mail_not_set_up' && /missing: MAIL_FROM/.test(e.message));
  const msg = { to: 'a@example.test', subject: 's', html: 'h' };
  await assert.rejects(MAILER.create({ http: fakeHttp({ sends: [refusal(403, 'ErrorAccessDenied', 'Access is denied.')] }), env: ENV }).send(msg),
    e => e.code === 'mail_forbidden' && /"Mail\.Send" permission for this mailbox \(ErrorAccessDenied\)/.test(e.message));
  await assert.rejects(MAILER.create({ http: fakeHttp({ sends: [refusal(404, 'ErrorInvalidUser', 'not found')] }), env: ENV }).send(msg), e => e.code === 'mail_no_mailbox' && /finance@example\.test was not found/.test(e.message));
  await assert.rejects(MAILER.create({ http: fakeHttp({ sends: [refusal(400, 'ErrorInvalidRecipients', 'At least one recipient is not valid.')] }), env: ENV }).send(msg), e => e.code === 'mail_failed' && /At least one recipient is not valid\. \(ErrorInvalidRecipients\)/.test(e.message));
  const bad = Object.assign(new Error('Request failed with status code 401'), { response: { status: 401, data: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: abc' } } });
  await assert.rejects(MAILER.create({ http: fakeHttp({ token: bad }), env: ENV }).send(msg), e => e.code === 'mail_auth' && /AADSTS7000215: Invalid client secret provided\.$/.test(e.message));
  await assert.rejects(MAILER.create({ http: fakeHttp(), env: ENV }).send({ to: [], subject: 's', html: 'h' }), /No address to send to/);
  // "too many requests": wait as long as Microsoft says, then send
  const waits = [];
  const busy = fakeHttp({ sends: [refusal(429, 'TooManyRequests', 'slow down', { 'retry-after': '3' })] });
  await MAILER.create({ http: busy, env: ENV, wait: async ms => { waits.push(ms); } }).send(msg);
  assert.deepEqual(waits, [3000]); assert.equal(busy.calls.filter(c => /sendMail/.test(c.url)).length, 2);
  // a sign-in that expired early: sign in again once
  const expired = fakeHttp({ sends: [refusal(401, 'InvalidAuthenticationToken', 'expired')] });
  await MAILER.create({ http: expired, env: ENV }).send(msg);
  assert.equal(expired.calls.filter(c => /login/.test(c.url)).length, 2); assert.equal(expired.calls[3].opts.headers.Authorization, 'Bearer tok2');
});

test('the emails: whatever came from Zoho or from a person is escaped, long lists are cut with a count, amounts are in Indian grouping', () => {
  const item = (n, extra = {}) => ({ key: `k${n}`, company_name: 'T', gstin: F.REC_A, gstin_label: 'GJ', supplier: `Supplier ${n}`, supplier_gstin: F.SUP_GJ, doc_no: `D/${n}`, doc_date: '2026-10-05', doc_type: 'INV',
    status: 'mismatched', status_label: 'Mismatched', books_gst: 12345678, portal_gst: 12345600, diff_gst: -78, workflow_label: '', next_action: '', due: '2026-11-10', days: -4, state: 'overdue', ...extra });
  const evil = item(0, { supplier: '<script>alert(1)</script> & Sons', next_action: '"><img src=x onerror=alert(2)>', doc_no: 'A&B/<1>' });
  const d = MAIL.digest({ name: '<b>Asha</b>', sections: { overdue: [evil, ...Array.from({ length: 29 }, (_, i) => item(i + 1))], today: [], soon: [], fresh: [], undated: [] }, counts: { open: 33 }, appUrl: 'https://dash.example.test/"x', soonDays: 2 });
  assert.ok(!/<script>|<img |<b>Asha/.test(d.html), 'nothing from outside is HTML');
  for (const s of ['&lt;script&gt;alert(1)&lt;/script&gt; &amp; Sons', '&quot;&gt;&lt;img src=x onerror=alert(2)&gt;', 'A&amp;B/&lt;1&gt;', 'Hello &lt;b&gt;Asha&lt;/b&gt;', 'href="https://dash.example.test/&quot;x/?open=gstr2b&amp;g2b=mine"']) assert.ok(d.html.includes(s), s);
  assert.equal((d.html.match(/<tr>\n/g) || []).length, MAIL.MAX_ROWS, 'twenty-five rows are written out');
  assert.ok(d.html.includes('… and 5 more — open the dashboard to see all of them.') && d.html.includes('Overdue (30)') && d.html.includes('3 more open rows are with you and not listed today'));
  assert.ok(d.html.includes('Books ₹1,23,456.78') && d.html.includes('Difference -₹0.78'));
  assert.equal(d.subject, 'GSTR-2B Reco: 30 overdue — 33 open rows with you');
  assert.equal(MAIL.inr(0), '₹0.00'); assert.equal(MAIL.inr(-150050), '-₹1,500.50'); assert.equal(MAIL.inr(100000000), '₹10,00,000.00'); assert.equal(MAIL.day('2026-11-05'), '5 Nov 2026');
  // without a dashboard address the email says where to click instead of linking somewhere wrong
  const plain = MAIL.assigned({ name: 'Asha', by: 'Admin', items: [item(1)] });
  assert.ok(!plain.html.includes('href=') && plain.html.includes('open the finance dashboard → <b>GSTR-2B Reco → My rows</b>'));
});
