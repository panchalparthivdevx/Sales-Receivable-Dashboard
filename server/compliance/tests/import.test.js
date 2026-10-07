'use strict';

// Excel import: preview writes nothing, Month/Quarter/Half checks, duplicates, blank vs #CLEAR,
// bulk update by Task ID, manual entry validation (same functions).

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const IE = require('../lib/importExport');
const T  = require('../lib/tasks');
const G  = require('../lib/taskGenerator');
const H  = require('./helpers');

function workbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const TASK_HEAD = ['Task ID', 'Company', 'FY', 'Month', 'Quarter', 'Half Year', 'Module', 'Compliance ID', 'Compliance Name', 'Applicable', 'Due Date', 'Responsible', 'Reviewer', 'Status', 'Completion Date', 'Remarks'];

test('template round-trip: template parses with example rows ignored', () => {
  const s = H.seededState();
  const buf = IE.buildWorkbook(s, H.settings(), { withData: false });
  const parsed = IE.parseWorkbook(buf);
  assert.deepEqual(parsed.found, ['Companies', 'Compliances', 'Applicability', 'Tasks']);
  for (const k of Object.keys(parsed.sheets)) assert.equal(parsed.sheets[k].length, 0, `${k} example row must be ignored`);
});

test('import rejects August + Q1 (and H2 + August); preview writes nothing', () => {
  const s = H.seededState();
  const buf = workbook({ Tasks: [TASK_HEAD,
    ['', 'DEVX', '2026-27', 'Aug', 'Q1', '', '', 'GST002', '', '', '', '', '', '', '', ''],
    ['', 'DEVX', '2026-27', 'Aug', '', 'H2', '', 'GST002', '', '', '', '', '', '', '', ''],
    ['', 'DEVX', '2026-27', 'Aug', 'Q2', 'H1', 'GST', 'GST002', '', 'Yes', '', 'Ravi', 'Kiran', '', '', ''],
  ] });
  const copy = JSON.parse(JSON.stringify(s));
  const r = IE.run(copy, IE.parseWorkbook(buf), H.ctx());
  assert.equal(s.tasks.length, 0, 'preview must not touch the real data');
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0].error, /August is in Q2, not Q1/);
  assert.match(r.errors[1].error, /August is in H1, not H2/);
  assert.ok(r.errors.every(e => e.sheet === 'Tasks' && e.row && e.field && e.fix));
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].id, 'DEVX-GST002-2026-27-AUG');
});

test('duplicates are skipped within the file and against existing data', () => {
  const s = H.seededState();
  G.generate(s, { fy: '2026-27', months: ['AUG'] }, H.ctx(), { apply: true });
  const buf = workbook({ Tasks: [TASK_HEAD,
    ['', 'DEVX', '2026-27', 'Sep', '', '', '', 'GST001', '', '', '', '', '', '', '', ''],
    ['', 'DEVX', '2026-27', 'September', '', '', '', 'GST001', '', '', '', '', '', '', '', ''],   // same as row 2
    ['', 'DEVX', '2026-27', 'Aug', '', '', '', 'GST001', '', '', '', '', '', '', '', ''],         // already in DB
  ] });
  const r = IE.run(s, IE.parseWorkbook(buf), H.ctx());
  assert.equal(r.actions.length, 1);
  assert.equal(r.skipped.length, 2);
  assert.match(r.skipped[0].error, /Duplicate of row 2/);
  assert.match(r.skipped[1].error, /already exists/);
});

test('bulk update by Task ID: blank = unchanged, #CLEAR = empty, Completed needs a date', () => {
  const s = H.seededState();
  const c = H.ctx();
  G.generate(s, { fy: '2026-27', months: ['AUG'] }, c, { apply: true });
  const id = 'DEVX-GST002-2026-27-AUG';
  T.updateTask(s, id, { responsible: 'Ravi', reviewer: 'Kiran', remarks: 'old note' }, c);
  const buf = workbook({ Tasks: [TASK_HEAD,
    [id, '', '', '', '', '', '', '', '', '', '', '', '#CLEAR', 'Completed', '18-09-2026', ''],
  ] });
  const r = IE.run(s, IE.parseWorkbook(buf), c);
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const t = s.tasks.find(x => x.task_id === id);
  assert.equal(t.responsible, 'Ravi');          // blank → unchanged
  assert.equal(t.reviewer, '');                 // #CLEAR → empty
  assert.equal(t.remarks, 'old note');
  assert.equal(t.status, 'Completed');
  assert.equal(t.completion_date, '2026-09-18');
});

test('import validates company, FY, month, compliance, dates and identity changes', () => {
  const s = H.seededState();
  G.generate(s, { fy: '2026-27', months: ['AUG'] }, H.ctx(), { apply: true });
  const buf = workbook({ Tasks: [TASK_HEAD,
    ['', 'NOPE', '2026-27', 'Aug', '', '', '', 'GST002', '', '', '', '', '', '', '', ''],
    ['', 'DEVX', '2030-31', 'Aug', '', '', '', 'GST002', '', '', '', '', '', '', '', ''],
    ['', 'DEVX', '2026-27', 'Augu', '', '', '', 'GST002', '', '', '', '', '', '', '', ''],
    ['', 'DEVX', '2026-27', 'Sep', '', '', '', 'XYZ999', '', '', '', '', '', '', '', ''],
    ['', 'DEVX', '2026-27', 'Sep', '', '', '', 'GST002', '', '', '31-02-2026', '', '', '', '', ''],
    ['DEVX-GST002-2026-27-AUG', '', '', 'Sep', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['', 'DEVX', '2026-27', 'Oct', '', '', '', 'GST002', '', '', '', '', '', 'Overdue', '', ''],
  ] });
  const r = IE.run(s, IE.parseWorkbook(buf), H.ctx());
  const msgs = r.errors.map(e => `${e.row}:${e.field}`);
  assert.deepEqual(msgs, ['2:company', '3:fy', '4:month', '5:compliance_id', '6:due_date', '7:month', '8:status']);
});

test('manual entry uses the same validation (August + Q1 rejected, Quarter/Half derived)', () => {
  const s = H.seededState();
  const bad = T.createTask(s, { company: 'DEVX', fy: '2026-27', month: 'Aug', quarter: 'Q1', compliance_id: 'GST001' }, H.ctx());
  assert.equal(bad.ok, false);
  const good = T.createTask(s, { company: 'DEVX', fy: '2026-27', month: 'Aug', compliance_id: 'GST001' }, H.ctx());
  assert.equal(good.ok, true);
  assert.equal(good.record.due_date, '2026-09-11');
  assert.equal(good.record.task_id, 'DEVX-GST001-2026-27-AUG');
  assert.equal(good.record.quarter, undefined, 'quarter is never stored — always derived');
});

test('master import: new company and compliance can be used by tasks in the same file', () => {
  const s = H.seededState();
  const buf = workbook({
    Companies: [['Company Name', 'Short Code', 'Status', 'Zoho Org ID', 'Remarks'], ['Test Co Pvt Ltd', 'TCO', 'Active', '', '']],
    Compliances: [['Compliance ID', 'Compliance Name', 'Module', 'Frequency', 'Due Date Rule', 'Form / Return Name', 'Applicable Months', 'Statutory Date', 'Remarks', 'Active'],
      ['GST099', 'Test Return', 'GST', 'Quarterly', 'Q1=31-Jul; Q2=31-Oct; Q3=31-Jan; Q4=31-May', '', '', 'Yes', '', 'Yes'],
      ['BAD01', 'Bad Rule', 'GST', 'Monthly', 'whenever', '', '', '', '', '']],
    Tasks: [TASK_HEAD, ['', 'TCO', '2026-27', 'Aug', '', '', '', 'GST099', '', '', '', '', '', '', '', '']],
  });
  const r = IE.run(s, IE.parseWorkbook(buf), H.ctx());
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].field, 'due_rule');
  assert.ok(s.tasks.some(t => t.task_id === 'TCO-GST099-2026-27-Q2' && t.month === 'SEP' && t.due_date === '2026-10-31'));
});
