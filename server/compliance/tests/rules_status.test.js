'use strict';

// Due Date Rule mini-language + status engine (KPI maths, computed statuses).

const test = require('node:test');
const assert = require('node:assert/strict');
const R  = require('../lib/dueDateRules');
const SE = require('../lib/statusEngine');
const H  = require('./helpers');

const due = (rule, fy, pk) => R.dueDateFor(rule, fy, pk).date;

test('rule: Nth / last day of following month (with clamping)', () => {
  assert.equal(due('11th of following month', '2026-27', 'AUG'), '2026-09-11');
  assert.equal(due('20 of next month', '2026-27', 'MAR'), '2027-04-20');
  assert.equal(due('last day of following month', '2026-27', 'JAN'), '2027-02-28');
  assert.equal(due('31st of following month', '2026-27', 'JAN'), '2027-02-28');          // clamp
  assert.equal(due('31st of following month', '2027-28', 'JAN'), '2028-02-29');          // leap year
  assert.equal(due('7th of same month', '2026-27', 'JUN'), '2026-06-07');
  assert.equal(due('15th of 2 months after', '2026-27', 'DEC'), '2027-02-15');
});

test('rule: month override MAR=30-Apr (TDS payment)', () => {
  const rule = '7th of following month; MAR=30-Apr';
  assert.equal(due(rule, '2026-27', 'FEB'), '2027-03-07');
  assert.equal(due(rule, '2026-27', 'MAR'), '2027-04-30');
});

test('rule: quarterly dates Q1=31-Jul; Q2=31-Oct; Q3=31-Jan; Q4=31-May', () => {
  const rule = 'Q1=31-Jul; Q2=31-Oct; Q3=31-Jan; Q4=31-May';
  assert.equal(due(rule, '2026-27', 'Q1'), '2026-07-31');
  assert.equal(due(rule, '2026-27', 'Q2'), '2026-10-31');
  assert.equal(due(rule, '2026-27', 'Q3'), '2027-01-31');
  assert.equal(due(rule, '2026-27', 'Q4'), '2027-05-31');
});

test('rule: annual fixed date comes after the FY ends (GSTR-9 31-Dec, ITR 31-Jul)', () => {
  assert.equal(due('31-Dec', '2025-26', 'FY'), '2026-12-31');
  assert.equal(due('31-Jul', '2026-27', 'FY'), '2027-07-31');
  assert.equal(due('31-Feb', '2026-27', 'FY'), '2028-02-29');                            // first Feb after 31-Mar-2027, clamped (leap year)
  assert.equal(due('31-Feb', '2025-26', 'FY'), '2027-02-28');                            // clamped (non-leap year)
});

test('rule: invalid rules are rejected with a clear message', () => {
  assert.equal(R.parseRule('').ok, false);
  assert.match(R.parseRule('every month').error, /Could not understand/);
  assert.match(R.parseRule('Q5=31-Jul').error, /not a valid period/);
  assert.match(R.validateRule('Q1=31-Jul; Q2=31-Oct', 'Quarterly').error, /no date for: Q3, Q4/);
  assert.match(R.validateRule('MAR=30-Apr; 7th of following month', 'Quarterly').error, /cannot be used/);
  assert.equal(R.validateRule('7th of following month; MAR=30-Apr', 'Monthly').ok, true);
});

test('every seeded compliance rule is valid for its frequency', () => {
  const s = H.seededState();
  for (const c of s.compliances) assert.equal(R.validateRule(c.due_rule, c.frequency).ok, true, `${c.id}: ${c.due_rule}`);
});

test('status: Due Soon and Overdue are computed at read time, never stored', () => {
  const t = { applicable: true, status: 'Not Started', due_date: '2026-10-05' };
  const before = JSON.stringify(t);
  assert.equal(SE.displayStatus(t, '2026-10-03', 7), 'Due Soon');
  assert.equal(SE.displayStatus(t, '2026-10-06', 7), 'Overdue');
  assert.equal(SE.displayStatus(t, '2026-09-01', 7), 'Not Started');
  assert.equal(SE.displayStatus({ ...t, status: 'In Progress' }, '2026-09-01', 7), 'In Progress');
  assert.equal(SE.displayStatus({ ...t, status: 'Completed' }, '2026-10-06', 7), 'Completed');
  assert.equal(SE.displayStatus({ ...t, applicable: false }, '2026-10-06', 7), 'N/A');
  assert.equal(JSON.stringify(t), before, 'task object must not be modified');
  assert.equal(SE.normUserStatus('Overdue'), null, 'Overdue cannot be stored as a user status');
  assert.equal(SE.normUserStatus('Due Soon'), null, 'Due Soon cannot be stored as a user status');
});

test('KPI: Compliance % = Completed / (Total − N/A); N/A is never pending', () => {
  const rows = ['Completed', 'Completed', 'Overdue', 'N/A', 'N/A', 'Due Soon', 'In Progress', 'Not Started'].map(s => ({ display_status: s }));
  const k = SE.stats(rows);
  assert.equal(k.total, 8);
  assert.equal(k.na, 2);
  assert.equal(k.completed, 2);
  assert.equal(k.pending, 4);                       // Overdue + Due Soon + In Progress + Not Started
  assert.equal(k.compliance_pct, Math.round((2 / 6) * 1000) / 10);   // 33.3, not 25
  assert.equal(SE.stats([{ display_status: 'N/A' }]).compliance_pct, null);
});
