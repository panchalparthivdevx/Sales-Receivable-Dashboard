'use strict';

// The calculation rules of the user's brief (28 Nov 2026), case by case. Dates are fixed: "today" is 5 Dec 2026.

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../lib/engine');
const CFG = require('../lib/config');

const TODAY = '2026-12-05';
const CATS = CFG.DEFAULTS.categories;
const ACC = new Map([['a_brk', 'brokerage'], ['a_rent', 'rent'], ['a_el', 'electricity']]);
const CO = { id: 'devx', name: 'Dev Accelerator Ltd', org_id: '60027116474' };

let n = 0;
/** A compact Zoho bill: one line per entry of `lines` ([account, basic, gst]) */
function bill({ id = `b${++n}`, date, due = '', vid = 'v1', vn = 'Vendor One', br = 'Amd_The First', total, lines, pays = [], creds = [], bal, tds = 0, desc = '' }) {
  const ls = lines.map(([acc, amt, tax = 0]) => ({ acc, an: acc, d: desc, amt, tax, tn: '', tds: 0 }));
  const sub = ls.reduce((s, l) => s + l.amt, 0), tax = ls.reduce((s, l) => s + l.tax, 0);
  const t = total ?? sub + tax - tds;
  const paid = pays.reduce((s, p) => s + p.amt, 0) + creds.reduce((s, c) => s + c.amt, 0);
  return { id, no: `NO-${id}`, date, due, status: 'open', lmt: '', vid, vn, br, ref: '', cur: 'INR', sub, tax, tds, total: t, bal: bal ?? t - paid, adj: 0, lines: ls,
    pays: pays.map(p => ({ pid: p.pid || `p_${id}_${p.date}`, no: '', ref: p.ref || '', mode: '', acct: '', apply: p.apply || p.date, ...p })), creds };
}
const model = ({ bills = [], budgets = [], parts = {}, advances = {}, payments = [], portal = new Map(), vendorMasterCategory } = {}) =>
  E.buildModel({ company: CO, bills, accCat: ACC, plan: { budgets, parts, advances, slips: {} }, portal, payments, customers: [], categories: CATS, vendorMasterCategory });
const budget = (o) => ({ id: o.id || `bud${++n}`, category: 'brokerage', branch: '', planned_month: '2026-11', amount: 0, created_at: '2026-11-01T00:00:00Z', ...o });
const view = (m, o = {}) => E.monthView([m], { month: '2026-11', today: TODAY, ...o });

test('the brief\'s example: budget ₹1,00,000, bill ₹80,000, paid ₹30,000, ₹10,000 initiated → remaining ₹70,000, outstanding ₹50,000, pending ₹10,000, to initiate ₹40,000', () => {
  const b = bill({ id: 'brk1', date: '2026-11-05', due: '2026-11-20', vid: 'brk', vn: 'Fulcrum CRE Advisors LLP', lines: [['a_brk', 80000]],
    pays: [{ pid: 'pay1', date: '2026-11-12', amt: 30000, ref: 'UTR1' }] });
  const m = model({ bills: [b], budgets: [budget({ id: 'B1', vendor_id: 'brk', vendor_name: 'Fulcrum CRE Advisors LLP', amount: 100000 })],
    parts: { 'brk1:brokerage': { initiations: [
      { id: 'i1', date: '2026-11-10', amount: 30000, reference: 'NEFT batch 1', status: 'initiated' },
      { id: 'i2', date: '2026-11-25', amount: 10000, reference: 'NEFT batch 2', status: 'initiated' },
    ] } } });
  const v = view(m);
  const p = v.rows.parts.find(x => x.key === 'brk1:brokerage');
  assert.equal(p.budget_id, 'B1'); assert.equal(p.link, 'auto');
  assert.equal(p.at.final_out, 50000);
  assert.equal(p.at.pending, 10000);
  assert.equal(p.at.to_initiate, 40000);
  const bud = v.rows.budgets.find(x => x.id === 'B1');
  assert.equal(bud.at.remaining, 70000);
  assert.equal(bud.at.unbilled, 20000, 'the ₹20,000 difference stays visible for review');
  assert.equal(bud.at.awaiting, 0, 'not Awaiting Bill unless another bill is expected');
  const s = v.summary.brokerage;
  assert.deepEqual([s.budget, s.billed, s.paid_plan, s.remaining, s.final_out, s.pending, s.to_initiate, s.unbilled, s.awaiting], [100000, 80000, 30000, 70000, 50000, 10000, 40000, 20000, 0]);
  assert.equal(v.actions.initiate[0].amount, 40000);
  assert.equal(v.actions.settlement[0].amount, 10000);
  // only if another bill is actually expected does the difference become Awaiting Bill
  const m2 = model({ bills: [b], budgets: [budget({ id: 'B1', vendor_id: 'brk', amount: 100000, expects_more_bills: true })] });
  const b2 = view(m2).rows.budgets[0];
  assert.equal(b2.at.awaiting, 20000); assert.equal(b2.at.unbilled, 0);
});

test('missing bill: a budget with no bill is Awaiting Bill, stays in the forecast and in "Follow up for bills"', () => {
  const m = model({ budgets: [budget({ id: 'R1', category: 'rent', vendor_id: 'll1', vendor_name: 'Kailashben Natvarlal Patel', branch: 'Amd_Binori', amount: 66283 })] });
  const v = view(m, { categories: ['rent'] });
  const b = v.rows.budgets[0];
  assert.equal(b.at.awaiting, 66283); assert.equal(b.at.remaining, 66283); assert.equal(b.at.bills, 0);
  assert.equal(b.at.schedule[0].pay_on, '2026-11-30', 'forecast on the planned month');
  assert.equal(v.summary.rent.awaiting, 66283);
  assert.equal(v.summary.rent.final_out, 0, 'no bill, nothing outstanding yet');
  assert.equal(v.actions.follow_up.length, 1); assert.equal(v.actions.follow_up[0].amount, 66283);
  assert.equal(v.actions.initiate.length, 0, 'only a received bill can enter the payment list');
});

test('partial payment with instalments: what is still to initiate, and a passed Pay On date with part not initiated is flagged', () => {
  const b = bill({ id: 'el1', date: '2026-11-03', due: '2026-11-15', vid: 'mgvcl', vn: 'Madhya Gujarat Vij Company Limited - Baroda 3-5216 (6th floor)', lines: [['a_el', 80000]],
    pays: [{ pid: 'pe1', date: '2026-11-12', amt: 30000 }] });
  const m = model({ bills: [b], parts: { 'el1:electricity': { schedule: [{ id: 's1', pay_on: '2026-11-10', amount: 40000 }, { id: 's2', pay_on: '2026-12-15', amount: 40000 }] } } });
  const p = view(m, { categories: ['electricity'] }).rows.parts[0];
  assert.equal(p.at.final_out, 50000); assert.equal(p.at.paid, 30000);
  assert.equal(p.at.sched_unpaid, 50000); assert.equal(p.at.to_initiate, 50000);
  assert.equal(p.at.overdue.pay_on, '2026-11-10'); assert.equal(p.at.overdue.short, 10000); assert.equal(p.at.overdue.days, 25);
  assert.equal(p.at.state, 'unconfirmed', 'no initiation data and a Pay On date passed → Initiation unconfirmed');
  assert.equal(p.connection, 'Baroda 3-5216 (6th floor)');
  // scheduling only part of the bill caps what can be initiated
  const m2 = model({ bills: [b], parts: { 'el1:electricity': { schedule: [{ id: 's1', pay_on: '2026-12-10', amount: 45000 }] } } });
  assert.equal(view(m2, { categories: ['electricity'] }).rows.parts[0].at.to_initiate, 15000);
});

test('advance adjustment: paid in October, applied to the November bill on 1 Nov — counted once in October\'s cash, reduces the November bill', () => {
  // the real case read from Zoho on 28 Nov 2026 (Kailashben Natvarlal Patel, bill 0046): ₹7,364 of the 12 Oct payment applied on 1 Nov
  const nov = bill({ id: 'r46', date: '2026-11-01', due: '2026-11-10', vid: 'kp', vn: 'Kailashben Natvarlal Patel (108)', lines: [['a_rent', 73648]], tds: 7365,
    pays: [{ pid: 'VP4145', date: '2026-10-12', apply: '2026-11-01', amt: 7364 }, { pid: 'VP4945', date: '2026-11-23', amt: 58919 }] });
  const oct = bill({ id: 'r45', date: '2026-10-01', due: '2026-10-01', vid: 'kp', vn: 'Kailashben Natvarlal Patel (108)', lines: [['a_rent', 73649]], tds: 7365,
    pays: [{ pid: 'VP4145', date: '2026-10-12', amt: 58920 }] });
  const payments = [
    { payment_id: 'VP4145', vendor_id: 'kp', vendor_name: 'Kailashben Natvarlal Patel (108)', date: '2026-10-12', amount: 66284, balance: 0, payment_number: 'VP/26-27/GJ/4145' },
    { payment_id: 'VP4945', vendor_id: 'kp', vendor_name: 'Kailashben Natvarlal Patel (108)', date: '2026-11-23', amount: 58919, balance: 0 },
  ];
  const m = model({ bills: [nov, oct], payments, budgets: [budget({ id: 'RN', category: 'rent', vendor_id: 'kp', planned_month: '2026-11', amount: 66283 })] });
  const v = view(m, { categories: ['rent'] });
  const p = v.rows.parts.find(x => x.key === 'r46:rent');
  assert.equal(p.net, 66283); assert.equal(p.tds, 7365);
  assert.equal(p.at.direct, 58919); assert.equal(p.at.adv, 7364);
  assert.equal(p.at.out_before, 7364, 'outstanding before advance adjustment');
  assert.equal(p.at.final_out, 0, 'final outstanding after the advance');
  assert.equal(p.at.balance_gap, 0, 'agrees with Zoho\'s balance');
  assert.equal(v.rows.budgets[0].at.remaining, 0, 'the advance is a cash payment allocated to the November budget');
  assert.equal(v.summary.rent.cash_out, 58919, 'November cash: only what was paid in November');
  // October: the advance is October's cash, exactly once, in both views
  const octEnd = E.monthView([m], { month: '2026-10', mode: 'month_end', today: TODAY, categories: ['rent'] });
  const octNow = E.monthView([m], { month: '2026-10', mode: 'current', today: TODAY, categories: ['rent'] });
  assert.equal(octEnd.summary.rent.cash_out, 66284); assert.equal(octNow.summary.rent.cash_out, 66284);
  assert.deepEqual(octEnd.cash.map(x => [x.kind, x.amount]).sort(), [['advance_unapplied', 7364], ['bill_payment', 58920]]);
  assert.deepEqual(octNow.cash.map(x => [x.kind, x.amount]).sort(), [['advance_applied', 7364], ['bill_payment', 58920]]);
  assert.equal(octEnd.rows.advances[0].unapplied, 7364, 'at 31 Oct the money was an unapplied advance');
  assert.equal(octNow.rows.advances.length, 0, 'today it is applied');
});

test('payment settled in a later month: outstanding at month-end, "paid later" today, cash in December', () => {
  const b = bill({ id: 'r9', date: '2026-11-01', due: '2026-11-10', vid: 'll9', vn: 'Aadit Kunal Sheth (405)', lines: [['a_rent', 50000]],
    pays: [{ pid: 'pd', date: '2026-12-03', amt: 50000 }] });
  const m = model({ bills: [b], budgets: [budget({ id: 'R9', category: 'rent', vendor_id: 'll9', amount: 50000 })] });
  const end = E.monthView([m], { month: '2026-11', mode: 'month_end', today: TODAY, categories: ['rent'] });
  const now = E.monthView([m], { month: '2026-11', mode: 'current', today: TODAY, categories: ['rent'] });
  assert.equal(end.as_of, '2026-11-30');
  assert.equal(end.rows.parts[0].at.final_out, 50000); assert.equal(end.rows.budgets[0].at.remaining, 50000);
  assert.equal(end.summary.rent.final_out, 50000);
  assert.equal(now.rows.parts[0].at.final_out, 0); assert.equal(now.rows.parts[0].paid_later, 50000);
  assert.equal(now.summary.rent.final_out, 0);
  assert.equal(now.summary.rent.cash_out, 0, 'no November cash');
  const dec = E.monthView([m], { month: '2026-12', today: TODAY, categories: ['rent'] });
  assert.equal(dec.summary.rent.cash_out, 50000, 'the cash is December\'s');
  // unpaid on 30 November, so it is one of December's opening dues — paid in December
  const d = dec.rows.parts[0];
  assert.equal(d.carried_from, '2026-11'); assert.equal(d.opening_out, 50000); assert.equal(d.paid_against_plan, 50000); assert.equal(d.at.final_out, 0);
  assert.equal(dec.summary.rent.opening, 50000);
});

test('credit notes count once; a payment above the budget leaves a negative remaining budget and is flagged', () => {
  const b = bill({ id: 'c1', date: '2026-11-04', vid: 'v1', lines: [['a_brk', 10000]], creds: [{ no: 'VC-1', date: '2026-11-06', amt: 2000 }],
    pays: [{ date: '2026-11-08', amt: 3000 }] });
  const p = view(model({ bills: [b] })).rows.parts[0];
  assert.equal(p.at.credits, 2000); assert.equal(p.at.out_before, 5000); assert.equal(p.at.final_out, 5000);
  const b2 = bill({ id: 'x1', date: '2026-11-04', vid: 'vx', lines: [['a_brk', 60000]], pays: [{ date: '2026-11-08', amt: 60000 }] });
  const v = view(model({ bills: [b2], budgets: [budget({ id: 'BX', vendor_id: 'vx', amount: 50000 })] }));
  assert.equal(v.rows.budgets[0].at.remaining, -10000); assert.equal(v.rows.budgets[0].at.excess, true);
  assert.equal(v.summary.brokerage.counts.excess, 1);
});

test('one bill with rent and electricity lines: two parts, each with its share of the payments; unlinked bills stay visible', () => {
  const b = bill({ id: 'mx', date: '2026-11-02', vid: 'nws', vn: 'NURTURE WORK SPACE SOLUTIONS LLP', lines: [['a_rent', 50000, 9000], ['a_el', 10000, 1800], ['a_cam', 5000, 900]],
    pays: [{ date: '2026-11-09', amt: 38350 }] });
  const v = view(model({ bills: [b] }), { categories: ['rent', 'electricity'] });
  const rent = v.rows.parts.find(x => x.category === 'rent'), el = v.rows.parts.find(x => x.category === 'electricity');
  assert.equal(rent.net, 59000); assert.equal(el.net, 11800);
  assert.equal(rent.at.paid, 29500); assert.equal(el.at.paid, 5900);
  assert.equal(rent.link, 'none'); assert.equal(v.summary.rent.counts.unlinked, 1); assert.equal(v.summary.rent.unlinked, 59000);
});

test('several bills against one branch budget; the team\'s link (or "no budget") survives a refresh', () => {
  const b1 = bill({ id: 'l1', date: '2026-11-01', due: '2026-11-07', vid: 'a', br: 'Amd_Binori', lines: [['a_rent', 40000]] });
  const b2 = bill({ id: 'l2', date: '2026-11-01', due: '2026-11-07', vid: 'b', br: 'Amd_Binori', lines: [['a_rent', 35000]] });
  const bud = budget({ id: 'BR', category: 'rent', branch: 'Amd_Binori', amount: 80000 });
  let v = view(model({ bills: [b1, b2], budgets: [bud] }), { categories: ['rent'] });
  assert.deepEqual(v.rows.parts.map(p => p.budget_id), ['BR', 'BR']);
  assert.equal(v.rows.budgets[0].at.billed, 75000);
  v = view(model({ bills: [b1, b2], budgets: [bud, budget({ id: 'OTHER', category: 'rent', amount: 1 })], parts: { 'l1:rent': { budget_id: 'OTHER' }, 'l2:rent': { budget_id: '' } } }), { categories: ['rent'] });
  assert.equal(v.rows.parts.find(p => p.key === 'l1:rent').link, 'team');
  assert.equal(v.rows.parts.find(p => p.key === 'l2:rent').budget_id, '');
  assert.equal(v.rows.parts.find(p => p.key === 'l2:rent').link, 'none');
});

test('earlier unpaid bills come into the month as opening dues; cancelled or failed instructions never count as pending', () => {
  const b = bill({ id: 'o1', date: '2026-10-05', due: '2026-10-15', vid: 'v1', lines: [['a_brk', 20000]], pays: [{ date: '2026-11-20', amt: 5000 }] });
  const m = model({ bills: [b], parts: { 'o1:brokerage': { initiations: [
    { id: 'i1', date: '2026-11-21', amount: 8000, status: 'failed' }, { id: 'i2', date: '2026-11-22', amount: 6000, status: 'cancelled' }, { id: 'i3', date: '2026-11-25', amount: 4000, status: 'initiated' }] } } });
  const v = view(m);
  const p = v.rows.parts[0];
  assert.equal(p.carried_from, '2026-10'); assert.equal(p.earlier_bill, true);
  assert.equal(p.opening_out, 20000); assert.equal(p.paid_against_plan, 5000);
  assert.equal(p.at.pending, 4000);
  assert.equal(v.summary.brokerage.opening, 20000); assert.equal(v.summary.brokerage.billed, 0, 'not a bill received this month');
  assert.equal(view(m, { month: '2026-10' }).rows.parts[0].carried_from, '', 'in its own month it is a new bill');
  // "Initiate payment": this month's bills first, then opening dues — the oldest last
  const nov = bill({ id: 'n1', date: '2026-11-03', due: '2026-11-25', vid: 'v2', lines: [['a_brk', 5000]] });
  const old = bill({ id: 'o0', date: '2022-08-01', due: '2022-08-08', vid: 'v3', lines: [['a_brk', 7000]] });
  const keys = view(model({ bills: [b, nov, old] })).actions.initiate.map(a => a.key);
  assert.deepEqual(keys, ['n1:brokerage', 'o1:brokerage', 'o0:brokerage']);
  assert.equal(view(model({ bills: [b, nov, old] })).summary.brokerage.counts.overdue_opening, 2);
});

test('a bill not received by the month\'s end is not in the month-end view; its budget is then still awaiting the bill', () => {
  const b = bill({ id: 'late', date: '2026-12-02', vid: 'vl', lines: [['a_brk', 10000]] });
  const m = model({ bills: [b], budgets: [budget({ id: 'BL', vendor_id: 'vl', amount: 10000 })], parts: { 'late:brokerage': { budget_id: 'BL' } } });
  const end = E.monthView([m], { month: '2026-11', mode: 'month_end', today: TODAY });
  assert.equal(end.rows.parts.length, 0); assert.equal(end.rows.budgets[0].at.awaiting, 10000);
  const now = E.monthView([m], { month: '2026-11', mode: 'current', today: TODAY });
  assert.equal(now.rows.parts.length, 1); assert.equal(now.rows.budgets[0].at.awaiting, 0);
});

test('an advance linked to a budget counts against it until it is applied to a bill — never twice', () => {
  const payments = [{ payment_id: 'ADV', vendor_id: 'brk', vendor_name: 'SpaceWallah Enterprises', date: '2026-11-03', amount: 25000, balance: 25000 }];
  const m = model({ payments, budgets: [budget({ id: 'BA', vendor_id: 'brk', amount: 100000 })], advances: { ADV: { budget_id: 'BA' } }, vendorMasterCategory: () => 'brokerage' });
  const v = view(m);
  assert.equal(v.rows.advances[0].unapplied, 25000);
  assert.equal(v.rows.budgets[0].at.paid, 25000); assert.equal(v.rows.budgets[0].at.remaining, 75000);
  assert.equal(v.summary.brokerage.cash_out, 25000);
  // later applied to the bill linked to the same budget: still ₹25,000 against the budget
  const b = bill({ id: 'sw', date: '2026-11-15', vid: 'brk', lines: [['a_brk', 100000]], pays: [{ pid: 'ADV', date: '2026-11-03', apply: '2026-11-15', amt: 25000 }] });
  const payments2 = [{ ...payments[0], balance: 0 }];
  const v2 = view(model({ bills: [b], payments: payments2, budgets: [budget({ id: 'BA', vendor_id: 'brk', amount: 100000 })], advances: { ADV: { budget_id: 'BA' } } }));
  assert.equal(v2.rows.budgets[0].at.paid, 25000); assert.equal(v2.rows.budgets[0].at.remaining, 75000);
  assert.equal(v2.summary.brokerage.cash_out, 25000);
  assert.equal(v2.rows.parts[0].at.adv, 25000); assert.equal(v2.rows.parts[0].at.final_out, 75000);
});

test('a rounding leftover (₹10 or less) counts as paid: not carried into the next month, nothing to initiate — still in the outstanding total', () => {
  const b = bill({ id: 'rd', date: '2026-10-01', due: '2026-10-10', vid: 'v', lines: [['a_rent', 59335]], pays: [{ date: '2026-10-08', amt: 59333 }] });
  const m = model({ bills: [b] });
  const oct = view(m, { month: '2026-10', categories: ['rent'] }).rows.parts[0];
  assert.equal(oct.at.final_out, 2); assert.equal(oct.at.state, 'paid'); assert.equal(oct.at.to_initiate, 0); assert.equal(oct.at.overdue, null);
  assert.equal(view(m, { month: '2026-11', categories: ['rent'] }).rows.parts.length, 0, 'not an opening due of November');
  assert.equal(view(m, { month: '2026-10', categories: ['rent'] }).summary.rent.final_out, 2);
});

test('rent period: from the bill wording, but old template text far from the bill month gives way to the bill month', () => {
  const a = bill({ id: 'p1', date: '2026-11-01', vid: 'x', lines: [['a_rent', 1000]], desc: 'Noida rent for the month of Nov-26' });
  const b = bill({ id: 'p2', date: '2026-11-01', vid: 'y', lines: [['a_rent', 1000]], desc: 'House Rent Baroda - 1003 Rate: 31.70 Period: Aug-22' });
  const parts = model({ bills: [a, b] }).parts;
  assert.equal(parts.find(p => p.bill_id === 'p1').period.label, 'Nov-26');
  const old = parts.find(p => p.bill_id === 'p2').period;
  assert.equal(old.label, 'Nov-26'); assert.match(old.source, /the bill text says Aug-22/);
});

test('financial-year grid: branch × landlord rows with budget, bills, paid, outstanding and cash per month', () => {
  const b1 = bill({ id: 'g1', date: '2026-10-01', due: '2026-10-05', vid: 'kp', vn: 'Kailashben', br: 'Amd_Binori', lines: [['a_rent', 66283]], pays: [{ date: '2026-10-04', amt: 66283 }] });
  const b2 = bill({ id: 'g2', date: '2026-11-01', due: '2026-11-05', vid: 'kp', vn: 'Kailashben', br: 'Amd_Binori', lines: [['a_rent', 66283]] });
  const g = E.fyGrid([model({ bills: [b1, b2], budgets: [budget({ category: 'rent', vendor_id: 'kp', vendor_name: 'Kailashben', branch: 'Amd_Binori', planned_month: '2026-12', amount: 66283 })] })], { fy: '2026-27', category: 'rent', today: TODAY });
  assert.equal(g.months.length, 12); assert.equal(g.months[0], '2026-04'); assert.equal(g.months[11], '2027-03');
  assert.equal(g.rows.length, 1);
  const r = g.rows[0];
  assert.equal(r.cells['2026-10'].billed, 66283); assert.equal(r.cells['2026-10'].paid, 66283); assert.equal(r.cells['2026-10'].cash, 66283);
  assert.equal(r.cells['2026-11'].outstanding, 66283);
  assert.equal(r.cells['2026-12'].budget, 66283);
  assert.equal(g.totals['2026-11'].outstanding, 66283);
});
