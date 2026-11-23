/**
 * The Tax Year 2026-27 "Annual Tax Statement" (Income-tax Act, 2025), laid out like a real one seen on 23 Nov 2026 — but with
 * SYNTHETIC data only (PAN ZZZ…, TANs AHM…000…): section codes 1009 / 1024 / 1027, "S.No." headings, transactions numbered 1.1, the
 * deductor's PAN column, booking status as a word, reversal rows in brackets with remark G, page furniture on every page, and the
 * PART-I "Gross Total". Also: the sync lock that keeps two online server instances from running a step at the same time.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const H = require('./helpers');
const P = require('../lib/parse26as');
const ST = require('../lib/statements');
const CFG = require('../lib/config');
const BS = require('../lib/booksSync');
const RC = require('../lib/recon');
const RP = require('../lib/reports');
const PER = require('../lib/periods');
const store = require('../lib/store');

const PAN = 'ZZZPT4321Q';
const R = { cust: 'cR', name: 'RHO RENT PAYER LIMITED', tan: 'AHMR00021R' };
const S = { cust: 'cS', name: 'SIGMA CONTRACT LLP', tan: 'AHMS00022S', pan: 'ZZZPS1111S' };
const A = ['2,82,145.00', '28,214.50', '28,214.50'], NEG_A = ['(2,82,145.00)', '(28,214.50)', '(28,214.50)'];

/** rows of cells, spread over wide sheet columns like the portal's Excel download */
function statementAoa({ gross = ['6,24,290.00', '58,429.00', '57,429.00'] } = {}) {
  const rows = [];
  const put = (cells) => { const r = []; for (const [c, v] of cells) r[c] = v; rows.push(r); };
  const blank = n => { for (let i = 0; i < n; i++) rows.push([]); };
  blank(1); put([[48, 'Data updated till 14-Nov-2026']]); blank(2);
  put([[1, 'Annual Tax Statement']]); blank(3);
  put([[2, 'Permanent Account Number (PAN)'], [17, 'Current Status of PAN'], [37, 'Tax Year']]);
  put([[2, PAN], [17, 'Active'], [37, '2026-27']]); blank(2);
  put([[2, 'Name of Assessee']]); put([[2, 'SYNTHETIC TAX YEAR LIMITED']]); blank(2);
  put([[2, 'Address of Assessee']]); put([[2, '1 SYNTHETIC ROAD, AHMEDABAD']]); blank(2);
  put([[1, '(All amount values are in ₹)']]); put([[1, 'Summary for TY 2026-27']]);
  put([[2, 'TDS'], [14, 'TCS']]); put([[2, '₹ 57,429.00'], [14, '₹ 0.00']]);
  put([[51, 'Page 1 of'], [53, '59']]); blank(2); put([[1, 'Annual Tax Statement']]); blank(1);
  put([[3, 'PART I - Details of Tax Deducted at Source']]);
  const dedHead = () => put([[1, 'S.No.'], [4, 'Name of Deductor'], [19, 'TAN of Deductor'], [31, 'PAN of Deductor (If Available)'], [36, 'Total Amount Paid/Credited (₹)'], [45, 'Total Tax Deducted (₹)'], [52, 'Total TDS Deposited (₹)']]);
  const txnHead = () => put([[1, 'S.No.'], [4, 'Section Code'], [6, 'Transaction Date'], [12, 'Status of Booking*'], [17, 'Date of Booking'], [19, 'Remarks**'], [36, 'Amount Paid/Credited (₹)'], [45, 'Tax Deducted (₹)'], [52, 'TDS Deposited (₹)']]);
  const txn = (sr, sec, date, status, booked, remark, [p, d, dep]) => put([[1, sr], [4, sec], [6, date], [12, status], [17, booked], [19, remark], [36, p], [45, d], [52, dep]]);
  dedHead();
  put([[1, '1'], [4, R.name], [19, R.tan], [31, '-'], [36, '5,64,290.00'], [45, '56,429.00'], [52, '56,429.00']]);
  txnHead();
  // the client revised its statement: the April credit printed, reversed (G), printed again, reversed again, printed again
  txn('1.1', '1009', '17-Apr-2026', 'Final', '20-Jul-2026', '-', A);
  txn('1.2', '1009', '17-Apr-2026', 'Final', '20-Jul-2026', 'G', NEG_A);
  txn('1.3', '1009', '17-Apr-2026', 'Final', '20-Jul-2026', '-', A);
  txn('1.4', '1009', '17-Apr-2026', 'Final', '20-Jul-2026', 'G', NEG_A);
  put([[51, 'Page 2 of'], [53, '59']]); blank(2); put([[1, 'Annual Tax Statement']]); blank(1);
  txn('1.5', '1009', '17-Apr-2026', 'Final', '20-Jul-2026', '-', A);
  txn('1.6', '1009', '17-May-2026', 'Final', '20-Jul-2026', '-', A);
  put([[1, '2'], [4, S.name], [19, S.tan], [31, S.pan], [36, '60,000.00'], [45, '2,000.00'], [52, '1,000.00']]);
  txnHead();
  txn('2.1', '1024', '03-Jun-2026', 'Final', '23-Jul-2026', '-', ['50,000.00', '1,000.00', '1,000.00']);
  txn('2.2', '1027', '05-Jun-2026', 'Unmatched', '-', '-', ['10,000.00', '1,000.00', '0.00']);
  put([[1, 'Gross Total(₹)'], [36, gross[0]], [45, gross[1]], [52, gross[2]]]);
  put([[1, 'PART-II Details of Tax Deducted at Source for Form No. 121']]); put([[1, 'No Transactions Present']]);
  put([[1, 'PART X (a)-TDS/TCS Defaults* (Processing of Statements)']]);
  put([[1, 'S.No.'], [3, 'Tax Year'], [6, 'Short Payment (₹)']]); put([[1, '1'], [3, '2026'], [6, '0.00']]);
  put([[1, 'Sections']]); put([[1, 'Section Code'], [3, 'Section'], [6, 'Description']]);
  put([[1, '1009'], [3, '393(1) [Table: Sl. No. 2(ii).D(b)]'], [6, 'Rent other than machinery etc.- specified person']]);
  return rows;
}
const xlsxOf = aoa => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'AnnualTaxStatement'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };

test('Tax Year 2026-27 statement (Excel): header, S.No. headings, codes 10xx, status words, brackets, page furniture, Gross Total', async () => {
  const r = await P.parse(xlsxOf(statementAoa()), 'ty2026.xlsx');
  assert.equal(r.format, 'excel');
  assert.deepEqual({ pan: r.header.pan, name: r.header.name, fy: r.header.fy, tax_year: r.header.tax_year, date: r.header.statement_date, basis: r.header.statement_date_basis },
    { pan: PAN, name: 'SYNTHETIC TAX YEAR LIMITED', fy: '2026-27', tax_year: '2026-27', date: '2026-11-14', basis: 'Data updated till' });
  assert.equal(r.problems.length, 0, `no problems expected, got ${JSON.stringify(r.problems.map(p => p.message))}`);   // page furniture is not "unreadable"
  assert.equal(r.deductors.length, 2);
  assert.deepEqual(r.deductors.map(d => d.sr), ['1', '2']);
  assert.equal(r.rows.length, 8);
  assert.deepEqual(r.rows.map(x => x.sr), ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '2.1', '2.2']);
  assert.deepEqual(r.rows.map(x => x.status), ['F', 'F', 'F', 'F', 'F', 'F', 'F', 'U']);
  assert.equal(r.rows[1].deposited, -2821450, 'a bracketed amount is negative');
  assert.equal(r.rows[1].remarks, 'G');
  assert.deepEqual(r.rows.map(x => CFG.sectionFamily(x.section)), ['194I', '194I', '194I', '194I', '194I', '194I', '194C', '194J']);
  assert.deepEqual({ ...r.gross, src: undefined }, { amount_paid: 62429000, deducted: 5842900, deposited: 5742900, src: undefined });
  assert.deepEqual(ST.controlChecks(r), [], 'deductor totals and the Gross Total agree with the rows');
  // a Gross Total that differs from the rows is reported
  const bad = await P.parse(xlsxOf(statementAoa({ gross: ['6,24,290.00', '58,429.00', '57,430.00'] })), 'bad.xlsx');
  const ctl = ST.controlChecks(bad);
  assert.equal(ctl.length, 1);
  assert.equal(ctl[0].deductor, 'PART-I Gross Total');
  assert.equal(ctl[0].field, 'TDS deposited');
});

test('Tax Year 2026-27 statement (PDF lines): PAN column, 1.1 numbering, "Final", brackets, page furniture, Gross Total', async () => {
  const lines = [
    [[440, 'Data'], [462, 'updated'], [496, 'till'], [512, '14-'], [526, 'Nov-2026']],
    [[200, 'Annual Tax Statement']],
    [[18, 'Permanent Account Number (PAN)'], [200, 'Current Status of PAN'], [360, 'Tax Year']],
    [[18, PAN], [200, 'Active'], [360, '2026-27']],
    [[18, 'Name of Assessee']], [[18, 'SYNTHETIC TAX YEAR LIMITED']],
    [[10, 'PART I - Details of Tax Deducted at Source']],
    [[16, 'S.No.'], [60, 'Name of Deductor'], [250, 'TAN of Deductor'], [320, 'PAN of Deductor (If Available)'], [420, 'Total Amount Paid/Credited (Rs.)'], [480, 'Total Tax Deducted'], [530, 'Total TDS Deposited']],
    [[16, '1'], [60, R.name], [250, R.tan], [320, '-'], [420, '5,64,290.00'], [480, '56,429.00'], [530, '56,429.00']],
    [[16, 'S.No.'], [47, 'Section Code'], [108, 'Transaction Date'], [173, 'Status of Booking*'], [241, 'Date of Booking'], [311, 'Remarks**'], [420, 'Amount Paid/Credited'], [480, 'Tax Deducted'], [530, 'TDS Deposited']],
    [[16, '1.1'], [47, '1009'], [108, '17-Apr-2026'], [180, 'Final'], [241, '20-Jul-2026'], [320, '-'], [420, A[0]], [480, A[1]], [530, A[2]]],
    [[16, '1.2'], [47, '1009'], [108, '17-Apr-2026'], [180, 'Final'], [241, '20-Jul-2026'], [320, 'G'], [420, NEG_A[0]], [480, NEG_A[1]], [530, NEG_A[2]]],
    [[16, '1.3'], [47, '1009'], [108, '17-Apr-2026'], [180, 'Final'], [241, '20-Jul-2026'], [320, '-'], [420, A[0]], [480, A[1]], [530, A[2]]],
    [[16, '1.4'], [47, '1009'], [108, '17-May-2026'], [180, 'Final'], [241, '20-Jul-2026'], [320, '-'], [420, A[0]], [480, A[1]], [530, A[2]]],
    [[500, 'Page 1 of'], [540, '2']],
  ];
  const lines2 = [
    [[200, 'Annual Tax Statement']],
    [[16, '2'], [60, S.name], [250, S.tan], [320, S.pan], [420, '60,000.00'], [480, '2,000.00'], [530, '1,000.00']],
    [[16, 'S.No.'], [47, 'Section Code'], [108, 'Transaction Date'], [173, 'Status of Booking*'], [241, 'Date of Booking'], [311, 'Remarks**'], [420, 'Amount Paid/Credited'], [480, 'Tax Deducted'], [530, 'TDS Deposited']],
    [[16, '2.1'], [47, '1024'], [108, '03-Jun-2026'], [180, 'Final'], [241, '23-Jul-2026'], [320, '-'], [420, '50,000.00'], [480, '1,000.00'], [530, '1,000.00']],
    [[16, '2.2'], [47, '1027'], [108, '05-Jun-2026'], [180, 'Unmatched'], [241, '-'], [320, '-'], [420, '10,000.00'], [480, '1,000.00'], [530, '0.00']],
    [[16, 'Gross Total(Rs.)'], [420, '6,24,290.00'], [480, '58,429.00'], [530, '57,429.00']],
    [[10, 'PART-II Details of Tax Deducted at Source for Form No. 121']], [[10, 'No Transactions Present']],
  ];
  const page = ls => ls.flatMap((cells, i) => cells.map(([x, t]) => ({ x, y: 800 - i * 14, t })));
  const r = await P.parse(H.pdf([page(lines), page(lines2)]), 'ty2026.pdf');
  assert.equal(r.format, 'pdf');
  assert.equal(r.header.pan, PAN);
  assert.equal(r.header.fy, '2026-27');
  assert.equal(r.header.statement_date, '2026-11-14');
  assert.equal(r.header.name, 'SYNTHETIC TAX YEAR LIMITED');
  assert.equal(r.problems.length, 0, `no problems expected, got ${JSON.stringify(r.problems.map(p => p.message))}`);
  assert.deepEqual(r.deductors.map(d => [d.sr, d.tan]), [['1', R.tan], ['2', S.tan]], 'the deductor PAN column ("-" or a PAN) is stepped over');
  assert.deepEqual(r.rows.map(x => [x.sr, x.section, x.status, x.deposited]), [['1.1', '1009', 'F', 2821450], ['1.2', '1009', 'F', -2821450], ['1.3', '1009', 'F', 2821450], ['1.4', '1009', 'F', 2821450], ['2.1', '1024', 'F', 100000], ['2.2', '1027', 'U', 0]]);
  assert.equal(r.rows[1].remarks, 'G');
  assert.equal(r.gross.deposited, 5742900);
  assert.deepEqual(ST.controlChecks(r), []);
});

test('Income-tax Act 2025 section codes map to the 1961 sections Zoho still uses; an alias overrides', () => {
  assert.equal(CFG.sectionFamily('1009'), '194I');
  assert.equal(CFG.sectionFamily('1008'), '194I');
  assert.equal(CFG.sectionFamily('1024'), '194C');
  assert.equal(CFG.sectionFamily('1027'), '194J');
  assert.equal(CFG.sectionFamily('1026'), '194J');
  assert.equal(CFG.sectionFamily('1021'), '194A');
  assert.equal(CFG.sectionFamily('1006'), '194H');
  assert.equal(CFG.sectionFamily('1031'), '194Q');
  assert.equal(CFG.sectionFamily('1045'), '1045', 'a code without a known 1961 section keeps its code');
  assert.equal(CFG.sectionFamily('1009', { 1009: '194IB' }), '194IB', 'Settings → section aliases win');
  assert.equal(CFG.sectionFamily('194I(b)'), '194I', 'old-style codes unchanged');
  assert.equal(CFG.act2025('1009').label, 'Rent other than machinery etc.');
});

test('reversal pairs (+X, (X), +X, (X), +X) leave one credit, keyed as if there had been no pairs; an unpaired reversal stays', async () => {
  const r = await P.parse(xlsxOf(statementAoa()), 'ty2026.xlsx');
  const credits = ST.toCredits('syn', '2026-27', r.rows);
  const net = ST.netReversals(credits);
  assert.equal(net.pairs.length, 2);
  assert.equal(net.credits.length, 4, '8 rows − 2 pairs');
  const sum = list => list.reduce((s, c) => s + c.deposited, 0);
  assert.equal(sum(net.credits), sum(credits), 'netting does not change the total');
  const april = net.credits.filter(c => c.tan === R.tan && c.txn_date === '2026-04-17');
  assert.equal(april.length, 1);
  const clean = ST.toCredits('syn', '2026-27', r.rows.filter(x => !(x.tan === R.tan && x.txn_date === '2026-04-17') || x.sr === '1.1'));
  assert.equal(april[0].key, clean.find(c => c.tan === R.tan && c.txn_date === '2026-04-17').key, 'the surviving credit keeps the key it has in a statement without the pair');
  // a reversal with no earlier credit of the same amounts is not netted
  const lone = ST.netReversals(ST.toCredits('syn', '2026-27', r.rows.filter(x => x.sr === '1.2' || x.sr === '2.1')));
  assert.equal(lone.pairs.length, 0);
  assert.equal(lone.credits.length, 2);
});

test('a client credit printed with its reversal pairs matches its invoice once (not "Need to Check"); the bridge ties', async () => {
  H.tempStore();
  const E = { id: 'syn-ty', name: 'Synthetic TY Limited', pan: PAN, org_id: '', active: true, tan_field: 'cf_organization_tan_number',
    ledgers: [{ account_id: 'syn194I', name: '194I', section: '194I', parent: 'TDS Receivable' }, { account_id: 'syn194C', name: '194C', section: '194C', parent: 'TDS Receivable' }] };
  await H.saveConfig({ entities: [E] });
  const row = (id, acc, tid, date, cl, paise, no) => ({ id, acc, type: 'invoice', type_label: 'Invoice', tid, date, cust: cl.cust, payee: cl.name, desc: '', no, ref: '', dr: paise, cr: 0, off: '' });
  await store.write('ledger_syn-ty_2026_27', { rows: {
    z1: row('z1', 'syn194I', 'iR1', '2026-04-17', R, 2821450, 'SY/26-27/0001'), z2: row('z2', 'syn194I', 'iR2', '2026-05-17', R, 2821450, 'SY/26-27/0002'),
    z3: row('z3', 'syn194C', 'iS1', '2026-06-03', S, 100000, 'SY/26-27/0003') }, months: {} });
  const inv = (id, no, date, cl, basic, tds, names) => ({ id, no, date, cust: cl.cust, cust_name: cl.name, status: 'paid', sub_total: basic, tax_total: Math.round(basic * 0.18), total: Math.round(basic * 1.18) - tds, tds, tds_percent: null, tds_section: '', tds_names: names, tan: cl.tan, lmt: '', branch: '', at: '' });
  const docs = { invoices: {}, payments: {}, paylist: {}, journals: {}, invno: {} };
  for (const i of [inv('iR1', 'SY/26-27/0001', '2026-04-17', R, 28214500, 2821450, ['194I']), inv('iR2', 'SY/26-27/0002', '2026-05-17', R, 28214500, 2821450, ['194I']), inv('iS1', 'SY/26-27/0003', '2026-06-03', S, 5000000, 100000, ['194C'])]) {
    docs.invoices[i.id] = i; docs.invno[i.no] = { id: i.id, cust: i.cust, date: i.date };
  }
  await store.write('docs_syn-ty', docs);
  const group = (id, cl) => ({ id, name: cl.name, customers: [{ id: cl.cust, name: cl.name }], tans: [{ tan: cl.tan, name: cl.name, by: 'test', at: '2026-11-23T00:00:00Z', basis: 'test' }], by: 'test', at: '2026-11-23T00:00:00Z' });
  await store.write('clients_syn-ty', { groups: [group('g000000000000r001', R), group('g000000000000s001', S)], no_customer: {}, rejected: {} });
  await store.write('sync_syn-ty', { last_ok_at: '2026-11-23T06:00:00.000Z', listed: { '2026-04': 'x', '2026-05': 'x', '2026-06': 'x' } });

  const pv = await ST.preview({ buffer: xlsxOf(statementAoa()), fileName: 'ty2026.xlsx', entity: E, by: 'tester', settings: (await H.cfgNow()).settings });
  assert.deepEqual(pv.validation.blockers, []);
  assert.deepEqual(pv.validation.needs_ack, []);
  assert.deepEqual(pv.reversals, { pairs: 2, deposited: 5642900, unpaired: 0 });
  assert.deepEqual(pv.sections.map(s => [s.code, s.family, s.rows]), [['1009', '194I', 6], ['1024', '194C', 1], ['1027', '194J', 1]]);
  await ST.commit({ previewId: pv.preview_id, entity: E, by: 'tester' });

  const recon = RC.create({ sync: BS.create({ zr: { get: async () => { throw new Error('no Zoho in tests'); }, isGone: () => false, errText: e => e.message }, cfgNow: H.cfgNow }), cfgNow: H.cfgNow });
  const period = PER.resolve({ fy: '2026-27', q: 1 });
  const { d, res } = await recon.run(E, period);
  const rho = res.units.filter(u => u.client === R.name);
  assert.equal(rho.length, 2, 'April and May, one unit each');
  assert.ok(rho.every(u => u.method === 'transaction' && u.status === 'matched'), JSON.stringify(rho.map(u => [u.method, u.status, u.reason && u.reason.code])));
  assert.ok(!res.units.some(u => u.status === 'need_check'), 'nothing is left for review because of the reversal rows');
  const sigma = res.units.filter(u => u.client === S.name);
  assert.ok(sigma.some(u => u.status === 'matched' && u.zoho.length === 1));
  const dash = RP.dashboard(d, res, period);
  assert.equal(dash.totals.reversal_pairs, 2);
  assert.equal(dash.totals.deposited, 5742900, 'the 26AS total equals the statement (pairs net to ₹0)');
  assert.equal(dash.totals.zoho, 2821450 * 2 + 100000);
  const last = dash.bridge.lines ? dash.bridge.lines[dash.bridge.lines.length - 1] : null;
  assert.equal(dash.bridge.difference !== undefined ? dash.bridge.difference : (last && last.effect), 0);
});

test('online: a sync step refuses to start while another server instance holds the stored lock', async () => {
  H.tempStore();
  const E = { id: 'syn-lock', name: 'Synthetic lock', pan: PAN, org_id: '1', active: true, ledgers: [{ account_id: 'a1', name: '194I', section: '194I' }] };
  let calls = 0;
  const zr = { get: async () => { calls++; return { transactions: [], page_context: { has_more_page: false } }; }, isGone: () => false, errText: e => e.message };
  const sync = BS.create({ zr, cfgNow: H.cfgNow });
  await store.write('sync_syn-lock', { run: { id: 'rx', by: 'Another user', mode: 'changes', from: '2026-04-01', to: '2026-04-30', months_todo: ['2026-04'], months_done: [], phase: 'ledgers', calls: 0, errors: [], lock_until: new Date(Date.now() + 120000).toISOString() } });
  const r = await sync.step({ entity: E, from: '2026-04-01', to: '2026-04-30', by: 'me' });
  assert.equal(r.busy, true);
  assert.match(r.message, /already running \(started by Another user\)/);
  assert.equal(calls, 0, 'no Zoho call was made');
  // an expired lock (the other step ended or was stopped by the platform) does not block
  await store.update('sync_syn-lock', {}, st => { st.run.lock_until = new Date(Date.now() - 1000).toISOString(); });
  const r2 = await sync.step({ entity: E, from: '2026-04-01', to: '2026-04-30', by: 'me' });
  assert.ok(!r2.busy, JSON.stringify(r2));
  assert.ok(calls > 0);
});
