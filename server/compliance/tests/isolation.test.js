'use strict';

// Period isolation (highest priority): a selection only ever returns its own months.
// Also covers task generation (no duplicates, N/A from applicability, Task ID format).

const test = require('node:test');
const assert = require('node:assert/strict');
const P  = require('../lib/period');
const G  = require('../lib/taskGenerator');
const RP = require('../lib/reports');
const M  = require('../lib/masters');
const H  = require('./helpers');

function fullYear() {
  const state = H.seededState();
  const c = H.ctx();
  G.generate(state, { fy: '2026-27', months: P.MONTH_KEYS }, c, { apply: true });
  G.generate(state, { fy: '2025-26', months: P.MONTH_KEYS }, c, { apply: true });
  return state;
}
const pick = (state, sel) => RP.selectTasks(state, P.validateSelection(sel));

test('Task ID format COMPANYSHORT-COMPLIANCEID-FY-PERIODKEY', () => {
  const s = fullYear();
  assert.ok(s.tasks.some(t => t.task_id === 'DEVX-GST002-2026-27-AUG'));
  assert.ok(s.tasks.some(t => t.task_id === 'DEVX-TDS003-2026-27-Q1' && t.month === 'JUN'));
  assert.ok(s.tasks.some(t => t.task_id === 'DEVX-GST005-2026-27-FY' && t.month === 'MAR'));
});

test('April data never appears under August (and vice versa)', () => {
  const s = fullYear();
  const aug = pick(s, { fy: '2026-27', month: 'AUG' });
  const apr = pick(s, { fy: '2026-27', month: 'APR' });
  assert.ok(aug.length > 0 && apr.length > 0);
  assert.ok(aug.every(t => t.month === 'AUG' && t.fy === '2026-27'));
  assert.ok(apr.every(t => t.month === 'APR' && t.fy === '2026-27'));
  const ids = new Set(aug.map(t => t.task_id));
  assert.ok(apr.every(t => !ids.has(t.task_id)));
});

test('H1 never mixes with H2', () => {
  const s = fullYear();
  const h1 = pick(s, { fy: '2026-27', half: 'H1' });
  const h2 = pick(s, { fy: '2026-27', half: 'H2' });
  assert.ok(h1.every(t => P.halfOf(t.month) === 'H1'));
  assert.ok(h2.every(t => P.halfOf(t.month) === 'H2'));
  const ids = new Set(h1.map(t => t.task_id));
  assert.ok(h2.every(t => !ids.has(t.task_id)));
  assert.equal(h1.length + h2.length, pick(s, { fy: '2026-27' }).length);
});

test('Q1 never mixes with Q2, Q3 or Q4', () => {
  const s = fullYear();
  const byQ = Object.fromEntries(P.QUARTER_KEYS.map(q => [q, pick(s, { fy: '2026-27', quarter: q })]));
  for (const q of P.QUARTER_KEYS) assert.ok(byQ[q].every(t => P.quarterOf(t.month) === q), q);
  const q1 = new Set(byQ.Q1.map(t => t.task_id));
  for (const q of ['Q2', 'Q3', 'Q4']) assert.ok(byQ[q].every(t => !q1.has(t.task_id)), q);
});

test('FYs never mix', () => {
  const s = fullYear();
  assert.ok(pick(s, { fy: '2025-26', month: 'AUG' }).every(t => t.fy === '2025-26'));
  assert.ok(pick(s, { fy: '2026-27', month: 'AUG' }).every(t => t.fy === '2026-27'));
});

test('quarterly task sits in its period end month only (TDS Q1 return under June)', () => {
  const s = fullYear();
  assert.ok(pick(s, { fy: '2026-27', month: 'JUN' }).some(t => t.task_id === 'DEVX-TDS003-2026-27-Q1'));
  for (const m of ['APR', 'MAY', 'JUL']) assert.ok(!pick(s, { fy: '2026-27', month: m }).some(t => t.task_id === 'DEVX-TDS003-2026-27-Q1'), m);
});

test('generation never duplicates; re-running skips existing tasks', () => {
  const s = fullYear();
  const before = s.tasks.length;
  const again = G.generate(s, { fy: '2026-27', months: P.MONTH_KEYS }, H.ctx(), { apply: true });
  assert.equal(again.create.length, 0);
  assert.equal(s.tasks.length, before);
  assert.equal(new Set(s.tasks.map(t => t.task_id)).size, s.tasks.length);
});

test('preview generation does not change the data', () => {
  const s = H.seededState();
  const g = G.generate(s, { fy: '2026-27', months: ['AUG'] }, H.ctx(), { apply: false });
  assert.ok(g.create.length > 0);
  assert.equal(s.tasks.length, 0);
});

test('LWF (Applicable Months JUN,DEC) is only generated for June and December', () => {
  const s = fullYear();
  const lwf = s.tasks.filter(t => t.compliance_id === 'PAY004' && t.company_id === 'CO-001' && t.fy === '2026-27');
  assert.deepEqual(lwf.map(t => t.month).sort(), ['DEC', 'JUN']);
});

test('applicability No creates N/A tasks; switching back restores open tasks', () => {
  const s = H.seededState();
  const c = H.ctx();
  M.saveApplicability(s, { company: 'SAAS', compliance_id: 'PAY002', applicable: 'No' }, c);
  G.generate(s, { fy: '2026-27', months: ['AUG'] }, c, { apply: true });
  const t = s.tasks.find(x => x.task_id === 'SAAS-PAY002-2026-27-AUG');
  assert.equal(t.applicable, false);
  assert.equal(t.na_source, 'applicability');
  const r = M.saveApplicability(s, { company: 'SAAS', compliance_id: 'PAY002', applicable: 'Yes', responsible: 'Meena' }, c);
  assert.ok(r.ok);
  assert.equal(t.applicable, true);
  assert.equal(t.responsible, 'Meena');
});
