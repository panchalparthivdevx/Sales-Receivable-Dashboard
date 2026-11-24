/**
 * Clients matched on the deductor TAN (23 Nov 2026): Form 26AS lists a client once under its TAN, while the books hold it as several
 * customers (one per branch, names slightly different) that record the same TAN on their invoices. SYNTHETIC data only (PAN ZZZ…,
 * TANs AHM…000…). Cases:
 *   Q  one TAN, three Zoho customers, only one of them in an approved client group (as seen in the real data) + a journal without an
 *      invoice, placed by the TAN the customer records on its other invoices
 *   P  one TAN, two Zoho customers, nobody mapped anything: one 26AS credit = the two invoices together
 *   W  a customer whose second invoice carries a mistyped TAN that no statement has
 *   V  a customer in an approved group whose invoice records another client's TAN
 *   R  a customer whose invoice records Q's TAN, ruled out by a reviewer ("not the same client")
 *   N  a deductor no invoice records; the customer with a similar name records another TAN — approving the suggestion joins both TANs
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
const CL = require('../lib/clients');
const M = require('../lib/match');
const PER = require('../lib/periods');
const store = require('../lib/store');

const PAN = 'ZZZPT5555T';
const E = { id: 'syn-tan', name: 'Synthetic TAN Limited', pan: PAN, org_id: '', active: true, tan_field: 'cf_organization_tan_number',
  ledgers: [{ account_id: 'syn194J', name: '194J', section: '194J', parent: 'TDS Receivable' }] };
const TAN = { Q: 'AHMQ00031Q', P: 'AHMP00032P', W: 'AHMW00033W', Wtypo: 'AHMW00033X', V: 'AHMV00034V', N26: 'AHMN00035N', Nzoho: 'AHMN00036N' };
const cust = {
  Q1: ['cQ1', 'QUASAR GLOBAL SERVICES PRIVATE LIMITED - 14 Floor'], Q2: ['cQ2', 'QUASAR GLOBAL SERVICES PRIVATE LIMITED - Mumbai - 1'], Q3: ['cQ3', 'Quasar Global Services Pvt. Ltd. - Hyderabad'],
  P1: ['cP1', 'PAPERCHASE ACCOUNTANCY INDIA PRIVATE LIMITED - Indore'], P2: ['cP2', 'Paperchase Accountancy India Pvt Ltd - Surat'],
  W: ['cW', 'WIDGET SOLUTIONS LIMITED'], V: ['cV', 'VEGA SYSTEMS LIMITED'], R: ['cR', 'ROGUE TRADERS'], N: ['cN', 'NOVA LABS PVT LTD'],
};
const GQ = 'g000000000000q001', GV = 'g000000000000v001';
const period = PER.resolve({ fy: '2026-27', q: 1 });
const P_ = v => Math.round(v * 100);

// invoices: id, customer, date, basic (₹), TDS (₹), TAN recorded on the invoice
const INV = [
  ['iQ1', 'Q1', '2026-04-02', 336000, 33600, TAN.Q], ['iQ2', 'Q2', '2026-04-02', 190180, 19018, TAN.Q], ['iQ3', 'Q3', '2026-05-10', 487200, 48720, TAN.Q],
  ['iP1', 'P1', '2026-04-03', 150000, 15000, TAN.P], ['iP2', 'P2', '2026-04-20', 50000, 5000, TAN.P],
  ['iW1', 'W', '2026-05-05', 100000, 10000, TAN.W], ['iW2', 'W', '2026-05-25', 30000, 3000, TAN.Wtypo],
  ['iV1', 'V', '2026-04-10', 80000, 8000, TAN.V], ['iV2', 'V', '2026-05-28', 15000, 1500, TAN.W],
  ['iR1', 'R', '2026-06-01', 20000, 2000, TAN.Q], ['iN1', 'N', '2026-06-18', 10000, 1000, TAN.Nzoho],
];

async function setup() {
  H.tempStore();
  await H.saveConfig({ entities: [E] });
  const rows = {};
  INV.forEach(([id, c, date, , tds], k) => { rows[`z${k}`] = { id: `z${k}`, acc: 'syn194J', type: 'invoice', type_label: 'Invoice', tid: id, date, cust: cust[c][0], payee: cust[c][1], desc: '', no: `SY/26-27/${String(k + 1).padStart(4, '0')}`, ref: '', dr: P_(tds), cr: 0, off: '' }; });
  // a journal booking TDS for the Hyderabad customer, with no invoice named in it (so no invoice TAN of its own)
  rows.zj = { id: 'zj', acc: 'syn194J', type: 'journal', type_label: 'Journal', tid: 'jQ3', date: '2026-06-15', cust: cust.Q3[0], payee: cust.Q3[1], desc: 'TDS as per Form 26AS', no: 'JR/26-27/0001', ref: '', dr: P_(5000), cr: 0, off: '' };
  await store.write('ledger_syn-tan_2026_27', { rows, months: {} });
  const docs = { invoices: {}, payments: {}, paylist: {}, journals: {}, invno: {} };
  INV.forEach(([id, c, date, basic, tds, tan], k) => {
    const no = `SY/26-27/${String(k + 1).padStart(4, '0')}`;
    docs.invoices[id] = { id, no, date, cust: cust[c][0], cust_name: cust[c][1], status: 'paid', sub_total: P_(basic), tax_total: P_(basic * 0.18), total: P_(basic * 1.18 - tds), tds: P_(tds), tds_percent: 10, tds_section: '', tds_names: ['194J'], tan, lmt: '', branch: '', at: '' };
    docs.invno[no] = { id, cust: cust[c][0], date };
  });
  docs.journals.jQ3 = { id: 'jQ3', no: 'JR/26-27/0001', date: '2026-06-15', notes: 'TDS as per Form 26AS', ref: '', lines: [{ acc: 'syn194J', acc_name: '194J', cust: cust.Q3[0], cust_name: cust.Q3[1], dc: 'debit', amount: P_(5000) }, { acc: 'synAR', acc_name: 'Receivable', cust: cust.Q3[0], cust_name: cust.Q3[1], dc: 'credit', amount: P_(5000) }], lmt: '', at: '' };
  await store.write('docs_syn-tan', docs);
  const g = (id, c, tan) => ({ id, name: cust[c][1], customers: [{ id: cust[c][0], name: cust[c][1] }], tans: [{ tan, name: '', by: 'test', at: '2026-11-23T00:00:00Z', basis: 'tan_field' }], by: 'test', at: '2026-11-23T00:00:00Z' });
  await store.write('clients_syn-tan', { groups: [g(GQ, 'Q1', TAN.Q), g(GV, 'V', TAN.V)], no_customer: {}, rejected: { [`${cust.R[0]}|${TAN.Q}`]: { by: 'test', at: '2026-11-23T00:00:00Z' } } });
  await store.write('sync_syn-tan', { last_ok_at: '2026-11-23T06:00:00.000Z', listed: { '2026-04': 'x', '2026-05': 'x', '2026-06': 'x' } });

  const tx = (date, paid, ded) => ({ section: '194J(b)', date, status: 'F', booked: '31-Jul-2026', paid, deducted: ded, deposited: ded });
  const deductors = [
    { sr: 1, cl: { name: 'QUASAR GLOBAL SERVICES PRIVATE LIMITED', tan: TAN.Q }, rows: [tx('03-Apr-2026', 336000, 33600), tx('04-Apr-2026', 190180, 19018), tx('12-May-2026', 487200, 48720), tx('15-Jun-2026', 50000, 5000)] },
    { sr: 2, cl: { name: 'PAPER CHASE ACCOUNTANCY INDIA PRIVATE LIMITED', tan: TAN.P }, rows: [tx('30-Apr-2026', 200000, 20000)] },
    { sr: 3, cl: { name: 'WIDGET SOLUTIONS LIMITED', tan: TAN.W }, rows: [tx('06-May-2026', 100000, 10000)] },
    { sr: 4, cl: { name: 'VEGA SYSTEMS LIMITED', tan: TAN.V }, rows: [tx('11-Apr-2026', 80000, 8000)] },
    { sr: 5, cl: { name: 'NOVA LABS PRIVATE LIMITED', tan: TAN.N26 }, rows: [tx('20-Jun-2026', 10000, 1000)] },
  ];
  const text = DEMO.tracesText({ pan: PAN, name: E.name, fy: '2026-27', ay: '2027-28', created: '20-11-2026', deductors });
  const settings = (await H.cfgNow()).settings;
  const pv = await ST.preview({ buffer: Buffer.from(text, 'latin1'), fileName: 'syn_tan_2026-27.txt', entity: E, by: 'tester', settings });
  assert.deepEqual(pv.validation.blockers, []);
  await ST.commit({ previewId: pv.preview_id, entity: E, by: 'tester', ack: pv.validation.needs_ack.map(x => x.id || x.code || x), settings });
  return RC.create({ sync: BS.create({ zr: { get: async () => { throw new Error('no Zoho in tests'); }, isGone: () => false, errText: e => e.message }, cfgNow: H.cfgNow }), cfgNow: H.cfgNow });
}

const byInvoice = (d, res, inv) => { const z = d.items.find(i => i.invoices.some(x => x.id === inv)); return { z, u: res.units.find(u => u.zoho.includes(z.key)) }; };

test('one TAN, several Zoho customers with different names: matched together under the TAN, with or without a mapping', async () => {
  const recon = await setup();
  const { d, res } = await recon.run(E, period);

  // Q: only "14 Floor" is in the approved group; Mumbai and Hyderabad join it through the TAN on their invoices
  const q = res.units.filter(u => u.group === GQ);
  assert.equal(q.length, 4, JSON.stringify(res.units.map(u => [u.client, u.status, u.reason && u.reason.code])));
  assert.ok(q.every(u => u.status === 'matched' && u.method === 'transaction' && u.zoho.length === 1 && u.credits.length === 1), JSON.stringify(q.map(u => [u.status, u.method])));
  assert.deepEqual([...new Set(q.flatMap(u => u.zoho.map(k => d.items.find(i => i.key === k).customer_id)))].sort(), ['cQ1', 'cQ2', 'cQ3']);
  const j = d.items.find(i => i.type === 'journal');
  assert.equal(d.clients.entryInfo.get(j.key).basis, 'customer_tan', 'the journal has no invoice: the TAN the customer records on its invoices places it');
  assert.equal(d.clients.entryInfo.get(byInvoice(d, res, 'iQ2').z.key).basis, 'invoice_tan');

  // P: nobody mapped anything — an automatic client named after the deductor; one credit = both invoices
  const p = res.units.filter(u => u.group === `tan:${TAN.P}`);
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].method, p[0].status, p[0].zoho.length, p[0].credits.length], ['client_total', 'matched', 2, 1]);
  assert.equal(p[0].client, 'PAPER CHASE ACCOUNTANCY INDIA PRIVATE LIMITED');

  // nothing from Q or P is "not mapped" or flagged as "booked under the wrong customer"
  assert.ok(!res.units.some(u => u.reason && ['customer_unmapped', 'deductor_unmapped'].includes(u.reason.code) && u.zoho.some(k => /^c[QP]/.test(d.items.find(i => i.key === k).customer_id))));
  const cr = RP.corrections(d, res, '');
  const wrong = cr.rows.filter(r => r.label === 'Customer may be booked under the wrong Zoho customer');
  assert.deepEqual(wrong.map(r => r.zoho.customer_id), ['cR'], 'only the customer a reviewer ruled out of the TAN it records is flagged');

  // the follow-up report has one row per client and still ties to both sources
  const fu = RP.followUp(d, res, period), dash = RP.dashboard(d, res, period);
  assert.equal(fu.totals.zoho, dash.totals.zoho);
  assert.equal(fu.totals.deposited, dash.totals.deposited);
  assert.equal(fu.rows.filter(r => r.id === GQ).length, 1);
  assert.equal(dash.bridge.difference, 0);
});

test('a mistyped TAN on one invoice, another client\'s TAN on an invoice, and a pair a reviewer ruled out', async () => {
  const recon = await setup();
  const { d, res } = await recon.run(E, period);
  const cr = RP.corrections(d, res, '');

  // W: the right TAN matches; the mistyped one is a client of its own, "Not in 26AS", and the corrections report names the TAN
  assert.equal(byInvoice(d, res, 'iW1').u.status, 'matched');
  const w2 = byInvoice(d, res, 'iW2');
  assert.deepEqual([w2.u.status, w2.u.group, w2.u.reason.code], ['not_in_26as', `tan:${TAN.Wtypo}`, 'tan_not_in_26as']);
  assert.ok(cr.rows.some(r => r.label === 'TAN on the Zoho invoice is in no Form 26AS' && r.detail.includes(TAN.Wtypo) && r.detail.includes(TAN.W)));

  // V: in its own approved group, but this invoice records Widget's TAN — matched under Widget, and reported
  const v2 = byInvoice(d, res, 'iV2');
  assert.equal(v2.u.group, `tan:${TAN.W}`);
  assert.ok(cr.rows.some(r => r.label === 'Invoice TAN belongs to another client than the customer' && r.zoho && r.zoho.number === v2.z.number));
  assert.equal(byInvoice(d, res, 'iV1').u.status, 'matched');

  // R: records Quasar's TAN, but a reviewer said it is not that client — not matched, and it takes nothing from Quasar
  const r1 = byInvoice(d, res, 'iR1');
  assert.deepEqual([r1.u.status, r1.u.reason.code, r1.u.group], ['need_check', 'customer_unmapped', null]);
  assert.match(r1.u.reason.text, /ruled out/);
  const s = CL.suggestions(d.clientsDoc, d.items, d.credits, d.clients);
  assert.ok(s.unmapped_customers.some(c => c.id === 'cR' && /ruled out/.test(c.why)));
  assert.ok(!s.unmapped_customers.some(c => /^c[QPWV]/.test(c.id)), 'customers placed by the TAN are not listed as unmapped');
});

test('approving a name suggestion for a TAN no invoice records joins it with the TAN the customer is already matched on', async () => {
  const recon = await setup();
  let { d, res } = await recon.run(E, period);
  assert.equal(byInvoice(d, res, 'iN1').u.status, 'not_in_26as', 'before: the customer\'s own TAN is in no statement');
  assert.ok(res.units.some(u => u.reason && u.reason.code === 'deductor_unmapped' && u.tans.includes(TAN.N26)));
  const s = CL.suggestions(d.clientsDoc, d.items, d.credits, d.clients).suggestions.find(x => x.tan === TAN.N26 && x.customer_id === 'cN');
  assert.ok(s, 'a similar-name suggestion');
  assert.deepEqual(s.customer_tans, [TAN.Nzoho]);
  await CL.approve(E.id, 'tester', [s]);
  recon.bump();
  ({ d, res } = await recon.run(E, period));
  const g = (await CL.load(E.id)).groups.find(x => x.customers.some(c => c.id === 'cN'));
  assert.deepEqual(g.tans.map(t => t.tan).sort(), [TAN.N26, TAN.Nzoho].sort());
  const n = byInvoice(d, res, 'iN1').u;
  assert.deepEqual([n.status, n.group, n.credits.length], ['matched', g.id, 1]);
});

test('the TAN rule does not depend on the order of the entries; "no Zoho customer" and rejections are respected', async () => {
  const recon = await setup();
  const { d } = await recon.run(E, period);
  const ix1 = CL.index(d.clientsDoc, { items: d.items, credits: d.credits, invoices: d.docs.invoices });
  const ix2 = CL.index(d.clientsDoc, { items: d.items.slice().reverse(), credits: d.credits.slice().reverse(), invoices: Object.fromEntries(Object.entries(d.docs.invoices).reverse()) });
  assert.deepEqual([...ix1.byEntry.entries()].sort(), [...ix2.byEntry.entries()].sort());
  // a TAN no statement has, recorded by a customer without a group and by a customer in a group: the grouped customer stays in its
  // group whichever entry comes first (the automatic client made for the first must not pull in the second)
  const odd = 'AHMX00040X';
  const za = { key: 'ka', customer_id: 'cX', customer_name: 'X LIMITED', tan_hints: [odd] }, zb = { key: 'kb', customer_id: 'cQ1', customer_name: cust.Q1[1], tan_hints: [odd] };
  for (const items of [[za, zb], [zb, za]]) {
    const ix = CL.index(d.clientsDoc, { items, credits: d.credits });
    assert.deepEqual([ix.byEntry.get('ka'), ix.byEntry.get('kb')], [`tan:${odd}`, GQ], `order ${items.map(z => z.key).join(',')}`);
  }
  // a TAN marked "no Zoho customer" gets no automatic client, so its credits do not wait for a mapping
  const doc = { ...d.clientsDoc, no_customer: { [TAN.P]: { by: 'test', at: '' } } };
  const ix3 = CL.index(doc, { items: d.items, credits: d.credits, invoices: d.docs.invoices });
  assert.equal(ix3.byTan.get(TAN.P), undefined);
  const r = M.reconcile({ entity: E, period, items: d.items, credits: d.credits, clients: ix3, links: [], cfConsumed: new Map(), coverage: { zohoMonths: d.zohoMonths, statements: d.statements }, settings: d.settings });
  assert.ok(r.units.some(u => u.status === 'not_in_zoho' && u.tans.includes(TAN.P)));
  // a plain index of the approved groups alone (no entries given) still maps by customer
  const plain = CL.index(d.clientsDoc);
  assert.equal(plain.entry({ key: 'x', customer_id: 'cQ1', tan_hints: [] }).group, GQ);
});
