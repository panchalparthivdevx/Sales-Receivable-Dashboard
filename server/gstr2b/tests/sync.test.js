/**
 * Zoho sync (read-only): period history, change feed, deletion check, interruption and safe retry.
 * Uses a fake Zoho with the verified response shapes — synthetic data.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDir, rm } = require('./helpers');
const F = require('./fakeZoho');
const store = require('../lib/store');
const books = require('../lib/booksStore');
const SYNC = require('../lib/booksSync');
const C = require('../lib/canonBooks');
const ZR = require('../lib/zohoRead');

function setup({ budget = 1000, pageSize = 3, seed = true, lease = false, rate = 600, workers = 3, reserve = 0 } = {}) {
  const dir = tempDir();
  store.configure({ dir, useDb: false });
  const zr = F.makeFake({ pageSize });
  const cfg = { companies: [{ id: 'devx', name: 'Test Co', org_id: F.ORG, active: true, invoice_date_field: 'cf_vendor_bill_date', credit_date_field: 'cf_bill_date', credit_number_field: 'vendor_credit_number', registrations: [{ gstin: F.REC_A }, { gstin: F.REC_B }] }],
    sync: { rate_per_min: rate, concurrency: workers, daily_budget: budget, zoho_reserve: reserve, slice_seconds: 60 } };
  const naps = [];                                                  // the waits the calls-per-minute queue asked for (never really slept in tests)
  const audit = []; const sync = SYNC.create({ zr, cfgNow: async () => cfg, audit: { log: async e => audit.push(e) }, log: { error() {} }, useLease: lease, sleepFn: async ms => { naps.push(ms); } });
  if (seed) {
    zr.put('bills', F.bill({ id: 'b1', no: 'INV/1', date: '2026-10-12', taxable: 1000 }));
    zr.put('bills', F.bill({ id: 'b2', no: 'INV/2', date: '2026-10-14', taxable: 2000, tax: 'inter', gst: F.SUP_MH, branch: 'br_b', dest: 'MH' }));
    zr.put('bills', F.bill({ id: 'b3', no: 'NG/3', date: '2026-09-10', gst: '' }));
    zr.put('bills', F.bill({ id: 'b4', no: 'VD/4', date: '2026-09-11', status: 'void' }));
    zr.put('bills', F.bill({ id: 'b5', no: 'TD/5', date: '2026-08-20', taxable: 5000, tds: 100 }));
    zr.put('bills', F.bill({ id: 'b6', no: 'UM/6', date: '2026-10-20', branch: 'br_x' }));
    zr.put('bills', F.bill({ id: 'b7', no: 'US/7', date: '2026-10-21', cur: 'USD' }));
    zr.put('credits', F.credit({ id: 'c1', no: 'CN/1', date: '2026-10-18' }));
    zr.put('expenses', F.expense({ id: 'e1', ref: 'SUP/7', date: '2026-10-21' }));
    zr.put('expenses', F.expense({ id: 'e2', noTax: true, date: '2026-10-22' }));
  }
  return { dir, zr, cfg, sync, audit, naps };
}
const detailCalls = zr => zr.log.filter(l => /^GET \/(bills|vendorcredits|expenses)\/[^/]+$/.test(l));
const byZohoId = async (id) => (await books.all('devx')).filter(d => d.zoho_id === id);

test('period sync: lists, then details only for documents that can be matched; exclusions are decided without a detail call', async () => {
  const { dir, zr, sync } = setup();
  const r = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10', by: 'tester' });
  assert.equal(r.status, 'completed', r.message || r.error);
  const docs = await books.all('devx');
  assert.equal(docs.length, 9, '7 bills + 1 credit + 1 GST expense (the no-GST expense is not stored)');
  const ex = id => docs.find(d => d.zoho_id === id);
  assert.equal(ex('b3').excluded, 'no_supplier_gstin'); assert.equal(ex('b4').excluded, 'void'); assert.equal(ex('b6').excluded, 'recipient_unmapped'); assert.equal(ex('b7').excluded, 'foreign_currency');
  assert.ok(!docs.some(d => d.zoho_id === 'e2'));
  // detail fetched exactly once for each of the five in-scope documents
  assert.equal(detailCalls(zr).length, 5);
  assert.deepEqual(detailCalls(zr).map(l => l.split('/').pop()).sort(), ['b1', 'b2', 'b5', 'c1', 'e1']);
  const b1 = ex('b1'), b2 = ex('b2'), b5 = ex('b5');
  assert.equal(b1.amounts.taxable, 100000); assert.equal(b1.amounts.cgst, 9000); assert.equal(b1.recipient_gstin, F.REC_A);
  assert.equal(b2.amounts.igst, 36000); assert.equal(b2.recipient_gstin, F.REC_B);
  assert.equal(b5.invoice_value, 500000 + 90000);                                                // TDS never reduces the invoice value
  assert.equal(ex('c1').doc_type, 'CRN');
  const st = await books.stats('devx');
  assert.equal(st.pending, 0); assert.equal(st.detailed, 5);
  assert.deepEqual(st.excluded, { no_supplier_gstin: 1, void: 1, recipient_unmapped: 1, foreign_currency: 1 });
  // the detail list contains no write: every call is a GET / LIST
  assert.ok(zr.log.every(l => /^(GET|LIST) /.test(l)));
  rm(dir);
});

test('a repeat run changes nothing and fetches no detail again (idempotent upserts)', async () => {
  const { dir, zr, sync } = setup();
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  const before = JSON.stringify((await books.all('devx')).map(d => [d.id, d.hash, d.source.lmt]));
  const callsBefore = detailCalls(zr).length;
  const r = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(r.status, 'completed');
  assert.equal(detailCalls(zr).length, callsBefore, 'no detail fetched twice');
  assert.equal(r.lists.bill.added + r.lists.bill.changed, 0);
  assert.equal(JSON.stringify((await books.all('devx')).map(d => [d.id, d.hash, d.source.lmt])), before);
  rm(dir);
});

test('interrupted by the daily budget, then resumed: nothing lost, nothing fetched twice', async () => {
  const { dir, zr, sync, cfg } = setup({ budget: 9 });
  const r1 = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(r1.status, 'paused_budget'); assert.match(r1.message, /budget/);
  cfg.sync.daily_budget = 1000;
  const r2 = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(r2.status, 'completed');
  const fetched = detailCalls(zr).map(l => l.split('/').pop());
  assert.equal(new Set(fetched).size, fetched.length, 'every document detail was fetched exactly once across both runs');
  assert.equal((await books.all('devx')).length, 9);
  assert.equal((await books.stats('devx')).pending, 0);
  rm(dir);
});

test('a period sync that is cut short continues where it stopped: no month is listed twice, and its later steps spend their calls on amounts only', async () => {
  const { dir, zr, sync, cfg } = setup({ budget: 9 });
  const lists = () => zr.log.filter(l => /^LIST /.test(l)).length;
  const ask = () => sync.run({ company: 'devx', mode: 'period', from: '2026-05', to: '2026-10' });
  const first = await ask();
  assert.equal(first.status, 'paused_budget'); assert.ok(first.windows_listed > 0 && first.windows_listed < 13, 'stopped in the middle of the listing');
  cfg.sync.daily_budget = 1000;
  const second = await ask();
  assert.equal(second.status, 'completed', second.message || second.error);
  assert.equal(first.windows_listed + second.windows_listed, 13, '6 months × bills and expenses + the credit list = 13 listings, each done exactly once across both steps');
  assert.equal(second.windows_skipped, first.windows_listed - (first.windows_listed === 13 ? 1 : 0), 'the second step skipped what the first had listed');
  const afterListing = lists();
  // a later step of the same sync (online each step asks for the same period again) lists nothing at all
  const st = await sync.loadState('devx');
  st.initial.completed_at = null; await store.write('sync_devx', st);          // as if amounts were still waiting
  const third = await ask();
  assert.equal(third.status, 'completed'); assert.equal(third.windows_listed, 0); assert.equal(lists(), afterListing, 'not a single list call');
  // once the sync is finished, asking for the same period again is a new pass and lists everything
  const again = await ask();
  assert.equal(again.windows_listed, 13); assert.equal(again.windows_skipped, 0);
  // a re-check always lists everything
  const before = lists();
  const recheck = await sync.run({ company: 'devx', mode: 'recheck', from: '2026-05', to: '2026-10' });
  assert.equal(recheck.windows_skipped, 0); assert.equal(recheck.windows_listed, 13); assert.ok(lists() > before);
  assert.equal((await books.stats('devx')).detailed, 5);
  rm(dir);
});

test('online: a run on another serverless instance is seen through the stored lease; a lease never outlives its slice and is released afterwards', async () => {
  const { dir, sync } = setup({ lease: true });
  const key = 'sync_devx';
  const other = { run_id: 'run_elsewhere', by: 'Another user', at: new Date().toISOString(), until: new Date(Date.now() + 120000).toISOString() };
  await store.update(key, {}, s => { s.lease = other; });
  const refused = await sync.run({ company: 'devx', mode: 'period', from: '2026-10', to: '2026-10' });
  assert.equal(refused.busy, true); assert.match(refused.message, /already running.*Another user/); assert.equal(refused.run_id, 'run_elsewhere');
  assert.equal((await sync.status('devx')).running, true, 'the status page of any instance shows the run');
  assert.equal((await sync.loadState('devx')).runs.length, 0, 'a refused run leaves no trace');
  // the other run died (the platform killed it): once its lease has run out, nothing blocks the next sync
  await store.update(key, {}, s => { s.lease = { ...other, until: new Date(Date.now() - 1000).toISOString() }; });
  assert.equal((await sync.status('devx')).running, false);
  const r = await sync.run({ company: 'devx', mode: 'period', from: '2026-10', to: '2026-10' });
  assert.equal(r.status, 'completed', r.message || r.error);
  assert.equal((await sync.loadState('devx')).lease, null, 'the lease is released when the run ends');
  assert.equal((await sync.status('devx')).running, false);
  rm(dir);
});

test('office PC: a lease is never consulted, so a restart after a crash cannot be blocked by one', async () => {
  const { dir, sync } = setup({ lease: false });
  await store.update('sync_devx', {}, s => { s.lease = { run_id: 'run_old', by: 'x', until: new Date(Date.now() + 3600000).toISOString() }; });
  assert.equal((await sync.status('devx')).running, false);
  assert.equal((await sync.run({ company: 'devx', mode: 'period', from: '2026-10', to: '2026-10' })).status, 'completed');
  rm(dir);
});

test('a first sync that is cut short has already fixed its change-feed starting point (edits made during a multi-slice first sync are not missed)', async () => {
  const { dir, sync } = setup();
  const r = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10', maxMs: 1 });
  assert.equal(r.status, 'partial');
  const st = await sync.loadState('devx');
  assert.ok(st.hwm.bill && st.hwm.expense && st.hwm.vendor_credit, 'high-water marks are set from the start of the first slice');
  rm(dir);
});

test('a time slice ends a run cleanly ("partial") and the next run carries on', async () => {
  const { dir, zr, sync } = setup();
  const r1 = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10', maxMs: 1 });
  assert.equal(r1.status, 'partial');
  const r2 = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(r2.status, 'completed');
  assert.equal((await books.stats('devx')).detailed, 5);
  rm(dir);
});

test('change feed: an edited bill, expense and credit are refreshed, a voided bill is excluded without a detail call, a new bill is added', async () => {
  const { dir, zr, sync } = setup();
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  const callsBefore = detailCalls(zr).length, queriesBefore = zr.queries.length;
  const later = s => new Date(Date.now() + s * 1000).toISOString().replace(/\.\d+Z$/, '+0000');            // modified AFTER the first sync
  zr.put('bills', F.bill({ id: 'b1', no: 'INV/1', date: '2026-10-12', taxable: 1200, lmt: later(5) }));                                       // edited amount
  zr.put('bills', F.bill({ id: 'b2', no: 'INV/2', date: '2026-10-14', taxable: 2000, tax: 'inter', gst: F.SUP_MH, branch: 'br_b', dest: 'MH', status: 'void', lmt: later(6) }));
  zr.put('bills', F.bill({ id: 'b8', no: 'INV/8', date: '2026-11-10', taxable: 300, lmt: later(7) }));
  zr.put('expenses', F.expense({ id: 'e1', ref: 'SUP/7', date: '2026-10-21', taxable: 300, lmt: later(8) }));                                 // an edited expense: its list refuses sort_column=last_modified_time
  zr.put('credits', F.credit({ id: 'c1', no: 'CN/1', date: '2026-10-18', taxable: 700, lmt: later(9) }));
  const r = await sync.run({ company: 'devx', mode: 'incremental' });
  assert.equal(r.status, 'completed', r.message || r.error);
  const fetched = detailCalls(zr).slice(callsBefore).map(l => l.split('/').pop()).sort();
  assert.deepEqual(fetched, ['b1', 'b8', 'c1', 'e1'], 'only the edited and the new documents are fetched; the voided bill needs no detail');
  const [b1] = await byZohoId('b1'), [b2] = await byZohoId('b2'), [b8] = await byZohoId('b8'), [e1] = await byZohoId('e1'), [c1] = await byZohoId('c1');
  assert.equal(b1.amounts.taxable, 120000); assert.equal(b1.revisions.length, 1); assert.equal(b1.revisions[0].lmt, '2026-10-15T10:00:00+0530'); assert.equal(b1.stale, undefined);
  assert.equal(b2.excluded, 'void'); assert.equal(b2.detail_pending, false);
  assert.equal(b8.amounts.taxable, 30000); assert.equal(e1.amounts.taxable, 30000); assert.equal(c1.amounts.taxable, 70000);
  // what the feed asked Zoho: its own "modified since" filter in the form Zoho accepts, one list per kind, and never a sort on last_modified_time
  const asked = zr.queries.slice(queriesBefore);
  assert.deepEqual([...new Set(asked.map(q => q.path))].sort(), ['/bills', '/expenses', '/vendorcredits']);
  for (const q of asked) {
    assert.match(q.params.last_modified_time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+0000$/, `${q.path}: the modified-since filter`);
    assert.equal(q.params.sort_column, 'created_time', `${q.path}: sorted by created time — never by last_modified_time, which Zoho refuses on expenses`);
  }
  rm(dir);
});

// ── Scope: which documents are worth a Zoho call (one call per document is what a sync costs) ──
test('scope: a switched-off GSTIN costs no detail call; switched on again it is read at the next sync without listing anything again', async () => {
  const { dir, zr, cfg, sync } = setup();
  cfg.companies[0].registrations[1].active = false;                                           // REC_B (Maharashtra: bill b2) is switched off
  const r = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(r.status, 'completed', r.message || r.error);
  assert.deepEqual(detailCalls(zr).map(l => l.split('/').pop()).sort(), ['b1', 'b5', 'c1', 'e1'], 'b2, the switched-off GSTIN, is not read');
  const [b2] = await byZohoId('b2');
  assert.equal(b2.excluded, 'gstin_off'); assert.equal(b2.detail_pending, false); assert.equal(b2.amounts, null);
  const st = await books.stats('devx');
  assert.equal(st.excluded.gstin_off, 1); assert.equal(st.pending, 0, 'nothing is shown as waiting for amounts that will not be read');
  const status = await sync.status('devx');
  assert.equal(status.scope.gstins_total, 2); assert.deepEqual(status.scope.gstins_on.map(x => x.gstin), [F.REC_A]); assert.equal(status.scope.from, '2026-08');
  // switched on: the next change sync reads it; no month is listed again
  cfg.companies[0].registrations[1].active = true;
  const queriesBefore = zr.queries.length;
  const r2 = await sync.run({ company: 'devx', mode: 'incremental' });
  assert.equal(r2.status, 'completed', r2.message || r2.error); assert.deepEqual(r2.scope, { parked: 0, revived: 1 });
  const [on] = await byZohoId('b2');
  assert.equal(on.excluded, null); assert.equal(on.amounts.igst, 36000);
  assert.ok(zr.queries.slice(queriesBefore).every(q => q.params.last_modified_time && !q.params.date_start), 'only the change feed listed: no month was listed again');
  assert.equal(detailCalls(zr).filter(l => l.endsWith('/b2')).length, 1);
  assert.equal((await sync.run({ company: 'devx', mode: 'incremental' })).scope, null, 'the scope step runs only when a setting or the first month changed');
  rm(dir);
});

test('scope: no GSTIN set up yet restricts nothing (every document that can be matched is read)', async () => {
  const { dir, zr, cfg, sync } = setup();
  cfg.companies[0].registrations = [];
  assert.equal((await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' })).status, 'completed');
  assert.deepEqual(detailCalls(zr).map(l => l.split('/').pop()).sort(), ['b1', 'b2', 'b5', 'c1', 'e1']);
  rm(dir);
});

test('scope step: waiting documents of a switched-off GSTIN or before the first month are set aside without a Zoho call, and come back; documents with amounts are never touched', async () => {
  const dir = tempDir(); store.configure({ dir, useDb: false });
  const base = { company: { id: 'devx', org_id: F.ORG, invoice_date_field: 'cf_vendor_bill_date', credit_date_field: 'cf_bill_date', credit_number_field: 'vendor_credit_number' }, branches: new Map(F.BRANCHES.map(b => [b.id, { name: b.name, gstin: b.gstin, state: b.state_code }])), vendors: new Map() };
  const open = { ...base, activeGstins: new Set([F.REC_A, F.REC_B]), periodFrom: null };
  const rows = [F.bill({ id: 'w1', no: '1', date: '2026-10-12' }), F.bill({ id: 'w2', no: '2', date: '2026-10-12', branch: 'br_b', dest: 'MH', tax: 'inter' }), F.bill({ id: 'w3', no: '3', date: '2025-01-05' }), F.bill({ id: 'w4', no: '4', date: '2026-10-13' })];
  await books.upsertMany('devx', rows.map(b => C.fromList(b.row, open, 'bill')));
  const done = C.fromDetail(rows[3].detail, rows[3].row, open, 'bill');                       // w4 already has its amounts
  await books.upsertMany('devx', [done]);
  const narrow = { ...base, activeGstins: new Set([F.REC_A]), periodFrom: '2026-08-01' };
  const apply = c => books.applyScope('devx', C.EXCLUSIONS, (g, d) => C.scopeExclusion(g, d, c));
  const get = async id => (await books.all('devx')).find(d => d.zoho_id === id);
  assert.deepEqual(await apply(narrow), { parked: 2, revived: 0 });
  assert.equal((await get('w1')).detail_pending, true);
  assert.equal((await get('w2')).excluded, 'gstin_off'); assert.equal((await get('w3')).excluded, 'outside_period');
  assert.equal((await get('w2')).excluded_text, C.EXCLUSIONS.gstin_off);
  assert.deepEqual(await apply(narrow), { parked: 0, revived: 0 }, 'applying the same scope again changes nothing');
  assert.deepEqual(await apply({ ...narrow, activeGstins: new Set([F.REC_A, F.REC_B]) }), { parked: 0, revived: 1 });              // GSTIN switched on: only w2 returns
  assert.equal((await get('w2')).detail_pending, true); assert.equal((await get('w2')).excluded, null); assert.equal((await get('w3')).excluded, 'outside_period');
  assert.deepEqual(await apply(open), { parked: 0, revived: 1 });                                                                    // an earlier first month: w3 returns
  assert.equal((await get('w3')).excluded, null); assert.equal((await get('w3')).detail_pending, true);
  assert.deepEqual(await apply({ ...narrow, activeGstins: new Set(), periodFrom: '2099-01-01' }).then(r => r.parked), 3, 'all three waiting documents are set aside');
  const w4 = await get('w4'); assert.ok(w4.amounts && w4.excluded === null, 'a document that already has its amounts is never parked');
  rm(dir);
});

test('scope: a vendor credit dated before the first month synced is not read; an earlier period reads it', async () => {
  const { dir, zr, sync } = setup();
  zr.put('credits', F.credit({ id: 'c0', no: 'CN/0', date: '2025-03-01' }));
  const r = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(r.status, 'completed', r.message || r.error);
  assert.ok(!detailCalls(zr).some(l => l.endsWith('/c0')), 'the old credit costs no detail call');
  assert.equal((await byZohoId('c0'))[0].excluded, 'outside_period');
  assert.equal((await sync.loadState('devx')).synced_from, '2026-08');
  // an earlier period brings it into scope: the credit list is read in full each time, and the scope step revives it
  const r2 = await sync.run({ company: 'devx', mode: 'period', from: '2025-01', to: '2025-04' });
  assert.equal(r2.status, 'completed', r2.message || r2.error);
  assert.equal((await sync.loadState('devx')).synced_from, '2025-01');
  const [c0] = await byZohoId('c0');
  assert.equal(c0.excluded, null); assert.ok(c0.amounts);
  assert.ok(detailCalls(zr).some(l => l.endsWith('/c0')));
  rm(dir);
});

test('scope: the change feed does not read a changed document older than the first month synced', async () => {
  const { dir, zr, sync } = setup();
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  const before = detailCalls(zr).length;
  zr.put('bills', F.bill({ id: 'old1', no: 'OLD/1', date: '2025-02-10', lmt: new Date(Date.now() + 5000).toISOString().replace(/\.\d+Z$/, '+0000') }));
  const r = await sync.run({ company: 'devx', mode: 'incremental' });
  assert.equal(r.status, 'completed', r.message || r.error);
  assert.equal(detailCalls(zr).length, before, 'no detail call for it');
  assert.equal((await byZohoId('old1'))[0].excluded, 'outside_period');
  rm(dir);
});

test('scope: a state saved before the first month was recorded falls back to the months already listed', async () => {
  const { dir, zr, sync } = setup();
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  await store.update('sync_devx', {}, s => { delete s.synced_from; delete s.scope_sig; });      // the shape of a state written by the previous version
  zr.put('credits', F.credit({ id: 'c9', no: 'CN/9', date: '2024-05-05' }));
  zr.put('credits', F.credit({ id: 'c10', no: 'CN/10', date: '2026-10-25', lmt: new Date(Date.now() + 5000).toISOString().replace(/\.\d+Z$/, '+0000') }));
  const before = detailCalls(zr).length;
  const r = await sync.run({ company: 'devx', mode: 'incremental' });
  assert.equal(r.status, 'completed', r.message || r.error);
  assert.equal((await sync.status('devx')).scope.from, '2026-08');
  assert.deepEqual(detailCalls(zr).slice(before).map(l => l.split('/').pop()), ['c10'], 'only the credit inside the synced months is read');
  rm(dir);
});

test('a re-check without months re-reads the months already synced, not two financial years', async () => {
  const { dir, zr, sync } = setup();
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  const mark = zr.queries.length;
  const r = await sync.run({ company: 'devx', mode: 'recheck' });
  assert.equal(r.status, 'completed', r.message || r.error); assert.equal(r.from, '2026-08');
  assert.equal(zr.queries.slice(mark).filter(q => q.params.date_start).map(q => q.params.date_start).sort()[0], '2026-08-01');
  rm(dir);
});

test('the Zoho test double refuses what live Zoho refused (so such a request can never pass the tests again)', async () => {
  const zr = F.makeFake();
  const refused = (path, key, params) => zr.list(F.ORG, path, key, params, {});
  await assert.rejects(refused('/expenses', 'expenses', { sort_column: 'last_modified_time', sort_order: 'D' }), e => e.response.status === 400 && e.response.data.code === 2 && /sort_column/.test(e.response.data.message));
  await assert.doesNotReject(refused('/bills', 'bills', { sort_column: 'last_modified_time', sort_order: 'D' }));          // accepted live
  await assert.doesNotReject(refused('/vendorcredits', 'vendor_credits', { sort_column: 'last_modified_time' }));            // accepted live
  await assert.doesNotReject(refused('/expenses', 'expenses', { sort_column: 'created_time' }));
  await assert.rejects(refused('/bills', 'bills', { last_modified_time: '2026-11-12 10:00:00' }), e => e.response.data.code === 2 && /last_modified_time/.test(e.response.data.message));   // Zoho wants ISO 8601 with an offset
  zr.put('expenses', F.expense({ id: 'x1', lmt: '2026-11-10T10:00:00+0530' })); zr.put('expenses', F.expense({ id: 'x2', lmt: '2026-11-12T10:00:00+0530' }));
  const got = await zr.list(F.ORG, '/expenses', 'expenses', { last_modified_time: '2026-11-11T00:00:00+0000' }, { onPage: async () => true });
  assert.equal(got.complete, true);
  const seen = []; await zr.list(F.ORG, '/expenses', 'expenses', { last_modified_time: '2026-11-11T00:00:00+0000' }, { onPage: async p => { seen.push(...p.map(r => r.expense_id)); return true; } });
  assert.deepEqual(seen, ['x2'], 'only the document modified since is listed');
});

test('incremental before any initial sync does nothing, says so, and is not recorded as a successful sync', async () => {
  const { dir, zr, sync } = setup();
  const r = await sync.run({ company: 'devx', mode: 'incremental' });
  assert.equal(r.status, 'needs_first_sync'); assert.match(r.message, /no first sync yet/i);
  assert.ok(r.warnings.some(w => /No initial sync yet/.test(w)));
  assert.equal((await books.all('devx')).length, 0);
  assert.equal(zr.log.filter(l => /^LIST /.test(l)).length, 0, 'nothing was listed in Zoho');
  const st = await sync.loadState('devx');
  assert.equal(st.last_ok_at, null, 'nothing was synced, so there is no "last successful sync"');
  assert.deepEqual(st.hwm, {}, 'and the change feed has no starting point yet');
  assert.equal((await sync.status('devx')).last_ok_at, null);
  assert.equal(st.runs.length, 1); assert.equal(st.runs[0].status, 'needs_first_sync');
  // the first period sync then works, sets the starting point, and the change feed runs normally afterwards
  assert.equal((await sync.run({ company: 'devx', mode: 'period', from: '2026-10', to: '2026-10' })).status, 'completed');
  assert.ok((await sync.loadState('devx')).hwm.bill);
  assert.equal((await sync.run({ company: 'devx', mode: 'incremental' })).status, 'completed');
  assert.ok((await sync.loadState('devx')).last_ok_at);
  rm(dir);
});

test('recheck finds a document deleted in Zoho (confirmed by a 404) and keeps it as a tombstone', async () => {
  const { dir, zr, sync } = setup();
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  zr.remove('bills', 'b5'); zr.remove('credits', 'c1');
  const r = await sync.run({ company: 'devx', mode: 'recheck', from: '2026-08', to: '2026-10' });
  assert.equal(r.status, 'completed', r.message || r.error);
  assert.equal(r.details.deleted, 2);
  const [b5] = await byZohoId('b5'), [c1] = await byZohoId('c1');
  for (const d of [b5, c1]) { assert.equal(d.deleted, true); assert.equal(d.excluded, 'deleted'); assert.ok(d.deleted_at); }
  assert.ok(zr.log.includes('GET /bills/b5'), 'confirmed by ID before removal');
  assert.equal((await byZohoId('b1'))[0].deleted, false);
  rm(dir);
});

test('posting date edited in Zoho: the document moves months, never duplicates', async () => {
  const { dir, zr, sync } = setup();
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-11' });
  zr.put('bills', F.bill({ id: 'b1', no: 'INV/1', date: '2026-11-03', inv: '2026-10-12', lmt: '2026-11-11T10:00:00+0530' }));
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-11' });
  const hits = await byZohoId('b1');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].posting_date, '2026-11-03'); assert.equal(hits[0].doc_date, '2026-10-12');
  assert.equal(await books.get('devx', hits[0].id).then(d => d.accounting_period), '2026-11');
  rm(dir);
});

test('one failing detail does not stop the others; after three failures it is parked and reported', async () => {
  const { dir, zr, sync } = setup();
  zr.state.failDetail.add('b5');
  for (let i = 0; i < 4; i++) await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  const docs = await books.all('devx');
  assert.equal(docs.filter(d => d.amounts).length, 4, 'the other four were fetched');
  const b5 = docs.find(d => d.zoho_id === 'b5');
  assert.equal(b5.detail_fail, 3); assert.match(b5.detail_error, /internal error/);
  assert.equal(detailCalls(zr).filter(l => l.endsWith('/b5')).length, 3, 'stops retrying after three failures');
  assert.equal((await sync.status('devx')).failing_documents, 1);
  rm(dir);
});

test('status shows the budget, backlog and last runs; a concurrent run is refused; demo / unknown companies are rejected', async () => {
  const { dir, sync, cfg } = setup({ budget: 2000 });
  const p1 = sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  const busy = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(busy.busy, true);
  await p1;
  const st = await sync.status('devx');
  assert.equal(st.running, false); assert.equal(st.budget.limit, 2000); assert.ok(st.budget.used > 0); assert.equal(st.runs[0].status, 'completed'); assert.ok(st.last_ok_at);
  await assert.rejects(sync.run({ company: 'nope' }), /Unknown company/);
  cfg.companies.push({ id: 'demo', name: 'Demo', demo: true, active: true, registrations: [] });
  await assert.rejects(sync.run({ company: 'demo' }), /demo company/);
  rm(dir);
});

test('cancel stops a running sync at the next call (a user clicking Stop while it runs)', async () => {
  const { dir, zr, sync } = setup({ pageSize: 1 });
  const realList = zr.list;
  let seen = 0;
  zr.list = async (...a) => { if (++seen === 2) assert.equal(sync.cancel('devx'), true); return realList.apply(zr, a); };   // Stop pressed during the second listing
  const r = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(r.status, 'cancelled');
  assert.ok((await books.stats('devx')).pending >= 0);
  const r2 = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });   // and a later run simply continues
  assert.equal(r2.status, 'completed');
  assert.equal((await books.stats('devx')).detailed, 5);
  rm(dir);
});

// ── the Zoho client itself ──
test('the Zoho client has no way to write: only GET methods exist and every request is a GET', async () => {
  const sent = [];
  const http = { get: async (url, o) => { sent.push({ url, params: o.params }); return { data: { ok: true } }; }, post: async () => { throw new Error('POST must never be used for data'); } };
  const zr = ZR.create({ http, env: { ZOHO_API_DOMAIN: 'https://www.zohoapis.in', ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.in' }, zoho: { getAccessToken: async () => 'tok' }, sleep: async () => {} });
  assert.deepEqual(Object.keys(zr).sort(), ['calls', 'checkAccess', 'dedicated', 'errText', 'get', 'identity', 'isGone', 'list', 'listBranches', 'listOrganizations', 'usage']);
  for (const k of Object.keys(zr)) assert.ok(!/^(post|put|delete|patch|send|create|update)/i.test(k), `no write method: ${k}`);
  assert.ok(Object.isFrozen(zr));
  await zr.get('123', '/bills', { per_page: 1 });
  assert.equal(sent.length, 1); assert.equal(sent[0].params.organization_id, '123'); assert.match(sent[0].url, /\/books\/v3\/bills$/);
});

test('Zoho client: waits out a short 429, stops on the daily limit (45), paces calls, refreshes a dedicated token on 401', async () => {
  const waits = [];
  let n = 0;
  const http429 = { get: async () => { if (n++ === 0) throw Object.assign(new Error('rl'), { response: { status: 429, data: { code: 7 }, headers: { 'retry-after': '5' } } }); return { data: { ok: 1 } }; } };
  const env = { ZOHO_API_DOMAIN: 'x', ZOHO_ACCOUNTS_URL: 'y' };
  const z1 = ZR.create({ http: http429, env, zoho: { getAccessToken: async () => 't' }, sleep: async ms => waits.push(ms) });
  assert.deepEqual(await z1.get('1', '/bills'), { ok: 1 });
  assert.deepEqual(waits, [5000]);
  const http45 = { get: async () => { throw Object.assign(new Error('limit'), { response: { status: 429, data: { code: 45 }, headers: {} } }); } };
  const z2 = ZR.create({ http: http45, env, zoho: { getAccessToken: async () => 't' }, sleep: async () => {} });
  await assert.rejects(z2.get('1', '/bills'), e => e instanceof ZR.ZohoLimit && e.code === 45);
  const http90 = { get: async () => { throw Object.assign(new Error('rl'), { response: { status: 429, data: {}, headers: { 'retry-after': '600' } } }); } };
  await assert.rejects(ZR.create({ http: http90, env, zoho: { getAccessToken: async () => 't' }, sleep: async () => {} }).get('1', '/bills'), e => e instanceof ZR.ZohoLimit);
  // dedicated read-only token: refreshed once on a 401
  let posts = 0, gets = 0;
  const httpTok = { post: async () => ({ data: { access_token: `tok${++posts}`, expires_in: 3600 } }),
    get: async (u, o) => { if (gets++ === 0) throw Object.assign(new Error('401'), { response: { status: 401, data: {} } }); return { data: { used: o.headers.Authorization } }; } };
  const z3 = ZR.create({ http: httpTok, env: { ...env, GSTR2B_ZOHO_REFRESH_TOKEN: 'r', ZOHO_CLIENT_ID: 'c', ZOHO_CLIENT_SECRET: 's' }, sleep: async () => {} });
  assert.equal(z3.dedicated(), true);
  assert.equal((await z3.get('1', '/bills')).used, 'Zoho-oauthtoken tok2');
  assert.equal(posts, 2);
  // pacing: a minimum gap between two calls
  const gaps = [];
  const z4 = ZR.create({ http: { get: async () => ({ data: {} }) }, env, zoho: { getAccessToken: async () => 't' }, sleep: async ms => gaps.push(ms) });
  await z4.get('1', '/a', {}, { paceMs: 1000 }); await z4.get('1', '/b', {}, { paceMs: 1000 });
  assert.ok(gaps.length === 1 && gaps[0] > 0 && gaps[0] <= 1000);
  assert.ok(z4.isGone(Object.assign(new Error('x'), { response: { status: 404 } })) && z4.isGone({ response: { data: { code: 1002 } } }) && !z4.isGone(new Error('x')));
});

// ── Speed and limits ──
test('the calls-per-minute queue: turns are 60 / rate seconds apart however many callers wait, and a "too many requests" from Zoho holds everyone back', async () => {
  const naps = [];
  const q = SYNC.limiter(60, async ms => { naps.push(Math.round(ms / 100) * 100); });          // 60 a minute = one turn a second
  await Promise.all([q.turn(), q.turn(), q.turn(), q.turn(), q.turn()]);                       // five workers ask at the same moment
  assert.deepEqual(naps, [1000, 2000, 3000, 4000], 'the first goes at once, the others one second apart');
  q.holdFor(30000);
  naps.length = 0; await q.turn();
  assert.ok(naps[0] >= 29900, `nobody takes a turn while Zoho asked us to wait (${naps[0]} ms)`);
  assert.equal(Math.round(SYNC.limiter(90).gap), 667, '90 a minute = a call every two thirds of a second');
});

test('amounts are read by several workers at once, each document exactly once, at the rate set — and the old "pause between calls" no longer exists', async () => {
  const { dir, zr, sync, naps } = setup({ rate: 600, workers: 3 });                              // 600 a minute = a turn every 100 ms
  for (let i = 0; i < 12; i++) zr.put('bills', F.bill({ id: `p${i}`, no: `P/${i}`, date: '2026-10-0' + (1 + (i % 9)), taxable: 100 + i }));
  zr.state.detailMs = 25;                                                                       // every answer takes a moment
  const r = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(r.status, 'completed', r.message || r.error);
  const fetched = detailCalls(zr).map(l => l.split('/').pop());
  assert.equal(fetched.length, 17); assert.equal(new Set(fetched).size, 17, 'no document was read twice');
  assert.equal(zr.maxInFlight, 3, 'three calls were in flight at once — never more than the setting');
  assert.ok(naps.length > 0 && naps.every(ms => ms > 0), 'calls waited for their turn in the queue');
  assert.equal((await books.stats('devx')).pending, 0);
  // the limits a company saved with the first version (a 6-second pause, a budget sized for 10,000 calls a day) are replaced, not carried over
  const CFG = require('../lib/config');
  assert.deepEqual(CFG.merge({ sync: { pace_ms: 6000, daily_budget: 5000, slice_seconds: 200 } }).sync, { rate_per_min: 90, concurrency: 4, daily_budget: 30000, zoho_reserve: 15000, slice_seconds: 200 });
  assert.deepEqual(CFG.merge({ sync: { rate_per_min: 60, daily_budget: 20000, pace_ms: 6000 } }).sync, { rate_per_min: 60, concurrency: 4, daily_budget: 20000, zoho_reserve: 15000, slice_seconds: 180 });
  assert.match(CFG.validateSyncLimits({ rate_per_min: 5 }, CFG.merge(null).sync).error, /between 10 and 120/);
  assert.match(CFG.validateSyncLimits({ concurrency: 9 }, CFG.merge(null).sync).error, /between 1 and 6/);
  assert.match(CFG.validateSyncLimits({ zoho_reserve: 70000 }, CFG.merge(null).sync).error, /between 0 and 60000/);
  rm(dir);
});

test('Zoho says "too many requests" in the middle of a run: the other workers hold back as long as Zoho asked, and nothing is lost', async () => {
  const { dir, zr, sync, naps } = setup();
  zr.state.throttleOnce = 20;                                                                   // one "retry after 20 seconds"
  const r = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(r.status, 'completed', r.message || r.error);
  assert.ok(naps.some(ms => ms >= 19000), 'a later call waited out the 20 seconds');
  assert.equal((await books.stats('devx')).detailed, 5);
  rm(dir);
});

test('the organisation\'s own Zoho allowance is respected: the sync stops for the day when Zoho reports that only the reserve is left, and carries on the next day', async () => {
  const { dir, zr, sync } = setup({ reserve: 15000 });
  const tomorrow = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
  zr.state.usage = { day_limit: 90000, day_remaining: 14990, day_reset_at: tomorrow, minute_limit: 150, minute_remaining: 149, concurrency_limit: 20, at: new Date().toISOString() };
  const r = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(r.status, 'paused_limit'); assert.match(r.message, /14990 of the organisation's 90000 calls left.*keeps 15000 free for the other integrations/);
  assert.equal(zr.log.filter(l => /^(LIST|GET \/(bills|vendorcredits|expenses))/.test(l)).length, 0, 'not one more call was made');
  const st = await sync.status('devx');
  assert.equal(st.zoho.day_remaining, 14990); assert.equal(st.zoho.day_limit, 90000); assert.equal(st.zoho.reserve, 15000); assert.equal(st.zoho.minute_limit, 150);
  // a reading from before Zoho's midnight reset says nothing about today
  zr.state.usage = { ...zr.state.usage, day_reset_at: new Date(Date.now() - 60000).toISOString() };
  const next = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(next.status, 'completed', next.message || next.error);
  assert.equal((await sync.status('devx')).zoho.day_remaining, null, 'yesterday\'s count is not shown as today\'s');
  rm(dir);
});

// ── First-sync status ──
test('first sync status: not started → in progress (listing, then amounts, with a percentage) → completed; headers alone are never "completed"', async () => {
  const { dir, sync, cfg } = setup({ budget: 6 });
  let st = await sync.status('devx');
  assert.equal(st.initial.status, 'not_started'); assert.equal(st.initial.percent, null);
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10', by: 'CFO' });           // the small budget stops it while listing
  st = await sync.status('devx');
  assert.equal(st.initial.status, 'in_progress'); assert.equal(st.initial.phase, 'listing'); assert.equal(st.initial.percent, null, 'no percentage until the total is known');
  assert.equal(st.initial.from, '2026-08'); assert.equal(st.initial.to, '2026-10'); assert.equal(st.initial.by, 'CFO');
  cfg.sync.daily_budget = 12;                                                                              // enough to finish listing (10 calls so far) and read a few amounts
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10', by: 'CFO' });
  st = await sync.status('devx');
  assert.equal(st.initial.status, 'in_progress'); assert.equal(st.initial.phase, 'amounts', 'every month is listed, but amounts are still missing: NOT complete');
  assert.equal(st.initial.discovered, 5); assert.ok(st.initial.fetched > 0 && st.initial.fetched < 5, `${st.initial.fetched} fetched`); assert.equal(st.initial.pending, 5 - st.initial.fetched);
  assert.equal(st.initial.percent, st.initial.fetched * 20); assert.equal(st.initial.completed_at, null);
  assert.ok(st.speed.eta_minutes >= 1);
  cfg.sync.daily_budget = 1000;
  const done = await sync.run({ company: 'devx', mode: 'incremental', by: 'schedule', auto: true });       // the scheduler finishes it
  assert.equal(done.status, 'completed');
  st = await sync.status('devx');
  assert.equal(st.initial.status, 'completed'); assert.equal(st.initial.percent, 100); assert.equal(st.initial.pending, 0); assert.equal(st.initial.failed, 0); assert.ok(st.initial.completed_at);
  assert.equal(st.speed.eta_minutes, 0);
  rm(dir);
});

test('a sync state written by the previous version is taken over as it is: the first sync shows "in progress" and finishes without listing a month again', async () => {
  const { dir, zr, sync } = setup();
  const now = new Date().toISOString();
  const ctx = { company: { id: 'devx', org_id: F.ORG, invoice_date_field: 'cf_vendor_bill_date', credit_date_field: 'cf_bill_date', credit_number_field: 'vendor_credit_number' }, branches: new Map(F.BRANCHES.map(b => [b.id, { name: b.name, gstin: b.gstin, state: b.state_code }])), vendors: new Map(), activeGstins: null, periodFrom: '2026-08-01' };
  await books.upsertMany('devx', [...zr.store.bills.values()].map(e => C.fromList(e.row, ctx, 'bill')));   // listed, no amounts — as the old version left them
  // … with an error from 5:34 pm still in the state although runs after it got through (what the card showed in red on 12 Nov 2026)
  const earlier = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const oldRun = { run_id: 'run_old', company: 'devx', mode: 'period', by: 'Administrator', status: 'partial', started_at: now, finished_at: now, from: '2026-08', to: '2026-10', lists: { bill: { rows: 0, added: 0, changed: 0 } }, details: { queued: 3, fetched: 0, failed: 0, deleted: 0 }, calls: 31, warnings: [], message: 'This slice used its time; the run continues next time' };
  await store.write('sync_devx', { branches: {}, hwm: { bill: now, expense: now, vendor_credit: now }, synced_from: '2026-08', budget: { day: '', used: 0 }, runs: [oldRun], last_ok_at: null, lease: null,
    last_error: { at: earlier, message: 'Zoho: Invalid value passed for sort_column (code 2)' },
    windows: Object.fromEntries(['2026-08', '2026-09', '2026-10'].flatMap(m => [[`bill:${m}`, { at: now, rows: 1, kept: 1 }], [`expense:${m}`, { at: now, rows: 0, kept: 0 }]])) });
  let st = await sync.status('devx');
  assert.equal(st.initial.status, 'in_progress'); assert.equal(st.initial.phase, 'amounts'); assert.equal(st.initial.from, '2026-08'); assert.equal(st.initial.to, '2026-10');
  assert.equal(st.initial.pending, 3); assert.equal(st.initial.percent, 0);
  assert.equal(st.last_error, null, 'the leftover error is not shown: later runs got through');
  assert.equal(st.runs[0].run_id, 'run_old', 'the earlier runs are still listed');
  assert.deepEqual(await sync.due('devx').then(d => [d.run, d.mode]), [true, 'incremental'], 'the scheduler carries on with a change check + the amounts, not with a new listing');
  const lists = zr.queries.length;
  const r = await sync.run({ company: 'devx', mode: 'incremental', by: 'schedule', auto: true });
  assert.equal(r.status, 'completed', r.message || r.error);
  assert.ok(zr.queries.slice(lists).every(q => q.params.last_modified_time && !q.params.date_start), 'no month was listed again');
  st = await sync.status('devx');
  assert.equal(st.initial.status, 'completed'); assert.equal(st.initial.fetched, 3);
  assert.equal(st.last_error, null, 'the error of an earlier run is not shown once a later run got through');
  rm(dir);
});

test('an error is shown only while it is the latest outcome: a later run that gets through — even a partial one — clears it', async () => {
  const { dir, zr, sync } = setup();
  const real = zr.listBranches;
  zr.listBranches = async () => { throw new Error('Zoho: service unavailable'); };
  const bad = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(bad.status, 'failed');
  let st = await sync.status('devx');
  assert.match(st.last_error.message, /service unavailable/); assert.equal(st.initial.status, 'not_started');
  zr.listBranches = real;
  const part = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10', maxMs: -1 });
  assert.equal(part.status, 'partial');
  st = await sync.status('devx');
  assert.equal(st.last_error, null); assert.equal(st.initial.status, 'in_progress');
  // a failure during a first sync is shown as "failed" until the next run
  zr.listBranches = async () => { throw new Error('Zoho: service unavailable'); };
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal((await sync.status('devx')).initial.status, 'failed');
  zr.listBranches = real;
  assert.equal((await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' })).status, 'completed');
  assert.equal((await sync.status('devx')).initial.status, 'completed');
  rm(dir);
});

test('checked against Zoho: every listed document is accounted for, stored totals are compared with Zoho\'s list, and a difference is reported — not hidden', async () => {
  const { dir, zr, sync } = setup();
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  const ok = await sync.run({ company: 'devx', mode: 'recheck', from: '2026-08', to: '2026-10', by: 'CFO' });
  assert.equal(ok.status, 'completed', ok.message || ok.error);
  let v = (await sync.status('devx')).verify;
  assert.equal(v.ok, true); assert.equal(v.by, 'CFO'); assert.equal(v.from, '2026-08');
  const b = v.kinds.bill, e = v.kinds.expense, c = v.kinds.vendor_credit;
  assert.equal(b.zoho_rows, 7); assert.equal(b.stored, 7); assert.equal(b.kept_out, 4); assert.equal(b.agree, 3); assert.equal(b.differ, 0); assert.equal(b.waiting, 0);
  assert.equal(b.kept_out + b.waiting + b.agree + b.differ, b.zoho_rows, 'every bill Zoho lists is in exactly one column');
  assert.equal(b.agree_total_p, 118000 + 236000 + (590000 - 10000), 'the three bills\' totals as Zoho lists them (the third is net of Rs 100 TDS)');
  assert.equal(b.taxable_p, 100000 + 200000 + 500000); assert.equal(b.tax_p, 18000 + 36000 + 90000);
  assert.equal(e.zoho_rows, 2); assert.equal(e.not_kept, 1, 'the expense without GST is not stored'); assert.equal(e.agree, 1);
  assert.equal(c.zoho_rows, 1); assert.equal(c.agree, 1);
  assert.equal(v.total.zoho_rows, 10); assert.equal(v.total.agree, 5);
  // Zoho's own count of each list was asked for too, and the lists returned exactly that many different documents
  assert.equal(b.zoho_count, 7); assert.equal(e.zoho_count, 2); assert.equal(c.zoho_count, 1); assert.equal(v.total.zoho_count, 10); assert.equal(v.counts_ok, true);
  // Zoho now lists a different total for a bill whose "last modified" did not move (so the change feed cannot know)
  const b1 = zr.store.bills.get('b1'); b1.row = { ...b1.row, total: 9999 };
  await sync.run({ company: 'devx', mode: 'recheck', from: '2026-08', to: '2026-10' });
  v = (await sync.status('devx')).verify;
  assert.equal(v.ok, false); assert.equal(v.kinds.bill.differ, 1); assert.equal(v.kinds.bill.agree, 2); assert.equal(v.kinds.bill.differ_p, 118000 - 999900);
  assert.deepEqual(v.differ_docs.map(d => [d.doc_no, d.zoho_p, d.stored_p]), [['INV/1', 999900, 118000]]);
  rm(dir);
});

test('the scheduler\'s question "what is due?": nothing before a first sync, the rest of an unfinished listing, waiting amounts, a change check when the last one is old enough', async () => {
  const { dir, sync, cfg } = setup({ budget: 4 });
  assert.deepEqual(await sync.due('devx'), { run: false, reason: 'needs_first_sync' });
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.deepEqual(await sync.due('devx').then(d => [d.run, d.mode, d.from, d.to]), [true, 'period', '2026-08', '2026-10']);
  cfg.sync.daily_budget = 13;
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });                       // listing done, amounts not
  const d = await sync.due('devx', { minAgeMs: 3600000 });
  assert.equal(d.run, true); assert.equal(d.mode, 'incremental'); assert.match(d.why, /waiting for amounts/);
  cfg.sync.daily_budget = 1000;
  await sync.run({ company: 'devx', mode: 'incremental' });
  assert.deepEqual(await sync.due('devx', { minAgeMs: 3600000 }), { run: false, reason: 'fresh' });
  const fresh = await sync.due('devx');
  assert.equal(fresh.run, true); assert.equal(fresh.verify_due, true, 'a finished first sync is compared with Zoho once');
  await sync.run({ company: 'devx', mode: 'recheck' });
  assert.equal((await sync.due('devx')).verify_due, false);
  rm(dir);
});

test('Zoho client: reads the organisation\'s allowance from every answer (per organisation), also from a refusal, and tells the caller how long Zoho asked to wait', async () => {
  const h = (left, minute) => ({ 'x-rate-limit-limit': '90000', 'x-rate-limit-remaining': String(left), 'x-rate-limit-reset': '3600', 'x-user-access-limit': '150', 'x-user-access-remaining': String(minute), 'x-user-concurrency-limit': '20' });
  let n = 0; const asked = [];
  const http = { get: async (url, o) => {
    n++;
    if (o.params.organization_id === 'B') return { data: {}, headers: {} };                                   // an answer without the allowance headers
    if (n === 2) throw Object.assign(new Error('rl'), { response: { status: 429, data: { code: 44 }, headers: { ...h(80000, 0), 'retry-after': '12' } } });
    return { data: { ok: n }, headers: h(90000 - n, 149) };
  } };
  const zr = ZR.create({ http, env: { ZOHO_API_DOMAIN: 'x', ZOHO_ACCOUNTS_URL: 'y' }, zoho: { getAccessToken: async () => 't' }, sleep: async () => {} });
  assert.equal(zr.usage('A'), null, 'nothing known before the first answer');
  await zr.get('A', '/bills');
  const u = zr.usage('A');
  assert.equal(u.day_limit, 90000); assert.equal(u.day_remaining, 89999); assert.equal(u.minute_limit, 150); assert.equal(u.minute_remaining, 149); assert.equal(u.concurrency_limit, 20);
  assert.ok(Math.abs(Date.parse(u.day_reset_at) - Date.now() - 3600000) < 5000, 'the reset moment is worked out from Zoho\'s "seconds until reset"');
  await zr.get('A', '/bills', {}, { onThrottle: s => asked.push(s) });                                         // refused once, then answered
  assert.deepEqual(asked, [12]); assert.equal(zr.usage('A').day_remaining, 89997);
  await zr.get('B', '/bills');
  assert.equal(zr.usage('B'), null, 'one organisation\'s allowance is never taken for another\'s');
  await assert.rejects(ZR.create({ http: { get: async () => { throw Object.assign(new Error('limit'), { response: { status: 429, data: { code: 45 }, headers: {} } }); } }, env: {}, zoho: { getAccessToken: async () => 't' }, sleep: async () => {} }).get('1', '/bills'), /after midnight \(India time\)/);
});

// ── Every document of a list — completely ──
test('a list that pages badly (one document missing, another returned twice — seen live on vendor credits) is read again until Zoho\'s own count is reached', async () => {
  const { dir, zr, sync } = setup();
  zr.state.pagingDefect = { '/bills': { ids: ['b1'], readings: 1 } };                          // the first reading of a bills list loses b1
  const r = await sync.run({ company: 'devx', mode: 'period', from: '2026-10', to: '2026-10' });
  assert.equal(r.status, 'completed', r.message || r.error); assert.deepEqual(r.warnings, []);
  const docs = await books.all('devx');
  assert.ok(docs.find(d => d.zoho_id === 'b1').amounts, 'the document the first reading lost was found by the second and has its amounts');
  assert.equal(docs.filter(d => d.kind === 'bill').length, 4, 'and no document was stored twice');
  const readings = zr.queries.filter(q => q.path === '/bills').map(q => `${q.params.sort_column} ${q.params.sort_order}`);
  assert.deepEqual(readings, ['created_time A', 'created_time D'], 'sorted by created time (dates repeat, created times hardly ever), the second reading in the opposite order');
  assert.deepEqual(zr.counts.filter(c => c.path === '/bills').map(c => [c.params.date_start, c.params.response_option]), [['2026-10-01', 2], ['2026-10-01', 2]], 'Zoho was asked for its own count after each reading');
  assert.equal((await sync.loadState('devx')).windows['bill:2026-10'].complete, true); assert.equal((await sync.loadState('devx')).windows['bill:2026-10'].count, 4);
  rm(dir);
});

test('a list that stays short of Zoho\'s count is reported, never taken for complete: nothing is removed on its word, and the check against Zoho shows the gap', async () => {
  const { dir, zr, sync } = setup();
  assert.equal((await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' })).status, 'completed');
  zr.state.pagingDefect = { '/bills': { ids: ['b1'], readings: 99 } };                         // Zoho keeps leaving b1 out of the October list
  const gets = detailCalls(zr).length;
  const r = await sync.run({ company: 'devx', mode: 'recheck', from: '2026-08', to: '2026-10' });
  assert.equal(r.status, 'completed', r.message || r.error);
  assert.ok(r.warnings.some(w => /Zoho counts 4 bills dated 2026-10 but its list returned only 3 different ones in three readings/.test(w)), r.warnings.join(' | '));
  assert.equal(zr.queries.filter(q => q.path === '/bills' && q.params.date_start === '2026-10-01').length - 1, 3, 'three readings of that month in the re-check (plus the first sync\'s one)');
  const b1 = (await books.all('devx')).find(d => d.zoho_id === 'b1');
  assert.equal(b1.deleted, false, 'b1 was not in the list, but the list was known to be incomplete: it is not taken for deleted');
  assert.equal(detailCalls(zr).length, gets, 'and Zoho was not even asked whether it still exists');
  const v = (await sync.status('devx')).verify;
  assert.equal(v.counts_ok, false); assert.equal(v.kinds.bill.zoho_count, 7); assert.equal(v.kinds.bill.zoho_rows, 6);
  assert.equal((await sync.loadState('devx')).windows['bill:2026-10'].complete, false);
  // the change check is held to the same standard: a "modified since" list that is short does not move the checkpoint
  zr.state.pagingDefect = null;
  for (let i = 0; i < 5; i++) zr.put('bills', F.bill({ id: `m${i}`, no: `M/${i}`, date: '2026-10-2' + i, lmt: new Date(Date.now() + 5000 + i).toISOString().replace(/\.\d+Z$/, '+0000') }));
  const mark = (await sync.loadState('devx')).hwm.bill;
  zr.state.pagingDefect = { '/bills': { ids: ['m4'], readings: 99 } };
  const inc = await sync.run({ company: 'devx', mode: 'incremental' });
  assert.equal(inc.status, 'completed'); assert.equal(inc.details.fetched, 4);
  assert.equal((await sync.loadState('devx')).hwm.bill, mark, 'the checkpoint stays where it was');
  zr.state.pagingDefect = null;
  const again = await sync.run({ company: 'devx', mode: 'incremental' });
  assert.equal(again.details.fetched, 1, 'so the next change check finds the document that was left out');
  assert.ok((await sync.loadState('devx')).hwm.bill > mark, 'and only then moves on');
  rm(dir);
});

test('a change check that fits in one page asks Zoho for nothing more (an idle check stays at four calls); an organisation whose Zoho gives no count is simply not compared by count', async () => {
  const { dir, zr, sync } = setup();
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  const counts = zr.counts.length, calls = zr.calls.total;
  const idle = await sync.run({ company: 'devx', mode: 'incremental', by: 'schedule', auto: true });
  assert.equal(idle.status, 'completed'); assert.equal(idle.calls, 4, 'the branch list and one "modified since" list for bills, vendor credits and expenses');
  assert.equal(zr.calls.total - calls, 4); assert.equal(zr.counts.length, counts, 'no count was asked for: a single page has no boundary to lose a document at');
  zr.state.noCount = true;
  const r = await sync.run({ company: 'devx', mode: 'recheck', from: '2026-08', to: '2026-10' });
  assert.equal(r.status, 'completed', r.message || r.error); assert.deepEqual(r.warnings, []);
  const v = (await sync.status('devx')).verify;
  assert.equal(v.kinds.bill.zoho_count, null); assert.equal(v.kinds.bill.zoho_rows, 7); assert.equal(v.counts_ok, true); assert.equal(v.ok, true);
  rm(dir);
});
