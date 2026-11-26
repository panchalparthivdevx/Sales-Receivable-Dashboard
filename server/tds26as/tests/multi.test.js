/**
 * One 26AS amount for several Zoho entries, and equal amounts in unequal numbers (26 Nov 2026). A client billed a monthly fee of
 * ₹6,620 TDS (invoices 3 Apr, 1 May, 1 Jun, 1 Jul, 1 Aug, 1 Sep 2026). SYNTHETIC data only (PAN ZZZ…, TANs AHM…000…). Cases:
 *   H1  four ₹6,620 credits (1 Jun, 15 Jun, 30 Jun, 31 Jul): before, the three not on an invoice date went to review as "ambiguous" and a
 *       reviewer's one-click link joined ONE invoice with all three (Not Matched −₹13,240, four "Not in 26AS") — now each credit takes the
 *       oldest open invoice dated up to 3 days after it
 *   H2  1 Jun ₹6,620 + 31 Jul ₹19,860 (one credit for three invoices): before, five "Not in 26AS" and one "Not in Zoho Books" — now the
 *       ₹19,860 credit matches the three oldest open invoices up to its date
 *   NM  30 Jun ₹13,240 + 31 Jul ₹19,860: earlier credits take earlier invoices
 *   MX  one combination of different amounts with a repeated one; two possible combinations → nothing is chosen
 *   RV  one entry for several equal credits, and fewer entries than equal credits
 */

'use strict';

process.env.VERCEL = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const DEMO = require('../lib/demo');
const ST = require('../lib/statements');
const BS = require('../lib/booksSync');
const RC = require('../lib/recon');
const RV = require('../lib/review');
const RP = require('../lib/reports');
const M = require('../lib/match');
const PER = require('../lib/periods');
const store = require('../lib/store');

const PAN = 'ZZZPM4444M', TAN = 'AHMT00101T', NAME = 'TAU RESEARCH LLP';
const E = { id: 'syn-mu', name: 'Synthetic Multi Limited', pan: PAN, org_id: '', active: true, tan_field: 'cf_organization_tan_number', ledgers: [{ account_id: 'syn194J', name: '194J', section: '194J', parent: 'TDS Receivable' }] };
const P_ = v => Math.round(v * 100);
const MONTHLY = [['2026-04-03', 6620], ['2026-05-01', 6620], ['2026-06-01', 6620], ['2026-07-01', 6620], ['2026-08-01', 6620], ['2026-09-01', 6620]];
const APR_SEP = PER.resolve({ from: '2026-04-01', to: '2026-09-30' });

/** invoices: [[date, TDS ₹]], credits: [['dd-Mon-yyyy', TDS ₹]] */
async function setup(invoices, credits, { reverse = false } = {}) {
  H.tempStore();
  await H.saveConfig({ entities: [E] });
  const rows = {}, docs = { invoices: {}, payments: {}, paylist: {}, journals: {}, invno: {} };
  invoices.forEach(([date, tds], k) => {
    const id = `i${k}`, no = `IN/26-27/GJ/${String(k).padStart(4, '0')}`;
    rows[`z${k}`] = { id: `z${k}`, acc: 'syn194J', type: 'invoice', type_label: 'Invoice', tid: id, date, cust: 'cT', payee: NAME, desc: '', no, ref: '', dr: P_(tds), cr: 0, off: '' };
    docs.invoices[id] = { id, no, date, cust: 'cT', cust_name: NAME, status: 'paid', sub_total: P_(tds * 10), tax_total: 0, total: 0, tds: P_(tds), tds_percent: 10, tds_section: '', tds_names: ['194J'], tan: TAN, lmt: '', branch: '', at: '' };
    docs.invno[no] = { id, cust: 'cT', date };
  });
  await store.write('ledger_syn-mu_2026_27', { rows, months: {} });
  await store.write('docs_syn-mu', docs);
  await store.write('clients_syn-mu', { groups: [], no_customer: {}, rejected: {} });
  const listed = {}; ['04', '05', '06', '07', '08', '09', '10', '11'].forEach(m => { listed[`2026-${m}`] = 'x'; });
  await store.write('sync_syn-mu', { last_ok_at: '2026-11-23T06:00:00.000Z', listed });
  const txs = credits.map(([date, tds]) => ({ section: '194J(b)', date, status: 'F', booked: '15-Nov-2026', paid: tds * 10, deducted: tds, deposited: tds }));
  const deductors = [{ sr: 1, cl: { name: NAME, tan: TAN }, rows: reverse ? txs.reverse() : txs }];
  const text = DEMO.tracesText({ pan: PAN, name: E.name, fy: '2026-27', ay: '2027-28', created: '20-11-2026', deductors });
  const settings = (await H.cfgNow()).settings;
  const pv = await ST.preview({ buffer: Buffer.from(text, 'latin1'), fileName: 'syn_mu.txt', entity: E, by: 't', settings });
  assert.deepEqual(pv.validation.blockers, []);
  await ST.commit({ previewId: pv.preview_id, entity: E, by: 't', ack: pv.validation.needs_ack.map(x => x.id || x.code || x), settings });
}
const newRecon = () => RC.create({ sync: BS.create({ zr: { get: async () => { throw new Error('no Zoho'); }, isGone: () => false, errText: e => e.message }, cfgNow: H.cfgNow }), cfgNow: H.cfgNow });
// "status method Z[mm-dd,…] C[mm-dd:₹,…]" per unit, sorted
const picture = s => s.res.units.map(u => `${u.effective} ${u.method} Z[${u.zoho.map(k => s.d.items.find(i => i.key === k).date.slice(5)).join(',')}] C[${u.credits.map(k => { const c = s.d.credits.find(x => x.key === k); return `${c.txn_date.slice(5)}:${c.deposited / 100}`; }).join(',')}]`).sort();
const ties = (s, p) => { const dash = RP.dashboard(s.d, s.res, p); assert.equal(dash.bridge.difference, 0); assert.equal(RP.followUp(s.d, s.res, p).totals.zoho, dash.totals.zoho); };

test('H1: equal credits fewer than equal invoices — each credit takes the oldest open invoice up to its date; the newest stay open', async () => {
  await setup(MONTHLY, [['01-Jun-2026', 6620], ['15-Jun-2026', 6620], ['30-Jun-2026', 6620], ['31-Jul-2026', 6620]]);
  const s = await newRecon().run(E, APR_SEP);
  assert.deepEqual(picture(s), [
    'matched transaction Z[04-03] C[06-15:6620]', 'matched transaction Z[05-01] C[06-30:6620]', 'matched transaction Z[06-01] C[06-01:6620]', 'matched transaction Z[07-01] C[07-31:6620]',
    'not_in_26as single Z[08-01] C[]', 'not_in_26as single Z[09-01] C[]']);
  assert.equal(s.res.units.filter(u => u.flags.includes('equal_amounts_date_order')).length, 3, 'the three chosen by date say so');
  assert.equal(s.res.units.find(u => u.credits.length && !u.flags.includes('equal_amounts_date_order')).zoho.length, 1, 'the 1 Jun pair is still the exact-date match');
  assert.equal(RP.clientTotals(s.d, s.res, APR_SEP).rows.find(r => r.id === `tan:${TAN}`).diff, P_(13240));
  ties(s, APR_SEP);
});

test('H1 with the old one-click link (one invoice ↔ three credits): the link wins until it is removed; then the credits pair by date', async () => {
  await setup(MONTHLY, [['01-Jun-2026', 6620], ['15-Jun-2026', 6620], ['30-Jun-2026', 6620], ['31-Jul-2026', 6620]]);
  const recon = newRecon();
  let s = await recon.run(E, APR_SEP);
  const three = s.d.credits.filter(c => c.txn_date !== '2026-06-01').map(c => c.key);
  const l = await RV.link(E.id, 'reviewer', [s.d.items.find(i => i.date === '2026-04-03').key], three, 'chosen among equal candidates');
  recon.bump();
  s = await recon.run(E, APR_SEP);
  const linked = s.res.units.find(u => u.method === 'manual');
  assert.deepEqual([linked.effective, linked.zoho.length, linked.credits.length, linked.diff], ['not_matched', 1, 3, -P_(13240)], 'what the screenshot showed');
  assert.equal(s.res.units.filter(u => u.effective === 'not_in_26as').length, 4);
  await RV.unlink(E.id, 'reviewer', l.id);
  recon.bump();
  s = await recon.run(E, APR_SEP);
  assert.equal(s.res.units.filter(u => u.effective === 'matched').length, 4);
  assert.equal(s.res.units.filter(u => u.effective === 'not_in_26as').length, 2);
});

test('H2: one credit for three equal invoices — matched with the three oldest open ones up to its date, flagged; order of the statement rows does not matter', async () => {
  for (const reverse of [false, true]) {
    await setup(MONTHLY, [['01-Jun-2026', 6620], ['31-Jul-2026', 19860]], { reverse });
    const s = await newRecon().run(E, APR_SEP);
    assert.deepEqual(picture(s), ['matched client_total Z[04-03,05-01,07-01] C[07-31:19860]', 'matched transaction Z[06-01] C[06-01:6620]', 'not_in_26as single Z[08-01] C[]', 'not_in_26as single Z[09-01] C[]'], `reverse=${reverse}`);
    const u = s.res.units.find(x => x.method === 'client_total');
    assert.deepEqual(u.flags.filter(f => f !== 'section_mismatch'), ['one_credit_many_entries', 'equal_amounts_date_order']);
    ties(s, APR_SEP);
  }
});

test('NM: two combined credits — the earlier credit takes the earlier invoices', async () => {
  await setup(MONTHLY, [['30-Jun-2026', 13240], ['31-Jul-2026', 19860]]);
  const s = await newRecon().run(E, APR_SEP);
  assert.deepEqual(picture(s), ['matched client_total Z[04-03,05-01] C[06-30:13240]', 'matched client_total Z[06-01,07-01,08-01] C[07-31:19860]', 'not_in_26as single Z[09-01] C[]']);
  ties(s, APR_SEP);
});

test('MX: one combination of different amounts (one repeated) is matched; two possible combinations are not', async () => {
  await setup([['2026-04-10', 6620], ['2026-05-10', 6620], ['2026-06-10', 6620], ['2026-07-10', 6620], ['2026-05-20', 3000], ['2026-06-20', 5000]], [['31-Jul-2026', 16240]]);
  let s = await newRecon().run(E, APR_SEP);
  assert.ok(picture(s).includes('matched client_total Z[04-10,05-10,05-20] C[07-31:16240]'), picture(s).join(' | '));
  // ₹10,000 = 6,000 + 4,000 = 5,000 + 5,000: which invoices the client paid cannot be told → nothing is chosen
  await setup([['2026-04-10', 6000], ['2026-05-10', 4000], ['2026-06-10', 5000], ['2026-07-10', 5000]], [['31-Jul-2026', 10000]]);
  s = await newRecon().run(E, APR_SEP);
  assert.ok(!s.res.units.some(u => u.method === 'client_total'), picture(s).join(' | '));
  assert.ok(s.res.units.some(u => !u.zoho.length && u.credits.length === 1), 'the credit stays open');
});

test('RV: one invoice for several equal credits takes the earliest from its date; fewer equal invoices than credits — each takes the earliest credit on or after it', async () => {
  await setup([['2026-06-01', 19860]], [['20-May-2026', 6620], ['05-Jun-2026', 6620], ['20-Jun-2026', 6620], ['10-Jul-2026', 6620]]);
  let s = await newRecon().run(E, APR_SEP);
  assert.ok(picture(s).includes('matched client_total Z[06-01] C[06-05:6620,06-20:6620,07-10:6620]'), picture(s).join(' | '));
  assert.ok(s.res.units.find(u => u.method === 'client_total').flags.includes('equal_amounts_date_order'));
  await setup([['2026-05-02', 2977], ['2026-06-02', 2977]], [['10-Apr-2026', 2977], ['14-May-2026', 2977], ['06-Jun-2026', 2977]]);
  s = await newRecon().run(E, APR_SEP);
  assert.deepEqual(picture(s).filter(x => x.startsWith('matched')), ['matched transaction Z[05-02] C[05-14:2977]', 'matched transaction Z[06-02] C[06-06:2977]']);
  ties(s, APR_SEP);
});

test('the building blocks: amount combinations (repeats, size limit, too-large amounts) and date pairing (sections that tell them apart)', () => {
  const pool = [6620, 6620, 6620, 6620, 3000, 50000].map((v, i) => ({ v, i }));
  assert.deepEqual(M.amountCombos(pool, x => x.v, [P_(0) + 19860], 0, 6), [[[6620, 3]]], 'three of four equal amounts: one combination; 50,000 is too large to be in it');
  assert.deepEqual(M.amountCombos(pool, x => x.v, [19860], 0, 2), [], 'needs three items, only two allowed');
  assert.equal(M.amountCombos([6000, 4000, 5000, 5000].map(v => ({ v })), x => x.v, [10000], 0, 6).length, 2);
  assert.deepEqual(M.amountCombos([6620, 6619].map(v => ({ v })), x => x.v, [13240], 2, 6), [[[6620, 1], [6619, 1]]], 'within the tolerance');
  const S = { date_close_days: 3 };
  const z = (date, section, key) => ({ date, section, key, number: key, amount: 100 });
  const c = (txn_date, section, key) => ({ txn_date, section, key, deducted: 100, deposited: 100 });
  const pairs = M.datePairs([z('2026-04-03', '194J', 'a'), z('2026-05-01', '194J', 'b'), z('2026-07-01', '194J', 'c')], [c('2026-07-31', '194J', 'x'), c('2026-06-15', '194J', 'y')], S);
  assert.deepEqual(pairs.map(([zz, cc]) => `${zz.key}${cc.key}`), ['ay', 'bx']);
  assert.equal(M.datePairs([z('2026-04-03', '194C', 'a'), z('2026-05-01', '194J', 'b')], [c('2026-04-05', '194J', 'x')], S), null, 'the oldest is a 194C entry, the credit is 194J and another entry is 194J → left to the reviewer');
  assert.deepEqual(M.datePairs([z('2026-08-02', '194J', 'a')], [c('2026-07-31', '194J', 'x'), c('2026-08-20', '194J', 'y')], S).map(([zz, cc]) => `${zz.key}${cc.key}`), ['ax'], 'a credit up to 3 days before the invoice still counts');
});
