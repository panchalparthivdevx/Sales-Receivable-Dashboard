/**
 * Journals without a Zoho customer (25 Nov 2026): TDS booked by journal for banks' fixed deposits, interest on loans given and clients
 * the journal does not name as a customer. The deductor comes from the journal's Reference number / Notes — the invoice it names (last
 * year's too: the sync looks the number up in Zoho), a TAN written there, or a Form 26AS deductor's name — or a reviewer chooses it.
 * SYNTHETIC data only (PAN ZZZ…, TANs AHM…000…, invented names). Cases (Zoho journal → Form 26AS credit):
 *   F1  "TDS on FD interest Zeta Bank …"                    → ZETA BANK LIMITED (all the name's words)
 *   F2  "SBZ FD interest Q2"                                 → STATE BANK OF ZEDLAND (initials)
 *   F3  "… by Bank of Zedland on FD"                         → BANK OF ZEDLAND, not STATE BANK OF ZEDLAND (the longer name is not written)
 *   L1  Reference number "AHMN00074N", notes "Interest on loan given Q2"   → the TAN
 *   L2  "… interest on loan to Omicron Finlease"             → OMICRON FINLEASE LLP, a TAN marked "no Zoho customer"
 *   R1  "TDS against invoice 25-26/UP/00024" (last year's invoice, fetched by the sync) → the invoice's customer and TAN
 *   A1  "TDS from Psi Kappa" — two deductors are PSI KAPPA … → unallocated, both listed; a reviewer chooses one
 *   U1  "TDS receivable adjustment 01/10/2025 31/03/2026"    → nothing (the dates are not "references"); a reviewer chooses
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
const BM = require('../lib/booksModel');
const RC = require('../lib/recon');
const CL = require('../lib/clients');
const RP = require('../lib/reports');
const PER = require('../lib/periods');
const store = require('../lib/store');

const PAN = 'ZZZPJ8888J';
const TAN = { F1: 'AHMZ00071Z', F2: 'AHMS00072S', F3: 'AHMB00073B', L1: 'AHMN00074N', L2: 'AHMO00075O', R1: 'AHMR00076R', A1: 'AHMP00077P', A2: 'AHMP00078P', U1: 'AHMC00079C' };
const NAME = { F1: 'ZETA BANK LIMITED', F2: 'STATE BANK OF ZEDLAND', F3: 'BANK OF ZEDLAND', L1: 'NAVKAR LOGIX PRIVATE LIMITED', L2: 'OMICRON FINLEASE LLP', R1: 'RHO CLIENT PRIVATE LIMITED', A1: 'PSI KAPPA TRADERS LLP', A2: 'PSI KAPPA EXPORTS LLP', U1: 'CHI HOLDINGS LIMITED' };
const E = { id: 'syn-jr', name: 'Synthetic Journals Limited', pan: PAN, org_id: '', active: true, tan_field: 'cf_organization_tan_number',
  ledgers: [{ account_id: 'syn194A', name: '194A', section: '194A', parent: 'TDS Receivable' }, { account_id: 'syn194J', name: '194J', section: '194J', parent: 'TDS Receivable' }] };
const P_ = v => Math.round(v * 100);
// journals: case, posting date, ledger, TDS (₹), notes, reference number
const J = [
  ['F1', '2026-06-30', 'syn194A', 12345, 'TDS on FD interest Zeta Bank FD 1001 01/04/2026 to 30/06/2026', ''],
  ['F2', '2026-09-30', 'syn194A', 8000, 'SBZ FD interest Q2', ''],
  ['F3', '2026-09-30', 'syn194A', 2500, 'TDS deducted by Bank of Zedland on FD', ''],
  ['L1', '2026-09-30', 'syn194A', 15000, 'Interest on loan given Q2', 'AHMN00074N'],
  ['L2', '2026-06-30', 'syn194A', 4000, 'Being TDS on interest on loan to Omicron Finlease', ''],
  ['R1', '2026-06-17', 'syn194J', 5000, 'TDS against invoice 25-26/UP/00024', ''],
  ['A1', '2026-09-30', 'syn194J', 1000, 'TDS from Psi Kappa', ''],
  ['U1', '2026-08-31', 'syn194J', 3000, 'TDS receivable adjustment 01/10/2025 31/03/2026', ''],
];
// Form 26AS credits: case, transaction date, section, TDS (₹)
const CR = [['F1', '30-Jun-2026', '194A', 12345], ['F2', '30-Sep-2026', '194A', 8000], ['F3', '30-Sep-2026', '194A', 2500], ['L1', '30-Sep-2026', '194A', 15000],
  ['L2', '30-Jun-2026', '194A', 4000], ['R1', '31-May-2026', '194J(b)', 5000], ['A1', '30-Sep-2026', '194J(b)', 1000], ['A2', '30-Sep-2026', '194J(b)', 2000], ['U1', '31-Aug-2026', '194J(b)', 3000]];
const FY = PER.resolve({ fy: '2026-27' });

async function setup() {
  H.tempStore();
  await H.saveConfig({ entities: [E] });
  const rows = {}, docs = { invoices: {}, payments: {}, paylist: {}, journals: {}, invno: {} };
  J.forEach(([k, date, acc, tds, notes, ref]) => {
    const tid = `j${k}`, no = `JR/26-27/${k}`;
    rows[`r${k}`] = { id: `r${k}`, acc, type: 'journal', type_label: 'Journal', tid, date, cust: '', payee: '', desc: '', no, ref: '', dr: P_(tds), cr: 0, off: '' };
    docs.journals[tid] = { id: tid, no, date, notes, ref, lines: [{ acc, acc_name: acc, cust: '', cust_name: '', dc: 'debit', amount: P_(tds) }, { acc: 'synInt', acc_name: 'Interest income', cust: '', cust_name: '', dc: 'credit', amount: P_(tds) }], lmt: '', at: '' };
  });
  // last year's invoice that R1 names (stored by the sync's look-up by number)
  docs.invoices.invP = { id: 'invP', no: '25-26/UP/00024', date: '2026-03-20', cust: 'cR', cust_name: NAME.R1, status: 'paid', sub_total: P_(50000), tax_total: P_(9000), total: P_(54000), tds: 0, tds_percent: null, tds_section: '', tds_names: [], tan: TAN.R1, lmt: '', branch: '', at: '' };
  docs.invno['25-26/UP/00024'] = { id: 'invP', cust: 'cR', date: '2026-03-20' };
  await store.write('ledger_syn-jr_2026_27', { rows, months: {} });
  await store.write('docs_syn-jr', docs);
  await store.write('clients_syn-jr', { groups: [], no_customer: { [TAN.L2]: { by: 'tester', at: '2026-11-01T00:00:00.000Z', note: 'never a customer' } }, rejected: {} });
  const listed = {}; ['04', '05', '06', '07', '08', '09', '10', '11'].forEach(m => { listed[`2026-${m}`] = 'x'; });
  await store.write('sync_syn-jr', { last_ok_at: '2026-11-23T06:00:00.000Z', listed });
  const deductors = CR.map(([k, date, section, tds], i) => ({ sr: i + 1, cl: { name: NAME[k], tan: TAN[k] }, rows: [{ section, date, status: 'F', booked: '15-Nov-2026', paid: tds * 10, deducted: tds, deposited: tds }] }));
  const text = DEMO.tracesText({ pan: PAN, name: E.name, fy: '2026-27', ay: '2027-28', created: '20-11-2026', deductors });
  const settings = (await H.cfgNow()).settings;
  const pv = await ST.preview({ buffer: Buffer.from(text, 'latin1'), fileName: 'syn_jr_2026-27.txt', entity: E, by: 'tester', settings });
  assert.deepEqual(pv.validation.blockers, []);
  await ST.commit({ previewId: pv.preview_id, entity: E, by: 'tester', ack: pv.validation.needs_ack.map(x => x.id || x.code || x), settings });
}
const newRecon = () => RC.create({ sync: BS.create({ zr: { get: async () => { throw new Error('no Zoho in tests'); }, isGone: () => false, errText: e => e.message }, cfgNow: H.cfgNow }), cfgNow: H.cfgNow });
const unitOf = (s, k) => s.res.units.find(u => u.zoho.some(key => s.d.items.find(i => i.key === key).journal.no === `JR/26-27/${k}`));
const fromOf = (s, u) => RP.unitView(u, s.d, RP.maps(s.d), '').zoho_lines[0].client_from;

test('journals without a customer: the deductor from the Reference number / Notes — name, initials, phrase, TAN, invoice; the rest unallocated', async () => {
  await setup();
  const s = await newRecon().run(E, FY);
  const expect = { F1: ['journal_name', 'F1'], F2: ['journal_initials', 'F2'], F3: ['journal_name', 'F3'], L1: ['journal_tan', 'L1'], L2: ['journal_name', 'L2'] };
  for (const [k, [basis, who]] of Object.entries(expect)) {
    const u = unitOf(s, k);
    assert.equal(u.group, `tan:${TAN[who]}`, `${k} belongs to ${NAME[who]}`);
    assert.deepEqual([u.effective, u.credits.length], ['matched', 1], `${k} is matched with the deductor's credit`);
    assert.equal(fromOf(s, u).basis, basis, k);
  }
  assert.deepEqual(fromOf(s, unitOf(s, 'F1')).words, ['ZETA BANK']);
  assert.deepEqual(fromOf(s, unitOf(s, 'F2')).words, ['SBZ']);
  assert.equal(fromOf(s, unitOf(s, 'F3')).name, NAME.F3);
  // L2's TAN is marked "no Zoho customer": its credit is matched with the journal, not reported "Not in Zoho Books"
  assert.ok(!s.res.units.some(u => u.reason && u.reason.code === 'no_customer'));
  // R1: the customer of last year's invoice it names (the long-standing rule, now that the sync fetches such invoices)
  const r1 = unitOf(s, 'R1');
  assert.deepEqual([r1.group, r1.effective], [`tan:${TAN.R1}`, 'matched']);
  assert.equal(s.d.items.find(i => i.journal && i.journal.no === 'JR/26-27/R1').customer_basis, 'invoice_reference');
  // A1: two names fit equally → unallocated, both listed
  const a1 = unitOf(s, 'A1');
  assert.equal(a1.reason.code, 'unallocated');
  assert.match(a1.reason.text, /fit several deductors \(PSI KAPPA (TRADERS|EXPORTS) LLP AHMP0007\dP; PSI KAPPA (TRADERS|EXPORTS) LLP AHMP0007\dP\) — choose the deductor in the item/);
  assert.deepEqual(fromOf(s, a1).candidates.map(c => c.tan).sort(), [TAN.A1, TAN.A2]);
  // U1: nothing to go on — and its dates are not called "references that are not Zoho invoices"
  const u1 = unitOf(s, 'U1');
  assert.equal(u1.reason.code, 'unallocated');
  assert.doesNotMatch(u1.reason.text, /references|01\/10\/2025/);
  assert.match(u1.reason.text, /name no Zoho invoice, TAN or Form 26AS deductor — choose the deductor in the item/);
  assert.equal(fromOf(s, u1), null);
  assert.deepEqual(s.d.items.find(i => i.journal && i.journal.no === 'JR/26-27/U1').refs_unresolved, []);
  // the dashboard: only A1 and U1 remain unallocated; the bridge still ties
  const dash = RP.dashboard(s.d, s.res, FY);
  assert.equal(dash.totals.unallocated, P_(1000 + 3000));
  assert.equal(dash.bridge.difference, 0);
  assert.equal(RP.followUp(s.d, s.res, FY).totals.zoho, dash.totals.zoho);
  assert.equal(RP.clientTotals(s.d, s.res, FY).rows.find(x => x.id === `tan:${TAN.F1}`).diff, 0);
});

test('a reviewer chooses the deductor of a journal (and can go back to the automatic rule); a wrong automatic one can be overridden', async () => {
  await setup();
  const recon = newRecon();
  await assert.rejects(CL.journalDeductor(E.id, 'rev', 'jA1', 'NOT-A-TAN'), /valid TAN/);
  await CL.journalDeductor(E.id, 'rev', 'jA1', TAN.A1, { note: 'trader, not exporter', number: 'JR/26-27/A1', name: NAME.A1 });
  await CL.journalDeductor(E.id, 'rev', 'jU1', TAN.U1.toLowerCase(), { number: 'JR/26-27/U1' });
  await CL.journalDeductor(E.id, 'rev', 'jF2', TAN.F3, { note: 'test override', number: 'JR/26-27/F2' });      // a deliberate override of a right one
  recon.bump();
  let s = await recon.run(E, FY);
  const a1 = unitOf(s, 'A1');
  assert.deepEqual([a1.group, a1.effective], [`tan:${TAN.A1}`, 'matched']);
  assert.deepEqual(Object.fromEntries(Object.entries(fromOf(s, a1)).filter(([k]) => ['basis', 'by', 'note', 'name'].includes(k))), { basis: 'journal_manual', by: 'rev', note: 'trader, not exporter', name: NAME.A1 });
  assert.deepEqual([unitOf(s, 'U1').group, unitOf(s, 'U1').effective], [`tan:${TAN.U1}`, 'matched'], 'the TAN is taken in capitals');
  // the override wins over the notes: F2 now sits with BANK OF ZEDLAND (whose 2,500 credit is taken by F3) and SBZ's credit is open
  const f2 = unitOf(s, 'F2');
  assert.equal(f2.group, `tan:${TAN.F3}`);
  assert.ok(s.res.units.some(u => !u.zoho.length && u.credits.some(k => s.d.credits.find(c => c.key === k).tan === TAN.F2) && u.reason.code === 'deductor_unmapped'), 'the SBZ credit is left without a booking');
  assert.equal(RP.dashboard(s.d, s.res, FY).totals.unallocated, 0);
  const doc = await CL.load(E.id);
  assert.equal(doc.journal_tans.jA1.tan, TAN.A1);
  assert.match(doc.history[0].what, /journal JR\/26-27\/F2: deductor \(AHMB00073B\)/);
  // back to the automatic rule
  await CL.journalDeductor(E.id, 'rev', 'jF2', '', { number: 'JR/26-27/F2' });
  recon.bump();
  s = await recon.run(E, FY);
  assert.deepEqual([unitOf(s, 'F2').group, unitOf(s, 'F2').effective, fromOf(s, unitOf(s, 'F2')).basis], [`tan:${TAN.F2}`, 'matched', 'journal_initials']);
  assert.equal((await CL.load(E.id)).journal_tans.jF2, undefined);
});

test('over HTTP: the deductor list, rights, an unknown journal, a journal with a customer, the choice with its audit entry, and the drawer', async () => {
  await setup();
  // R1's journal names its customer on a line: its client comes from the customer, so choosing a deductor is refused
  await store.update('docs_syn-jr', {}, d => { d.journals.jR1.lines[0].cust = 'cR'; d.journals.jR1.lines[0].cust_name = NAME.R1; });
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
    const qs = 'entity=syn-jr&fy=2026-27';
    const ded = await call('/clients/deductors?entity=syn-jr', { user: '2' });
    assert.equal(ded.status, 200);
    assert.equal(ded.body.deductors.length, CR.length);
    assert.deepEqual(ded.body.deductors.find(x => x.tan === TAN.A1), { tan: TAN.A1, name: NAME.A1, credits: 1, deposited: P_(1000) });
    const body = { entity: 'syn-jr', journal_id: 'jA1', tan: TAN.A1, note: 'checked with the client' };
    assert.equal((await call('/clients/journal-deductor', { user: '2', method: 'POST', body })).status, 403, 'a viewer cannot choose');
    assert.equal((await call('/clients/journal-deductor', { user: '3', method: 'POST', body: { ...body, journal_id: 'jNOPE' } })).status, 404);
    assert.equal((await call('/clients/journal-deductor', { user: '3', method: 'POST', body: { ...body, tan: '123' } })).status, 400);
    const withCust = await call('/clients/journal-deductor', { user: '3', method: 'POST', body: { ...body, journal_id: 'jR1' } });
    assert.equal(withCust.status, 400, JSON.stringify(withCust.body));
    const ok = await call('/clients/journal-deductor', { user: '3', method: 'POST', body });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const audit = (await call('/audit?entity=syn-jr')).body;
    const entries = audit.entries || audit.rows || audit;
    assert.ok(entries.some(x => x.action === 'clients.change' && /journal JR\/26-27\/A1: deductor PSI KAPPA TRADERS LLP \(AHMP00077P\)/.test(x.detail)), JSON.stringify(entries).slice(0, 400));
    const units = (await call(`/recon/units?${qs}&group=tan:${TAN.A1}`)).body.units;
    const a1 = units.find(u => u.zoho.length);
    assert.equal(a1.effective, 'matched');
    assert.equal(a1.zoho_lines[0].client_from.basis, 'journal_manual');
    assert.equal(a1.zoho_lines[0].client_from.by, 'Reviewer');
    const drawer = await call(`/recon/unit?${qs}&id=${a1.id}`);
    assert.equal(drawer.body.unit.zoho_lines[0].journal.notes, 'TDS from Psi Kappa');
    const f1 = (await call(`/recon/units?${qs}&group=tan:${TAN.F1}`)).body.units.find(u => u.zoho.length);
    assert.deepEqual([f1.zoho_lines[0].client_from.basis, f1.zoho_lines[0].client_from.words], ['journal_name', ['ZETA BANK']]);
    const left = (await call(`/recon/units?${qs}&reason=unallocated`)).body.units;
    assert.deepEqual(left.map(u => u.zoho_lines[0].number), ['JR/26-27/U1']);
    assert.equal(left[0].zoho_lines[0].client_from, null);
  } finally { server.close(); }
});

test('names in a narration: the longer name written wins, two full fits identify nothing, a word shared with another name does not count, narration words are never initials', () => {
  const f = CL.nameFinder([
    { tan: TAN.F1, key: 'k1', name: NAME.F1 }, { tan: TAN.F2, key: 'k2', name: NAME.F2 }, { tan: TAN.F3, key: 'k3', name: NAME.F3 }, { tan: TAN.L2, key: 'k5', name: NAME.L2 },
    { tan: 'AHMK00091K', key: 'k6', name: 'KAPPA MAHINDRA BANK LIMITED' }, { tan: 'AHMM00092M', key: 'k7', name: 'MAHINDRA FINLEASE LIMITED' },
    { tan: 'AHMT00093T', key: 'k8', name: 'TAU DIGITAL SERVICES LTD' }, { tan: 'AHMS00094S', key: 'k9', name: 'SERVICES LIMITED' },
  ]);
  const who = text => { const r = f(text); return !r ? null : r.tan ? `${r.tan} ${r.basis}` : r.candidates.map(c => c.tan).sort().join(' | '); };
  assert.equal(who('TDS deducted by State Bank of Zedland on FD'), `${TAN.F2} journal_name`, 'not a tie with BANK OF ZEDLAND, whose name is inside it');
  assert.equal(who('TDS on FD with Bank of Zedland'), `${TAN.F3} journal_name`);
  assert.equal(who('Interest from Zeta Bank and Omicron Finlease'), [TAN.F1, TAN.L2].sort().join(' | '), 'two full names: nothing is chosen');
  assert.equal(who('Kappa Mahindra FD interest'), 'AHMK00091K journal_word', '"Kappa" is only in one name; "Mahindra" is shared, so it does not make it a tie');
  assert.equal(who('Mahindra FD interest'), ['AHMK00091K', 'AHMM00092M'].join(' | '), 'only a shared word: both listed');
  assert.equal(who('TDS on FD interest as per Form 26AS'), null, '"TDS" is not TAU DIGITAL SERVICES');
  assert.equal(who('Payment for services'), null, 'a name of generic words only must be written in full');
});

test('sync: invoice numbers a journal names that are not known (last year\'s) are looked up by number once, then read in detail', async () => {
  H.tempStore();
  await store.write('config', { sync: { rate_per_min: 600000, ledger_rate_per_min: 600000, concurrency: 3, daily_budget: 100000, step_seconds: 60 } });
  const ORG = '99999998', L = '9100000001';
  const ENT = { id: 'synj', name: 'Synthetic J', pan: 'ZZZPJ0002Z', org_id: ORG, active: true, ledgers: [{ account_id: L, name: '194J', section: '194J' }], tan_field: 'cf_organization_tan_number' };
  const row = (ct, tid, date, no, dr) => ({ categorized_transaction_id: ct, transaction_type: 'journal', transaction_id: tid, transaction_date: date, transaction_type_formatted: 'Journal', account_id: L, customer_id: '', payee: '',
    description: '', entry_number: no, currency_code: 'INR', debit_or_credit: 'debit', offset_account_name: '', reference_number: '', debit_amount: dr, credit_amount: '' });
  const journals = {
    jx1: { journal_id: 'jx1', entry_number: 'JR/26-27/UP/00007', journal_date: '2026-10-17', notes: 'TDS on 25-26/UP/00024, 25-26/UP/00099 for 01/10/2025 to 31/03/2026', reference_number: '', line_items: [{ account_id: L, customer_id: '', debit_or_credit: 'debit', amount: 700 }] },
    jx2: { journal_id: 'jx2', entry_number: 'JR/26-27/UP/00008', journal_date: '2026-10-18', notes: 'TDS on 25-26/UP/00041', reference_number: '', line_items: [{ account_id: L, customer_id: '', debit_or_credit: 'debit', amount: 300 }] },
  };
  const inv = (id, no, cust, tan) => ({ invoice_id: id, invoice_number: no, date: '2025-05-10', customer_id: cust, customer_name: `CUSTOMER ${cust}`, sub_total: 7000, tax_total: 1260, total: 8260, tds_amount: '0', tds_summary: [], cf_organization_tan_number: tan, last_modified_time: '2025-05-10T10:00:00+0530' });
  const invoices = { iv24: inv('iv24', '25-26/UP/00024', 'cu1', 'AHMU00081U'), iv41: inv('iv41', '25-26/UP/00041', 'cu2', 'AHMU00082U') };
  const calls = [];
  const zr = {
    async get(org, path, params, { before } = {}) {
      if (before) await before();
      calls.push({ path, params: { ...params } });
      if (path === '/chartofaccounts/transactions') return { transactions: params.account_id === L ? [row('c1', 'jx1', '2026-10-17', 'JR/26-27/UP/00007', 700), row('c2', 'jx2', '2026-10-18', 'JR/26-27/UP/00008', 300)].filter(r => r.transaction_date >= params.date_start && r.transaction_date <= params.date_end) : [], page_context: { has_more_page: false } };
      // like a search that also returns near numbers: only the exact number counts
      if (path === '/invoices') return { invoices: Object.values(invoices).filter(i => i.invoice_number.startsWith(params.invoice_number.slice(0, 9))).map(i => ({ invoice_id: i.invoice_id, invoice_number: i.invoice_number, customer_id: i.customer_id })), page_context: { has_more_page: false } };
      const m = path.match(/^\/(invoices|journals)\/(.+)$/);
      if (m) { const src = { invoices, journals }[m[1]][m[2]]; if (!src) throw Object.assign(new Error('not found'), { response: { status: 404 } }); return { [m[1] === 'invoices' ? 'invoice' : 'journal']: src }; }
      throw new Error(`unexpected GET ${path}`);
    },
    isGone: e => !!(e && e.response && e.response.status === 404), errText: e => e.message,
  };
  // 25-26/UP/00041 is in the dashboard's "paid in the last 12 months" list: read in detail without a look-up
  const readSynced = async (org, name) => (name === 'invoices_paid_12mo' ? { data: [{ invoice_id: 'iv41', invoice_number: '25-26/UP/00041', customer_id: 'cu2', date: '2025-05-10', total: 8260 }] } : null);
  const sync = BS.create({ zr, cfgNow: H.cfgNow, readSynced, log: { error() {}, warn() {}, info() {} } });
  const run = async mode => { let r = await sync.step({ entity: ENT, from: '2026-10-01', to: '2026-10-31', mode, by: 't', maxMs: 60000 }); let n = 0; while (r.more && n++ < 20) r = await sync.step({ entity: ENT, maxMs: 60000 }); return r; };
  const r = await run('changes');
  assert.ok(!r.error, r.error);
  const lookups = () => calls.filter(c => c.path === '/invoices').map(c => c.params.invoice_number);
  assert.deepEqual(lookups(), ['25-26/UP/00024', '25-26/UP/00099'], 'only the unknown numbers — no dates, nothing from the central list');
  assert.deepEqual(calls.filter(c => /^\/invoices\//.test(c.path)).map(c => c.path).sort(), ['/invoices/iv24', '/invoices/iv41']);
  const docs = await sync.docs('synj');
  assert.deepEqual([docs.refs['25-26/UP/00024'].id, docs.refs['25-26/UP/00099'].id], ['iv24', '']);
  assert.equal(docs.invoices.iv24.tan, 'AHMU00081U');
  const books = BM.build({ entity: ENT, rows: await sync.ledgerRows('synj'), docs });
  const j1 = books.items.find(i => i.journal.id === 'jx1'), j2 = books.items.find(i => i.journal.id === 'jx2');
  assert.deepEqual([j1.customer_id, j1.customer_basis, j1.refs_unresolved], ['cu1', 'invoice_reference', ['25-26/UP/00099']]);
  assert.deepEqual([j2.customer_id, j2.tan_hints], ['cu2', ['AHMU00082U']]);
  // the next sync does not ask again; a full sync asks again only for the number Zoho did not know
  calls.length = 0;
  await run('changes');
  assert.deepEqual(lookups(), []);
  calls.length = 0;
  await run('full');
  assert.deepEqual(lookups(), ['25-26/UP/00099']);
});
