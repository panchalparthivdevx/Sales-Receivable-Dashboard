/**
 * Tasks — one compliance, for one company, for one period.
 *
 *   Task ID      COMPANYSHORT-COMPLIANCEID-FY-PERIODKEY     e.g. DEVX-GST002-2026-27-AUG
 *   Identity     company + compliance + FY + period key (no duplicates)
 *   Period       `month` is the period's month (for quarterly/half-yearly/annual tasks the
 *                LAST month of the period). Quarter and Half are always derived from it.
 *
 * Manual entry, Excel import and bulk update all use createTask / updateTask, so they apply
 * the same validation. Functions mutate `state` only when the result is ok.
 */

'use strict';

const P  = require('./period');
const R  = require('./dueDateRules');
const F  = require('./fields');
const A  = require('./audit');
const SE = require('./statusEngine');
const M  = require('./masters');

const TASK_AUDIT_FIELDS = ['applicable', 'due_date', 'responsible', 'reviewer', 'status', 'completion_date', 'remarks'];

function buildTaskId(companyShort, complianceId, fy, periodKey) {
  return `${companyShort}-${complianceId}-${fy}-${periodKey}`.toUpperCase();
}

const identityKey = (companyId, complianceId, fy, periodKey) => `${companyId}|${complianceId}|${fy}|${periodKey}`;

function findDuplicate(state, companyId, complianceId, fy, periodKey, taskId) {
  const key = identityKey(companyId, complianceId, fy, periodKey);
  return state.tasks.find(t => identityKey(t.company_id, t.compliance_id, t.fy, t.period_key) === key || t.task_id === taskId) || null;
}

/**
 * Validate identity fields (company, FY, month, quarter, half, module, compliance).
 * Returns { errors, company, compliance, fy, month, periodKey }.
 */
function resolveIdentity(state, input, settings) {
  const errors = [];
  const err = (field, error, fix) => errors.push({ field, error, fix });

  const company = M.resolveCompany(state, input.company ?? input.company_id);
  if (input.company === undefined && input.company_id === undefined) err('company', 'Company is required.', 'Use a Short Code, e.g. DEVX.');
  else if (!company) err('company', `Company "${input.company ?? input.company_id}" not found.`, 'Use a Short Code from the Company Master.');

  let fy = null;
  if (input.fy === undefined || input.fy === '') err('fy', 'FY is required.', 'e.g. 2026-27');
  else {
    fy = P.normFY(input.fy);
    if (!fy) err('fy', `FY "${input.fy}" is not valid.`, 'Use the form 2026-27.');
    else if (!settings.fy_list.includes(fy)) err('fy', `FY ${fy} is not in the FY list.`, 'Add it in Master > Lists / Settings first.');
  }

  let month = null;
  if (input.month === undefined || input.month === '') err('month', 'Month is required.', 'e.g. Aug');
  else {
    month = P.normMonth(input.month);
    if (!month) err('month', `Month "${input.month}" is not valid.`, 'Use Apr … Mar.');
  }

  // Quarter / Half are never trusted — only checked against the Month
  if (month && input.quarter !== undefined && input.quarter !== '') {
    const q = P.normQuarter(input.quarter);
    if (!q) err('quarter', `Quarter "${input.quarter}" is not valid.`, 'Use Q1–Q4, or leave blank.');
    else if (q !== P.quarterOf(month)) err('quarter', `${P.monthLabel(month)} is in ${P.quarterOf(month)}, not ${q}.`, `Use ${P.quarterOf(month)} or leave Quarter blank (it is filled in from the Month).`);
  }
  if (month && input.half !== undefined && input.half !== '') {
    const h = P.normHalf(input.half);
    if (!h) err('half', `Half Year "${input.half}" is not valid.`, 'Use H1 or H2, or leave blank.');
    else if (h !== P.halfOf(month)) err('half', `${P.monthLabel(month)} is in ${P.halfOf(month)}, not ${h}.`, `Use ${P.halfOf(month)} or leave Half Year blank.`);
  }

  const compliance = M.resolveCompliance(state, input.compliance_id);
  if (input.compliance_id === undefined || input.compliance_id === '') err('compliance_id', 'Compliance ID is required.', 'e.g. GST002');
  else if (!compliance) err('compliance_id', `Compliance "${input.compliance_id}" not found.`, 'Use an ID from the Compliance Master.');

  if (compliance && input.module !== undefined && input.module !== '') {
    if (String(input.module).trim().toLowerCase() !== compliance.module.toLowerCase()) {
      err('module', `${compliance.id} belongs to module ${compliance.module}, not ${input.module}.`, `Use ${compliance.module} or leave Module blank.`);
    }
  }

  let periodKey = null;
  if (compliance && month) periodKey = P.periodKeyFor(compliance.frequency, month);
  return { errors, company, compliance, fy, month, periodKey };
}

/** Today as 'YYYY-MM-DD' unless the caller passes one (tests) */
const todayOf = ctx => ctx.today || P.localISODate();

/**
 * Apply the editable fields (applicable, due date, people, status, completion date, remarks)
 * from `input` onto `next`. Shared by create and update.
 */
function applyEditable(next, input, compliance, ctx, errors, isCreate) {
  const err = (field, error, fix) => errors.push({ field, error, fix });
  const today = todayOf(ctx);

  if (input.applicable !== undefined) {
    const y = F.yesNo(input.applicable);
    if (y === null) err('applicable', `Applicable "${input.applicable}" must be Yes or No.`, 'Yes or No');
    else if (y === 'No' && next.applicable !== false) { next.applicable = false; next.na_source = 'manual'; }
    else if (y === 'Yes' && next.applicable === false) { next.applicable = true; next.na_source = null; }
  }

  if (input.due_date !== undefined) {
    const d = F.parseDate(input.due_date);
    if (!d.ok) err('due_date', `Due Date "${input.due_date}" is not a valid date.`, 'Use DD-MM-YYYY, e.g. 20-09-2026.');
    else if (d.iso === '') {                                   // cleared → back to the rule
      const r = R.dueDateFor(compliance.due_rule, next.fy, next.period_key);
      if (!r.ok) err('due_date', `Due date rule failed: ${r.error}`, 'Fix the rule in the Compliance Master or type a date.');
      else { next.due_date = r.date; next.due_date_source = 'rule'; }
    } else if (d.iso !== undefined) { next.due_date = d.iso; next.due_date_source = 'manual'; }
  }

  for (const f of ['responsible', 'reviewer', 'remarks']) {
    const v = F.text(input[f]);
    if (v !== undefined) next[f] = v;
  }

  const prevStatus = SE.normUserStatus(next.status) || 'Not Started';
  if (input.status !== undefined && input.status !== '') {
    const s = SE.normUserStatus(input.status);
    if (!s) {
      const computed = ['due soon', 'overdue', 'n/a', 'na'].includes(String(input.status).trim().toLowerCase());
      err('status', `Status "${input.status}" ${computed ? 'is calculated by the system and cannot be set' : 'is not valid'}.`, 'Use Not Started, In Progress or Completed.');
    } else next.status = s;
  }

  let completion;
  if (input.completion_date !== undefined) {
    const d = F.parseDate(input.completion_date);
    if (!d.ok) err('completion_date', `Completion Date "${input.completion_date}" is not a valid date.`, 'Use DD-MM-YYYY.');
    else completion = d.iso;                                   // '' = cleared
  }

  if (next.status === 'Completed') {
    if (completion !== undefined && completion !== '') next.completion_date = completion;
    else if (completion === '') err('completion_date', 'Completion Date is required when Status is Completed.', 'Enter the date it was completed.');
    else if (!next.completion_date) next.completion_date = today;
    if (next.completion_date && next.completion_date > today) err('completion_date', 'Completion Date cannot be in the future.', `Use today (${F.fmtDMY(today)}) or an earlier date.`);
  } else {
    if (completion) err('completion_date', 'Completion Date can only be set when Status is Completed.', 'Set Status to Completed, or clear the date.');
    else if (prevStatus === 'Completed' || completion === '') next.completion_date = '';
  }

  if (next.applicable === false && next.status !== prevStatus && !isCreate) {
    err('status', 'This task is Not Applicable (N/A); its status cannot be changed.', 'Set Applicable = Yes first.');
  }
  if (next.applicable === false && next.status === 'Completed' && (isCreate || prevStatus !== 'Completed')) {
    err('status', 'A Not Applicable (N/A) task cannot be Completed.', 'Set Applicable = Yes, or leave Status as Not Started.');
  }
}

/**
 * Create one task (manual entry or import).
 * ctx: { settings, user, now, today?, source: 'manual' | 'import' | 'generated' }
 * Returns { ok, errors, duplicate?, record }.
 */
function createTask(state, input, ctx) {
  const { settings } = ctx;
  const id = resolveIdentity(state, input, settings);
  const errors = [...id.errors];
  if (errors.length) return { ok: false, errors };

  const { company, compliance, fy, month, periodKey } = id;
  if (compliance.active === false) errors.push({ field: 'compliance_id', error: `${compliance.id} is inactive.`, fix: 'Set Active = Yes in the Compliance Master first.' });
  if (compliance.frequency === 'Monthly' && compliance.active_months && !compliance.active_months.split(',').includes(month)) {
    errors.push({ field: 'month', error: `${compliance.id} applies only in ${compliance.active_months}.`, fix: 'Pick one of those months, or change Applicable Months in the Compliance Master.' });
  }
  const taskId = buildTaskId(company.short_code, compliance.id, fy, periodKey);
  const dup = findDuplicate(state, company.id, compliance.id, fy, periodKey, taskId);
  if (dup) return { ok: false, duplicate: true, errors: [{ field: 'task_id', error: `Task ${dup.task_id} already exists for this company, compliance and period.`, fix: 'Open that task to change it (in Excel: put its Task ID in the Task ID column).' }] };
  if (errors.length) return { ok: false, errors };

  const app = M.applicabilityOf(state, company.id, compliance.id, settings);
  const next = {
    task_id: taskId,
    company_id: company.id,
    compliance_id: compliance.id,
    fy,
    period_key: periodKey,
    month: P.anchorMonth(periodKey),
    due_date: '', due_date_source: 'rule',
    applicable: app.applicable !== 'No',
    na_source: app.applicable === 'No' ? 'applicability' : null,
    status: 'Not Started',
    completion_date: '',
    responsible: app.responsible,
    reviewer: app.reviewer,
    remarks: '',
    source: ctx.source || 'manual',
  };
  if (input.due_date === undefined || input.due_date === '') {
    const r = R.dueDateFor(compliance.due_rule, fy, periodKey);
    if (!r.ok) errors.push({ field: 'due_date', error: `Due date rule failed: ${r.error}`, fix: 'Fix the rule in the Compliance Master or type a Due Date.' });
    else next.due_date = r.date;
  }
  applyEditable(next, { ...input, due_date: input.due_date === '' ? undefined : input.due_date }, compliance, ctx, errors, true);
  if (errors.length) return { ok: false, errors };

  const by = ctx.user?.name || ctx.user?.username || 'system';
  next.created_at = ctx.now; next.created_by = by; next.updated_at = ctx.now; next.updated_by = by;
  state.tasks.push(next);
  return { ok: true, errors: [], action: 'create', record: next, changes: A.diff(null, next, TASK_AUDIT_FIELDS) };
}

/**
 * Update one task (task detail panel, bulk update by Task ID).
 * Identity fields in `input` (company, fy, month, quarter, half, module, compliance_id) are
 * only CHECKED — they can't move a task to another period.
 */
function updateTask(state, taskId, input, ctx) {
  const task = state.tasks.find(t => t.task_id === String(taskId ?? '').trim().toUpperCase());
  if (!task) return { ok: false, notFound: true, errors: [{ field: 'task_id', error: `Task ID "${taskId}" not found.`, fix: 'Check the ID, or leave Task ID blank to create a new task.' }] };
  const compliance = state.compliances.find(c => c.id === task.compliance_id);
  const errors = [];
  const err = (field, error, fix) => errors.push({ field, error, fix });
  const keep = `Identity fields cannot change on an existing task — leave the cell blank, or create a new task.`;

  if (input.company !== undefined && input.company !== '') {
    const co = M.resolveCompany(state, input.company);
    if (!co || co.id !== task.company_id) err('company', `Task ${task.task_id} belongs to another company.`, keep);
  }
  if (input.fy !== undefined && input.fy !== '' && P.normFY(input.fy) !== task.fy) err('fy', `Task ${task.task_id} is for FY ${task.fy}.`, keep);
  if (input.compliance_id !== undefined && input.compliance_id !== '' && String(input.compliance_id).trim().toUpperCase() !== task.compliance_id) err('compliance_id', `Task ${task.task_id} is for ${task.compliance_id}.`, keep);
  if (input.module !== undefined && input.module !== '' && compliance && String(input.module).trim().toLowerCase() !== compliance.module.toLowerCase()) err('module', `Task ${task.task_id} is in module ${compliance.module}.`, keep);
  let refMonth = task.month;
  if (input.month !== undefined && input.month !== '') {
    const m = P.normMonth(input.month);
    if (!m) err('month', `Month "${input.month}" is not valid.`, 'Use Apr … Mar.');
    else if (P.periodKeyFor(compliance.frequency, m) !== task.period_key) err('month', `Task ${task.task_id} is for period ${task.period_key}, not ${P.monthLabel(m)}.`, keep);
    else refMonth = m;
  }
  if (input.quarter !== undefined && input.quarter !== '') {
    const q = P.normQuarter(input.quarter);
    if (!q || q !== P.quarterOf(refMonth)) err('quarter', `${P.monthLabel(refMonth)} is in ${P.quarterOf(refMonth)}, not ${input.quarter}.`, `Use ${P.quarterOf(refMonth)} or leave blank.`);
  }
  if (input.half !== undefined && input.half !== '') {
    const h = P.normHalf(input.half);
    if (!h || h !== P.halfOf(refMonth)) err('half', `${P.monthLabel(refMonth)} is in ${P.halfOf(refMonth)}, not ${input.half}.`, `Use ${P.halfOf(refMonth)} or leave blank.`);
  }

  const next = { ...task };
  applyEditable(next, input, compliance, ctx, errors, false);
  if (errors.length) return { ok: false, errors };

  const changes = A.diff(task, next, TASK_AUDIT_FIELDS);
  if (!changes.length) return { ok: true, errors: [], action: 'nochange', record: task, changes };
  next.updated_at = ctx.now; next.updated_by = ctx.user?.name || ctx.user?.username || 'system';
  Object.assign(task, next);
  return { ok: true, errors: [], action: 'update', record: task, changes };
}

function deleteTask(state, taskId) {
  const task = state.tasks.find(t => t.task_id === taskId);
  if (!task) return { ok: false, error: 'Task not found.' };
  if (state.documents.some(d => d.task_id === taskId)) return { ok: false, error: 'This task has documents. Delete its documents first.' };
  state.tasks = state.tasks.filter(t => t.task_id !== taskId);
  return { ok: true, record: task };
}

module.exports = { buildTaskId, identityKey, findDuplicate, resolveIdentity, createTask, updateTask, deleteTask, TASK_AUDIT_FIELDS };
