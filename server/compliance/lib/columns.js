/**
 * Column definitions — the ONE place that lists the fields of every master and of tasks.
 *
 * Used by:  the Excel template, Excel import (header matching + validation), Excel export,
 *           and the browser UI (sent through GET /api/compliance/meta).
 * Add a field here and it appears in the template, import, export and UI tables together.
 *
 * Column properties
 *   key        field name in the data
 *   header     column title in Excel and in the UI
 *   required   must have a value when a NEW row is created
 *   type       text | enum | yesno | fy | month | quarter | half | date | rule | months | number
 *   info       shown/exported only — ignored on import
 *   help       one-line hint (template Instructions sheet + UI tooltips)
 *   example    value used in the template's example row
 *   width      Excel column width
 */

'use strict';

const SHEETS = {
  companies: {
    sheet: 'Companies',
    title: 'Company Master',
    keyHelp: 'Rows are matched on Short Code: an existing Short Code is updated, a new one is created.',
    columns: [
      { key: 'name',        header: 'Company Name', required: true, type: 'text', example: 'Example Industries Pvt Ltd', width: 34, help: 'Legal name of the company.' },
      { key: 'short_code',  header: 'Short Code',   required: true, type: 'text', example: 'EXMP', width: 12, help: '2–10 capital letters/digits. Used at the start of every Task ID. Key column.' },
      { key: 'status',      header: 'Status',       type: 'enum', values: ['Active', 'Inactive'], example: 'Active', width: 10, help: 'Inactive companies get no new tasks.' },
      { key: 'zoho_org_id', header: 'Zoho Org ID',  type: 'text', example: '', width: 16, help: 'Zoho Books organisation ID. Leave blank if the company is not in Zoho Books.' },
      { key: 'remarks',     header: 'Remarks',      type: 'text', example: '', width: 30 },
    ],
  },

  compliances: {
    sheet: 'Compliances',
    title: 'Compliance Master',
    keyHelp: 'Rows are matched on Compliance ID: an existing ID is updated, a new one is created.',
    columns: [
      { key: 'id',            header: 'Compliance ID',       required: true, type: 'text', example: 'GST099', width: 14, help: '2–12 capital letters/digits, e.g. GST002. Key column. Used in Task IDs.' },
      { key: 'name',          header: 'Compliance Name',     required: true, type: 'text', example: 'Example Return', width: 34 },
      { key: 'module',        header: 'Module',              required: true, type: 'enum', valuesFrom: 'modules', example: 'GST', width: 10, help: 'One of the modules in Lists / Settings.' },
      { key: 'frequency',     header: 'Frequency',           required: true, type: 'enum', valuesFrom: 'frequencies', example: 'Monthly', width: 12, help: 'Monthly, Quarterly, Half-Yearly or Annual.' },
      { key: 'due_rule',      header: 'Due Date Rule',       required: true, type: 'rule', example: '11th of following month', width: 40, help: 'See the Due Date Rule syntax in Instructions.' },
      { key: 'form_name',     header: 'Form / Return Name',  type: 'text', example: 'GSTR-1', width: 18 },
      { key: 'active_months', header: 'Applicable Months',   type: 'months', example: '', width: 18, help: 'Monthly only. Blank = every month. Otherwise a list like JUN,DEC.' },
      { key: 'statutory',     header: 'Statutory Date',      type: 'yesno', example: 'Yes', width: 10, help: 'Yes = date set by law (verify before use). No = internal deadline.' },
      { key: 'remarks',       header: 'Remarks',             type: 'text', example: 'Verify before use', width: 40 },
      { key: 'active',        header: 'Active',              type: 'yesno', example: 'Yes', width: 8, help: 'No = no new tasks are generated.' },
    ],
  },

  applicability: {
    sheet: 'Applicability',
    title: 'Company Applicability',
    keyHelp: 'Rows are matched on Company + Compliance ID. Applicable = No makes that company\'s open tasks N/A.',
    columns: [
      { key: 'company',       header: 'Company',        required: true, type: 'text', example: 'EXMP', width: 14, help: 'Company Short Code (or full name).' },
      { key: 'compliance_id', header: 'Compliance ID',  required: true, type: 'text', example: 'GST099', width: 14 },
      { key: 'applicable',    header: 'Applicable',     type: 'yesno', example: 'Yes', width: 11, help: 'No creates N/A tasks.' },
      { key: 'responsible',   header: 'Responsible',    type: 'text', example: 'Person A', width: 18 },
      { key: 'reviewer',      header: 'Reviewer',       type: 'text', example: 'Person B', width: 18 },
      { key: 'remarks',       header: 'Remarks',        type: 'text', example: '', width: 30 },
    ],
  },

  tasks: {
    sheet: 'Tasks',
    title: 'Task Data',
    keyHelp: 'Task ID filled = update that task (bulk update). Task ID blank = create a new task.',
    columns: [
      { key: 'task_id',         header: 'Task ID',          type: 'text', example: '', width: 30, help: 'Blank = new task (ID is created for you). Filled = update that task.' },
      { key: 'company',         header: 'Company',          required: true, type: 'text', example: 'EXMP', width: 14, help: 'Company Short Code (or full name).' },
      { key: 'fy',              header: 'FY',               required: true, type: 'fy', example: '2026-27', width: 10, help: 'Financial Year, e.g. 2026-27.' },
      { key: 'month',           header: 'Month',            required: true, type: 'month', example: 'Aug', width: 10, help: 'Apr … Mar. For quarterly/annual items any month of the period is accepted; the task is filed under the period\'s last month.' },
      { key: 'quarter',         header: 'Quarter',          type: 'quarter', example: 'Q2', width: 9, help: 'Optional. Checked against Month — August + Q1 is rejected.' },
      { key: 'half',            header: 'Half Year',        type: 'half', example: 'H1', width: 9, help: 'Optional. Checked against Month.' },
      { key: 'module',          header: 'Module',           type: 'text', example: 'GST', width: 10, help: 'Optional. Must match the compliance\'s module.' },
      { key: 'compliance_id',   header: 'Compliance ID',    required: true, type: 'text', example: 'GST099', width: 14 },
      { key: 'compliance_name', header: 'Compliance Name',  type: 'text', info: true, example: 'Example Return', width: 30, help: 'For reading only — ignored on import.' },
      { key: 'applicable',      header: 'Applicable',       type: 'yesno', example: 'Yes', width: 11 },
      { key: 'due_date',        header: 'Due Date',         type: 'date', example: '11-09-2026', width: 12, help: 'DD-MM-YYYY. Blank on a new task = calculated from the Due Date Rule.' },
      { key: 'responsible',     header: 'Responsible',      type: 'text', example: 'Person A', width: 18 },
      { key: 'reviewer',        header: 'Reviewer',         type: 'text', example: 'Person B', width: 18 },
      { key: 'status',          header: 'Status',           type: 'enum', values: ['Not Started', 'In Progress', 'Completed'], example: 'Not Started', width: 13, help: 'Due Soon / Overdue are calculated — do not type them.' },
      { key: 'completion_date', header: 'Completion Date',  type: 'date', example: '', width: 14, help: 'DD-MM-YYYY. Required when Status = Completed (defaults to today).' },
      { key: 'remarks',         header: 'Remarks',          type: 'text', example: '', width: 34 },
    ],
  },
};

/** Columns of the task table in the UI and in exports */
const TASK_VIEW = [
  { key: 'task_id',         header: 'Task ID',     ui: true,  export: true,  width: 30 },
  { key: 'company_name',    header: 'Company',     ui: true,  export: true,  width: 30 },
  { key: 'module',          header: 'Module',      ui: true,  export: true,  width: 10 },
  { key: 'compliance_name', header: 'Compliance',  ui: true,  export: true,  width: 32 },
  { key: 'period',          header: 'Period',      ui: true,  export: false, help: 'Month · Quarter · Half' },
  { key: 'period_label',    header: 'Period',      ui: false, export: true,  width: 18 },
  { key: 'month_label',     header: 'Month',       ui: false, export: true,  width: 11 },
  { key: 'quarter',         header: 'Quarter',     ui: false, export: true,  width: 9 },
  { key: 'half',            header: 'Half Year',   ui: false, export: true,  width: 9 },
  { key: 'due_date',        header: 'Due Date',    ui: true,  export: true,  type: 'date', width: 12 },
  { key: 'responsible',     header: 'Responsible', ui: true,  export: true,  width: 18 },
  { key: 'reviewer',        header: 'Reviewer',    ui: true,  export: true,  width: 18 },
  { key: 'display_status',  header: 'Status',      ui: true,  export: true,  type: 'status', width: 13 },
  { key: 'doc_count',       header: 'Docs',        ui: true,  export: true,  type: 'number', width: 8 },
  { key: 'completion_date', header: 'Completed On', ui: false, export: true, type: 'date', width: 13 },
  { key: 'remarks',         header: 'Remarks',     ui: false, export: true,  width: 34 },
];

/** Columns of the company-/module-wise summary reports */
const SUMMARY_VIEW = [
  { key: 'label',          header: 'Name' },
  { key: 'total',          header: 'Total' },
  { key: 'completed',      header: 'Done' },
  { key: 'pending',        header: 'Pending' },
  { key: 'overdue',        header: 'Overdue' },
  { key: 'na',             header: 'N/A' },
  { key: 'compliance_pct', header: 'Compliance %' },
];

/** Columns of the audit trail table/export */
const AUDIT_VIEW = [
  { key: 'at',        header: 'When',    type: 'datetime', width: 18 },
  { key: 'user',      header: 'User',    width: 16 },
  { key: 'action',    header: 'Action',  width: 10 },
  { key: 'entity',    header: 'Item',    width: 12 },
  { key: 'entity_id', header: 'ID',      width: 28 },
  { key: 'summary',   header: 'Summary', width: 50 },
  { key: 'changes',   header: 'Changes', type: 'changes', width: 60 },
];

/** Columns of the import error report */
const ERROR_REPORT = [
  { key: 'sheet', header: 'Sheet', width: 14 },
  { key: 'row',   header: 'Row',   width: 6 },
  { key: 'field', header: 'Field', width: 18 },
  { key: 'error', header: 'Error', width: 60 },
  { key: 'fix',   header: 'Suggested Fix', width: 50 },
];

const SHEET_ORDER = ['companies', 'compliances', 'applicability', 'tasks'];

module.exports = { SHEETS, SHEET_ORDER, TASK_VIEW, SUMMARY_VIEW, AUDIT_VIEW, ERROR_REPORT };
