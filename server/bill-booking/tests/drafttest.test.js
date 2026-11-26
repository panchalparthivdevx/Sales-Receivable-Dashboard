'use strict';

// The draft test bill copies the GST setting, branch and places of supply of the vendor's latest Zoho bill: Zoho
// refuses a GST-registered vendor's line without a tax, a tax exemption or reverse charge (code 110802).

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');

const user = { id: '1', username: 'admin', name: 'Admin A' };
const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test('draft test: the line gets the GST of the vendor\'s latest Zoho bill, with its branch and places of supply', async () => {
  const env = H.setup();
  await H.seedConfig();
  Object.values(env.history.details).forEach(d => { d.source_of_supply = 'GJ'; d.destination_of_supply = 'GJ'; });
  const t = await env.pipeline.draftTest('devx', { vendor_id: 'v_hk', account_id: 'acc_hk' }, user);
  assert.equal(t.verified, true);
  const p = env.zc.created[0].payload;
  assert.equal(p.is_draft, true);
  assert.equal(p.line_items[0].tax_id, 'tx_gst18');
  assert.equal(p.line_items[0].account_id, 'acc_hk', 'the account chosen for the test');
  assert.equal(p.line_items[0].rate, 1);
  assert.deepEqual([p.branch_id, p.source_of_supply, p.destination_of_supply], ['br_1', 'GJ', 'GJ']);
  assert.match(t.detail, /used GST18, GJ → GJ, branch Ahmedabad as on bill CC\/101/);
});

test('draft test: a tax exemption or reverse charge on the latest bill is copied instead of a tax', async () => {
  const ex = { bill_id: 'ex1', bill_number: 'EL/9', date: day(10), status: 'paid', lmt: 'l1', vendor_id: 'v_hk', branch_id: 'br_2', branch_name: 'Mumbai',
    source_of_supply: 'MH', destination_of_supply: 'MH', is_reverse_charge_applied: false,
    lines: [{ description: 'Electricity', account_id: 'acc_rm', tax_id: '', tax_exemption_id: 'ex_elec', reverse_charge_tax_id: '' }] };
  const env = H.setup({ zoho: { details: { ex1: ex }, vendorBills: [{ bill_id: 'ex1', bill_number: 'EL/9', date: ex.date, status: 'paid', total: 100, lmt: 'l1' }] } });
  await H.seedConfig();
  await env.pipeline.draftTest('devx', { vendor_id: 'v_hk', account_id: 'acc_hk' }, user);
  const li = env.zc.created[0].payload.line_items[0];
  assert.equal(li.tax_exemption_id, 'ex_elec'); assert.equal(li.tax_id, undefined);
  assert.equal(env.zc.created[0].payload.branch_id, 'br_2');

  const rc = { ...ex, bill_id: 'rc1', bill_number: 'GTA/1', is_reverse_charge_applied: true, lines: [{ description: 'Freight', account_id: 'acc_rm', tax_id: '', tax_exemption_id: '', reverse_charge_tax_id: 'tx_rcm5' }] };
  const env2 = H.setup({ zoho: { details: { rc1: rc }, vendorBills: [{ bill_id: 'rc1', bill_number: 'GTA/1', date: rc.date, status: 'paid', total: 100, lmt: 'l2' }] } });
  await H.seedConfig();
  await env2.pipeline.draftTest('devx', { vendor_id: 'v_hk', account_id: 'acc_hk' }, user);
  const p2 = env2.zc.created[0].payload;
  assert.equal(p2.is_reverse_charge_applied, true); assert.equal(p2.line_items[0].reverse_charge_tax_id, 'tx_rcm5');
});

test('draft test: a registered vendor without Zoho bills is refused before anything is created; an unregistered one needs no GST', async () => {
  const env = H.setup({ zoho: { vendorBills: [] } });
  await H.seedConfig();
  await assert.rejects(env.pipeline.draftTest('devx', { vendor_id: 'v_hk', account_id: 'acc_hk' }, user), /Clean Co Facility Services has no bill in Zoho yet/);
  assert.ok(!env.zc.calls.includes('create'));

  env.synced.devx.vendors_all.data = [...H.VENDORS, { contact_id: 'v_land', contact_name: 'A Landlord', gst_no: '', status: 'active', gst_treatment: 'business_none' }];
  const t = await env.pipeline.draftTest('devx', { vendor_id: 'v_land', account_id: 'acc_rent' }, user);
  assert.equal(t.verified, true);
  const li = env.zc.created[0].payload.line_items[0];
  assert.equal(li.tax_id, undefined); assert.equal(li.tax_exemption_id, undefined);
  assert.match(t.detail, /unregistered vendor: no GST on the test bill/);
});

test('Zoho bill summary keeps what the test bill copies (shape of a real Zoho bill)', () => {
  const ZC = require('../lib/zohoClient');
  const raw = { bill_id: 'b1', bill_number: 'DAL/LO/2627/03', date: '2026-09-01', status: 'paid', vendor_id: 'v1', branch_id: 'br9', branch_name: 'Support Branch',
    source_of_supply: 'MH', destination_of_supply: 'GJ', gst_treatment: 'business_gst', is_reverse_charge_applied: false,
    line_items: [{ account_id: 'a1', account_name: 'Subscription Expense - Monthly', tax_id: '', tax_exemption_id: 'ex_elec', tax_name: '', reverse_charge_tax_id: '', item_total: 1500 }] };
  const c = ZC.create({ zoho: {} }).compactBill(raw);
  assert.deepEqual([c.branch_id, c.branch_name, c.source_of_supply, c.destination_of_supply], ['br9', 'Support Branch', 'MH', 'GJ']);
  assert.equal(c.lines[0].tax_exemption_id, 'ex_elec');
});

test('draft test: when Zoho still refuses, the message says what the test bill used', async () => {
  const env = H.setup({ zoho: { createError: 'Specify either a Tax or Tax Exemption or Reverse Charge.' } });
  await H.seedConfig();
  await assert.rejects(env.pipeline.draftTest('devx', { vendor_id: 'v_hk', account_id: 'acc_hk' }, user),
    /Test bill not created — Zoho: Specify either a Tax.*\(the test bill used GST18, branch Ahmedabad as on bill CC\/101/);
});
