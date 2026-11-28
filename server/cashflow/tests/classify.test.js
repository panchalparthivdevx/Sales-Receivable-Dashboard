'use strict';

// Categories from Zoho's account tree, which bills are read in detail, the compact bill, parts of a mixed bill, and the
// client / period / connection read from the bill's wording.

const test = require('node:test');
const assert = require('node:assert/strict');
const CL = require('../lib/classify');
const CFG = require('../lib/config');
const H = require('./helpers');

const CATS = CFG.DEFAULTS.categories;
const coa = H.COA.map(a => ({ id: a.account_id, name: a.account_name, parent: a.parent_account_name }));

test('an account belongs to a category when it is the root or anywhere under it in the chart of accounts', () => {
  const m = CL.accountCategories(coa, CATS);
  assert.equal(m.get('a_brk_amd1'), 'brokerage', 'two levels below "Brokerage Charges"');
  assert.equal(m.get('a_brk_root'), 'brokerage');
  assert.equal(m.get('a_rent_binori'), 'rent');
  assert.equal(m.get('a_el_first'), 'electricity');
  assert.equal(m.get('a_cam'), undefined); assert.equal(m.get('a_hk'), undefined);
});

test('which bills are read in detail: bill or vendor-master category, words in the vendor name, or a vendor seen before', () => {
  const vendorMaster = new Map([['v_brk', 'brokers'], ['v_ll', 'rent/maint. vendors']]);
  const learned = new Set(['v_seen']);
  const ok = row => CL.isCandidate({ status: 'open', ...row }, { categories: CATS, vendorMaster, learned });
  assert.equal(ok({ vendor_id: 'x', cf_vendor_category: 'Landlord ' }), true);
  assert.equal(ok({ vendor_id: 'x', cf_vendor_category: 'Brokrage' }), true, 'Zoho\'s own spelling');
  assert.equal(ok({ vendor_id: 'v_brk' }), true);
  assert.equal(ok({ vendor_id: 'v_ll', cf_vendor_category: '' }), true);
  assert.equal(ok({ vendor_id: 'x', vendor_name: 'GALAXY SQUARE PRIVATE LIMITED-Electricity', cf_vendor_category: 'Recurring ' }), true);
  assert.equal(ok({ vendor_id: 'x', vendor_name: 'Madhya Gujarat Vij Company Limited - Baroda 2-4145' }), true);
  assert.equal(ok({ vendor_id: 'v_seen', vendor_name: 'Someone' }), true);
  assert.equal(ok({ vendor_id: 'x', vendor_name: 'Updater Services Ltd (UDS)', cf_vendor_category: 'Recurring ' }), false);
  assert.equal(ok({ vendor_id: 'x', cf_vendor_category: 'Landlord', status: 'void' }), false);
  assert.equal(ok({ vendor_id: 'x', cf_vendor_category: 'Landlord', status: 'draft' }), false);
});

test('compact bill: payments keep their cash date and apply date, credits applied, line GST; a foreign-currency bill in rupees', () => {
  const raw = H.rawBill({ id: '101', date: '2026-11-01', due: '2026-11-10', vid: 'v', vn: 'V', tds: 7365,
    lines: [{ acc: 'a_rent', amt: 73648, desc: 'Monthly Lease Rent for the month of November 2026' }],
    payments: [{ id: 'p1', date: '2026-10-12', apply: '2026-11-01', amount: 7364 }], credits: [{ id: 'c1', no: 'VC-9', date: '2026-11-05', amount: 100 }] });
  const b = CL.compactBill(raw);
  assert.equal(b.total, 66283); assert.equal(b.tds, 7365);
  assert.deepEqual(b.pays[0], { pid: 'p1', no: '', date: '2026-10-12', apply: '2026-11-01', amt: 7364, ref: '', mode: 'ICICI Bank', acct: '' });
  assert.deepEqual(b.creds[0], { id: 'c1', no: 'VC-9', date: '2026-11-05', amt: 100 });
  const usd = CL.compactBill({ ...H.rawBill({ id: '102', date: '2026-11-01', vid: 'v', vn: 'V', lines: [{ acc: 'a_brk_root', amt: 100 }] }), currency_code: 'USD', exchange_rate: 84 });
  assert.equal(usd.total, 8400); assert.equal(usd.lines[0].amt, 8400);
});

test('parts of a mixed landlord bill: rent and electricity get their share; other lines (maintenance) stay out; TDS goes by basic', () => {
  const accCat = CL.accountCategories(coa, CATS);
  const b = CL.compactBill(H.rawBill({ id: '103', date: '2026-11-01', vid: 'v', vn: 'V', tds: 6500,
    lines: [{ acc: 'a_rent_binori', amt: 50000, tax: 9000 }, { acc: 'a_el_first', amt: 10000, tax: 1800 }, { acc: 'a_cam', amt: 5000, tax: 900 }] }));
  const parts = CL.partsOf(b, accCat);
  const rent = parts.find(p => p.category === 'rent'), el = parts.find(p => p.category === 'electricity');
  assert.equal(parts.length, 2);
  assert.equal(rent.basic, 50000); assert.equal(rent.gst, 9000); assert.equal(rent.tds, 5000);
  assert.equal(el.tds, 1000);
  assert.ok(Math.abs(rent.net - b.total * (59000 / 76700)) < 0.02);
  assert.ok(Math.abs(rent.w + el.w - (59000 + 11800) / 76700) < 1e-9);
  // a bill wholly of one category: its whole total
  const one = CL.partsOf(CL.compactBill(H.rawBill({ id: '104', date: '2026-11-01', vid: 'v', vn: 'V', lines: [{ acc: 'a_brk_amd1', amt: 80000 }] })), accCat);
  assert.equal(one[0].net, 80000); assert.equal(one[0].w, 1);
});

test('period from the bill\'s wording: a month, a date range, nothing', () => {
  assert.equal(CL.periodOf('Monthly Lease Rent for the month of November 2026 Office No. 108').label, 'Nov-26');
  assert.equal(CL.periodOf('Rent for Nov-26').label, 'Nov-26');
  const r = CL.periodOf('Energy charges billing period 01/10/2026 to 31/10/2026, units 1450');
  assert.equal(r.from, '2026-10-01'); assert.equal(r.to, '2026-10-31');
  assert.equal(CL.periodOf('Service period 01-Oct-2026 To 31-Dec-2026').to, '2026-12-31');
  assert.equal(CL.periodOf('Monthly Lease Rent for the month of \nOffice No. 108, 1st Floor'), null);
});

test('brokerage client from the description: one of our customers named, an explicit "Client:", several names (ambiguous)', () => {
  const cust = CL.customerIndex(['MIZUHO CAPSAVE FINANCE PRIVATE LIMITED', 'MANUBHAI & SHAH LLP - CapitalOne', 'Rightsol Private Limited', 'DEV ACCELERATOR LIMITED']);
  assert.deepEqual(CL.clientOf('Brokerage for Mizuho Capsave Finance Pvt Ltd - 40 seats at The First', cust), { client: 'MIZUHO CAPSAVE FINANCE PRIVATE LIMITED', source: 'bill text', options: [] });
  assert.equal(CL.clientOf('Brokerage charges. Client: Acme Robotics, 20 seats', cust).client, 'Acme Robotics');
  const amb = CL.clientOf('Brokerage for Rightsol Private Limited and Mizuho Capsave Finance', cust);
  assert.equal(amb.client, ''); assert.equal(amb.options.length, 2);
  assert.equal(CL.clientOf('Professional fees', cust).client, '');
  // real DevX wording (28 Nov 2026) of clients not in the invoice list: a suggestion to check
  assert.deepEqual(CL.clientOf('Consulting Fees for Leasing of 4- Seater Cabin for Groww at DEV X - GIFT City', cust), { client: 'Groww', source: 'bill text (suggested)', options: [] });
  assert.equal(CL.clientOf('Brokerage Charges for Bluevium', cust).client, 'Bluevium');
  assert.equal(CL.clientOf('Brokerage Charges-AM incred.com SAC: 998599', cust).client, 'incred.com');
  assert.equal(CL.clientOf('Brokerage Charges', cust).client, '');
  assert.equal(CL.clientOf('Rent for the month of November 2026', cust).client, '', 'no client in plain wording');
});

test('electricity connection: consumer number in the text, else the part of the vendor name after the provider', () => {
  assert.equal(CL.connectionOf('Madhya Gujarat Vij Company Limited - Baroda 3-5216 (6th floor)', '').connection, 'Baroda 3-5216 (6th floor)');
  assert.equal(CL.connectionOf('Torrent Power', 'Electricity bill Service No: 300012345678 for Oct').meter, '300012345678');
  assert.equal(CL.connectionOf('Binori Torrent power -109', '').connection, '109');
});
