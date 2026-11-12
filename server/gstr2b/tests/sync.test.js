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
const ZR = require('../lib/zohoRead');

function setup({ budget = 1000, pageSize = 3, seed = true } = {}) {
  const dir = tempDir();
  store.configure({ dir, useDb: false });
  const zr = F.makeFake({ pageSize });
  const cfg = { companies: [{ id: 'devx', name: 'Test Co', org_id: F.ORG, active: true, invoice_date_field: 'cf_vendor_bill_date', credit_date_field: 'cf_bill_date', credit_number_field: 'vendor_credit_number', registrations: [{ gstin: F.REC_A }, { gstin: F.REC_B }] }],
    sync: { pace_ms: 0, daily_budget: budget, slice_seconds: 60 } };
  const audit = []; const sync = SYNC.create({ zr, cfgNow: async () => cfg, audit: { log: async e => audit.push(e) }, log: { error() {} } });
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
  return { dir, zr, cfg, sync, audit };
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

test('a time slice ends a run cleanly ("partial") and the next run carries on', async () => {
  const { dir, zr, sync } = setup();
  const r1 = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10', maxMs: 1 });
  assert.equal(r1.status, 'partial');
  const r2 = await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  assert.equal(r2.status, 'completed');
  assert.equal((await books.stats('devx')).detailed, 5);
  rm(dir);
});

test('change feed: an edited bill is refreshed, a voided bill is excluded without a detail call, a new bill is added', async () => {
  const { dir, zr, sync } = setup();
  await sync.run({ company: 'devx', mode: 'period', from: '2026-08', to: '2026-10' });
  const callsBefore = detailCalls(zr).length;
  const later = s => new Date(Date.now() + s * 1000).toISOString().replace(/\.\d+Z$/, '+0000');            // modified AFTER the first sync
  zr.put('bills', F.bill({ id: 'b1', no: 'INV/1', date: '2026-10-12', taxable: 1200, lmt: later(5) }));                                       // edited amount
  zr.put('bills', F.bill({ id: 'b2', no: 'INV/2', date: '2026-10-14', taxable: 2000, tax: 'inter', gst: F.SUP_MH, branch: 'br_b', dest: 'MH', status: 'void', lmt: later(6) }));
  zr.put('bills', F.bill({ id: 'b8', no: 'INV/8', date: '2026-11-10', taxable: 300, lmt: later(7) }));
  const r = await sync.run({ company: 'devx', mode: 'incremental' });
  assert.equal(r.status, 'completed', r.message || r.error);
  const fetched = detailCalls(zr).slice(callsBefore).map(l => l.split('/').pop()).sort();
  assert.deepEqual(fetched, ['b1', 'b8'], 'only the edited and the new bill are fetched; the voided one needs no detail');
  const [b1] = await byZohoId('b1'), [b2] = await byZohoId('b2'), [b8] = await byZohoId('b8');
  assert.equal(b1.amounts.taxable, 120000); assert.equal(b1.revisions.length, 1); assert.equal(b1.revisions[0].lmt, '2026-10-15T10:00:00+0530'); assert.equal(b1.stale, undefined);
  assert.equal(b2.excluded, 'void'); assert.equal(b2.detail_pending, false);
  assert.equal(b8.amounts.taxable, 30000);
  rm(dir);
});

test('incremental before any initial sync does nothing and says so', async () => {
  const { dir, sync } = setup();
  const r = await sync.run({ company: 'devx', mode: 'incremental' });
  assert.ok(r.warnings.some(w => /No initial sync yet/.test(w)));
  assert.equal((await books.all('devx')).length, 0);
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
  assert.deepEqual(Object.keys(zr).sort(), ['calls', 'checkAccess', 'dedicated', 'errText', 'get', 'identity', 'isGone', 'list', 'listBranches', 'listOrganizations']);
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
