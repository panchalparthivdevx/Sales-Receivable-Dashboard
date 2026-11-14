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

test('basis and reporting date come from the statement titles', { skip }, () => {
  load();
  assert.strictEqual(wb('Standalone DevX Q1').basis, 'SA');
  assert.strictEqual(wb('Consolidated DevX Q1').basis, 'CO');
  assert.strictEqual(wb('Standalone FS SEP26').reportingDate, '2026-09-30');
  assert.strictEqual(wb('Standalone FS FY 2025-26').reportingDate, '2026-03-31');
  assert.strictEqual(wb('Standalone DevX Q1').reportingDate, '2026-06-30');
});

test('the Q1 sheet named "SEBI Results PL Q4 FY 25-26" is mapped to the quarter ended 30 June 2026 and flagged', { skip }, () => {
  load();
  const st = wb('Standalone DevX Q1').statements.find(s => s.type === 'SEBI');
  assert.strictEqual(st.sheet, 'SEBI Results PL Q4 FY 25-26');
  assert.deepStrictEqual(st.periods.filter(p => p.role === 'primary').map(p => p.period), ['FY2027-Q1']);
  assert.ok(st.issues.some(i => i.code === 'STALE_SHEET_NAME'));
  const rev = fact('SA', 'pl.rev', 'FY2027-Q1', 'Standalone DevX Q1').find(f => f.k === 'SEBI');
  assert.ok(Math.abs(rev.v - 4198.417838) < 1e-6);
});

test('March balance sheets and annual cash flows inside the Q1 workbooks are not relabelled as June', { skip }, () => {
  load();
  for (const name of ['Standalone DevX Q1', 'Consolidated DevX Q1']) {
    const x = wb(name);
    const bs = x.statements.filter(s => s.type === 'BS');
    assert.ok(bs.length, `${name} has a balance sheet`);
    for (const s of bs) for (const p of s.periods) assert.notStrictEqual(p.period, 'BS-2026-06-30');
    for (const s of x.statements.filter(s => s.type === 'CF')) for (const p of s.periods) assert.ok(!['FY2027-Q1'].includes(p.period), `${name} CF column ${p.col} is ${p.period}`);
  }
  // nothing anywhere claims a June-2026 balance sheet
  assert.ok(!v.facts.some(f => f.p === 'BS-2026-06-30'));
  assert.ok(!M.periodsFor(ctx.ix, 'SA', 'BS').some(p => p.id === 'BS-2026-06-30'));
});

test('September results keep Q2 and H1 apart (same end date, different start and length)', { skip }, () => {
  load();
  const st = wb('Standalone FS SEP26').statements.find(s => s.type === 'SEBI');
  const ids = st.periods.map(p => p.period);
  assert.deepStrictEqual(ids, ['FY2027-Q2', 'FY2027-Q1', 'FY2026-Q2', 'FY2027-H1', 'FY2026-H1', 'FY2026-FY']);
  assert.ok(Math.abs(M.val(ctx, 'SA', 'pl.rev', 'FY2027-Q2') - 6299.162351) < 1e-5);
  assert.ok(Math.abs(M.val(ctx, 'SA', 'pl.rev', 'FY2027-H1') - 10497.58019) < 1e-5);
});

test('consolidated statements take the final consolidated column, never a company or elimination column', { skip }, () => {
  load();
  const bs = wb('Consolidated FS SEP26').statements.find(s => s.type === 'BS');
  assert.deepStrictEqual(bs.periods.map(p => p.col), ['H', 'M', 'N']);
  assert.ok(bs.components.some(c => /DevX/.test(c.header)) && bs.components.some(c => /Elim/.test(c.header)));
  assert.ok(Math.abs(M.val(ctx, 'CO', 'bs.ta', 'BS-2026-09-30') - 87612.188487) < 1e-4);
  assert.ok(Math.abs(M.val(ctx, 'SA', 'bs.ta', 'BS-2026-09-30') - 82990.864335) < 1e-4);
});

test('standalone and consolidated stay separate', { skip }, () => {
  load();
  const sa = M.val(ctx, 'SA', 'pl.pat', 'FY2026-FY'), co = M.val(ctx, 'CO', 'pl.pat', 'FY2026-FY');
  assert.ok(Math.abs(sa - 263.784475) < 1e-5, `SA PAT ${sa}`);
  assert.ok(Math.abs(co - 884.213791) < 1e-5, `CO PAT ${co}`);
  assert.ok(v.facts.every(f => f.b === 'SA' || f.b === 'CO'));
});

test('Excel errors stay errors — never zero', { skip }, () => {
  load();
  const errs = v.facts.filter(f => f.st === 'error');
  assert.ok(errs.length > 0);
  assert.ok(errs.every(f => f.v === null && f.err));
  const c = M.cell(ctx, 'SA', 'cf.net', 'FY2025-H1');      // #VALUE! in the FY26 workbook; no other valid source
  assert.ok(c.v === null || c.fact?.st !== 'error' || c.st === 'error');
});

test('FY2025-26 is shown as originally reported (audited annual workbook); later restatements stay visible', { skip }, () => {
  load();
  const orig = M.cell(ctx, 'CO', 'pl.exp_dep', 'FY2026-FY');
  assert.match(v.files[orig.fact.f].name, /FY 2025-26/);
  assert.ok(Math.abs(orig.v - 5888.23568) < 1e-5);
  assert.ok(orig.alts.some(a => Math.abs(a.v - 5888.012495) < 1e-6), 'Sep-26 figure kept as an alternative');
  const latest = M.cell(M.makeCtx(v, { mode: 'latest' }), 'CO', 'pl.exp_dep', 'FY2026-FY');
  assert.match(v.files[latest.fact.f].name, /SEP26/);
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
  const q2 = fact('SA', 'pl.rev', 'FY2027-Q2', 'Standalone FS SEP26').find(f => f.k === 'SEBI');
  assert.deepStrictEqual(q2.der, { plus: 'FY2027-H1', minus: 'FY2027-Q1' });
  const issues = v.issues.filter(i => i.code === 'EPS_DERIVED_IN_SOURCE');
  assert.ok(issues.length >= 1);
  assert.ok(v.facts.some(f => f.plug));
});
