/**
 * The six real workbooks (skipped when the folder is not on this machine): the mapping traps from the brief.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const X = require('../lib/extract');
const B = require('../lib/build');
const M = require('../lib/model');

const skip = !H.hasReal() && 'real workbooks not present';
let xs = null, v = null, ctx = null;
const load = () => {
  if (xs) return;
  xs = fs.readdirSync(H.REAL_DIR).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$')).map(f => X.extractWorkbook(fs.readFileSync(path.join(H.REAL_DIR, f)), { name: f }));
  v = B.build(xs);
  ctx = M.makeCtx(v);
};
const wb = name => xs.find(x => x.file.name.includes(name));
const fact = (b, l, p, f) => v.facts.filter(fc => fc.b === b && fc.l === l && fc.p === p && (f == null || v.files[fc.f].name.includes(f)));

const Q1 = 'FY 2026-27_Q-1', Q2 = 'FY 2026-27_Q-2';
const near = (a, b, tol = 1e-5) => assert.ok(a != null && Math.abs(a - b) < tol, `${a} ≠ ${b}`);

test('basis and reporting date come from the statement titles', { skip }, () => {
  load();
  for (const x of xs) assert.strictEqual(x.basis, 'SA', `${x.file.name} is standalone`);
  const dates = { 'FY 2022-23': '2023-03-31', 'FY 2023-24': '2024-03-31', 'FY 2024-25': '2025-03-31', 'FY 2025-26': '2026-03-31', [Q1]: '2026-06-30', [Q2]: '2026-09-30' };
  for (const [k, d] of Object.entries(dates)) assert.strictEqual(wb(k).reportingDate, d, k);
});

test('the Q1 sheet named "SEBI Results PL Q4 FY 25-26" is mapped to the quarter ended 30 June 2026 and flagged', { skip }, () => {
  load();
  const st = wb(Q1).statements.find(s => s.type === 'SEBI');
  assert.strictEqual(st.sheet, 'SEBI Results PL Q4 FY 25-26');
  assert.deepStrictEqual(st.periods.filter(p => p.role === 'primary').map(p => p.period), ['FY2027-Q1']);
  assert.ok(st.issues.some(i => i.code === 'STALE_SHEET_NAME'));
  near(fact('SA', 'pl.rev', 'FY2027-Q1', Q1).find(f => f.k === 'SEBI').v, 4198.417838, 1e-6);
});

test('March balance sheets and annual cash flows inside the Q1 workbook are not relabelled as June', { skip }, () => {
  load();
  const x = wb(Q1);
  const bs = x.statements.filter(s => s.type === 'BS');
  assert.ok(bs.length);
  for (const s of bs) for (const p of s.periods) assert.notStrictEqual(p.period, 'BS-2026-06-30');
  for (const s of x.statements.filter(s => s.type === 'CF')) for (const p of s.periods) assert.notStrictEqual(p.period, 'FY2027-Q1');
  assert.ok(!v.facts.some(f => f.p === 'BS-2026-06-30'));
  assert.ok(!M.periodsFor(ctx.ix, 'SA', 'BS').some(p => p.id === 'BS-2026-06-30'));
});

test('September results keep Q2 and H1 apart (same end date, different start and length)', { skip }, () => {
  load();
  const st = wb(Q2).statements.find(s => s.type === 'SEBI');
  assert.deepStrictEqual(st.periods.map(p => p.period), ['FY2027-Q2', 'FY2027-Q1', 'FY2026-Q2', 'FY2027-H1', 'FY2026-H1', 'FY2026-FY']);
  near(M.val(ctx, 'SA', 'pl.rev', 'FY2027-Q2'), 6299.162351);
  near(M.val(ctx, 'SA', 'pl.rev', 'FY2027-H1'), 10497.58019);
  near(M.val(ctx, 'SA', 'bs.ta', 'BS-2026-09-30'), 82990.864335, 1e-4);
});

test('consolidated statements take the final consolidated column (when a consolidated workbook is in the folder)', { skip }, t => {
  load();
  const co = xs.find(x => x.basis === 'CO' && x.reportingDate === '2026-09-30');
  if (!co) { t.skip('no consolidated workbook in the folder — the import is standalone only'); return; }
  const bs = co.statements.find(s => s.type === 'BS');
  assert.ok(bs.components.some(c => /DevX/.test(c.header)) && bs.components.some(c => /Elim/.test(c.header)));
});

test('only standalone figures are imported from a standalone folder', { skip }, () => {
  load();
  near(M.val(ctx, 'SA', 'pl.pat', 'FY2026-FY'), 263.784475);
  if (!xs.some(x => x.basis === 'CO')) {
    assert.ok(v.facts.every(f => f.b === 'SA'));
    assert.deepStrictEqual(M.periodsFor(ctx.ix, 'CO', 'PL'), []);
  }
});

test('Excel errors stay errors — never zero', { skip }, () => {
  load();
  const errs = v.facts.filter(f => f.st === 'error');
  assert.ok(errs.length > 0);
  assert.ok(errs.every(f => f.v === null && f.err));
});

test('a later workbook restating a year: original vs latest, marked Restated with no decision request', { skip }, () => {
  load();
  const orig = M.cell(ctx, 'SA', 'pl.pat', 'FY2024-FY');
  assert.match(v.files[orig.fact.f].name, /FY 2023-24/);
  near(orig.v, -5192.084104, 1e-5);
  near(M.cell(M.makeCtx(v, { mode: 'latest' }), 'SA', 'pl.pat', 'FY2024-FY').v, 51.035747, 1e-5);
  const RC = require('../lib/recon');
  const r = RC.reconcile(v, { ctx: M.makeCtx(v, { ix: ctx.ix }) });
  assert.ok(r.rows.some(x => x.check === 'Repeated figure' && x.line === 'pl.pat' && x.p === 'FY2024-FY' && x.status === 'Restated'));
  assert.ok(!r.decisions.some(d => d.l === 'pl.pat' && d.p === 'FY2024-FY'));
});

test('derived periods are labelled and never used for EPS or balance sheets', { skip }, () => {
  load();
  const h2 = M.cell(ctx, 'SA', 'pl.rev', 'FY2026-H2');
  assert.strictEqual(h2.st, 'derived');
  assert.strictEqual(h2.derived.formula, 'FY − H1');
  assert.strictEqual(M.cell(ctx, 'SA', 'pl.eps_basic', 'FY2026-H2').st, 'missing');
  assert.strictEqual(M.cell(ctx, 'SA', 'bs.ta', 'BS-2026-06-30').st, 'missing');
});

test('source-side derivations and rounding plugs are recorded', { skip }, () => {
  load();
  const q2 = fact('SA', 'pl.rev', 'FY2027-Q2', Q2).find(f => f.k === 'SEBI');
  assert.deepStrictEqual(q2.der, { plus: 'FY2027-H1', minus: 'FY2027-Q1' });
  assert.ok(v.issues.some(i => i.code === 'EPS_DERIVED_IN_SOURCE'));
  assert.ok(v.facts.some(f => f.plug));
});

test('loss years map to the profit lines ("Loss before tax", "Loss for the year", a note number after a label)', { skip }, () => {
  load();
  near(M.val(ctx, 'SA', 'pl.pbt', 'FY2023-FY'), -1598.35, 0.01);
  near(M.val(ctx, 'SA', 'pl.pat', 'FY2023-FY'), -1277.19, 0.01);
  near(M.val(ctx, 'SA', 'pl.exp_dep', 'FY2023-FY'), 3010.04, 0.01);
  const pl = wb('FY 2022-23').statements.find(s => s.type === 'PLD');
  assert.ok(!pl.rows.some(r => r.id.startsWith('pl.x.')), 'every P&L row of FY 2022-23 is a standard line');
});

test('a figure shown in lakh by its number format is read as shown, and flagged', { skip }, () => {
  load();
  near(M.val(ctx, 'SA', 'pl.rev', 'FY2022-FY'), 2409.95, 0.01);    // stored as rupees 24,09,94,851.44, format #\.00,
  assert.ok(wb('FY 2022-23').statements.flatMap(s => s.issues).some(i => i.code === 'FORMAT_SCALED' && i.cell === 'E5'));
  near(M.val(ctx, 'SA', 'bs.ta', 'BS-2022-03-31'), M.val(ctx, 'SA', 'bs.tel', 'BS-2022-03-31'), 0.05);
});

test('older notes layout (number and title in column A) is read, with the original cell references', { skip }, () => {
  load();
  for (const k of ['FY 2022-23', 'FY 2023-24']) assert.ok(wb(k).notes.length >= 20, `${k}: ${wb(k).notes.length} notes`);
  const rev = wb('FY 2022-23').notes.find(n => n.num === '22');
  assert.strictEqual(rev.title, 'Revenue from operations');
  const fy23 = rev.items.find(i => i.total).figs.find(g => g.p === 'FY2023-FY');
  near(fy23.v, 6123.8965553, 1e-6);
  assert.strictEqual(fy23.c, 'B10');
});

test('notes: Q1, Q2 and H1 FY27 columns; Q2 derived item by item from H1 − Q1 and agreeing with the Q2 statement', { skip }, () => {
  load();
  const V = require('../lib/views');
  const c = M.makeCtx(v, { ix: M.index(v) });
  const cols = M.notesDefaultColumns(v, 'SA');
  for (const p of ['BS-2026-09-30', 'FY2027-Q1', 'FY2027-Q2', 'FY2027-H1']) assert.ok(cols.includes(p), `notes columns include ${p}`);
  assert.ok(!cols.includes('BS-2026-06-30'), 'no June balance sheet exists in the workbooks');
  const nv = V.notesView(c, 'SA', cols);
  const emp = nv.groups.find(g => g.lines.includes('pl.exp_emp'));
  assert.strictEqual(emp.sourceNotes['FY2027-Q2'].derived, 'H1 − Q1');
  const tot = emp.rows.filter(r => r.total).pop().cells['FY2027-Q2'];
  assert.strictEqual(tot.st, 'derived');
  near(tot.v, emp.statement['FY2027-Q2'], 0.02);
  assert.ok(emp.sourceNotes['FY2027-Q1'].num && emp.rows.some(r => r.cells['FY2027-Q1']?.src));
  assert.ok(nv.groups.every(g => !g.sourceNotes['BS-2026-09-30']?.derived));
});
