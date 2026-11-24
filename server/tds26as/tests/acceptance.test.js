/**
 * Acceptance cases from the brief, on the synthetic demo scenario (lib/demo.js), with statements imported through the real importer.
 * Amounts in the assertions are paise (₹1 = 100).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const DEMO = require('../lib/demo');
const ST = require('../lib/statements');
const BS = require('../lib/booksSync');
const RC = require('../lib/recon');
const RP = require('../lib/reports');
const RV = require('../lib/review');
const CL = require('../lib/clients');
const PER = require('../lib/periods');

const fakeZr = { get: async () => { throw new Error('no Zoho in tests'); }, isGone: () => false, errText: e => e.message, identity: () => 'test' };
let recon, X, Y, sc;
const Q4 = PER.resolve({ fy: '2025-26', q: 4 }), Q1 = PER.resolve({ fy: '2026-27', q: 1 });

async function fresh(statements = null) {
  H.tempStore();
  const r = await DEMO.load({ cfgNow: H.cfgNow, saveConfig: patch => H.saveConfig(patch), by: 'tester', statements });
  sc = DEMO.scenario();
  const cfg = await H.cfgNow();
  X = cfg.entities.find(e => e.id === 'demo-x'); Y = cfg.entities.find(e => e.id === 'demo-y');
  const sync = BS.create({ zr: fakeZr, cfgNow: H.cfgNow });
  recon = RC.create({ sync, cfgNow: H.cfgNow });
  return r;
}
const unitsOf = (res, d, tan) => res.units.filter(u => u.credits.some(k => d.credits.find(c => c.key === k).tan === tan) || u.zoho.some(k => { const z = d.items.find(i => i.key === k); return z && d.clients.byEntry.get(z.key) === d.clients.byTan.get(tan); }));
const one = (list, msg) => { assert.equal(list.length, 1, msg); return list[0]; };

test.before(async () => { await fresh(); });

test('exact match, ₹2.00 rounding difference, ₹2.01 mismatch', async () => {
  const { d, res } = await recon.run(X, Q4);
  const a = unitsOf(res, d, sc.C.A.tan);
  assert.equal(a.length, 2);
  for (const u of a) { assert.equal(u.status, 'matched'); assert.equal(u.method, 'transaction'); assert.equal(u.diff, 0); }
  const b = one(unitsOf(res, d, sc.C.B.tan));
  assert.deepEqual([b.status, b.diff, b.method], ['rounding', 200, 'transaction'], 'Zoho ₹5,000.00 − deposited ₹4,998.00 = +₹2.00 → Matched Rounding Diff.');
  const c = one(unitsOf(res, d, sc.C.Cg.tan));
  assert.deepEqual([c.status, c.diff], ['not_matched', 201], 'Zoho ₹3,000.00 − ₹2,997.99 = +₹2.01 → Not Matched');
  assert.ok(c.zoho.length === 1 && c.credits.length === 1, 'both sides identified');
  assert.equal(c.matched_amount, 299799);
  assert.equal(c.open_zoho, 201);
  assert.ok(c.reason && c.reason.text.includes('₹3,000.00'), c.reason && c.reason.text);
});

test('several Zoho invoices matching one 26AS credit — client total, no credit used twice', async () => {
  const { d, res } = await recon.run(X, Q4);
  const u = one(unitsOf(res, d, sc.C.D.tan));
  assert.equal(u.method, 'client_total');
  assert.equal(u.status, 'matched');
  assert.equal(u.zoho.length, 3);
  assert.equal(u.credits.length, 1);
  assert.equal(u.z_amount, 500000);
  // no source amount is used twice anywhere
  const all = res.units.flatMap(x => [...x.zoho, ...x.credits]);
  assert.equal(all.length, new Set(all).size, 'every Zoho entry and every credit sits in exactly one unit');
  assert.equal(new Set(all).size, res.zoho_in_period.length + res.credits_in_period.length);
});

test('two identical TDS amounts for one client, one credit — sent to review as ambiguous', async () => {
  const { d, res } = await recon.run(X, Q4);
  const u = one(unitsOf(res, d, sc.C.E.tan));
  assert.equal(u.status, 'need_check');
  assert.equal(u.reason.code, 'ambiguous');
  assert.equal(u.zoho.length, 2);
  assert.equal(u.credits.length, 1);
  assert.equal(u.evidence.filter(e => e.kind === 'candidate').length, 2, 'both candidate invoices are listed');
});

test('March Zoho entry, April 26AS credit — March shows Need to Check with the April evidence; April is not in March totals', async () => {
  const { d, res } = await recon.run(X, Q4);
  const u = one(unitsOf(res, d, sc.C.F.tan));
  assert.equal(u.status, 'need_check');
  assert.equal(u.reason.code, 'timing');
  const ev = one(u.evidence);
  assert.equal(ev.kind, 'later_credit');
  assert.equal(ev.txn_date, '2026-04-03');
  assert.equal(ev.quarter, '2026-27-Q1');
  assert.equal(ev.deducted, 400000);
  assert.equal(u.credits.length, 0, 'the April credit is evidence only');
  const dash = RP.dashboard(d, res, Q4);
  assert.ok(!res.credits_in_period.some(k => d.credits.find(c => c.key === k).txn_date === '2026-04-03'));
  assert.equal(dash.totals.deposited, 3452899, 'Q4 deposited excludes the April credit');
  // the April quarter sees the March booking as its evidence
  const r1 = await recon.run(X, Q1);
  const a = one(r1.res.units.filter(x => x.credits.length));
  assert.equal(a.reason.code, 'timing');
  assert.equal(a.evidence[0].kind, 'earlier_booking');
});

test('timing evidence says so when the later quarter has its own booking the credit may belong to', async () => {
  const store = require('../lib/store');
  await store.update('ledger_demo-x_2026_27', { rows: {}, months: {} }, d => { d.rows['extra-apr'] = { id: 'extra-apr', acc: 'demo194J', type: 'invoice', type_label: 'Invoice', tid: 'iF2', date: '2026-04-05', cust: sc.C.F.cust, payee: sc.C.F.name, desc: '', no: 'DX/26-27/0001', ref: '', dr: 400000, cr: 0, off: '' }; });
  recon.bump();
  const q4 = await recon.run(X, Q4);
  const u = one(unitsOf(q4.res, q4.d, sc.C.F.tan));
  assert.equal(u.reason.code, 'timing');
  assert.equal(u.evidence[0].maybe_matched_there, true);
  assert.match(u.reason.text, /may belong to it/);
  const q1 = await recon.run(X, Q1);
  const a = one(unitsOf(q1.res, q1.d, sc.C.F.tan).filter(x => x.credits.length));
  assert.equal(a.status, 'matched', 'in April the credit matches the April booking');
  await fresh();
});

test('only in Zoho, only in 26AS, and tax deducted exceeding tax deposited', async () => {
  const { d, res } = await recon.run(X, Q4);
  const g = one(unitsOf(res, d, sc.C.G.tan));
  assert.deepEqual([g.status, g.z_amount, g.credits.length], ['not_in_26as', 150000, 0]);
  const h = one(unitsOf(res, d, sc.C.H.tan));
  assert.deepEqual([h.status, h.deposited, h.zoho.length], ['not_in_zoho', 90000, 0]);
  const i = one(unitsOf(res, d, sc.C.I.tan));
  assert.equal(i.status, 'not_matched');
  assert.equal(i.reason.code, 'deducted_exceeds_deposited');
  assert.deepEqual([i.deducted, i.deposited, i.diff], [600000, 0, 600000]);
  assert.ok(/Deductor/.test(i.reason.responsibility), 'responsibility is named only because the statement itself shows it');
  // other exceptions do not name anyone responsible
  assert.ok(res.units.filter(u => u.reason && u.reason.code !== 'deducted_exceeds_deposited').every(u => !u.reason.responsibility));
});

test('re-uploading the same statement changes nothing; a revised statement replaces the earlier one without doubling credits', async () => {
  const list = await ST.list('demo-x');
  const fy26 = list.filter(s => s.fy === '2025-26');
  assert.equal(fy26.length, 2);
  assert.deepEqual(fy26.map(s => [s.version, s.active]), [[1, false], [2, true]]);
  assert.equal(fy26[1].revision.added, 1, 'v2 adds the late filer\'s credit');
  const before = (await ST.activeCredits('demo-x')).length;
  assert.equal(before, 12 + 1, 'FY 2025-26 v2 (12 rows) + FY 2026-27 (1 row) — not v1 + v2');
  // the same v1 bytes again
  const s = sc.statements[0];
  const pv = await ST.preview({ buffer: Buffer.from(s.text), fileName: 'again.txt', entity: X, by: 't' });
  assert.ok(pv.same_file && pv.validation.checks.some(c => c.id === 'duplicate'));
  const cm = await ST.commit({ previewId: pv.preview_id, entity: X, by: 't', ack: true });
  assert.equal(cm.unchanged, true);
  assert.equal((await ST.list('demo-x')).length, list.length);
  assert.equal((await ST.activeCredits('demo-x')).length, before);
  // an OLDER statement uploaded after the newer one stays history
  const older = s.text.replace('15-06-2026^', '01-06-2026^').replace('Demo address', 'Demo address (older copy)');
  const pv2 = await ST.preview({ buffer: Buffer.from(older), fileName: 'older.txt', entity: X, by: 't' });
  assert.ok(pv2.validation.checks.some(c => c.id === 'older'));
  const cm2 = await ST.commit({ previewId: pv2.preview_id, entity: X, by: 't', ack: true });
  assert.equal(cm2.statement.active, false);
  assert.equal((await ST.activeCredits('demo-x')).length, before);
  // the late filer is matched only because of the revision
  recon.bump();
  const { d, res } = await recon.run(X, Q4);
  assert.equal(one(unitsOf(res, d, sc.C.O.tan)).status, 'matched');
});

test('the late filer is "Not in 26AS" when only the first statement is loaded', async () => {
  await fresh([0, 2, 3]);
  const { d, res } = await recon.run(X, Q4);
  assert.equal(one(unitsOf(res, d, sc.C.O.tan)).status, 'not_in_26as');
  await fresh();
});

test('two entities with the same client stay separate', async () => {
  const rx = await recon.run(X, Q4), ry = await recon.run(Y, Q4);
  const mx = one(unitsOf(rx.res, rx.d, sc.C.M.tan)), my = one(unitsOf(ry.res, ry.d, sc.C.MY.tan));
  assert.equal(sc.C.M.tan, sc.C.MY.tan, 'same deductor TAN in both statements');
  assert.deepEqual([mx.status, mx.z_amount, mx.deposited], ['matched', 333300, 333300]);
  assert.deepEqual([my.status, my.z_amount, my.deposited], ['matched', 777700, 777700]);
  const xKeys = new Set([...rx.d.items.map(i => i.key), ...rx.d.credits.map(c => c.key)]);
  assert.ok(ry.res.units.every(u => [...u.zoho, ...u.credits].every(k => !xKeys.has(k))), 'nothing of entity X appears in entity Y');
  assert.equal(ry.d.credits.length, 2);
  assert.ok(ry.d.statements.every(s => s.id && !rx.d.statements.some(t => t.id === s.id)));
});

test('client-wise follow-up report ties to the open transactions and to both source totals', async () => {
  const { d, res } = await recon.run(X, Q4);
  const dash = RP.dashboard(d, res, Q4);
  const fu = RP.followUp(d, res, Q4);
  assert.equal(fu.totals.zoho, dash.totals.zoho, 'Σ client rows = Zoho TDS receivable');
  assert.equal(fu.totals.deposited, dash.totals.deposited, 'Σ client rows = 26AS deposited');
  assert.equal(fu.totals.deducted, dash.totals.deducted);
  assert.equal(dash.totals.zoho, dash.totals.ledger_control, 'Zoho total = the ledger postings themselves');
  assert.equal(dash.totals.zoho, 4863300);
  assert.equal(dash.totals.deposited, 3452899);
  assert.equal(dash.totals.deducted, 4052899);
  assert.equal(dash.bridge.difference, 0, 'the bridge ties');
  const row = id => fu.rows.find(r => r.id === id);
  assert.equal(row(d.clients.byTan.get(sc.C.G.tan)).missing, 150000);
  assert.equal(row(d.clients.byTan.get(sc.C.I.tan)).ded_gt_dep, 600000);
  assert.equal(row(d.clients.byTan.get(sc.C.F.tan)).subsequent, 400000);
  assert.equal(row(d.clients.byTan.get(sc.C.F.tan)).follow_up, 0, 'a subsequent-period credit is shown, not chased');
  // follow-up = sum of the open units behind it
  for (const r of fu.rows) {
    const open = res.units.filter(u => r.open_units.includes(u.id));
    const expect = open.reduce((a, u) => a + (u.effective === 'not_in_26as' ? u.open_zoho : u.effective === 'not_matched' ? (u.reason.code === 'deducted_exceeds_deposited' ? u.open_zoho : Math.max(0, u.diff)) : 0), 0);
    assert.equal(r.follow_up, expect, `follow-up of ${r.client}`);
  }
  // an excess credit does not hide a shortfall of the same client
  const theta = row(d.clients.byTan.get(sc.C.H.tan));
  assert.equal(theta.excess_credit, 90000);
  assert.equal(theta.follow_up, 0);
  assert.ok(fu.rows.some(r => r.kind === 'unallocated') && fu.rows.some(r => r.kind === 'unmapped_tan') && fu.rows.some(r => r.kind === 'unmapped_customer'));
});

test('unallocated journal shown separately; transfer between own TDS ledgers not counted; partial payment compared with its share', async () => {
  const { d, res } = await recon.run(X, Q4);
  const ua = res.units.filter(u => u.reason && u.reason.code === 'unallocated');
  assert.equal(one(ua).z_amount, 100000);
  assert.equal(d.books.transfers.length, 1);
  assert.equal(d.books.transfers[0].legs.reduce((a, l) => a + l.amount, 0), 0);
  const n = one(unitsOf(res, d, sc.C.N.tan));
  assert.equal(n.status, 'matched');
  const z = d.items.find(i => i.key === n.zoho[0]);
  assert.equal(z.type, 'customer_payment');
  assert.equal(z.base.comparable, 5000000, 'half the invoice basic value (the payment settles ₹59,000 of ₹1,18,000)');
  const cmp = RP.comparison(n, RP.maps(d));
  assert.equal(cmp.calc.base_diff, 0);
  assert.equal(cmp.calc.rate_zoho, 2);
  assert.ok(cmp.checks.some(t => /Partial payment/.test(t)));
});

test('client mapping: a customer whose invoice records no TAN stays unmapped; a name suggestion, once approved, matches it', async () => {
  let { d, res } = await recon.run(X, Q4);
  const k = res.units.filter(u => u.reason && ['customer_unmapped', 'deductor_unmapped'].includes(u.reason.code));
  assert.equal(k.length, 2);
  const s = CL.suggestions(d.clientsDoc, d.items, d.credits).suggestions.filter(x => x.tan === sc.C.K.tan);
  assert.ok(s.some(x => x.basis === 'name' && x.customer_id === sc.C.K.cust));
  await CL.approve('demo-x', 'tester', [s.find(x => x.basis === 'name' && x.customer_id === sc.C.K.cust)]);
  recon.bump();
  ({ d, res } = await recon.run(X, Q4));
  assert.equal(one(unitsOf(res, d, sc.C.K.tan)).status, 'matched');
  await fresh();
});

test('carry forward: approved in March, settled once by the April credit; the March history stays', async () => {
  let { d, res } = await recon.run(X, Q4);
  const u = one(unitsOf(res, d, sc.C.F.tan));
  await assert.rejects(RV.decide('demo-x', 'reviewer', u, { final_status: 'carry_forward', carry_forward: { target: '2025-26-Q4', reason: 'x' } }, Q4), /after/);
  await assert.rejects(RV.decide('demo-x', 'reviewer', u, { final_status: 'carry_forward', carry_forward: { target: '2026-27-Q1' } }, Q4), /reason/);
  const out = await RV.decide('demo-x', 'reviewer', u, { final_status: 'carry_forward', remarks: 'Client deducted in April', carry_forward: { target: '2026-27-Q1', reason: 'Credit expected in Q1 FY 2026-27' } }, Q4);
  assert.equal(out.carry_forward.balance, 400000);
  recon.bump();
  const settled = await recon.settlePass(X);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].settlement.quarter, '2026-27-Q1');
  assert.equal((await recon.settlePass(X)).length, 0, 'settled once only');
  // Q1: the April credit now settles the carried balance
  const q1 = await recon.run(X, Q1);
  const cfu = one(q1.res.units.filter(x => x.method === 'cf_settlement'));
  assert.equal(cfu.status, 'matched');
  assert.equal(RP.dashboard(q1.d, q1.res, Q1).bridge.difference, 0);
  // Q4: the March item keeps its final status Carry Forward and shows the settlement
  ({ d, res } = await recon.run(X, Q4));
  const again = one(unitsOf(res, d, sc.C.F.tan));
  assert.equal(again.final_status, 'carry_forward');
  assert.equal(again.status, 'need_check', 'the system status is kept alongside the final status');
  assert.equal(again.cf_item.status, 'settled');
  assert.equal(d.review.items[again.zoho[0]].history.length, 1);
  // movement report
  const cf = RP.carryForward(d, '2026-01-01', '2026-06-30');
  const q4 = cf.rows.find(r => r.id === '2025-26-Q4'), q1r = cf.rows.find(r => r.id === '2026-27-Q1');
  assert.deepEqual([q4.opening, q4.additions, q4.settled, q4.closing], [0, 400000, 0, 400000]);
  assert.deepEqual([q1r.opening, q1r.additions, q1r.settled, q1r.closing], [400000, 0, 400000, 0]);
  assert.equal(q4.closing, q4.closing_check);
  await fresh();
});

test('carry forward: two items of different clients are both settled by credits of the same later quarter', async () => {
  const text = DEMO.tracesText({ pan: X.pan, name: X.name, fy: '2026-27', ay: '2027-28', created: '25-08-2026', deductors: [
    { sr: 1, cl: sc.C.F, rows: [{ section: '194J(b)', date: '03-Apr-2026', status: 'F', booked: '20-Jul-2026', paid: 40000, deducted: 4000, deposited: 4000 }] },
    { sr: 2, cl: sc.C.G, rows: [{ section: '194C', date: '10-Apr-2026', status: 'F', booked: '20-Jul-2026', paid: 75000, deducted: 1500, deposited: 1500 }] }] });
  const pv = await ST.preview({ buffer: Buffer.from(text), fileName: 'fy2627_v2.txt', entity: X, by: 't' });
  await ST.commit({ previewId: pv.preview_id, entity: X, by: 't', ack: true });
  recon.bump();
  const { d, res } = await recon.run(X, Q4);
  for (const tan of [sc.C.F.tan, sc.C.G.tan]) {
    const u = one(unitsOf(res, d, tan));
    await RV.decide('demo-x', 'reviewer', u, { final_status: 'carry_forward', carry_forward: { target: '2026-27-Q1', reason: 'credit expected in April' } }, Q4);
  }
  recon.bump();
  const settled = await recon.settlePass(X);
  assert.equal(settled.length, 2, 'both items settle in Q1');
  assert.deepEqual(settled.map(x => x.settlement.quarter), ['2026-27-Q1', '2026-27-Q1']);
  await fresh();
});

test('review: confirmed non-deposit needs evidence; final status, remarks and history are kept', async () => {
  const { d, res } = await recon.run(X, Q4);
  const i = one(unitsOf(res, d, sc.C.I.tan));
  await assert.rejects(RV.decide('demo-x', 'reviewer', i, { final_status: 'not_matched', non_deposit: { evidence: 'Client confirmed' } }, Q4), /evidence/);
  await RV.decide('demo-x', 'reviewer', i, { final_status: 'not_matched', remarks: 'Client will deposit', refs: ['Email from client 02-Jun-2026'], non_deposit: { evidence: 'Client confirmed by email that the TDS was not deposited' } }, Q4);
  await RV.decide('demo-x', 'reviewer2', i, { final_status: 'not_matched', remarks: 'Followed up again', refs: ['Email from client 02-Jun-2026'] }, Q4);
  recon.bump();
  const r2 = await recon.run(X, Q4);
  const u = one(unitsOf(r2.res, r2.d, sc.C.I.tan));
  const dec = r2.d.review.items[u.credits[0]];
  assert.equal(dec.history.length, 2);
  assert.equal(dec.system_status, 'not_matched');
  assert.equal(dec.by, 'reviewer2');
  assert.ok(dec.non_deposit, 'the earlier confirmation stays when a later save does not touch it');
  const fu = RP.followUp(r2.d, r2.res, Q4);
  const row = fu.rows.find(r => r.id === r2.d.clients.byTan.get(sc.C.I.tan));
  assert.equal(row.non_deposit, 600000);
  assert.equal(row.ded_gt_dep, 0, 'moved into confirmed non-deposit, not counted twice');
  await fresh();
});
