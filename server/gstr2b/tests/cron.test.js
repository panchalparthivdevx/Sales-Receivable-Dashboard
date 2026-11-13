/**
 * Automatic sync online: the scheduled tick (GET /api/cron/gstr2b), the mark every scheduler call leaves, the way it is wired into the
 * dashboard and Vercel's scheduler, the "keep it fresh while the module is open" call, and the GitHub job that carries a long sync through.
 * Uses a fake Zoho and a temporary store. SYNTHETIC data.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync, spawn } = require('child_process');
const express = require('express');
const { tempDir, rm, FAST_SYNC } = require('./helpers');
const F = require('./fakeZoho');
const store = require('../lib/store');
const files = require('../lib/files');
const books = require('../lib/booksStore');
const AUD = require('../lib/audit');
const CFG = require('../lib/config');

const ROOT = path.join(__dirname, '..', '..', '..');
const COMPANY = { id: 'devx', name: 'Test Co', short: 'T', org_id: F.ORG, active: true, invoice_date_field: 'cf_vendor_bill_date', credit_date_field: 'cf_bill_date', credit_number_field: 'vendor_credit_number',
  registrations: [{ gstin: F.REC_A, label: 'GJ', branch_ids: ['br_a'], active: true }, { gstin: F.REC_B, label: 'MH', branch_ids: ['br_b'], active: true }] };
const USERS = [{ id: '1', username: 'viewer', name: 'Viewer', role: 'user', active: true, permissions: { gstr2b: { enabled: true, sections: {} } } }];
const later = s => new Date(Date.now() + s * 1000).toISOString().replace(/\.\d+Z$/, '+0000');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function boot(companies = [COMPANY], sync = {}) {
  const dir = tempDir();
  store.configure({ dir: dir + '/data', useDb: false });
  files.configure({ dir: dir + '/files', blob: null });
  const router = require('../index');
  const zr = F.makeFake();
  Object.assign(zr, { listOrganizations: async () => [], listBranches: async () => F.BRANCHES, checkAccess: async () => ({ ok: true, results: [] }) });
  await store.write('config', { companies, sync: { ...FAST_SYNC, ...sync } });
  const ctx = router.init({ zr, loadUsers: async () => USERS, log: { error() {} } });
  zr.put('bills', F.bill({ id: 'b1', no: 'INV/1', date: '2026-10-12', taxable: 1000 }));
  zr.put('bills', F.bill({ id: 'b2', no: 'INV/2', date: '2026-10-14', taxable: 2000, tax: 'inter', gst: F.SUP_MH, branch: 'br_b', dest: 'MH' }));
  zr.put('credits', F.credit({ id: 'c1', no: 'CN/1', date: '2026-10-18' }));
  return { dir, zr, router, sync: ctx.sync, close: () => { router.stopScheduler(); rm(dir); } };
}
const entries = async () => (await AUD.month(new Date().toISOString().slice(0, 7))).filter(e => !!e);
const firstSync = sync => sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10', by: 'user' });
/** First sync, then the one tick that compares the finished first sync with Zoho — after this a tick is a plain change check */
const settled = async t => { assert.equal((await firstSync(t.sync)).status, 'completed'); assert.equal((await t.router.cronTick()).results[0].mode, 'recheck'); };
const seen = () => store.read('auto', null);

test('the tick leaves a company alone until its first sync has been started — no Zoho call, no run — but the call itself is on record', async () => {
  const t = await boot();
  try {
    const out = await t.router.cronTick({ source: 'Vercel\'s scheduler' });
    assert.deepEqual(out, { ok: true, mode: 'incremental', more: false, results: [{ company: 'devx', status: 'needs_first_sync' }] });
    assert.equal(t.zr.calls.total, 0, 'not a single Zoho call');
    assert.equal((await t.sync.loadState('devx')).runs.length, 0);
    const mark = await seen();
    assert.ok(Date.now() - Date.parse(mark.last_seen_at) < 5000); assert.equal(mark.source, 'Vercel\'s scheduler'); assert.equal(mark.results[0].status, 'needs_first_sync');
  } finally { t.close(); }
});

test('the first tick after a first sync is complete checks the store against Zoho; after that a tick is a plain change check', async () => {
  const t = await boot();
  try {
    assert.equal((await firstSync(t.sync)).status, 'completed');
    assert.equal((await t.sync.status('devx')).initial.status, 'completed');
    const a = await t.router.cronTick();
    assert.equal(a.results[0].mode, 'recheck'); assert.equal(a.results[0].status, 'completed'); assert.equal(a.more, false);
    const v = (await t.sync.loadState('devx')).verify;
    assert.equal(v.ok, true); assert.equal(v.kinds.bill.zoho_rows, 2); assert.equal(v.kinds.bill.agree, 2); assert.equal(v.kinds.vendor_credit.agree, 1); assert.equal(v.total.differ, 0);
    assert.equal(v.kinds.bill.zoho_total_p, v.kinds.bill.agree_total_p, 'the totals Zoho lists are the totals stored');
    const b = await t.router.cronTick();
    assert.equal(b.results[0].mode, 'incremental');
  } finally { t.close(); }
});

test('the tick reads what changed (a new bill and an edited older one), fetches their amounts, reconciles, and is recorded as a scheduled run', async () => {
  const t = await boot();
  try {
    await settled(t);
    const auditBefore = (await entries()).length, runsBefore = (await t.sync.loadState('devx')).runs.length;
    t.zr.put('bills', F.bill({ id: 'b1', no: 'INV/1', date: '2026-10-12', taxable: 1500, lmt: later(5) }));       // an older bill, edited now
    t.zr.put('bills', F.bill({ id: 'b9', no: 'INV/9', date: '2026-11-03', taxable: 300, lmt: later(6) }));        // a new bill
    const lists = t.zr.queries.length;
    const out = await t.router.cronTick();
    assert.equal(out.more, false); assert.equal(out.results.length, 1);
    assert.equal(out.results[0].status, 'completed'); assert.equal(out.results[0].mode, 'incremental'); assert.equal(out.results[0].fetched, 2); assert.equal(out.results[0].changed, 2);
    // it asked Zoho only for what was modified since the checkpoint — the history was not listed again
    assert.ok(t.zr.queries.slice(lists).every(q => q.params.last_modified_time && !q.params.date_start));
    const st = await t.sync.loadState('devx');
    assert.equal(st.runs.length, runsBefore + 1); assert.equal(st.runs[0].by, 'schedule');
    assert.equal((await books.all('devx')).find(d => d.zoho_id === 'b1').amounts.taxable, 150000);
    const after = await entries();
    assert.ok(after.length > auditBefore); assert.ok(after.some(e => e.action === 'sync.incremental' && e.by === 'schedule'));
    assert.ok(after.filter(e => e.action === 'recon.run' && e.by === 'schedule').length >= 1, 'the work was reconciled');
    assert.equal(st.last_auto.quiet, false); assert.equal(st.last_auto.mode, 'incremental'); assert.equal(st.last_auto.fetched, 2);
    assert.equal((await t.sync.loadState('devx')).recon_due, false, 'and nothing is owed after the reconciliation');
  } finally { t.close(); }
});

test('a tick that finds nothing is not written to the history or the audit trail, but the page still shows when it ran', async () => {
  const t = await boot();
  try {
    await settled(t);
    await t.router.cronTick();
    const runs = (await t.sync.loadState('devx')).runs.length, audit = (await entries()).length;
    for (let i = 0; i < 5; i++) { const out = await t.router.cronTick(); assert.equal(out.results[0].status, 'completed'); assert.equal(out.results[0].fetched, 0); assert.equal(out.more, false); }
    const st = await t.sync.loadState('devx');
    assert.equal(st.runs.length, runs, 'five idle ticks add nothing to "Recent sync runs"');
    assert.equal((await entries()).length, audit, 'and nothing to the audit trail');
    assert.equal(st.last_auto.quiet, true); assert.ok(Date.now() - Date.parse(st.last_auto.at) < 5000);
    const status = await t.sync.status('devx');
    assert.equal(status.auto_last.quiet, true); assert.equal(status.auto_last.status, 'completed');
    assert.ok(status.budget.used > 0, 'an idle tick still costs its few list calls, counted in the day\'s budget');
    assert.ok(Date.now() - Date.parse(status.last_checked_at) < 5000, 'and moves "last checked for changes"');
  } finally { t.close(); }
});

test('a user\'s own run is recorded as before; it is not taken for an automatic run', async () => {
  const t = await boot();
  try {
    await settled(t);
    const runs = (await t.sync.loadState('devx')).runs.length, auto = (await t.sync.loadState('devx')).last_auto.at;
    const r = await t.sync.run({ company: 'devx', mode: 'incremental', by: 'Admin' });
    assert.equal(r.status, 'completed'); assert.equal(r.quiet, false);
    assert.equal((await t.sync.loadState('devx')).runs.length, runs + 1, 'a manual run with nothing new is still shown');
    assert.equal((await t.sync.loadState('devx')).last_auto.at, auto, 'and does not move "last automatic run"');
  } finally { t.close(); }
});

test('a step that ends at its time slice says there is more to do, and is not reconciled yet; the next steps continue; a step that gets nowhere does not ask to be called again', async () => {
  const t = await boot([COMPANY], { concurrency: 1 });
  try {
    await settled(t);
    for (let i = 0; i < 8; i++) t.zr.put('bills', F.bill({ id: `n${i}`, no: `NEW/${i}`, date: '2026-11-05', taxable: 100 + i, lmt: later(10 + i) }));
    t.zr.state.detailMs = 40;                                                        // every amounts call takes a moment, one at a time
    const reconBefore = (await entries()).filter(e => e.action === 'recon.run').length;
    const a = await t.router.cronTick({ maxMs: 180 });
    assert.equal(a.results[0].status, 'partial'); assert.ok(a.results[0].fetched >= 1 && a.results[0].fetched < 8, `${a.results[0].fetched} fetched`); assert.equal(a.more, true);
    assert.equal((await entries()).filter(e => e.action === 'recon.run').length, reconBefore, 'no reconciliation after a partial step');
    assert.equal((await t.sync.loadState('devx')).recon_due, true, 'it is owed');
    const stuck = await t.router.cronTick({ maxMs: -1 });                            // a step with no time at all
    assert.equal(stuck.results[0].status, 'partial'); assert.equal(stuck.results[0].progress, 0); assert.equal(stuck.more, false, 'no progress: the caller must not ask again at once');
    let steps = 0, out = a;
    while (out.more && steps++ < 20) out = await t.router.cronTick({ maxMs: 180 });
    const last = await t.router.cronTick();                                          // a normal-length step finishes whatever is left
    assert.equal(last.more, false); assert.equal(last.results[0].status, 'completed');
    assert.equal((await books.stats('devx')).pending, 0, 'every new bill has its amounts');
    assert.ok((await entries()).filter(e => e.action === 'recon.run').length > reconBefore, 'reconciled once the work was done');
    assert.equal((await t.sync.loadState('devx')).recon_due, false);
  } finally { t.close(); }
});

test('a first sync that was cut short while still listing is carried on by the scheduler — nobody has to keep a page open', async () => {
  const t = await boot([COMPANY], { daily_budget: 5 });
  try {
    const first = await firstSync(t.sync);                                           // stops in the middle of the listing (the day's small budget)
    assert.equal(first.status, 'paused_budget');
    assert.equal((await t.sync.status('devx')).initial.status, 'in_progress'); assert.equal((await t.sync.status('devx')).initial.phase, 'listing');
    const cfg = await store.read('config', null); cfg.sync.daily_budget = 1000; await store.write('config', cfg);      // the next day
    const out = await t.router.cronTick();
    assert.equal(out.results[0].mode, 'period'); assert.equal(out.results[0].status, 'completed');
    const st = await t.sync.status('devx');
    assert.equal(st.initial.status, 'completed'); assert.equal(st.initial.fetched, 3); assert.equal(st.initial.pending, 0); assert.equal(st.initial.percent, 100);
    const months = t.zr.queries.filter(q => q.params.date_start).map(q => `${q.path} ${q.params.date_start}`);
    assert.equal(months.length, 6); assert.equal(new Set(months).size, 6, '3 months × bills and expenses: no month was listed twice across the two runs');
  } finally { t.close(); }
});

test('the daily budget stops the work for the day without asking the caller to come back at once', async () => {
  const t = await boot([COMPANY], { daily_budget: 6 });
  try {
    await firstSync(t.sync);                                                         // uses the small budget up
    for (let i = 0; i < 4; i++) t.zr.put('bills', F.bill({ id: `q${i}`, no: `Q/${i}`, date: '2026-11-05', taxable: 100, lmt: later(20 + i) }));
    const out = await t.router.cronTick();
    assert.ok(['paused_budget', 'completed'].includes(out.results[0].status));
    assert.equal(out.more, false, 'a pause for the budget is not "more to do now"');
  } finally { t.close(); }
});

test('the night tick is a re-check: a bill deleted in Zoho is found, and the comparison with Zoho is renewed', async () => {
  const t = await boot();
  try {
    await settled(t);
    t.zr.remove('bills', 'b1');
    assert.equal((await t.router.cronTick()).results[0].fetched, 0, 'the change feed cannot see a deletion');
    const out = await t.router.cronTick({ mode: 'recheck' });
    assert.equal(out.mode, 'recheck'); assert.equal(out.results[0].status, 'completed');
    const b1 = (await books.all('devx')).find(d => d.zoho_id === 'b1');
    assert.equal(b1.deleted, true);
    const st = await t.sync.loadState('devx');
    assert.equal(st.last_auto.mode, 'recheck'); assert.equal(st.verify.deleted, 1); assert.equal(st.verify.kinds.bill.zoho_rows, 1);
  } finally { t.close(); }
});

test('only companies that are set up, switched on and have a GSTIN switched on are visited; a run in progress is respected — and the scheduler\'s call is still on record', async () => {
  const demo = { ...COMPANY, id: 'demo', demo: true }, off = { ...COMPANY, id: 'off', active: false }, noGstin = { ...COMPANY, id: 'nog', registrations: COMPANY.registrations.map(r => ({ ...r, active: false })) };
  const t = await boot([demo, off, noGstin, COMPANY]);
  try {
    assert.deepEqual((await t.router.cronTick()).results.map(r => r.company), ['devx']);
    // a sync already running (a person's click or an earlier step) is not started twice
    const slow = fn => async (...a) => { await sleep(15); return fn(...a); };
    t.zr.get = slow(t.zr.get.bind(t.zr)); t.zr.list = slow(t.zr.list.bind(t.zr));
    const running = firstSync(t.sync);
    await sleep(40);
    assert.deepEqual((await t.router.cronTick({ source: 'Vercel\'s scheduler' })).results, [{ company: 'devx', status: 'busy' }]);
    const mark = await seen();
    assert.equal(mark.results[0].status, 'busy'); assert.ok(Date.now() - Date.parse(mark.last_seen_at) < 5000, 'the page can show that the scheduler called in, although a sync was running');
    await running;
  } finally { t.close(); }
});

test('what the page is told about the scheduler: when it last called in, when the next call is due, and when calls have stopped coming', () => {
  const router = require('../index');
  const at = Date.parse('2026-11-12T10:10:00.000Z');
  const none = router.schedulerSeen(null, at);
  assert.equal(none.last_seen_at, null); assert.equal(none.overdue, null, 'never seen is not the same as overdue'); assert.equal(none.every_min, 15);
  assert.equal(none.next_expected_at, '2026-11-12T10:22:00.000Z');
  assert.equal(router.schedulerSeen(null, Date.parse('2026-11-12T10:55:10.000Z')).next_expected_at, '2026-11-12T11:07:00.000Z', 'after :52 the next call is in the next hour');
  const fresh = router.schedulerSeen({ last_seen_at: '2026-11-12T10:07:05.000Z', source: 'Vercel\'s scheduler', mode: 'incremental', results: [] }, at);
  assert.equal(fresh.overdue, false); assert.equal(fresh.source, 'Vercel\'s scheduler');
  assert.equal(router.schedulerSeen({ last_seen_at: '2026-11-12T09:30:00.000Z' }, at).overdue, true, 'two missed calls: the page must say so');
  assert.deepEqual(CFG.ONLINE_SCHEDULE.minutes.map(m => (m + 30) % 60).sort((a, b) => a - b), CFG.ONLINE_SCHEDULE.minutes, 'the same minutes past the hour in India time');
});

test('the endpoints answer in the shape the callers read, say who called, and report a failure as an error', async () => {
  const t = await boot();
  try {
    await settled(t);
    const app = express(); app.get('/api/cron/gstr2b', t.router.cron); app.get('/api/cron/gstr2b-recheck', t.router.cronRecheck);
    const server = await new Promise(r => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    try {
      const base = `http://127.0.0.1:${server.address().port}/api/cron/gstr2b`;
      const a = await fetch(base, { headers: { 'user-agent': 'vercel-cron/1.0' } }); const aj = await a.json();
      assert.equal(a.status, 200); assert.equal(aj.ok, true); assert.equal(aj.mode, 'incremental'); assert.equal(aj.more, false);
      assert.match(JSON.stringify(aj), /^\{"ok":true,"mode":"incremental","more":false/, 'compact JSON: the GitHub job greps for "more":true');
      assert.equal((await seen()).source, 'Vercel\'s scheduler');
      assert.equal((await (await fetch(`${base}?src=github`)).json()).ok, true); assert.equal((await seen()).source, 'the GitHub job');
      assert.equal((await (await fetch(`${base}?mode=recheck`)).json()).mode, 'recheck');
      assert.equal((await (await fetch(`${base}?mode=anything`)).json()).mode, 'incremental', 'only "recheck" is accepted as a mode');
      assert.equal((await (await fetch(`${base}-recheck`)).json()).mode, 'recheck', 'the night route is a re-check whatever the query says');
      const real = t.router.cronTick;                                                 // the router is shared by every test in this file: put the tick back afterwards
      t.router.cronTick = async () => { throw new Error('boom'); };
      try { const bad = await fetch(base); assert.equal(bad.status, 500); assert.equal((await bad.json()).ok, false); } finally { t.router.cronTick = real; }
    } finally { server.closeAllConnections && server.closeAllConnections(); await new Promise(r => server.close(r)); }
  } finally { t.close(); }
});

test('wiring: both routes are in the dashboard server behind the same Bearer check as the other cron routes, let through the login gate, and on Vercel\'s scheduler every 15 minutes round the clock', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert.match(src, /app\.get\('\/api\/cron\/gstr2b', cronAuth, gstr2b\.cron\);/);
  assert.match(src, /app\.get\('\/api\/cron\/gstr2b-recheck', cronAuth, gstr2b\.cronRecheck\);/);
  assert.match(src, /'GET \/api\/cron\/gstr2b',/); assert.match(src, /'GET \/api\/cron\/gstr2b-recheck',/);
  assert.match(src, /function cronAuth\(req, res, next\) \{\s*const secret = process\.env\.CRON_SECRET;\s*if \(!secret \|\| req\.headers\.authorization !== `Bearer \$\{secret\}`\) return res\.status\(401\)/, 'without CRON_SECRET the routes always answer 401');
  const crons = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).crons;
  const tick = crons.find(c => c.path === '/api/cron/gstr2b'), night = crons.find(c => c.path === '/api/cron/gstr2b-recheck');
  assert.ok(tick && night, 'both are on Vercel\'s scheduler');
  const [mins, hours, ...rest] = tick.schedule.split(' ');
  assert.deepEqual(mins.split(',').map(Number), CFG.ONLINE_SCHEDULE.minutes, 'the page shows the same minutes the scheduler uses');
  assert.equal(mins.split(',').length * CFG.ONLINE_SCHEDULE.every_min, 60, 'every 15 minutes');
  assert.equal(hours, '*', 'round the clock'); assert.deepEqual(rest, ['*', '*', '*'], 'every day');
  // India time = UTC + 5:30: the dashboard's own Zoho syncs start at :00 / :10 / :20 / :30 — none of ours may coincide
  for (const m of mins.split(',').map(Number)) assert.ok(![0, 10, 20, 30].includes((m + 30) % 60), `minute ${m} UTC = :${(m + 30) % 60} IST`);
  assert.equal(night.schedule, `${+CFG.ONLINE_SCHEDULE.recheck_utc.slice(3)} ${+CFG.ONLINE_SCHEDULE.recheck_utc.slice(0, 2)} * * *`, 'the night re-check at 1 AM India time');
  for (const c of crons) assert.ok(!c.path.includes('?'), 'no query strings in scheduler paths');
});

// ── "Keep it fresh while the module is open" ───────────────────────────────────
async function withApp(t, fn) {
  const app = express(); app.use(express.json()); app.use((req, res, next) => { req.user = { id: '1' }; next(); }); app.use('/api/gstr2b', t.router);
  const server = await new Promise(r => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
  const call = async (method, p, body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/gstr2b${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try { return await fn(call); } finally { server.closeAllConnections && server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
const idle = async t => { for (let i = 0; i < 200 && t.sync.isRunning('devx'); i++) await sleep(10); };

test('opening the module keeps the data fresh: nothing before a first sync, nothing when it was checked minutes ago, a change check when it is due — for any module user, never two at once', async () => {
  const t = await boot();
  try {
    await withApp(t, async call => {
      assert.deepEqual((await call('POST', '/sync/kick', { company: 'devx' })).body, { ran: false, reason: 'needs_first_sync' });
      await settled(t);
      assert.deepEqual((await call('POST', '/sync/kick', { company: 'devx' })).body, { ran: false, reason: 'fresh' }, 'checked a moment ago: no Zoho call');
      // eleven minutes later a bill has been added in Zoho
      await store.update('sync_devx', {}, s => { s.last_checked_at = new Date(Date.now() - 11 * 60000).toISOString(); });
      t.zr.put('bills', F.bill({ id: 'k1', no: 'K/1', date: '2026-11-06', taxable: 700, lmt: later(5) }));
      const runs = (await t.sync.loadState('devx')).runs.length;
      const k = (await call('POST', '/sync/kick', { company: 'devx' })).body;       // a viewer without the "Prepare" right
      assert.equal(k.ran, true); assert.equal(k.background, true);
      for (let i = 0; i < 300 && (await t.sync.loadState('devx')).runs.length === runs; i++) await sleep(10);
      await idle(t);
      const st = await t.sync.loadState('devx');
      assert.equal((await books.all('devx')).find(d => d.zoho_id === 'k1').amounts.taxable, 70000, 'the new bill was read');
      assert.equal(st.runs.length, runs + 1); assert.equal(st.runs[0].by, 'auto');
      for (let i = 0; i < 100 && (await t.sync.loadState('devx')).recon_due; i++) await sleep(10);
      assert.equal((await t.sync.loadState('devx')).recon_due, false, 'and reconciled');
      // while a sync is running a second one is not started
      const slow = fn => async (...a) => { await sleep(20); return fn(...a); };
      t.zr.list = slow(t.zr.list.bind(t.zr));
      await store.update('sync_devx', {}, s => { s.last_checked_at = new Date(Date.now() - 11 * 60000).toISOString(); });
      assert.equal((await call('POST', '/sync/kick', { company: 'devx' })).body.ran, true);
      assert.deepEqual((await call('POST', '/sync/kick', { company: 'devx' })).body, { ran: false, reason: 'running' });
      await idle(t);
    });
  } finally { t.close(); }
});

test('documents that could not be read are listed with the reason, and "try again" gives them new attempts (it needs the Prepare right)', async () => {
  const t = await boot();
  try {
    t.zr.state.failDetail.add('b2');
    for (let i = 0; i < 3; i++) await firstSync(t.sync);
    const st = await t.sync.status('devx');
    assert.equal(st.initial.status, 'completed_with_errors', 'finished, but not silently: one document is missing');
    assert.equal(st.initial.failed, 1); assert.equal(st.initial.pending, 0); assert.equal(st.failing_documents, 1);
    assert.equal(st.stats.failing_docs[0].doc_no, 'INV/2'); assert.match(st.stats.failing_docs[0].error, /internal error/); assert.equal(st.stats.failing_docs[0].attempts, 3);
    await withApp(t, async call => {
      assert.equal((await call('POST', '/sync/retry-failed', { company: 'devx' })).status, 403);
      USERS[0].permissions.gstr2b.sections.g2b_prepare = true;
      try { assert.deepEqual((await call('POST', '/sync/retry-failed', { company: 'devx' })).body, { reset: 1 }); } finally { USERS[0].permissions.gstr2b.sections = {}; }
    });
    t.zr.state.failDetail.delete('b2');                                              // Zoho answers again
    assert.equal((await t.sync.run({ company: 'devx', mode: 'incremental', by: 'user' })).details.fetched, 1);
    const done = await t.sync.status('devx');
    assert.equal(done.initial.status, 'completed'); assert.equal(done.failing_documents, 0); assert.equal(done.initial.percent, 100);
  } finally { t.close(); }
});

// ── The GitHub job ──────────────────────────────────────────────────────────────
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'gstr2b-sync.yml');
const workflowText = () => fs.readFileSync(WORKFLOW, 'utf8');
const scriptOf = () => {
  const lines = workflowText().split(/\r?\n/);
  const i = lines.findIndex(l => /^\s+run: \|\s*$/.test(l));
  const indent = lines[i + 1].match(/^ */)[0].length;
  const out = [];
  for (let k = i + 1; k < lines.length && (lines[k].trim() === '' || lines[k].startsWith(' '.repeat(indent))); k++) out.push(lines[k].slice(indent));
  return out.join('\n');
};

test('the GitHub job starts on every push and on "Run workflow" (GitHub\'s own schedule is only a second line), with the existing secrets', () => {
  const y = workflowText();
  assert.match(y, /\n {2}push:\s*\n {4}branches: \[main\]/); assert.match(y, /\n {2}workflow_dispatch:/);
  const crons = [...y.matchAll(/- cron: '([^']+)'/g)].map(m => m[1]);
  assert.equal(crons.length, 1, 'one hourly extra call — the 15-minute schedule is Vercel\'s');
  assert.ok(!CFG.ONLINE_SCHEDULE.minutes.includes(+crons[0].split(' ')[0]), 'not in the same minute as Vercel\'s scheduler');
  assert.match(y, /secrets\.APP_URL/); assert.match(y, /secrets\.CRON_SECRET/); assert.match(y, /\/api\/cron\/gstr2b\?src=github/);
  assert.match(y, /if: env\.APP_URL != ''/, 'does nothing until APP_URL is set');
  assert.match(y, /concurrency:\s*\n\s+group: gstr2b-sync\s*\n\s+cancel-in-progress: false/, 'runs queue; they never overlap');
  assert.match(y, /permissions:\s*\n\s+contents: read\s*\n\s+statuses: read/, 'read-only: the repository and Vercel\'s mark on the commit');
  assert.match(y, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(y, /timeout-minutes: 300/);
});

// The job's own script is run against a local stand-in for the dashboard and for GitHub's "commit status" answer (needs bash: Git Bash
// on Windows, any Linux / Mac)
const hasBash = (() => { try { return spawnSync('bash', ['-c', 'exit 0']).status === 0; } catch (_) { return false; } })();
async function runJob({ event = 'workflow_dispatch', statuses = [], moreFor = 0, secret = 'good', maxSteps = '', vercel = null } = {}) {
  const seenCalls = [], asked = [];
  const server = await new Promise(r => { const s = http.createServer((req, res) => {
    if (req.url.startsWith('/repos/')) {                                              // GitHub: the combined status of the pushed commit
      asked.push({ url: req.url, auth: req.headers.authorization });
      const state = vercel[Math.min(asked.length, vercel.length) - 1];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ state: 'pending', statuses: state === 'none' ? [] : [{ context: 'Vercel – sales-receivable-dashboard', state, description: state === 'failure' ? 'Deployment has failed' : 'Deployment has completed' }] }, null, 2));
    }
    seenCalls.push({ url: req.url, auth: req.headers.authorization, at: Date.now() });
    if (req.headers.authorization !== 'Bearer good') { res.writeHead(401); return res.end('{"error":"Unauthorized"}'); }
    const status = statuses[seenCalls.length - 1] || 200;
    if (status !== 200) { res.writeHead(status); return res.end('{"ok":false}'); }
    const okCalls = seenCalls.filter((c, i) => (statuses[i] || 200) === 200).length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode: 'incremental', more: okCalls <= moreFor, results: [] }));
  }).listen(0, '127.0.0.1', () => r(s)); });
  const dir = tempDir();
  try {
    const file = path.join(dir, 'job.sh'); fs.writeFileSync(file, scriptOf());
    const base = `http://127.0.0.1:${server.address().port}`;
    const started = Date.now();
    // the real job waits for Vercel (polling every 15 s), 3 s between steps and 30 s × n after a failed answer
    const env = { ...process.env, APP_URL: `${base}/`, CRON_SECRET: secret, EVENT: event, STEP_PAUSE: '0', RETRY_PAUSE: '0', DEPLOY_WAIT: '1', DEPLOY_POLL: '0', DEPLOY_SETTLE: '0', DEPLOY_TRIES: '4',
      GITHUB_TOKEN: vercel ? 'gh-token' : '', GITHUB_API_URL: base, GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: 'abc123', ...(maxSteps ? { MAX_STEPS: maxSteps } : {}) };
    const child = spawn('bash', [file], { cwd: dir, env });
    let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    const code = await new Promise(r => child.on('close', r));
    return { code, out, seen: seenCalls, asked, started };
  } finally { server.closeAllConnections && server.closeAllConnections(); await new Promise(r => server.close(r)); rm(dir); }
}

test('the job script: keeps asking while there is more; a scheduled run asks once; "Run workflow" carries on until done; a run never goes on for ever', { skip: !hasBash && 'bash is not available here' }, async () => {
  const idle = await runJob();
  assert.equal(idle.code, 0); assert.equal(idle.seen.length, 1); assert.equal(idle.seen[0].url, '/api/cron/gstr2b?src=github'); assert.equal(idle.seen[0].auth, 'Bearer good');
  assert.equal(idle.asked.length, 0, '"Run workflow" does not wait for a deployment');
  const drain = await runJob({ moreFor: 6 });
  assert.equal(drain.code, 0); assert.equal(drain.seen.length, 7, 'keeps going until the dashboard says there is no more');
  assert.match(drain.out, /step 7: \{"ok":true,"mode":"incremental","more":false/);
  const hourly = await runJob({ event: 'schedule', moreFor: 100 });
  assert.equal(hourly.seen.length, 1, 'GitHub\'s own schedule asks once');
  const capped = await runJob({ moreFor: 100, maxSteps: '5' });
  assert.equal(capped.seen.length, 5);
});

test('the job script after a push: it waits until Vercel reports the new version live, and does NOT sync with the old version if Vercel could not deploy it', { skip: !hasBash && 'bash is not available here' }, async () => {
  const live = await runJob({ event: 'push', moreFor: 2, vercel: ['none', 'pending', 'success'] });
  assert.equal(live.code, 0, live.out); assert.equal(live.asked.length, 3, 'asked GitHub until Vercel said "success"');
  assert.equal(live.asked[0].url, '/repos/owner/repo/commits/abc123/status'); assert.equal(live.asked[0].auth, 'Bearer gh-token');
  assert.equal(live.seen.length, 3, 'then carried the sync through');
  const refused = await runJob({ event: 'push', moreFor: 5, vercel: ['pending', 'failure'] });
  assert.equal(refused.code, 1); assert.equal(refused.seen.length, 0, 'the dashboard (still the old version) was not called at all');
  assert.match(refused.out, /::error::Vercel could not put this version online \(Deployment has failed\)/);
  const silent = await runJob({ event: 'push', vercel: ['none'] });                   // Vercel never says anything
  assert.equal(silent.code, 0); assert.equal(silent.asked.length, 4); assert.match(silent.out, /::warning::No word from Vercel/); assert.equal(silent.seen.length, 1);
  const noToken = await runJob({ event: 'push' });                                     // without a token it simply waits a fixed time
  assert.equal(noToken.code, 0); assert.equal(noToken.asked.length, 0); assert.ok(noToken.seen[0].at - noToken.started >= 900);
});

test('the job script: a wrong CRON_SECRET fails loudly; a dashboard that does not answer is tried again a few times with a growing wait, then left alone', { skip: !hasBash && 'bash is not available here' }, async () => {
  const wrong = await runJob({ secret: 'bad' });
  assert.equal(wrong.code, 1); assert.match(wrong.out, /::error::The dashboard refused the CRON_SECRET \(401\)/);
  const blip = await runJob({ statuses: [503, 504], moreFor: 1 });                  // two failed answers, then it works
  assert.equal(blip.code, 0); assert.equal(blip.seen.length, 4); assert.match(blip.out, /::warning::step 1: HTTP 503/); assert.match(blip.out, /step 4: \{"ok":true/);
  const down = await runJob({ statuses: [500, 500, 500, 500, 500, 500] });
  assert.equal(down.code, 0); assert.equal(down.seen.length, 4, 'it does not hammer a failing dashboard'); assert.match(down.out, /::warning::step 4: HTTP 500/);
});
