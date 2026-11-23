/**
 * Month-wise & Branch-wise Recurring Expense Report (server/recurring-expense.js): the pure
 * computation on hand-made ledgers, bills, payments and details. No Zoho, no files.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../recurring-expense');

const HK = R.HEADS.find(h => h.key === 'hk_material');
const HS = R.HEADS.find(h => h.key === 'hk_service');
const EL = R.HEADS.find(h => h.key === 'electricity');
const MONTHS = R.monthList(R.fyInfo('current', '2026-11-23', () => '2026-27'));

const led = (id, date, amt, type = 'bill') => ({
  transaction_type: type, transaction_id: id, transaction_date: date,
  debit_amount: amt > 0 ? amt : '', credit_amount: amt < 0 ? -amt : '',
});
const bill = (o) => ({
  bill_id: o.id, vendor_id: o.vid || 'V1', vendor_name: o.vn || 'Vendor One', bill_number: o.bn || o.id,
  date: o.date, branch_name: o.br || 'Amd_Binori B Square_3', status: o.status || 'open',
  total: o.total, balance: o.balance, tds_total: o.tds || 0, last_modified_time: o.lmt || 'L1',
});
function run({ ledgers, bills = null, details = {}, payments = [], months = MONTHS, now }) {
  const list = bills ? new Map(bills.map(b => [b.bill_id, b])) : null;
  return R.computeReport({ months, ledgers, list, details, payIdx: list ? R.buildPayIndex(payments) : null, now, current: !!bills });
}
const cellOf = (out, head, branch, mk) => out.rows.find(r => r.head_key === head && r.branch === branch)?.monthly[mk];

test('months: current FY runs April to this month; FY 2025-26 has twelve', () => {
  assert.deepEqual(MONTHS.map(m => m.key), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  const past = R.monthList(R.fyInfo('fy2526', '2026-11-23', () => '2026-27'));
  assert.equal(past.length, 12);
  assert.equal(past[0].key, '2025-04');
  assert.equal(past[11].key, '2026-03');
});

test('a single-head bill at a standard GST rate is exact from the synced list', () => {
  // basic 10,000 + 18% GST 1,800 − TDS 200 = payable 11,600; 5,000 paid on 15 May
  const out = run({
    ledgers: { [HK.account_id]: [led('B1', '2026-04-30', 10000)] },
    bills: [bill({ id: 'B1', bn: 'INV-1', date: '2026-04-30', total: 11600, balance: 6600, tds: 200 })],
    payments: [{ vendor_id: 'V1', bill_numbers: 'INV-1', date: '2026-05-15' }],
  });
  const c = cellOf(out, 'hk_material', 'Amd_Binori B Square_3', '2026-04');
  assert.deepEqual({ basic: c.basic, bill: c.bill, outstanding: c.outstanding }, { basic: 10000, bill: 11600, outstanding: 6600 });
  const b = c.bills[0];
  assert.equal(b.account_name, 'Housekeeping Material Expense');
  assert.deepEqual([b.basic, b.gst, b.tds, b.bill_amount, b.paid_amount, b.outstanding], [10000, 1800, 200, 11600, 5000, 6600]);
  assert.equal(b.paid_date, '2026-05-15');
  assert.equal(b.est, undefined);
  assert.equal(b.part, null);
  assert.equal(out.details_pending, 0);
  assert.equal(out.needDetail.length, 0);
});

test('a bill touching two heads is split; without its detail it is an estimate and is queued', () => {
  const out = run({
    ledgers: { [HK.account_id]: [led('B2', '2026-05-10', 2000)], [HS.account_id]: [led('B2', '2026-05-10', 8000)] },
    bills: [bill({ id: 'B2', date: '2026-05-10', total: 11800, balance: 11800 })],
  });
  const hk = cellOf(out, 'hk_material', 'Amd_Binori B Square_3', '2026-05');
  const hs = cellOf(out, 'hk_service', 'Amd_Binori B Square_3', '2026-05');
  assert.equal(hk.basic, 2000);
  assert.equal(hs.basic, 8000);
  assert.equal(r(hk.bill + hs.bill), 11800);
  assert.equal(r(hk.outstanding + hs.outstanding), 11800);
  assert.equal(hk.bills[0].est, true);
  assert.equal(hk.bills[0].part, 20);
  assert.deepEqual(out.needDetail.map(n => n.bill_id), ['B2']);
});

test('with a fresh detail the split follows the bill lines (GST, TDS) and other accounts are left out', () => {
  // Lines: HK material 1,000 @5%, HK service 9,000 @18% (TDS 180), office supplies 500 @18% (other account)
  const det = {
    lmt: 'L1', at: '2026-11-01T00:00:00Z', vid: 'V1', vn: 'Vendor One', bn: 'B3', d: '2026-06-01', br: 'Amd_Binori B Square_3',
    total: 12080, bal: 0, tds: 180, sub: 10500, tax: 1760,
    acc: { [HK.account_id]: [1000, 50, 0], [HS.account_id]: [9000, 1620, 180], OTHER: [500, 90, 0] },
    pay: [['2026-06-20', 11000], ['2026-07-05', 1080]],
  };
  const out = run({
    ledgers: { [HK.account_id]: [led('B3', '2026-06-01', 1000)], [HS.account_id]: [led('B3', '2026-06-01', 9000)] },
    bills: [bill({ id: 'B3', date: '2026-06-01', total: 12080, balance: 0, tds: 180, status: 'paid' })],
    details: { B3: det },
  });
  const hk = cellOf(out, 'hk_material', 'Amd_Binori B Square_3', '2026-06').bills[0];
  const hs = cellOf(out, 'hk_service', 'Amd_Binori B Square_3', '2026-06').bills[0];
  assert.deepEqual([hk.basic, hk.gst, hk.tds], [1000, 50, 0]);
  assert.deepEqual([hs.basic, hs.gst, hs.tds], [9000, 1620, 180]);
  assert.equal(hk.bill_amount, 1050);                 // 12,080 × 1,050 / 12,080 (lines: 1,050 + 10,440 + 590)
  assert.equal(hs.bill_amount, 10440);                // the office-supplies line (590) belongs to neither head
  assert.equal(hk.paid_date, '2026-07-05');           // latest payment
  assert.equal(hk.est, undefined);
  assert.equal(out.needDetail.length, 0);
});

test('a single-head bill whose GST is not a standard rate needs its detail', () => {
  const out = run({
    ledgers: { [HK.account_id]: [led('B4', '2026-07-01', 7363.7)] },
    bills: [bill({ id: 'B4', date: '2026-07-01', total: 10753, balance: 10753 })],
  });
  assert.deepEqual(out.needDetail.map(n => n.bill_id), ['B4']);
  assert.equal(out.details_pending, 1);
});

test('a changed bill (new last-modified time) is re-queued and shown as an estimate', () => {
  const det = { lmt: 'OLD', at: '2026-10-01T00:00:00Z', acc: { [HK.account_id]: [100, 18, 0], [HS.account_id]: [100, 18, 0] }, pay: [], total: 236, bal: 236, tds: 0, tax: 36 };
  const out = run({
    ledgers: { [HK.account_id]: [led('B5', '2026-08-01', 100)], [HS.account_id]: [led('B5', '2026-08-01', 100)] },
    bills: [bill({ id: 'B5', date: '2026-08-01', total: 236, balance: 0, lmt: 'NEW', status: 'paid' })],
    details: { B5: det },
  });
  assert.deepEqual(out.needDetail, [{ bill_id: 'B5', lmt: 'NEW' }]);
  const b = cellOf(out, 'hk_material', 'Amd_Binori B Square_3', '2026-08').bills[0];
  assert.equal(b.est, true);
  assert.equal(b.outstanding, 0);                      // balance from the (fresher) list
});

test('paid with no payment naming the bill, or a reused bill number: the paid date needs the detail', () => {
  const out = run({
    ledgers: { [EL.account_id]: [led('E1', '2026-09-10', 1000), led('E2', '2026-09-10', 2000), led('E3', '2026-09-12', 500)] },
    bills: [
      bill({ id: 'E1', vid: 'MSEB', bn: 'Sep-2026', date: '2026-09-10', total: 1000, balance: 0, status: 'paid' }),
      bill({ id: 'E2', vid: 'MSEB', bn: 'Sep-2026', date: '2026-09-10', total: 2000, balance: 0, status: 'paid' }),
      bill({ id: 'E3', vid: 'OTHER', bn: 'X-9', date: '2026-09-12', total: 500, balance: 0, status: 'paid' }),
    ],
    payments: [{ vendor_id: 'MSEB', bill_numbers: 'Sep-2026', date: '2026-09-20' }],
  });
  assert.deepEqual(out.needDetail.map(n => n.bill_id).sort(), ['E1', 'E2', 'E3']);
  const c = cellOf(out, 'electricity', 'Amd_Binori B Square_3', '2026-09');
  assert.equal(c.basic, 3500);
  assert.ok(c.bills.every(b => b.paid_date === null));
});

test('journals and vendor credits are left out and counted; void bills and other months are skipped', () => {
  const out = run({
    ledgers: { [HK.account_id]: [
      led('B6', '2026-10-01', 1000),
      led('J1', '2026-10-31', 5000, 'journal'),
      led('J1b', '2026-10-31', -5000, 'journal'),
      led('VC1', '2026-10-15', -300, 'vendor_credit'),
      led('B7', '2026-10-02', 400),                 // void
      led('B8', '2026-12-05', 900),                 // after this month: not in the report yet
    ] },
    bills: [
      bill({ id: 'B6', date: '2026-10-01', total: 1180, balance: 1180 }),
      bill({ id: 'B7', date: '2026-10-02', total: 472, balance: 0, status: 'void' }),
      bill({ id: 'B8', date: '2026-12-05', total: 1062, balance: 1062 }),
    ],
  });
  const c = cellOf(out, 'hk_material', 'Amd_Binori B Square_3', '2026-10');
  assert.equal(c.basic, 1000);
  assert.equal(c.bills.length, 1);
  assert.deepEqual(out.excluded, { journal: { count: 2, amount: 0 }, vendor_credit: { count: 1, amount: -300 } });
});

test('FY 2025-26: bills come from their details; a bill not read yet is pending, not guessed', () => {
  const months = R.monthList(R.fyInfo('fy2526', '2026-11-23', () => '2026-27'));
  const det = {
    lmt: 'L', at: new Date().toISOString(), vid: 'V9', vn: 'Old Vendor', bn: 'OLD-1', d: '2025-05-05', br: 'Noi_Embassy_5th Floor',
    total: 1180, bal: 0, tds: 0, sub: 1000, tax: 180, acc: { [HK.account_id]: [1000, 180, 0] }, pay: [['2025-06-01', 1180]],
  };
  const out = run({
    months,
    ledgers: { [HK.account_id]: [led('P1', '2025-05-05', 1000), led('P2', '2025-05-06', 700)] },
    details: { P1: det },
  });
  const c = cellOf(out, 'hk_material', 'Noi_Embassy_5th Floor', '2025-05');
  assert.equal(c.basic, 1000);
  assert.deepEqual([c.bills[0].gst, c.bills[0].bill_amount, c.bills[0].paid_date], [180, 1180, '2025-06-01']);
  assert.equal(out.bills_pending, 1);
  assert.equal(out.bills_pending_basic, 700);
  assert.deepEqual(out.needDetail, [{ bill_id: 'P2', lmt: null }]);
});

test('FY 2025-26: an open bill read over a week ago is read again', () => {
  const months = R.monthList(R.fyInfo('fy2526', '2026-11-23', () => '2026-27'));
  const old = { lmt: 'L', at: '2026-10-01T00:00:00Z', br: 'X', total: 100, bal: 100, tds: 0, tax: 0, acc: { [HK.account_id]: [100, 0, 0] }, pay: [] };
  const out = run({ months, ledgers: { [HK.account_id]: [led('P3', '2025-07-01', 100)] }, details: { P3: old }, now: Date.parse('2026-11-23T00:00:00Z') });
  assert.deepEqual(out.needDetail.map(n => n.bill_id), ['P3']);
});

test('slimDetail keeps per-account basic / GST / TDS and the payments', () => {
  const s = R.slimDetail({
    vendor_id: 'V', vendor_name: 'Vn', bill_number: 'N', date: '2026-09-01', branch_name: 'Br', status: 'paid',
    total: 10753, balance: 0, tds_amount: 0, sub_total: 9191.48, tax_total: 1561.68,
    line_items: [
      { account_id: 'A', item_total: 468, line_item_taxes: [{ tax_amount: 11.7 }, { tax_amount: 11.7 }] },
      { account_id: 'A', item_total: 6415.7, line_item_taxes: [{ tax_amount: 577.41 }, { tax_amount: 577.41 }], tds_tax_amount: 0 },
      { account_id: 'B', item_total: 2307.78, line_item_taxes: [{ tax_amount: 191.73 }, { tax_amount: 191.73 }] },
    ],
    payments: [{ date: '2026-09-16', amount: 10753 }],
  }, 'LMT');
  assert.deepEqual(s.acc, { A: [6883.7, 1178.22, 0], B: [2307.78, 383.46, 0] });
  assert.deepEqual(s.pay, [['2026-09-16', 10753]]);
  assert.equal(s.lmt, 'LMT');
  assert.equal(s.br, 'Br');
});

test('GST rate check allows rounding but not other lines', () => {
  assert.ok(R.isStdGst(10000, 1800));
  assert.ok(R.isStdGst(10000, 1801.5));
  assert.ok(R.isStdGst(9191, 0));
  assert.ok(!R.isStdGst(7363.7, 3389.3));
});

function r(v) { return Math.round(v * 100) / 100; }
