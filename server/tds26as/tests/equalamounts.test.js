/**
 * The same amount several times in one quarter (24 Nov 2026). A client billed a monthly fee: two invoices of ₹2,977 (2 May, 2 Jun) and
 * two 26AS credits of ₹2,977 (14 May, 6 Jun) in Q1. Dates 12 and 19 days apart did not decide between them, so the engine left all
 * four open and, because the client had other open entries (an invoice partly reversed by a credit note), showed them as timing
 * differences against the July / August credits and a July invoice. They are now paired in date order. SYNTHETIC data only
 * (PAN ZZZ…, TANs AHM…000…). Cases:
 *   O  the pattern above, plus the April invoice that matches exactly, the ₹2,918 invoice and the −₹2,782 credit note (net ₹136)
 *   S  two equal invoices booked to a 194C ledger against two 194J credits: every pair differs in section → still paired, flagged
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const DEMO = require('../lib/demo');
const ST = require('../lib/statements');
const BS = require('../lib/booksSync');
const RC = require('../lib/recon');
const M = require('../lib/match');
const RP = require('../lib/reports');
const PER = require('../lib/periods');
const store = require('../lib/store');

const PAN = 'ZZZPE6666E';
const TAN = { O: 'AHMO00041O', S: 'AHMS00042S' };
const E = { id: 'syn-eq', name: 'Synthetic Equal Limited', pan: PAN, org_id: '', active: true, tan_field: 'cf_organization_tan_number',
  ledgers: [{ account_id: 'syn194J', name: '194J', section: '194J', parent: 'TDS Receivable' }, { account_id: 'syn194C', name: '194C', section: '194C', parent: 'TDS Receivable' }] };
const CUST = { O: ['cO', 'ONE SYNTHETIC ASSET MANAGEMENT LIMITED'], S: ['cS', 'SIGMA SYNTHETIC CONTRACTORS LIMITED'] };
const P_ = v => Math.round(v * 100);
// id, customer, ledger, date, basic (₹), TDS (₹) — the June invoice is listed before the May one on purpose (read order ≠ date order)
const INV = [
  ['iA', 'O', 'syn194J', '2026-04-07', 29183.13, 2918], ['iD', 'O', 'syn194J', '2026-04-04', 27820, 2782],
  ['iC', 'O', 'syn194J', '2026-06-02', 29767.38, 2977], ['iB', 'O', 'syn194J', '2026-05-02', 29767.38, 2977], ['iE', 'O', 'syn194J', '2026-07-02', 29767.38, 2977],
  ['iS1', 'S', 'syn194C', '2026-04-15', 250000, 5000], ['iS2', 'S', 'syn194C', '2026-05-15', 250000, 5000],
];

async function setup() {
  H.tempStore();
  await H.saveConfig({ entities: [E] });
  const rows = {};
  INV.forEach(([id, c, acc, date, , tds], k) => { rows[`z${k}`] = { id: `z${k}`, acc, type: 'invoice', type_label: 'Invoice', tid: id, date, cust: CUST[c][0], payee: CUST[c][1], desc: '', no: `SY/26-27/${id}`, ref: '', dr: P_(tds), cr: 0, off: '' }; });
  rows.zcn = { id: 'zcn', acc: 'syn194J', type: 'creditnote', type_label: 'Credit note', tid: 'cn1', date: '2026-04-07', cust: CUST.O[0], payee: CUST.O[1], desc: '', no: 'CN/26-27/0005', ref: '', dr: 0, cr: P_(2782), off: '' };
  await store.write('ledger_syn-eq_2026_27', { rows, months: {} });
  const docs = { invoices: {}, payments: {}, paylist: {}, journals: {}, invno: {} };
  INV.forEach(([id, c, acc, date, basic, tds]) => {
    const no = `SY/26-27/${id}`;
    docs.invoices[id] = { id, no, date, cust: CUST[c][0], cust_name: CUST[c][1], status: 'paid', sub_total: P_(basic), tax_total: P_(basic * 0.18), total: P_(basic * 1.18 - tds), tds: P_(tds), tds_percent: acc === 'syn194C' ? 2 : 10, tds_section: '', tds_names: [acc.slice(3)], tan: TAN[c], lmt: '', branch: '', at: '' };
    docs.invno[no] = { id, cust: CUST[c][0], date };
  });
  await store.write('docs_syn-eq', docs);
  await store.write('clients_syn-eq', { groups: [], no_customer: {}, rejected: {} });
  await store.write('sync_syn-eq', { last_ok_at: '2026-11-23T06:00:00.000Z', listed: { '2026-04': 'x', '2026-05': 'x', '2026-06': 'x', '2026-07': 'x', '2026-08': 'x', '2026-09': 'x' } });
  const tx = (section, date, paid, ded, status = 'F') => ({ section, date, status, booked: '31-Aug-2026', paid, deducted: ded, deposited: ded });
  const deductors = [
    { sr: 1, cl: { name: CUST.O[1], tan: TAN.O }, rows: [tx('194J(b)', '08-Apr-2026', 27820, 2782), tx('194J(b)', '14-May-2026', 29767.38, 2977, 'O'), tx('194J(b)', '06-Jun-2026', 29767.38, 2977),
      tx('194J(b)', '07-Jul-2026', 29767.38, 2977), tx('194J(b)', '04-Aug-2026', 29767.38, 2977)] },
    { sr: 2, cl: { name: CUST.S[1], tan: TAN.S }, rows: [tx('194J(b)', '20-Apr-2026', 50000, 5000), tx('194J(b)', '22-May-2026', 50000, 5000)] },
  ];
  const text = DEMO.tracesText({ pan: PAN, name: E.name, fy: '2026-27', ay: '2027-28', created: '20-11-2026', deductors });
  const settings = (await H.cfgNow()).settings;
  const pv = await ST.preview({ buffer: Buffer.from(text, 'latin1'), fileName: 'syn_eq_2026-27.txt', entity: E, by: 'tester', settings });
  assert.deepEqual(pv.validation.blockers, []);
  await ST.commit({ previewId: pv.preview_id, entity: E, by: 'tester', ack: pv.validation.needs_ack.map(x => x.id || x.code || x), settings });
  return RC.create({ sync: BS.create({ zr: { get: async () => { throw new Error('no Zoho in tests'); }, isGone: () => false, errText: e => e.message }, cfgNow: H.cfgNow }), cfgNow: H.cfgNow });
}

// one line per unit of the client of `tan` (an automatic client: nobody mapped it): status, method, Zoho invoice ids (or credit-note number), 26AS dates
function lines(d, res, tan) {
  const zid = k => { const z = d.items.find(i => i.key === k); return (z.invoices[0] && z.invoices[0].id) || z.number; };
  const cdt = k => d.credits.find(c => c.key === k).txn_date;
  return res.units.filter(u => u.group === `tan:${tan}`)
    .map(u => `${u.status} ${u.method} [${u.zoho.map(zid).sort().join(' ')}] [${u.credits.map(cdt).sort().join(' ')}]`).sort();
}

test('the same amount twice in a quarter, twice in the 26AS: paired in date order, not sent to other quarters', async () => {
  const recon = await setup();
  const { d, res } = await recon.run(E, PER.resolve({ fy: '2026-27', q: 1 }));
  assert.deepEqual(lines(d, res, TAN.O), [
    'matched transaction [iB] [2026-05-14]',
    'matched transaction [iC] [2026-06-06]',
    'matched transaction [iD] [2026-04-08]',
    'need_check single [CN/26-27/0005] []',
    'not_in_26as single [iA] []',
  ]);
  const paired = res.units.filter(u => u.group === `tan:${TAN.O}` && u.flags.includes('equal_amounts_date_order'));
  assert.equal(paired.length, 2, 'only the equal-amount pairs carry the flag (the exact April match does not)');
  assert.ok(!res.units.some(u => u.reason && u.reason.code === 'timing'), 'nothing of this client is a timing difference any more');
  // the client's difference is what is really open: ₹2,918 invoice − ₹2,782 credit note = ₹136
  const o = res.units.filter(u => u.group === `tan:${TAN.O}`);
  assert.equal(o.length, 5);
  assert.equal(o.reduce((a, u) => a + u.diff, 0), P_(136));
  const dash = RP.dashboard(d, res, PER.resolve({ fy: '2026-27', q: 1 }));
  assert.equal(dash.bridge.difference, 0, 'the dashboard still ties to both sources');

  // Q2: one ₹2,977 invoice (2 Jul) and two ₹2,977 credits (7 Jul, 4 Aug) — the invoice takes the earliest credit on or after it
  // (26 Nov 2026; before, this went to review); the 4 Aug credit stays open for steps 3–4
  const q2 = await recon.run(E, PER.resolve({ fy: '2026-27', q: 2 }));
  const u2 = q2.res.units.filter(u => u.group === `tan:${TAN.O}`);
  assert.equal(u2.length, 2);
  const pair = u2.find(u => u.zoho.length);
  assert.deepEqual([pair.effective, pair.flags.includes('equal_amounts_date_order'), q2.d.credits.find(c => c.key === pair.credits[0]).txn_date], ['matched', true, '2026-07-07']);
  const rest = u2.find(u => !u.zoho.length);
  assert.deepEqual([rest.credits.length, q2.d.credits.find(c => c.key === rest.credits[0]).txn_date], [1, '2026-08-04']);
  assert.ok(!u2.some(u => u.reason && u.reason.code === 'ambiguous'));
});

test('pairing in date order does not depend on the order the entries and credits are read in', async () => {
  const recon = await setup();
  const d = await recon.load(E);
  const period = PER.resolve({ fy: '2026-27', q: 1 });
  const run = (items, credits) => M.reconcile({ entity: E, period, items, credits, clients: d.clients, links: [], cfConsumed: new Map(), coverage: { zohoMonths: d.zohoMonths, statements: d.statements }, settings: d.settings });
  const a = run(d.items, d.credits), b = run(d.items.slice().reverse(), d.credits.slice().reverse());
  const pairsOf = res => res.units.filter(u => u.flags.includes('equal_amounts_date_order')).map(u => `${u.zoho.join(',')}|${u.credits.join(',')}`).sort();
  assert.equal(pairsOf(a).length, 4, 'two pairs of O and two of S');
  assert.deepEqual(pairsOf(b), pairsOf(a));
});

test('every entry differs in section from every credit (194C ledger, 194J credits): still paired by date, flagged "section differs"', async () => {
  const recon = await setup();
  const { d, res } = await recon.run(E, PER.resolve({ fy: '2026-27', q: 1 }));
  assert.deepEqual(lines(d, res, TAN.S), ['matched transaction [iS1] [2026-04-20]', 'matched transaction [iS2] [2026-05-22]']);
  const s = res.units.filter(u => u.group === `tan:${TAN.S}`);
  assert.ok(s.every(u => u.flags.includes('equal_amounts_date_order') && u.flags.includes('section_mismatch')), JSON.stringify(s.map(u => u.flags)));
});
