/**
 * Synthetic workbooks (made-up figures): header reading, components, working columns, errors, blanks, units,
 * recon arithmetic, derivations and version choice.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const P = require('../lib/periods');
const X = require('../lib/extract');
const B = require('../lib/build');
const M = require('../lib/model');
const RC = require('../lib/recon');
const RA = require('../lib/ratios');
const V = require('../lib/views');

test('period headings', () => {
  assert.strictEqual(P.parseDateText('30/09/2026'), '2026-09-30');
  assert.strictEqual(P.parseDateText('As at \nSeptember 30,2026'), '2026-09-30');
  assert.strictEqual(P.parseDateText('Year Ended 31st March, 2026'), '2026-03-31');
  assert.strictEqual(P.parseDateText('As on 30th september,2024'), '2024-09-30');
  assert.strictEqual(P.makePeriod('quarter', '2026-06-30').id, 'FY2027-Q1');
  assert.strictEqual(P.makePeriod('half', '2026-09-30').id, 'FY2027-H1');
  assert.strictEqual(P.makePeriod('half', '2026-03-31').id, 'FY2026-H2');
  assert.strictEqual(P.makePeriod('period', '2026-09-30').id, 'FY2027-H1');
  assert.strictEqual(P.makePeriod('nine', '2025-12-31').id, 'FY2026-9M');
  assert.strictEqual(P.makePeriod('quarter', '2026-08-31'), null);
  assert.deepStrictEqual(P.parseLooseHeading('2025-26'), { date: '2026-03-31', form: 'fylabel' });
  assert.strictEqual(P.parseLooseHeading('2025-27'), null);
  assert.strictEqual(P.fromId('FY2027-Q2').days, 92);
  assert.strictEqual(P.fromId('FY2027-H1').days, 183);
});

// A small standalone SEBI result + balance sheet (synthetic)
function sampleBook({ revQ2 = 600, error = false, hiddenBs = false } = {}) {
  const sebi = [
    [null, 'Synthetic Co Ltd'], [null, 'Unaudited Standalone Financial Results for the Quarter and Half Year ended September 30, 2026'], [null, null, null, null, null, null, null, '(Rs. In lakhs except EPS)'],
    [null, 'PARTICULARS', null, null, 'QUARTER ENDED', null, 'HALF YEAR ENDED', null, null, null, '9M working'],
    [null, null, null, null, '30/09/2026', '30/06/2026', '30/09/2026', null, null, null, '9M ended 31/12/2025'],
    [null, null, null, null, '(Unaudited)', '(Unaudited)', '(Unaudited)'],
    ['I', 'Revenue from operations', null, null, revQ2, 400, 1000],
    ['II', 'Other Income', null, null, 10, 5, 15],
    ['III', 'Total Income (I+II)', null, null, revQ2 + 10, 405, 1015],
    ['IV', 'Expenses'],
    [null, '(a) Operating Expenses', null, null, 100, 80, 180],
    [null, '(b) Employee Benefits Expenses', null, null, 50, 40, 90],
    [null, '(c) Finance Costs', null, null, 30, 20, 50],
    [null, '(d) Depreciation and amortization expenses', null, null, 20, 20, 40],
    [null, '(e) Other expenses', null, null, 10, 5, 15],
    [null, 'Total expenses (IV)', null, null, 210, 165, 375],
    ['V', 'Profit before exceptional items and tax (III-IV)', null, null, revQ2 + 10 - 210, 240, 640],
    ['VI', 'Exceptional Items', null, null, 0, null, 0],
    ['VII', 'Profit Before Tax (V - VI)', null, null, revQ2 + 10 - 210, 240, 640],
    [null, 'Basic EPS heading'],
  ];
  const bs = [
    [null, 'Synthetic Co Ltd'], [null, 'Standalone Balance Sheet as at September 30, 2026'], [null, null, null, '(Rs. In lakhs)'],
    [null, 'Particulars', 'Notes', 'As at September 30, 2026', 'As at March 31, 2026'],
    ['I', 'ASSETS'], [1, 'Non-current Assets'], [null, '(a) Property, Plant and Equipment', 2, 500, 450],
    [null, 'Total Non-current Assets', null, 500, 450], [2, 'Current Assets'], [null, '(i) Cash and cash equivalents', 11, 100, 80],
    [null, 'Total Current Assets', null, 100, 80], [null, 'TOTAL ASSETS', null, 600, 530],
    ['II', 'EQUITY AND LIABILITIES'], [1, 'Equity'], [null, '(a) Equity Share capital', null, 200, 200], [null, '(b) Other Equity', null, 250, 200], [null, 'Total Equity', null, 450, 400],
    [2, 'Non-current Liabilities'], [null, '(i) Borrowings', null, 100, 90], [null, 'Total Non-current Liabilities', null, 100, 90],
    [3, 'Current Liabilities'], [null, '(i) Borrowings', null, 50, 40], [null, 'Total Current Liabilities', null, 50, 40], [null, 'TOTAL EQUITY AND LIABILITIES', null, 600, 530],
  ];
  return H.workbook({ 'SEBI S26': sebi, BS: bs }, { errors: error ? { 'SEBI S26': ['F11'] } : {}, formulas: { 'SEBI S26': { E7: '+G7-F7', E16: 'SUM(E11:E15)+0.01' } }, hidden: hiddenBs ? ['BS'] : undefined });
}

test('headings decide periods; a column standing apart is a working column; errors and blanks are kept as such', () => {
  const x = X.extractWorkbook(sampleBook({ error: true }), { name: 'synthetic.xlsx' });
  assert.strictEqual(x.basis, 'SA');
  assert.strictEqual(x.reportingDate, '2026-09-30');
  const st = x.statements.find(s => s.type === 'SEBI');
  assert.deepStrictEqual(st.periods.map(p => [p.period, p.role]), [['FY2027-Q2', 'primary'], ['FY2027-Q1', 'comparative'], ['FY2027-H1', 'primary'], ['FY2026-9M', 'working']]);
  assert.strictEqual(st.unit, 'lakh');
  const ops = st.rows.find(r => r.id === 'pl.exp_ops');
  assert.strictEqual(ops.figs[1].f.st, 'error');
  assert.strictEqual(ops.figs[1].f.v, null);
  const exc = st.rows.find(r => r.id === 'pl.exceptional');
  assert.strictEqual(exc.figs[1].f.st, 'blank');
  assert.ok(st.issues.some(i => i.code === 'EXCEL_ERROR' && i.cell === 'F11'));
  assert.ok(st.issues.some(i => i.code === 'ROUNDING_PLUG'));
  const rev = st.rows.find(r => r.id === 'pl.rev');
  assert.deepStrictEqual(rev.figs[0].f.der, { plus: 'FY2027-H1', minus: 'FY2027-Q1' });
});

test('component and elimination columns are skipped; the final column is used', () => {
  const bs = [
    [null, 'Synthetic Group'], [null, 'Consolidated Balance Sheet as at March 31, 2026'], [null, null, null, null, null, null, '(Rs. In lakhs)'],
    [null, 'Particulars', 'Notes', 'DevX', 'Neddle', 'Elim', 'As at March 31, 2026'],
    ['I', 'ASSETS'], [1, 'Non-current Assets'], [null, '(a) Property, Plant and Equipment', null, 300, 20, 0, 320], [null, 'Total Non-current Assets', null, 300, 20, 0, 320], [null, 'TOTAL ASSETS', null, 300, 20, 0, 320],
  ];
  const x = X.extractWorkbook(H.workbook({ BS: bs }), { name: 'group.xlsx' });
  const st = x.statements[0];
  assert.strictEqual(x.basis, 'CO');
  assert.deepStrictEqual(st.periods.map(p => p.col), ['G']);
  assert.strictEqual(st.rows.find(r => r.id === 'bs.ppe').figs[0].f.v, 320);
  assert.strictEqual(st.components.length, 3);
});

test('recon lists differences against the sum of components and explains rounding plugs', () => {
  const v = B.build([X.extractWorkbook(sampleBook(), { name: 's.xlsx' })]);
  const r = RC.reconcile(v, {});
  const tot = r.rows.find(x => x.check === 'Subtotal' && x.line === 'pl.exp_tot' && x.p === 'FY2027-Q2');
  assert.strictEqual(tot.status, 'Agrees');
  const bal = r.rows.find(x => x.check === 'Balance' && x.p === 'BS-2026-09-30');
  assert.strictEqual(bal.status, 'Agrees');
});

test('a total that does not add up is a difference, never forced to agree', () => {
  const book = sampleBook({ revQ2: 650 });   // total income left at 610 in the source would be wrong: build one explicitly
  const x = X.extractWorkbook(book, { name: 's.xlsx' });
  const st = x.statements.find(s => s.type === 'SEBI');
  st.rows.find(r => r.id === 'pl.tot_inc').figs[0].f.v = 700;   // simulate a broken total
  const r = RC.reconcile(B.build([x]), {});
  const row = r.rows.find(z => z.line === 'pl.tot_inc' && z.p === 'FY2027-Q2' && z.check === 'Subtotal');
  assert.strictEqual(row.status, 'Material difference');
  assert.ok(Math.abs(row.diff - 40) < 1e-9);
});

test('two workbooks with different figures for the same period: original vs latest, decision request above materiality', () => {
  const a = X.extractWorkbook(sampleBook({ revQ2: 600 }), { name: 'a.xlsx' });
  const b = X.extractWorkbook(sampleBook({ revQ2: 605 }), { name: 'b.xlsx' });
  b.reportingDate = '2026-12-31';   // b is the later workbook: its Sep-26 columns become comparatives
  for (const s of b.statements) for (const p of s.periods) if (p.role === 'primary') p.role = 'comparative';
  const v = B.build([a, b]);
  const orig = M.cell(M.makeCtx(v), 'SA', 'pl.rev', 'FY2027-Q2');
  const late = M.cell(M.makeCtx(v, { mode: 'latest' }), 'SA', 'pl.rev', 'FY2027-Q2');
  assert.strictEqual(orig.v, 600);
  assert.strictEqual(late.v, 605);
  const r = RC.reconcile(v, {});
  assert.ok(r.decisions.some(d => d.l === 'pl.rev' && d.p === 'FY2027-Q2'));
  // a recorded decision overrides the priority for its version
  const dk = M.factKey(v.facts.find(f => f.l === 'pl.rev' && f.p === 'FY2027-Q2' && f.v === 605));
  const decided = M.cell(M.makeCtx(v, { decisions: { 'SA|pl.rev|FY2027-Q2|original': dk } }), 'SA', 'pl.rev', 'FY2027-Q2');
  assert.strictEqual(decided.v, 605);
  assert.ok(decided.decided);
});

test('derivation: Q2 = H1 − Q1 only when Q2 is not reported; EPS and balance sheets are never derived', () => {
  const x = X.extractWorkbook(sampleBook(), { name: 's.xlsx' });
  const st = x.statements.find(s => s.type === 'SEBI');
  st.periods = st.periods.filter(p => p.period !== 'FY2027-Q2');
  st.rows.forEach(r => { r.figs = r.figs.filter(f => f.pc.period !== 'FY2027-Q2'); });
  const v = B.build([x]);
  const ctx = M.makeCtx(v);
  const q2 = M.cell(ctx, 'SA', 'pl.rev', 'FY2027-Q2');
  assert.strictEqual(q2.st, 'derived');
  assert.strictEqual(q2.v, 600);
  assert.strictEqual(M.cell(ctx, 'SA', 'pl.eps_basic', 'FY2027-Q2').st, 'missing');
  assert.strictEqual(M.cell(ctx, 'SA', 'bs.ta', 'BS-2026-06-30').st, 'missing');
});

test('ratios: averages, annualisation, proxies and missing inputs are labelled; alerts are never green without data and a threshold', () => {
  const v = B.build([X.extractWorkbook(sampleBook(), { name: 's.xlsx' })]);
  const ctx = M.makeCtx(v);
  const r = RA.compute(ctx, 'SA', 'FY2027-H1', {});
  assert.strictEqual(r.values['liq.cr'].v, 100 / 50);
  assert.ok(r.values['eff.asset_turn'].annualised, 'interim turnover annualised');
  assert.ok(Math.abs(r.values['eff.asset_turn'].v - (1000 * 365 / 183) / ((600 + 530) / 2)) < 1e-9, 'average total assets');
  assert.strictEqual(r.values['prof.roe'].status, 'Missing Input');   // the synthetic book has no PAT line
  assert.strictEqual(r.values['unit.occupancy'].status, 'Missing Input');
  assert.strictEqual(r.values['sh.mcap'].status, 'Missing Input');
  const q2 = RA.compute(ctx, 'SA', 'FY2027-Q2', {});
  assert.strictEqual(q2.values['eff.asset_turn'].status, 'Proxy');   // no balance sheet at 30 June: closing balance, labelled
  const alerts = V.evaluateAlerts(r.values, {});
  assert.ok(alerts.every(a => !a.status.startsWith('Within')));
  const withT = V.evaluateAlerts(r.values, { 'liq.cr': { min: 1.5 } });
  assert.strictEqual(withT.find(a => a.id === 'liq.cr').status, 'Within threshold');
  const breach = V.evaluateAlerts(r.values, { 'liq.cr': { min: 3 } });
  assert.strictEqual(breach.find(a => a.id === 'liq.cr').status, 'Breach');
});

test('branch capacity is time-weighted over the days of the period', () => {
  const v = B.build([X.extractWorkbook(sampleBook(), { name: 's.xlsx' })]);
  const inputs = { records: [
    { type: 'branch_capacity', basis: 'SA', branch: 'A', effectiveDate: '2026-04-01', values: { branch: 'A', effectiveDate: '2026-04-01', capacitySeats: 100, occupiedSeats: 50 } },
    { type: 'branch_capacity', basis: 'SA', branch: 'A', effectiveDate: '2026-07-01', values: { branch: 'A', effectiveDate: '2026-07-01', capacitySeats: 200, occupiedSeats: 150 } },
  ] };
  const r = RA.compute(M.makeCtx(v), 'SA', 'FY2027-H1', inputs);
  const capDays = 100 * 91 + 200 * 92, occDays = 50 * 91 + 150 * 92;
  assert.ok(Math.abs(r.values['unit.occupancy'].v - occDays / capDays) < 1e-12);
  assert.ok(Math.abs(r.denominators.seats - capDays / 183) < 1e-9);
});
