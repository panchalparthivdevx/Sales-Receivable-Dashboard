/**
 * Recurring Expense Comparison Report (server/recurring-comparison.js): periods, labels, service
 * periods on bill lines, and the reasons for the change, on hand-made bills. No Zoho, no files.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../recurring-comparison');
const R = require('../recurring-expense');

const HS = R.HEADS.find(h => h.key === 'hk_service');
const HK = R.HEADS.find(h => h.key === 'hk_material');
const NET = R.HEADS.find(h => h.key === 'internet');
const BR = 'Mum_215-Atrium_10Th Floor';

let seq = 0;
const bill = o => ({
  bill_id: o.id || `B${++seq}`, vendor_id: o.vid || 'V1', vendor_name: o.vn || 'MJAVTA', bill_number: o.bn || `INV-${seq}`,
  date: o.date, basic: o.basic, account_name: 'x', branch_name: BR,
});
const row = (head, bills) => {
  const monthly = {};
  for (const b of bills) (monthly[b.date.slice(0, 7)] = monthly[b.date.slice(0, 7)] || { bills: [] }).bills.push(b);
  return { head_key: head.key, head_label: head.label, branch: BR, monthly };
};
const items = (acct, lines) => ({ lmt: 'L', at: 'x', li: lines.map(([t, q, rate, amt, desc = '']) => [acct, t, q, rate, amt ?? Math.round(q * rate * 100) / 100, desc]) });
const cmp = (rowsIn, itemsIn = {}, o = {}) => C.computeComparison({
  heads: R.HEADS, rows: rowsIn, curKeys: o.cur || ['2026-10'], prevKeys: o.prev || ['2026-09'], items: itemsIn,
  curLabel: o.curLabel || 'Oct-26', prevLabel: o.prevLabel || 'Sep-26', curRunning: !!o.running,
});
const texts = r => r.reasons.map(x => x.text);

test('periods: labels for a month, an FY quarter, an FY half and custom months', () => {
  assert.equal(C.periodLabel('2026-04', '2026-04').short, 'Apr-26');
  assert.equal(C.periodLabel('2026-10', '2026-12').short, 'Q-3');
  assert.equal(C.periodLabel('2027-01', '2027-03').long, 'Q-4 FY 26-27 (Jan-27 to Mar-27)');
  assert.equal(C.periodLabel('2026-10', '2027-03').short, 'H-2');
  assert.equal(C.periodLabel('2026-04', '2026-09').long, 'H-1 FY 26-27 (Apr-26 to Sep-26)');
  assert.equal(C.periodLabel('2026-05', '2026-07').short, 'May-26 to Jul-26');      // not an FY quarter
  assert.deepEqual(C.monthsBetween('2025-11', '2026-02'), ['2025-11', '2025-12', '2026-01', '2026-02']);
  assert.equal(C.addMonths('2026-01', -1), '2025-12');
});

test('the FY of a month: March 2026 is FY 2025-26, October 2026 the current FY', () => {
  const fyTag = () => '2026-27';
  const m = R.fyOfMonth('2026-03', '2026-11-25', fyTag);
  assert.deepEqual([m.tag, m.start, m.end, m.lastMonth, m.current], ['2025-26', '2025-04-01', '2026-03-31', '2026-03', false]);
  const o = R.fyOfMonth('2026-10', '2026-11-25', fyTag);
  assert.deepEqual([o.tag, o.lastMonth, o.current], ['2026-27', '2026-11', true]);
  // Same tag as the main report's FY toggle, so both share the ledger cache
  assert.equal(R.fyInfo('fy2526', '2026-11-25', fyTag).tag, m.tag);
});

test('service period written on a bill line', () => {
  assert.deepEqual(C.servicePeriod('Internet Connectivity Recurring Charge 01-Oct-2026 To 31-Dec-2026'), { from: '2026-10-01', to: '2026-12-31', months: 3 });
  assert.deepEqual(C.servicePeriod('Rent 01/10/2026 - 31/10/2026'), { from: '2026-10-01', to: '2026-10-31', months: 1 });
  assert.deepEqual(C.servicePeriod('Charges for Oct-26 to Dec-26'), { from: '2026-10-01', to: '2026-12-31', months: 3 });
  assert.deepEqual(C.servicePeriod('April 2026 – September 2026'), { from: '2026-04-01', to: '2026-09-30', months: 6 });
  assert.equal(C.servicePeriod('Electricity charge'), null);
  assert.equal(C.servicePeriod('Housekeeper 58.5 days'), null);
  assert.equal(C.servicePeriod('32-Oct-2026 to 31-Dec-2026'), null);          // no 32nd
  assert.equal(C.servicePeriod('01-Dec-2026 to 01-Oct-2026'), null);          // ends before it starts
});

test('slimItems keeps only the lines of the seven expense accounts', () => {
  const s = C.slimItems({ last_modified_time: 'T1', line_items: [
    { account_id: HK.account_id, name: 'CLEANING & HOUSEHOLD ', quantity: 1, rate: 6760, item_total: 6760 },
    { account_id: '999', name: '', description: 'Office Stationery', quantity: 1, rate: 1929.5, item_total: 1929.5 },
    { account_id: NET.account_id, name: '', description: 'Internet Connectivity Recurring Charge\n01-Oct-2026 To 31-Dec-2026', quantity: 1, rate: 23700, item_total: 23700 },
  ] }, new Set(R.HEADS.map(h => h.account_id)));
  assert.equal(s.lmt, 'T1');
  assert.deepEqual(s.li.map(l => l.slice(0, 5)), [
    [HK.account_id, 'CLEANING & HOUSEHOLD', 1, 6760, 6760],
    [NET.account_id, 'Internet Connectivity Recurring Charge 01-Oct-2026 To 31-Dec-2026', 1, 23700, 23700],
  ]);
});

test('quantity and rate effects: man-days up and daily rate up, with a new item and a dropped one', () => {
  const p = bill({ date: '2026-09-09', basic: 40083.62 + 37173.31 });
  const c = bill({ date: '2026-10-09', basic: 43400 + 7140.09 });
  const out = cmp([row(HS, [p, c])], {
    [p.bill_id]: items(HS.account_id, [['Housekeeper ', 58.5, 685.19, 40083.62], ['Pantry boy', 48.5, 766.46, 37173.31]]),
    [c.bill_id]: items(HS.account_id, [['Housekeeper', 62, 700, 43400], ['management fee', 1, 7140.09, 7140.09]]),
  });
  const r = out[0];
  assert.deepEqual([r.prev, r.cur, r.change, r.pct], [77256.93, 50540.09, -26716.84, -34.6]);
  const t = texts(r);
  assert.equal(t[0], 'MJAVTA: ₹77,257 → ₹50,540 (−₹26,717, −34.6%)');
  assert.ok(t.includes('Not billed this time: Pantry boy (₹37,173 in Sep-26)'), t.join('\n'));
  assert.ok(t.includes('New item management fee: ₹7,140'), t.join('\n'));
  // 3.5 more days × ₹685.19 = ₹2,398; rate +₹14.81 × 62 days = ₹918
  assert.ok(t.includes('Housekeeper: qty 58.5 → 62 (+₹2,398) · rate ₹685.19 → ₹700.00 (+₹918)'), t.join('\n'));
  assert.equal(r.attention, 0);
  assert.equal(r.items_pending, 0);
  assert.equal(r.items_cmp.length, 3);
  assert.deepEqual(r.bills.cur[0].items, [['Housekeeper', 62, 700, 43400], ['management fee', 1, 7140.09, 7140.09]]);
});

test('lump-sum lines (quantity 1) are compared by amount; several lines of one name are added up', () => {
  const p = bill({ vn: 'PROTEA', date: '2026-09-27', basic: 100000 });
  const c = bill({ vn: 'PROTEA', date: '2026-10-27', basic: 117673.9 });
  const out = cmp([row(HK, [p, c])], {
    [p.bill_id]: items(HK.account_id, [['CLEANING & HOUSEHOLD', 1, 100000]]),
    [c.bill_id]: items(HK.account_id, [['CLEANING & HOUSEHOLD', 1, 6760], ['CLEANING & HOUSEHOLD', 1, 102083.9], ['CLEANING & HOUSEHOLD', 1, 8830]]),
  });
  const t = texts(out[0]);
  assert.ok(t.includes('CLEANING & HOUSEHOLD: ₹1,00,000 → ₹1,17,674 (+₹17,674)'), t.join('\n'));
  assert.ok(!t.some(x => /qty|rate/.test(x)), 'no qty / rate split for lump sums');
});

test('the same item spelt differently (plural, typo) is matched; different items are not', () => {
  const p = bill({ vn: 'PROTEA', date: '2026-09-27', basic: 10814 + 1048 + 500 });
  const c = bill({ vn: 'PROTEA', date: '2026-10-27', basic: 6053 + 419 + 700 });
  const r = cmp([row(HK, [p, c])], {
    [p.bill_id]: items(HK.account_id, [['IT & ELECTRONIC', 1, 10814], ['pantry supllies', 1, 1048], ['Safety Supplies', 1, 500]]),
    [c.bill_id]: items(HK.account_id, [['IT & Electronics', 1, 6053], ['Pantry Supplies', 1, 419], ['Garbage bags', 1, 700]]),
  })[0];
  const t = texts(r);
  assert.ok(t.includes('IT & Electronics: ₹10,814 → ₹6,053 (−₹4,761)'), t.join('\n'));
  assert.ok(t.includes('Pantry Supplies: ₹1,048 → ₹419 (−₹629)'), t.join('\n'));
  assert.ok(t.includes('New item Garbage bags: ₹700'), t.join('\n'));
  assert.ok(t.includes('Not billed this time: Safety Supplies (₹500 in Sep-26)'), t.join('\n'));
  assert.equal(r.items_cmp.length, 4);
});

test('a rate rise above 10% needs attention and the bill is highlighted', () => {
  const p = bill({ vn: 'SPARKLING', date: '2026-09-06', basic: 7600 });
  const c = bill({ vn: 'SPARKLING', date: '2026-10-06', basic: 8820 });
  const out = cmp([row(HK, [p, c])], {
    [p.bill_id]: items(HK.account_id, [['MILK', 100, 76]]),
    [c.bill_id]: items(HK.account_id, [['MILK', 105, 84]]),
  });
  const r = out[0];
  assert.equal(r.attention, 1);
  const line = r.reasons.find(x => x.attn);
  assert.equal(line.text, 'MILK: qty 100 → 105 (+₹380) · rate ₹76.00 → ₹84.00 (+₹840) — rate up 10.5%');
  assert.deepEqual(r.bills.cur[0].attn, ['MILK rate up 10.5% (₹76.00 → ₹84.00)']);
  assert.equal(r.bills.prev[0].attn, undefined);
});

test('a vendor with no bill this period: attention, unless the period is running or another vendor billed', () => {
  const p = bill({ vn: 'Torrent Power', vid: 'TP', date: '2026-09-12', basic: 80000 });
  const its = { [p.bill_id]: items(HK.account_id, [['Electricity charge', 1, 80000]]) };
  // Until the Sep bill's lines are read it may still turn out to cover October: no flag yet
  const unread = cmp([row(HK, [p])])[0];
  assert.equal(unread.reasons[0].text, 'Torrent Power: no bill this period (₹80,000 in Sep-26) — checking the Sep-26 bill lines');
  assert.deepEqual([unread.attention, unread.items_pending], [0, 1]);

  const missing = cmp([row(HK, [p])], its)[0];
  assert.deepEqual([missing.cur, missing.prev, missing.change, missing.pct], [0, 80000, -80000, -100]);
  assert.equal(missing.reasons[0].text, 'Torrent Power: no bill this period (₹80,000 in Sep-26) — check whether the bill is still to be booked');
  assert.equal(missing.attention, 1);

  const running = cmp([row(HK, [p])], its, { running: true })[0];
  assert.equal(running.reasons[0].text, 'Torrent Power: not billed yet (₹80,000 in Sep-26) — the period is still running');
  assert.equal(running.attention, 0);

  const n = bill({ vn: 'Adani Electricity', vid: 'AD', date: '2026-10-12', basic: 82000 });
  const swapped = cmp([row(HK, [p, n])], its)[0];
  assert.deepEqual(texts(swapped), [
    'Adani Electricity: new this period — 1 bill, ₹82,000 (nothing in Sep-26)',
    'Torrent Power: no bill this period (₹80,000 in Sep-26) — another vendor billed instead',
  ]);
  assert.equal(swapped.attention, 0);
  assert.equal(swapped.pct, 2.5);
});

test('a quarterly bill: no bill next month is explained, not flagged; the bill itself says it covers 3 months', () => {
  const q = bill({ vn: 'ISHAN NETSOL', vid: 'IN', bn: 'IE242627010490', date: '2026-10-01', basic: 23700 });
  const its = { [q.bill_id]: items(NET.account_id, [['Internet Connectivity Recurring Charge 01-Oct-2026 To 31-Dec-2026', 1, 23700]]) };
  const nov = cmp([row(NET, [q])], its, { cur: ['2026-11'], prev: ['2026-10'], curLabel: 'Nov-26', prevLabel: 'Oct-26' })[0];
  assert.equal(nov.reasons[0].text, 'ISHAN NETSOL: no bill this period — the Oct-26 bill IE242627010490 covers 01-Oct-2026 to 31-Dec-2026 (3 months)');
  assert.equal(nov.attention, 0);
  const oct = cmp([row(NET, [q])], its)[0];
  assert.deepEqual(texts(oct), [
    'ISHAN NETSOL: new this period — 1 bill, ₹23,700 (nothing in Sep-26)',
    'Bill IE242627010490 covers 01-Oct-2026 to 31-Dec-2026 (3 months)',
  ]);
});

test('possible duplicates: same vendor, month and amount; or the same bill number in both periods', () => {
  const p = bill({ vn: 'ODS', vid: 'O', bn: 'ODS/77', date: '2026-09-05', basic: 123544 });
  const c1 = bill({ vn: 'ODS', vid: 'O', bn: 'ODS/91', date: '2026-10-05', basic: 123544 });
  const c2 = bill({ vn: 'ODS', vid: 'O', bn: 'ODS/91A', date: '2026-10-20', basic: 123544 });
  const r = cmp([row(HK, [p, c1, c2])])[0];
  assert.ok(texts(r).includes('Possible duplicate: 2 bills of the same amount ₹1,23,544 in Oct-26: ODS/91, ODS/91A'), texts(r).join('\n'));
  assert.ok(texts(r).includes('2 bills this period vs 1 in Sep-26 (average ₹1,23,544 vs ₹1,23,544 per bill)'), texts(r).join('\n'));
  assert.deepEqual(r.bills.cur.map(b => b.attn), [['Possible duplicate — same amount ₹1,23,544 as ODS/91A'], ['Possible duplicate — same amount ₹1,23,544 as ODS/91']]);

  const again = bill({ vn: 'ODS', vid: 'O', bn: 'ODS-77', date: '2026-10-05', basic: 120000 });
  const r2 = cmp([row(HK, [p, again])])[0];
  assert.ok(texts(r2).includes('Bill no. ODS-77 was also booked in Sep-26 (₹1,23,544) — possible duplicate'), texts(r2).join('\n'));
  assert.deepEqual(r2.bills.cur[0].attn, ['Same bill no. as a Sep-26 bill']);
});

test('many equal bills every month (one per phone line) are not duplicates; one more than usual is', () => {
  const mk = (date, n) => Array.from({ length: n }, () => bill({ vn: 'ISHAN NETSOL', vid: 'IN', date, basic: 800 }));
  const usual = cmp([row(NET, [...mk('2026-09-03', 18), ...mk('2026-10-03', 18)])])[0];
  assert.equal(usual.attention, 0);
  assert.equal(texts(usual)[0], 'ISHAN NETSOL: no change (₹14,400)');
  assert.ok(!texts(usual).some(t => /duplicate/i.test(t)));
  const extra = cmp([row(NET, [...mk('2026-09-03', 18), ...mk('2026-10-03', 19)])])[0];
  assert.equal(extra.attention, 1);
  assert.match(extra.reasons.find(x => x.attn).text, /^Possible duplicate: 19 bills of the same amount ₹800 in Oct-26 \(18 in a month in Sep-26\): INV-\d+, INV-\d+, INV-\d+, INV-\d+ and 15 more$/);
});

test('more bills at a similar amount per bill explain an increase: no flag', () => {
  const p = [1, 2, 3, 4].map(i => bill({ vn: 'Blazenet', vid: 'BZ', date: `2026-09-0${i}`, basic: 24537.5 }));
  const c = [1, 2, 3, 4, 5, 6].map(i => bill({ vn: 'Blazenet', vid: 'BZ', date: `2026-10-0${i}`, basic: 21233.33 + i }));
  const its = {};
  for (const b of [...p, ...c]) its[b.bill_id] = items(NET.account_id, [['IP Lease Line', 1, b.basic]]);
  const r = cmp([row(NET, [...p, ...c])], its)[0];
  assert.ok(texts(r).includes('6 bills this period vs 4 in Sep-26 (average ₹21,237 vs ₹24,538 per bill)'), texts(r).join('\n'));
  assert.equal(r.attention, 0);
});

test('item lines not read yet: counted, no flag; once read, a big increase they do not explain needs attention', () => {
  const p = bill({ vn: 'X', date: '2026-09-01', basic: 40000 });
  const c = bill({ vn: 'X', date: '2026-10-01', basic: 60000 });
  const pi = { [p.bill_id]: items(HK.account_id, [['Supplies', 1, 40000]]) };
  const r = cmp([row(HK, [p, c])], pi)[0];
  assert.equal(r.items_pending, 1);
  assert.ok(texts(r).includes('Item lines still being read from Zoho for 1 bill'));
  assert.equal(r.attention, 0);
  assert.equal(r.bills.cur[0].items, null);

  const read = cmp([row(HK, [p, c])], { ...pi, [c.bill_id]: items(HK.account_id, [['Supplies', 1, 60000]]) })[0];
  assert.ok(texts(read).includes('Up +50.0% with no quantity or rate change on the bill lines to explain it — check the bill'), texts(read).join('\n'));
  assert.deepEqual(read.bills.cur[0].attn, ['Up +50.0% vs Sep-26 — check']);
});

test('month names in item names: matched as one item; the service months on the bills explain the change', () => {
  // Sep-26 had the July and August bills booked late, Oct-26 only September's
  const j = bill({ vn: 'EMBASSY', vid: 'E', date: '2026-09-02', basic: 889602 });
  const a = bill({ vn: 'EMBASSY', vid: 'E', date: '2026-09-20', basic: 1006008 });
  const s = bill({ vn: 'EMBASSY', vid: 'E', date: '2026-10-08', basic: 1283153 });
  const r = cmp([row(HS, [j, a, s])], {
    [j.bill_id]: items(HS.account_id, [['housekeeping service - july 2026', 1, 889602]]),
    [a.bill_id]: items(HS.account_id, [['housekeeping service - AUG 2026', 1, 1006008]]),
    [s.bill_id]: items(HS.account_id, [['housekeeping service - SEPT 2026', 1, 1283153]]),
  })[0];
  const t = texts(r);
  assert.ok(t.includes('housekeeping service: ₹18,95,610 → ₹12,83,153 (−₹6,12,457)'), t.join('\n'));
  assert.ok(t.includes('Service months on the bills — Oct-26: Sep-26 ₹12,83,153 (1 month); Sep-26: Jul-26 ₹8,89,602, Aug-26 ₹10,06,008 (2 months)'), t.join('\n'));
  assert.equal(r.attention, 0);
  assert.equal(r.items_cmp.length, 1);
  // One month each (normal billing in arrears): no service-month line
  const s2 = bill({ vn: 'EMBASSY', vid: 'E', date: '2026-10-08', basic: 1000 });
  const a2 = bill({ vn: 'EMBASSY', vid: 'E', date: '2026-09-08', basic: 900 });
  const r2 = cmp([row(HS, [a2, s2])], {
    [a2.bill_id]: items(HS.account_id, [['housekeeping service - AUG 2026', 1, 900]]),
    [s2.bill_id]: items(HS.account_id, [['housekeeping service - SEPT 2026', 1, 1000]]),
  })[0];
  assert.deepEqual(texts(r2), ['EMBASSY: ₹900 → ₹1,000 (+₹100, +11.1%)', 'housekeeping service: ₹900 → ₹1,000 (+₹100)']);
});

test('a big increase explained by more service months on the bills is not flagged', () => {
  const p = bill({ vn: 'ODS', vid: 'O', date: '2026-09-05', basic: 100000 });
  const c1 = bill({ vn: 'ODS', vid: 'O', date: '2026-10-05', basic: 100000 });
  const c2 = bill({ vn: 'ODS', vid: 'O', date: '2026-10-25', basic: 90000 });
  const r = cmp([row(HK, [p, c1, c2])], {
    [p.bill_id]: items(HK.account_id, [['Security Guard Sep 2026', 1, 100000]]),
    [c1.bill_id]: items(HK.account_id, [['Security Guard Oct 2026', 1, 100000]]),
    [c2.bill_id]: items(HK.account_id, [['Security Guard - Aug-26', 1, 90000]]),
  })[0];
  assert.ok(texts(r).includes('Service months on the bills — Oct-26: Aug-26 ₹90,000, Oct-26 ₹1,00,000 (2 months); Sep-26: Sep-26 ₹1,00,000 (1 month)'), texts(r).join('\n'));
  assert.equal(r.attention, 0);
  // The item is the same one ("Security Guard") whatever month is written on it
  assert.equal(r.items_cmp.length, 1);
  assert.equal(r.items_cmp[0].item, 'Security Guard');
});

test('a difference the item lines do not carry (e.g. a discount) is shown separately', () => {
  const p = bill({ vn: 'Avighna', date: '2026-09-27', basic: 10164 });
  const c = bill({ vn: 'Avighna', date: '2026-10-27', basic: 10000 });             // ₹500 bill-level discount
  const r = cmp([row(HK, [p, c])], {
    [p.bill_id]: items(HK.account_id, [['MILK', 132, 77]]),
    [c.bill_id]: items(HK.account_id, [['MILK', 136, 77.21, 10500.56]]),
  })[0];
  const t = texts(r);
  assert.ok(t.some(x => x.startsWith('MILK: qty 132 → 136 (+₹308)')), t.join('\n'));
  assert.ok(t.includes('Other differences (discounts, rounding or amounts not on the item lines): −₹501'), t.join('\n'));
});

test('quarter on quarter adds up the months; branches with nothing in either period are left out', () => {
  const bills = [
    bill({ vn: 'MJAVTA', date: '2026-07-09', basic: 100 }), bill({ vn: 'MJAVTA', date: '2026-08-09', basic: 100 }), bill({ vn: 'MJAVTA', date: '2026-09-09', basic: 100 }),
    bill({ vn: 'MJAVTA', date: '2026-10-09', basic: 120 }), bill({ vn: 'MJAVTA', date: '2026-11-09', basic: 120 }),
  ];
  const r = cmp([row(HS, bills), row(HK, [bill({ date: '2026-04-01', basic: 5 })])], {}, {
    cur: ['2026-10', '2026-11'], prev: ['2026-07', '2026-08', '2026-09'], curLabel: 'Q-3', prevLabel: 'Q-2', running: true,
  });
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].cur, r[0].prev, r[0].change], [240, 300, -60]);
  assert.ok(texts(r[0]).includes('2 bills this period vs 3 in Q-2 (average ₹120 vs ₹100 per bill)'), texts(r[0]).join('\n'));
});

test('built on the real report rows: the comparison figures equal the report cells', () => {
  const months = [{ key: '2026-09', label: 'Sep 26' }, { key: '2026-10', label: 'Oct 26' }];
  const led = (id, date, amt) => ({ transaction_type: 'bill', transaction_id: id, transaction_date: date, debit_amount: amt, credit_amount: '' });
  const lb = (id, date, total) => ({ bill_id: id, vendor_id: 'V1', vendor_name: 'MJAVTA', bill_number: id, date, branch_name: BR, status: 'paid', total, balance: 0, tds_total: 0, last_modified_time: 'L' });
  const out = R.computeReport({
    months, ledgers: { [HS.account_id]: [led('S1', '2026-09-09', 10000), led('S2', '2026-10-09', 12000)] },
    list: new Map([['S1', lb('S1', '2026-09-09', 11800)], ['S2', lb('S2', '2026-10-09', 14160)]]), details: {}, payIdx: new Map(), current: true,
  });
  assert.equal(out.rows[0].monthly['2026-10'].bills[0].bill_id, 'S2');
  assert.equal(out.rows[0].monthly['2026-10'].bills[0].vendor_id, 'V1');
  const r = cmp(out.rows)[0];
  assert.deepEqual([r.cur, r.prev, r.change, r.pct], [12000, 10000, 2000, 20]);
  assert.equal(r.reasons[0].text, 'MJAVTA: ₹10,000 → ₹12,000 (+₹2,000, +20.0%)');
  assert.equal(r.items_pending, 2);
});
