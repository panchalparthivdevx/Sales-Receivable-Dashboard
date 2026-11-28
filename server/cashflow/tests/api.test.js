'use strict';

// Reading Zoho (only candidate bills, each once until it changes; deleted bills leave) and the API: rights, budgets,
// links, schedule, initiations (team + Finance Portal), advances, slips, refresh, settings — and that a refresh keeps
// every manual entry.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const H = require('./helpers');
const SY = require('../lib/sync');
const CFG = require('../lib/config');

const TODAY = new Date('2026-12-05T06:30:00Z');   // 12:00 IST

function world() {
  const details = {
    // landlord bill: rent + maintenance lines (only rent is a category)
    '9001': H.rawBill({ id: '9001', no: '0046', date: '2026-11-01', due: '2026-11-10', vid: 'v_kp', vn: 'Kailashben Natvarlal Patel (108)', br: 'Amd_Binori',
      lines: [{ acc: 'a_rent_binori', amt: 73648, desc: 'Monthly Lease Rent for the month of November 2026' }, { acc: 'a_cam', amt: 5000 }], tds: 7365,
      payments: [{ id: '7001', date: '2026-10-12', apply: '2026-11-01', amount: 7364 }] }),
    // broker (vendor master "Brokers"), bill category blank
    '9002': H.rawBill({ id: '9002', no: 'FCAL-031026', date: '2026-11-08', due: '2026-11-20', vid: 'v_brk', vn: 'FULCRUM CRE ADVISORS LLP', lines: [{ acc: 'a_brk_amd1', amt: 80000, desc: 'Brokerage for Mizuho Capsave Finance Pvt Ltd' }],
      payments: [{ id: '7002', date: '2026-11-12', amount: 30000 }] }),
    // electricity, recognised by the vendor's name
    '9003': H.rawBill({ id: '9003', no: 'EL-11', date: '2026-11-03', due: '2026-11-15', vid: 'v_el', vn: 'Madhya Gujarat Vij Company Limited - Baroda 3-5216 (6th floor)', lines: [{ acc: 'a_el_first', amt: 12000 }] }),
    // housekeeping: never read
    '9004': H.rawBill({ id: '9004', date: '2026-11-05', vid: 'v_hk', vn: 'Updater Services Ltd (UDS)', lines: [{ acc: 'a_hk', amt: 9000 }] }),
  };
  const synced = {
    devx: {
      bills_fy: { window_from: '2026-04-01', synced_at: '2026-12-05T02:00:00Z', data: [
        H.listRow(details['9001'], { cf_vendor_category: 'Landlord ' }), H.listRow(details['9002']), H.listRow(details['9003'], { cf_vendor_category: 'Recurring ' }),
        H.listRow(details['9004'], { cf_vendor_category: 'Recurring ' })] },
      bills_open: { data: [] }, bills_overdue: { data: [] },
      vendor_payments_fy: { synced_at: '2026-12-05T02:00:00Z', data: [
        { payment_id: '7001', vendor_id: 'v_kp', vendor_name: 'Kailashben Natvarlal Patel (108)', date: '2026-10-12', amount: 66284, balance: 0, payment_number: 'VP/4145' },
        { payment_id: '7002', vendor_id: 'v_brk', vendor_name: 'FULCRUM CRE ADVISORS LLP', date: '2026-11-12', amount: 30000, balance: 0 },
        { payment_id: '7003', vendor_id: 'v_brk', vendor_name: 'FULCRUM CRE ADVISORS LLP', date: '2026-11-20', amount: 15000, balance: 15000, payment_number: 'VP/5000' }] },
      vendors_all: { data: [
        { contact_id: 'v_kp', contact_name: 'Kailashben Natvarlal Patel (108)', cf_vendor_category_formatted: 'Rent/Maint. Vendors' },
        { contact_id: 'v_brk', contact_name: 'FULCRUM CRE ADVISORS LLP', cf_vendor_category_formatted: 'Brokers' },
        { contact_id: 'v_el', contact_name: 'Madhya Gujarat Vij Company Limited - Baroda 3-5216 (6th floor)', cf_vendor_category_formatted: 'Recurring Vendors' },
        { contact_id: 'v_hk', contact_name: 'Updater Services Ltd (UDS)', cf_vendor_category_formatted: 'Recurring Vendors' }] },
      invoices_fy: { data: [{ customer_name: 'MIZUHO CAPSAVE FINANCE PRIVATE LIMITED' }] },
    },
  };
  return { details, synced, readSynced: async (co, e) => synced[co]?.[e] || null };
}

test('refresh: the chart of accounts once a day, details only for candidate bills, each read once until it changes; deleted bills leave', async () => {
  H.tempDirs();
  const w = world();
  const zr = H.fakeZr(w.details);
  const sync = SY.create({ zr, readSynced: w.readSynced, cfgNow: async () => CFG.merge(null), log: { error() {} } });
  const st = await sync.step('devx', { until: Date.now() + 60000 });
  assert.equal(st.candidates, 3); assert.equal(st.fetched_last, 3); assert.equal(st.remaining, 0); assert.deepEqual(st.errors, []);
  assert.deepEqual(zr.calls.filter(c => c.startsWith('/chartofaccounts')), ['/chartofaccounts?AccountType.All&account_name']);
  assert.deepEqual(zr.calls.filter(c => c.startsWith('/bills')).sort(), ['/bills/9001', '/bills/9002', '/bills/9003']);
  assert.ok(st.last_complete_at);
  // nothing changed → no call at all
  zr.calls.length = 0;
  await sync.step('devx', { until: Date.now() + 60000 });
  assert.deepEqual(zr.calls, []);
  // a payment in Zoho changes the bill's balance in the synced list → only that bill is read again
  w.details['9002'].payments.push({ payment_id: '7009', date: '2026-11-25', amount: 10000 }); w.details['9002'].balance -= 10000;
  w.synced.devx.bills_fy.data[1] = H.listRow(w.details['9002']);
  await sync.step('devx', { until: Date.now() + 60000 });
  assert.deepEqual(zr.calls, ['/bills/9002']);
  assert.equal((await sync.loadBills('devx')).find(b => b.id === '9002').pays.length, 2);
  // deleted in Zoho: gone from the list (inside its window) → gone here
  w.synced.devx.bills_fy.data = w.synced.devx.bills_fy.data.filter(r => r.bill_id !== '9003');
  await sync.step('devx', { until: Date.now() + 60000 });
  assert.deepEqual((await sync.loadBills('devx')).map(b => b.id).sort(), ['9001', '9002']);
  // two refreshes never run together
  await H.store.update('status_devx', {}, s => { s.running_until = new Date(Date.now() + 60000).toISOString(); });
  assert.equal((await sync.step('devx', { until: Date.now() + 60000 })).busy, true);
});

async function app(opts = {}) {
  H.tempDirs();
  const w = world();
  const router = require('..');
  const USERS = [
    { id: '1', username: 'admin', name: 'Admin A', role: 'admin', active: true },
    { id: '2', username: 'mgmt', name: 'Mgmt View', role: 'user', active: true, permissions: { cashflow: { enabled: true, sections: {} } } },
    { id: '3', username: 'plan', name: 'Planner P', role: 'user', active: true, permissions: { cashflow: { enabled: true, sections: { cf_plan: true } } } },
    { id: '4', username: 'none', name: 'No Access', role: 'user', active: true, permissions: {} },
  ];
  const portal = opts.portal || [];
  const zr = H.fakeZr(w.details);
  const ctx = router.init({ zr, readSynced: w.readSynced, readPortal: async () => portal, loadUsers: async () => USERS, now: () => TODAY, log: { error() {} } });
  await ctx.sync.step('devx', { until: Date.now() + 60000 });
  const a = express(); a.use(express.json());
  a.use('/api/cashflow', (req, res, next) => { if (req.headers['x-user']) req.user = { id: req.headers['x-user'] }; next(); }, router);
  const server = await new Promise(r => { const s = a.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/cashflow`;
  const call = async (who, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'x-user': who, ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  return { w, call, ctx, zr, close: () => server.close() };
}

test('API: rights — viewers see, planners plan, payments and configuration need their own ticks', async () => {
  const { call, close } = await app();
  try {
    assert.equal((await call('4', 'GET', '/meta')).status, 403);
    const meta = (await call('2', 'GET', '/meta')).body;
    assert.deepEqual(meta.rights, { plan: false, payments: false, config: false, admin: false });
    assert.equal(meta.current_month, '2026-12'); assert.equal(meta.current_fy, '2026-27');
    assert.deepEqual(meta.categories.map(c => c.key), ['brokerage', 'rent', 'electricity']);
    assert.equal((await call('2', 'POST', '/budgets', { company: 'devx', category: 'rent', planned_month: '2026-11', amount: 100 })).status, 403);
    assert.equal((await call('3', 'POST', '/budgets', { company: 'devx', category: 'rent', planned_month: '2026-11', amount: 100 })).status, 200);
    assert.equal((await call('3', 'POST', '/parts/9002:brokerage/initiations', { company: 'devx', date: '2026-11-25', amount: 10 })).status, 403);
    assert.equal((await call('3', 'POST', '/refresh', { company: 'devx' })).status, 403);
    assert.equal((await call('3', 'PUT', '/config', { categories: {} })).status, 403);
  } finally { close(); }
});

test('API: the brief\'s brokerage example end to end — budget, bill from Zoho, payment, initiation → overview and action lists', async () => {
  const { call, close } = await app();
  try {
    const bud = (await call('1', 'POST', '/budgets', { company: 'devx', category: 'brokerage', planned_month: '2026-11', amount: 100000, vendor_id: 'v_brk', vendor_name: 'FULCRUM CRE ADVISORS LLP', client: 'Mizuho Capsave Finance' })).body.budget;
    assert.equal(bud.original_amount, 100000);
    await call('1', 'POST', '/parts/9002:brokerage/initiations', { company: 'devx', date: '2026-11-25', amount: 10000, reference: 'NEFT 25 Nov' });
    const v = (await call('2', 'GET', '/view?company=devx&month=2026-11')).body;
    const p = v.rows.parts.find(x => x.key === '9002:brokerage');
    assert.equal(p.budget_id, bud.id);
    assert.equal(p.client, 'MIZUHO CAPSAVE FINANCE PRIVATE LIMITED', 'client found in the bill description');
    assert.equal(p.at.final_out, 50000); assert.equal(p.at.pending, 10000); assert.equal(p.at.to_initiate, 40000);
    const s = v.summary.brokerage;
    assert.deepEqual([s.budget, s.remaining, s.final_out, s.pending, s.to_initiate, s.unbilled], [100000, 70000, 50000, 10000, 40000, 20000]);
    assert.equal(v.actions.initiate.find(a => a.key === '9002:brokerage').amount, 40000);
    assert.equal(v.actions.settlement.find(a => a.key === '9002:brokerage').amount, 10000);
    // the unapplied ₹15,000 advance to the same broker shows as an advance and as November cash
    assert.equal(v.rows.advances.find(a => a.pid === '7003').unapplied, 15000);
    assert.equal(s.cash_out, 45000);
    // rent: the bill's rent part only (maintenance stays out); the October advance reduces it
    const rent = v.rows.parts.find(x => x.key === '9001:rent');
    assert.equal(rent.basic, 73648);
    assert.equal(rent.at.adv, 6895.84, 'the advance reached the whole bill; the rent part carries its share (73,648 of 78,648)');
    assert.ok(!v.rows.parts.some(x => x.bill_id === '9004'), 'housekeeping is in no category');
    // budget changed later: the original figure is kept
    const ch = (await call('3', 'PUT', `/budgets/${bud.id}`, { company: 'devx', amount: 90000 })).body.budget;
    assert.equal(ch.amount, 90000); assert.equal(ch.original_amount, 100000); assert.equal(ch.history.at(-1).from, 100000);
  } finally { close(); }
});

test('API: links, planned month, schedule, initiation status, advances and slips are kept across refreshes', async () => {
  const { w, call, ctx, zr, close } = await app();
  try {
    const b1 = (await call('1', 'POST', '/budgets', { company: 'devx', category: 'rent', planned_month: '2026-11', amount: 66283, branch: 'Amd_Binori' })).body.budget;
    // team: no budget for the rent bill, then back to automatic
    await call('3', 'PUT', '/parts/9001:rent', { company: 'devx', budget_id: '' });
    let v = (await call('2', 'GET', '/view?company=devx&month=2026-11')).body;
    assert.equal(v.rows.parts.find(x => x.key === '9001:rent').link, 'none');
    await call('3', 'PUT', '/parts/9001:rent', { company: 'devx', budget_id: null });
    v = (await call('2', 'GET', '/view?company=devx&month=2026-11')).body;
    assert.equal(v.rows.parts.find(x => x.key === '9001:rent').budget_id, b1.id);
    assert.equal((await call('3', 'PUT', '/parts/9001:rent', { company: 'devx', budget_id: 'nope' })).status, 400);
    // schedule in two instalments; initiation recorded, then failed → not pending
    const sch = await call('3', 'PUT', '/parts/9003:electricity', { company: 'devx', schedule: [{ pay_on: '2026-11-20', amount: 6000 }, { pay_on: '2026-12-20', amount: 6000 }] });
    assert.equal(sch.status, 200);
    assert.equal((await call('3', 'PUT', '/parts/9003:electricity', { company: 'devx', schedule: [{ pay_on: 'soon', amount: 1 }] })).status, 400);
    const ini = (await call('1', 'POST', '/parts/9003:electricity/initiations', { company: 'devx', date: '2026-11-21', amount: 6000, reference: 'UTR-1' })).body.initiation;
    v = (await call('2', 'GET', '/view?company=devx&month=2026-11')).body;
    let el = v.rows.parts.find(x => x.key === '9003:electricity');
    assert.equal(el.at.pending, 6000); assert.equal(el.at.to_initiate, 6000);
    await call('1', 'PUT', `/parts/9003:electricity/initiations/${ini.id}`, { company: 'devx', status: 'failed' });
    v = (await call('2', 'GET', '/view?company=devx&month=2026-11')).body;
    el = v.rows.parts.find(x => x.key === '9003:electricity');
    assert.equal(el.at.pending, 0); assert.equal(el.at.to_initiate, 12000);
    assert.equal(el.at.overdue.pay_on, '2026-11-20');
    // advance linked to a budget; slip uploaded and opened
    const bb = (await call('1', 'POST', '/budgets', { company: 'devx', category: 'brokerage', planned_month: '2026-11', amount: 50000 })).body.budget;
    assert.equal((await call('3', 'PUT', '/advances/7003', { company: 'devx', budget_id: bb.id })).status, 200);
    const fd = new FormData(); fd.append('company', 'devx'); fd.append('file', new Blob([Buffer.from('%PDF-1.4 slip')], { type: 'application/pdf' }), 'advice.pdf');
    const up = await call('1', 'POST', '/slips/7003', fd);
    assert.equal(up.status, 200);
    const file = await call('2', 'GET', `/file/devx/7003/${up.body.slip.sha}`);
    assert.equal(file.status, 200); assert.equal(file.body.toString(), '%PDF-1.4 slip');
    // a refresh (bill changed in Zoho) keeps every manual entry
    w.details['9003'].last_modified_time = '2026-12-04T09:00:00+0530';
    w.synced.devx.bills_fy.data[2] = H.listRow(w.details['9003'], { cf_vendor_category: 'Recurring ' });
    zr.calls.length = 0;
    await ctx.sync.step('devx', { until: Date.now() + 60000 });
    assert.deepEqual(zr.calls, ['/bills/9003'], 'the changed bill is read again');
    v = (await call('2', 'GET', '/view?company=devx&month=2026-11')).body;
    el = v.rows.parts.find(x => x.key === '9003:electricity');
    assert.equal(el.schedule.length, 2); assert.equal(el.initiations[0].status, 'failed');
    const adv = v.rows.advances.find(a => a.pid === '7003');
    assert.equal(adv.budget_id, bb.id); assert.equal(adv.slips.length, 1);
    // a November brokerage budget with no vendor takes November's brokerage bill (₹30,000 paid) and the linked advance (₹15,000)
    assert.equal(v.rows.budgets.find(b => b.id === bb.id).at.paid, 45000);
    assert.equal(v.rows.budgets.find(b => b.id === bb.id).at.paid_advances, 15000);
    // copy November's lines to December, once
    assert.equal((await call('3', 'POST', '/budgets/copy', { company: 'devx', from_month: '2026-11', to_month: '2026-12' })).body.added, 2);
    assert.equal((await call('3', 'POST', '/budgets/copy', { company: 'devx', from_month: '2026-11', to_month: '2026-12' })).body.added, 0);
    const audit = (await call('2', 'GET', '/audit?month=2026-12')).body.entries;
    assert.ok(audit.some(e => e.action === 'initiation_changed') && audit.some(e => e.action === 'slip_added'));
  } finally { close(); }
});

test('API: a Finance Portal payment request against the bill counts as an initiation (rejected ones do not)', async () => {
  const portal = [
    { id: 'FP-1', request_type: 'vendor_payment', zoho_doc_type: 'bill', zoho_doc_id: '9002', payment_amount: 10000, status: 'in_progress', submitted_at: '2026-11-26T05:00:00Z' },
    { id: 'FP-2', request_type: 'vendor_payment', zoho_doc_type: 'bill', zoho_doc_id: '9002', payment_amount: 5000, status: 'rejected', submitted_at: '2026-11-27T05:00:00Z' },
    { id: 'FP-3', request_type: 'vendor_payment', zoho_doc_type: 'purchase_order', zoho_doc_id: '9002', payment_amount: 7000, status: 'pending', submitted_at: '2026-11-27T05:00:00Z' },
  ];
  const { call, close } = await app({ portal });
  try {
    const p = (await call('2', 'GET', '/view?company=devx&month=2026-11')).body.rows.parts.find(x => x.key === '9002:brokerage');
    assert.equal(p.at.pending, 10000);
    assert.equal(p.at.initiations.find(i => i.source === 'portal' && i.pending > 0).reference, 'Finance Portal request FP-1');
  } finally { close(); }
});

test('API: settings change the category accounts; the financial-year grid and the accounts check', async () => {
  const { call, close } = await app();
  try {
    let acc = (await call('1', 'GET', '/accounts?company=devx')).body.accounts;
    assert.deepEqual(acc.rent.map(a => a.name).sort(), ['Office Rent', 'Office Rent_Amd_Binori-3']);
    await call('1', 'PUT', '/config', { categories: { rent: { account_roots: 'Office Rent, Maintenance Charges' } } });
    acc = (await call('1', 'GET', '/accounts?company=devx')).body.accounts;
    assert.ok(acc.rent.some(a => a.name === 'Maintenance Charges'));
    const g = (await call('2', 'GET', '/fy-grid?company=devx&fy=2026-27&category=rent')).body;
    assert.equal(g.months[0], '2026-04');
    const row = g.rows.find(r => r.vendor.startsWith('Kailashben'));
    assert.ok(row.cells['2026-11'].billed > 66283, 'maintenance is rent now, so the bill counts in full');
    assert.ok(g.parts[row.cells['2026-11'].parts[0]], 'drill-down: the bills behind the cell');
  } finally { close(); }
});
