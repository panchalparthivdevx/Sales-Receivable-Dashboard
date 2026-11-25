/**
 * Period-end timing differences (25 Nov 2026). A client's TDS is in the 26AS on 30 Sep (the client booked the invoice) while Zoho books it
 * on the payment of 7 Oct: viewed for Apr–Sep it is "Need to Check — timing", for Apr–Oct it matches. SYNTHETIC data only (PAN ZZZ…,
 * TANs AHM…000…). Cases:
 *   A  26AS credit 30 Sep, Zoho booking 7 Oct (one clear match in Q3)
 *   M  26AS credit 28 Sep, two Zoho bookings of the same amount in Q3 (3 Oct, 10 Nov) — listed for a check, not ticked
 *   B  Zoho booking 25 Jun, 26AS credit 5 Jul (the Zoho side waits for a credit in Q2)
 *   Q  26AS credit 10 Sep, Zoho booking 20 Sep — viewed up to 15 Sep the other side is in the same quarter: only counted
 * Carried forward, an item closes by itself in the later quarter, and a period covering both dates shows ONE matched row (cf_inside).
 */

'use strict';

process.env.VERCEL = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const H = require('./helpers');
const DEMO = require('../lib/demo');
const ST = require('../lib/statements');
const BS = require('../lib/booksSync');
const RC = require('../lib/recon');
const RV = require('../lib/review');
const RP = require('../lib/reports');
const PER = require('../lib/periods');
const store = require('../lib/store');

const PAN = 'ZZZPT7777T';
const TAN = { A: 'AHMA00051A', M: 'AHMM00053M', B: 'AHMB00052B', Q: 'AHMQ00054Q' };
const E = { id: 'syn-tm', name: 'Synthetic Timing Limited', pan: PAN, org_id: '', active: true, tan_field: 'cf_organization_tan_number', ledgers: [{ account_id: 'syn194J', name: '194J', section: '194J', parent: 'TDS Receivable' }] };
const CUST = { A: ['cA', 'ALPHA SYNTHETIC MARITIME CO.'], M: ['cM', 'MU SYNTHETIC SERVICES LLP'], B: ['cB', 'BETA SYNTHETIC LIMITED'], Q: ['cQ', 'QUINTA SYNTHETIC LIMITED'] };
const P_ = v => Math.round(v * 100);
// Zoho TDS postings: id, client, posting date, invoice date, basic (₹), TDS (₹)
const Z = [['iA', 'A', '2026-10-07', '2026-09-30', 2301408, 46028], ['iM1', 'M', '2026-10-03', '2026-10-03', 50000, 5000], ['iM2', 'M', '2026-11-10', '2026-11-10', 50000, 5000],
  ['iB', 'B', '2026-06-25', '2026-06-25', 70000, 7000], ['iQ', 'Q', '2026-09-20', '2026-09-20', 30000, 3000]];
const view = (from, to) => PER.resolve({ from, to });
const V = { aprSep: view('2026-04-01', '2026-09-30'), aprOct: view('2026-04-01', '2026-10-31'), aprJul: view('2026-04-01', '2026-07-31'), toMidSep: view('2026-04-01', '2026-09-15'),
  q1: PER.resolve({ fy: '2026-27', q: 1 }), q2: PER.resolve({ fy: '2026-27', q: 2 }), q3: PER.resolve({ fy: '2026-27', q: 3 }), fy: PER.resolve({ fy: '2026-27' }) };

async function setup() {
  H.tempStore();
  await H.saveConfig({ entities: [E] });
  const rows = {}, docs = { invoices: {}, payments: {}, paylist: {}, journals: {}, invno: {} };
  Z.forEach(([id, c, date, invDate, basic, tds], k) => {
    const no = `SY/26-27/${id}`;
    rows[`z${k}`] = { id: `z${k}`, acc: 'syn194J', type: 'invoice', type_label: 'Invoice', tid: id, date, cust: CUST[c][0], payee: CUST[c][1], desc: '', no, ref: '', dr: P_(tds), cr: 0, off: '' };
    docs.invoices[id] = { id, no, date: invDate, cust: CUST[c][0], cust_name: CUST[c][1], status: 'paid', sub_total: P_(basic), tax_total: 0, total: P_(basic - tds), tds: P_(tds), tds_percent: Math.round((tds / basic) * 100), tds_section: '', tds_names: ['194J'], tan: TAN[c], lmt: '', branch: '', at: '' };
    docs.invno[no] = { id, cust: CUST[c][0], date: invDate };
  });
  await store.write('ledger_syn-tm_2026_27', { rows, months: {} });
  await store.write('docs_syn-tm', docs);
  await store.write('clients_syn-tm', { groups: [], no_customer: {}, rejected: {} });
  const listed = {}; ['04', '05', '06', '07', '08', '09', '10', '11', '12'].forEach(m => { listed[`2026-${m}`] = 'x'; });
  await store.write('sync_syn-tm', { last_ok_at: '2026-11-23T06:00:00.000Z', listed });
  const tx = (date, paid, ded) => ({ section: '194J(b)', date, status: 'F', booked: '15-Nov-2026', paid, deducted: ded, deposited: ded });
  const deductors = [
    { sr: 1, cl: { name: CUST.A[1], tan: TAN.A }, rows: [tx('30-Sep-2026', 2301408, 46028)] },
    { sr: 2, cl: { name: CUST.M[1], tan: TAN.M }, rows: [tx('28-Sep-2026', 50000, 5000)] },
    { sr: 3, cl: { name: CUST.B[1], tan: TAN.B }, rows: [tx('05-Jul-2026', 70000, 7000)] },
    { sr: 4, cl: { name: CUST.Q[1], tan: TAN.Q }, rows: [tx('10-Sep-2026', 30000, 3000)] },
  ];
  const text = DEMO.tracesText({ pan: PAN, name: E.name, fy: '2026-27', ay: '2027-28', created: '20-11-2026', deductors });
  const settings = (await H.cfgNow()).settings;
  const pv = await ST.preview({ buffer: Buffer.from(text, 'latin1'), fileName: 'syn_tm_2026-27.txt', entity: E, by: 'tester', settings });
  assert.deepEqual(pv.validation.blockers, []);
  await ST.commit({ previewId: pv.preview_id, entity: E, by: 'tester', ack: pv.validation.needs_ack.map(x => x.id || x.code || x), settings });
}
const newRecon = () => RC.create({ sync: BS.create({ zr: { get: async () => { throw new Error('no Zoho in tests'); }, isGone: () => false, errText: e => e.message }, cfgNow: H.cfgNow }), cfgNow: H.cfgNow });
const ofClient = (res, c) => res.units.filter(u => u.group === `tan:${TAN[c]}`);
const brief = (d, u) => `${u.effective}/${u.method} Z[${u.zoho.map(k => d.items.find(i => i.key === k).date)}] C[${u.credits.map(k => d.credits.find(x => x.key === k).txn_date)}]`;

test('timing differences at a period end: listed with the quarter their other side is in — clear ones ticked, the rest for a check', async () => {
  await setup();
  const recon = newRecon();
  const s = await recon.run(E, V.aprSep);
  assert.equal(ofClient(s.res, 'A')[0].reason.code, 'timing');
  assert.equal(ofClient((await recon.run(E, V.aprOct)).res, 'A')[0].effective, 'matched', 'with October in view the two match');

  const tc = RP.timingCandidates(s.d, s.res, V.aprSep);
  const a = tc.rows.find(x => x.client === CUST.A[1]), m = tc.rows.find(x => x.client === CUST.M[1]);
  assert.deepEqual([a.side, a.amount, a.origin, a.target, a.match.date, a.clear], ['26as', P_(46028), '2026-27-Q2', '2026-27-Q3', '2026-10-07', true]);
  assert.deepEqual([m.matches, m.clear], [2, false]);
  assert.match(m.note, /2 possible matches/);
  assert.equal(tc.rows.length, 2, 'B and Q match inside Apr–Sep');

  const q1 = await recon.run(E, V.q1);
  const b = RP.timingCandidates(q1.d, q1.res, V.q1).rows;
  assert.deepEqual(b.map(x => [x.client, x.side, x.target, x.match.date, x.clear]), [[CUST.B[1], 'zoho', '2026-27-Q2', '2026-07-05', true]]);

  const mid = await recon.run(E, V.toMidSep);
  const tm = RP.timingCandidates(mid.d, mid.res, V.toMidSep);
  assert.deepEqual([tm.rows.length, tm.same_quarter], [0, 1], 'Q\'s other side (20 Sep) is in the same quarter: only counted');
});

test('carried forward together: each closes by itself in the later quarter, and a period covering both dates shows one matched row', async () => {
  await setup();
  const recon = newRecon();
  const s = await recon.run(E, V.aprSep);
  const tc = RP.timingCandidates(s.d, s.res, V.aprSep);
  const picks = tc.rows.map(x => ({ unit: s.res.units.find(u => u.id === x.unit), target: x.target }));
  await assert.rejects(RV.carryForwardMany(E.id, 'reviewer', picks, { reason: ' ' }, V.aprSep), /reason/);
  await assert.rejects(RV.carryForwardMany(E.id, 'reviewer', picks.map(p => ({ ...p, target: '2026-27-Q2' })), { reason: 'x' }, V.aprSep), /after/);
  const out = await RV.carryForwardMany(E.id, 'reviewer', picks, { reason: 'Timing difference at the period end' }, V.aprSep);
  assert.equal(out.saved, 2);
  recon.bump();
  const settled = await recon.settlePass(E);
  assert.deepEqual(settled.map(x => x.client), [CUST.A[1]], 'A settles on the 7 Oct booking; M (two equal bookings in Q3) stays open for the reviewer');

  // Apr–Sep: both are Carry Forward — A settled, M open
  const s2 = await recon.run(E, V.aprSep);
  const [ua] = ofClient(s2.res, 'A'), [um] = ofClient(s2.res, 'M');
  assert.deepEqual([ua.effective, ua.cf_item.status, um.effective, um.cf_item.status], ['carry_forward', 'settled', 'carry_forward', 'open']);
  assert.ok(RP.timingCandidates(s2.d, s2.res, V.aprSep).rows.length === 0, 'carried items leave the list');
  // Q3: the 7 Oct booking is the carry-forward settlement
  const q3 = await recon.run(E, V.q3);
  assert.deepEqual(ofClient(q3.res, 'A').map(u => brief(q3.d, u)), ['matched/cf_settlement Z[2026-10-07] C[]']);
  // Apr–Oct and the whole year: one matched row, not "settlement" + "carry forward"
  for (const p of [V.aprOct, V.fy]) {
    const r = await recon.run(E, p);
    const ua2 = ofClient(r.res, 'A');
    assert.deepEqual(ua2.map(u => brief(r.d, u)), ['matched/cf_inside Z[2026-10-07] C[2026-09-30]'], p.label);
    assert.equal(ua2[0].final_status, '', 'the Carry Forward decision is fulfilled inside the view, so the pair shows its own status');
    assert.equal(ua2[0].cf_item.status, 'settled');
    assert.match(ua2[0].reason.text, /Carried forward from Q2 FY 2026-27 and settled by Zoho invoice SY\/26-27\/iA of 2026-10-07/);
    const dash = RP.dashboard(r.d, r.res, p);
    assert.equal(dash.bridge.difference, 0, p.label);
    assert.equal(RP.followUp(r.d, r.res, p).totals.zoho, dash.totals.zoho, 'the follow-up report still adds up to the Zoho total');
    assert.equal(RP.clientTotals(r.d, r.res, p).rows.find(x => x.id === `tan:${TAN.A}`).diff, 0);
  }

  // the Zoho side: B's 25 Jun booking waits for the 5 Jul credit
  const q1 = await recon.run(E, V.q1);
  const bRow = RP.timingCandidates(q1.d, q1.res, V.q1).rows[0];
  await RV.carryForwardMany(E.id, 'reviewer', [{ unit: q1.res.units.find(u => u.id === bRow.unit), target: bRow.target }], { reason: 'credit in July' }, V.q1);
  recon.bump();
  assert.deepEqual((await recon.settlePass(E)).map(x => x.client), [CUST.B[1]]);
  const jul = await recon.run(E, V.aprJul);
  assert.deepEqual(ofClient(jul.res, 'B').map(u => brief(jul.d, u)), ['matched/cf_inside Z[2026-06-25] C[2026-07-05]']);
  const q1b = await recon.run(E, V.q1);
  assert.deepEqual(ofClient(q1b.res, 'B').map(u => [u.effective, u.cf_item.status]), [['carry_forward', 'settled']]);
});

test('over HTTP: the list, rights, a stale page, the bulk carry forward with its audit entry, and the drawer of the combined row', async () => {
  await setup();
  const USERS = [
    { id: '1', username: 'admin', name: 'Admin', role: 'admin', active: true, permissions: {} },
    { id: '2', username: 'viewer', name: 'Viewer', role: 'user', active: true, permissions: { tds26as: { enabled: true, sections: {} } } },
    { id: '3', username: 'rev', name: 'Reviewer', role: 'user', active: true, permissions: { tds26as: { enabled: true, sections: { t26_review: true } } } },
  ];
  const router = require('../index');
  router.init({ loadUsers: async () => USERS, zr: { get: async () => { throw new Error('no Zoho'); }, identity: () => 'test', errText: e => e.message, isGone: () => false, listOrganizations: async () => [] } });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || '1' }; next(); });
  app.use('/api/tds26as', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/tds26as`;
  const call = async (path, { user = '1', method = 'GET', body } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'x-user': user, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try {
    const P = { entity: 'syn-tm', from: '2026-04-01', to: '2026-09-30' };
    const qs = 'entity=syn-tm&from=2026-04-01&to=2026-09-30';
    const list = await call(`/review/timing?${qs}`, { user: '2' });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const a = list.body.rows.find(x => x.client === CUST.A[1]);
    assert.ok(a && a.clear);
    assert.equal((await call('/review/carry-forward-bulk', { user: '2', method: 'POST', body: { ...P, units: [a.unit], reason: 'x' } })).status, 403, 'a viewer cannot carry forward');
    assert.equal((await call('/review/carry-forward-bulk', { user: '3', method: 'POST', body: { ...P, units: [a.unit, 'u0000000000000000'], reason: 'x' } })).status, 409, 'an item the page showed is gone');
    const matched = (await call(`/recon/units?${qs}&status=matched`)).body.units[0];
    assert.ok(matched);
    assert.equal((await call('/review/carry-forward-bulk', { user: '3', method: 'POST', body: { ...P, units: [matched.id], reason: 'x' } })).status, 409, 'an item that is no timing difference (here: matched) is refused');
    const noReason = await call('/review/carry-forward-bulk', { user: '3', method: 'POST', body: { ...P, units: [a.unit], reason: '' } });
    assert.equal(noReason.status, 400);
    const ok = await call('/review/carry-forward-bulk', { user: '3', method: 'POST', body: { ...P, units: [a.unit], reason: 'Booked in Zoho on the payment of 7 Oct' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body, { saved: 1, settled: 1 }, 'the 7 Oct booking already exists, so the item closes at once');
    const audit = (await call('/audit')).body.entries.find(e => e.action === 'review.carry_forward_bulk');
    assert.ok(audit && audit.detail.includes(CUST.A[1]) && audit.detail.includes('Q3 FY 2026-27'), audit && audit.detail);
    const cf = (await call('/reports/carryforward?entity=syn-tm&fy=2026-27')).body.items.find(x => x.client === CUST.A[1]);
    assert.deepEqual([cf.status, cf.reason, cf.by], ['settled', 'Booked in Zoho on the payment of 7 Oct', 'Reviewer']);
    const units = (await call('/recon/units?entity=syn-tm&from=2026-04-01&to=2026-10-31&method=cf_inside')).body.units;
    assert.deepEqual(units.map(u => [u.client, u.effective, u.method_label]), [[CUST.A[1], 'matched', 'Carried forward, settled in period']]);
    const drawer = (await call(`/recon/unit?entity=syn-tm&from=2026-04-01&to=2026-10-31&id=${units[0].id}`)).body;
    assert.equal(drawer.unit.cf_item.status, 'settled');
    assert.ok(drawer.history.some(h => h.history.some(x => x.bulk_cf && x.final_status === 'carry_forward')));
    const meta = (await call('/meta')).body;
    assert.equal(meta.methods.cf_inside, 'Carried forward, settled in period', 'the Transactions method filter offers it');
  } finally { server.close(); }
});
