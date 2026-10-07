'use strict';

// Period mapping + selection validation (server) and the dependent filter logic (browser).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const P = require('../lib/period');

test('April → Q1/H1, August → Q2/H1, November → Q3/H2, February → Q4/H2', () => {
  assert.deepEqual([P.quarterOf('APR'), P.halfOf('APR')], ['Q1', 'H1']);
  assert.deepEqual([P.quarterOf('Aug'), P.halfOf('August')], ['Q2', 'H1']);
  assert.deepEqual([P.quarterOf('NOV'), P.halfOf('nov')], ['Q3', 'H2']);
  assert.deepEqual([P.quarterOf('Feb'), P.halfOf('FEB')], ['Q4', 'H2']);
});

test('every month maps to exactly one quarter and half, consistently', () => {
  for (const m of P.MONTHS) {
    assert.ok(P.QUARTERS[m.quarter].months.includes(m.key));
    assert.equal(P.QUARTERS[m.quarter].half, m.half);
    assert.ok(P.HALVES[m.half].months.includes(m.key));
  }
});

test('selection: August + Q1 is rejected; August alone derives Q2/H1', () => {
  const bad = P.validateSelection({ fy: '2026-27', month: 'AUG', quarter: 'Q1' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /August belongs to Q2, not Q1/);
  const good = P.validateSelection({ fy: '2026-27', month: 'AUG' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.selection, { fy: '2026-27', half: 'H1', quarter: 'Q2', month: 'AUG' });
  assert.deepEqual(good.months, ['AUG']);
});

test('selection: H1 + Q3 and H2 + August are rejected', () => {
  assert.equal(P.validateSelection({ fy: '2026-27', half: 'H1', quarter: 'Q3' }).ok, false);
  assert.equal(P.validateSelection({ fy: '2026-27', half: 'H2', month: 'AUG' }).ok, false);
});

test('selection month lists: H1 = Apr–Sep, H2 = Oct–Mar, Q1 = Apr–Jun only', () => {
  assert.deepEqual(P.validateSelection({ fy: '2026-27', half: 'H1' }).months, ['APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP']);
  assert.deepEqual(P.validateSelection({ fy: '2026-27', half: 'H2' }).months, ['OCT', 'NOV', 'DEC', 'JAN', 'FEB', 'MAR']);
  assert.deepEqual(P.validateSelection({ fy: '2026-27', quarter: 'Q1' }).months, ['APR', 'MAY', 'JUN']);
});

test('FY normalisation and calendar mapping', () => {
  assert.equal(P.normFY('FY 2026-27'), '2026-27');
  assert.equal(P.normFY('2026-2027'), '2026-27');
  assert.equal(P.normFY('2026-28'), null);
  assert.deepEqual(P.calendarOf('2026-27', 'JAN'), { year: 2027, month: 1 });
  assert.deepEqual(P.monthRange('2026-27', 'FEB'), { from: '2027-02-01', to: '2027-02-28' });
  assert.deepEqual(P.monthRange('2027-28', 'FEB'), { from: '2028-02-01', to: '2028-02-29' });
});

test('period keys and anchor months', () => {
  assert.equal(P.periodKeyFor('Quarterly', 'AUG'), 'Q2');
  assert.equal(P.anchorMonth('Q2'), 'SEP');
  assert.equal(P.anchorMonth('H1'), 'SEP');
  assert.equal(P.anchorMonth('FY'), 'MAR');
  assert.equal(P.anchorMonth('AUG'), 'AUG');
});

// ── Browser filter logic (client/src/pages/compliance/filterLogic.js) ────────
async function loadFilterLogic() {
  const file = path.resolve(__dirname, '..', '..', '..', 'client', 'src', 'pages', 'compliance', 'filterLogic.js');
  return import(pathToFileURL(file).href);
}

test('UI: H1 enables only Q1/Q2; H2 only Q3/Q4', async () => {
  const FL = await loadFilterLogic();
  const idx = FL.buildPeriodIndex(P.periodMeta());
  const en = half => FL.quarterOptions(idx, half).filter(q => q.enabled).map(q => q.key);
  assert.deepEqual(en('H1'), ['Q1', 'Q2']);
  assert.deepEqual(en('H2'), ['Q3', 'Q4']);
  assert.deepEqual(en('All'), ['Q1', 'Q2', 'Q3', 'Q4']);
});

test('UI: each quarter enables only its three months', async () => {
  const FL = await loadFilterLogic();
  const idx = FL.buildPeriodIndex(P.periodMeta());
  for (const q of P.QUARTER_KEYS) {
    const enabled = FL.monthOptions(idx, P.QUARTERS[q].half, q).filter(m => m.enabled).map(m => m.key);
    assert.deepEqual(enabled, P.QUARTERS[q].months, q);
  }
});

test('UI: selecting a month auto-fills quarter and half', async () => {
  const FL = await loadFilterLogic();
  const idx = FL.buildPeriodIndex(P.periodMeta());
  const f = FL.applyFilterChange(idx, FL.emptyFilters('2026-27'), 'month', 'AUG');
  assert.deepEqual([f.month, f.quarter, f.half], ['AUG', 'Q2', 'H1']);
  const g = FL.applyFilterChange(idx, FL.emptyFilters('2026-27'), 'month', 'FEB');
  assert.deepEqual([g.month, g.quarter, g.half], ['FEB', 'Q4', 'H2']);
});

test('UI: August + Q1 is impossible — changing a parent resets the child to All', async () => {
  const FL = await loadFilterLogic();
  const idx = FL.buildPeriodIndex(P.periodMeta());
  let f = FL.applyFilterChange(idx, FL.emptyFilters('2026-27'), 'month', 'AUG');   // AUG/Q2/H1
  f = FL.applyFilterChange(idx, f, 'quarter', 'Q1');
  assert.deepEqual([f.quarter, f.month, f.half], ['Q1', 'All', 'H1']);
  assert.ok(FL.isValidCombo(idx, f));
  f = FL.applyFilterChange(idx, FL.applyFilterChange(idx, f, 'month', 'MAY'), 'half', 'H2');
  assert.deepEqual([f.half, f.quarter, f.month], ['H2', 'All', 'All']);
  // August is not even offered as enabled while Q1 is selected
  const q1 = FL.applyFilterChange(idx, FL.emptyFilters('2026-27'), 'quarter', 'Q1');
  assert.equal(FL.monthOptions(idx, q1.half, q1.quarter).find(m => m.key === 'AUG').enabled, false);
  // An exhaustive walk: no reachable state is ever invalid
  const values = { half: ['All', 'H1', 'H2'], quarter: ['All', 'Q1', 'Q2', 'Q3', 'Q4'], month: ['All', ...P.MONTH_KEYS] };
  let states = [FL.emptyFilters('2026-27')];
  for (let step = 0; step < 3; step++) {
    const next = [];
    for (const s of states) for (const [field, vals] of Object.entries(values)) for (const v of vals) {
      const r = FL.applyFilterChange(idx, s, field, v);
      assert.ok(FL.isValidCombo(idx, r), `invalid after ${field}=${v}: ${JSON.stringify(r)}`);
      next.push(r);
    }
    states = next.slice(0, 400);
  }
});
