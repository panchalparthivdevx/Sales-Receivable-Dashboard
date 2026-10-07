/**
 * Reports — everything the Dashboard shows is computed here from ONE selected period.
 *
 *   selectTasks()   the period filter: FY + months (from the validated selection) + company +
 *                   module + the user's company access. Nothing outside it gets through.
 *   viewRow()       a task as the UI/export sees it (display status computed at read time).
 *   dashboard()     KPI cards + company-wise + module-wise + upcoming + overdue.
 */

'use strict';

const P  = require('./period');
const SE = require('./statusEngine');

/**
 * Tasks inside a selection.
 *   sel      validated selection: { selection: { fy }, months: [...] }  (from P.validateSelection)
 *   filters  { company_id?, module? }
 *   access   { companies: [] }  (empty = all companies)
 */
function selectTasks(state, sel, filters = {}, access = {}) {
  const fy = sel.selection.fy;
  const months = new Set(sel.months);
  const cmById = new Map(state.compliances.map(c => [c.id, c]));
  const allowed = access.companies && access.companies.length ? new Set(access.companies) : null;
  const mod = filters.module && !P.isAll(filters.module) ? String(filters.module).toLowerCase() : null;
  const co = filters.company_id && !P.isAll(filters.company_id) ? filters.company_id : null;
  return state.tasks.filter(t =>
    (!fy || t.fy === fy) &&
    months.has(t.month) &&
    (!co || t.company_id === co) &&
    (!allowed || allowed.has(t.company_id)) &&
    (!mod || (cmById.get(t.compliance_id)?.module || '').toLowerCase() === mod));
}

/** Lookup maps reused by viewRow */
function lookups(state) {
  const docsByTask = new Map();
  for (const d of state.documents) {
    if (!docsByTask.has(d.task_id)) docsByTask.set(d.task_id, []);
    docsByTask.get(d.task_id).push(d);
  }
  return {
    company: new Map(state.companies.map(c => [c.id, c])),
    compliance: new Map(state.compliances.map(c => [c.id, c])),
    docsByTask,
  };
}

/** A task as shown in the UI / exports */
function viewRow(t, L, todayISO, dueSoonDays) {
  const co = L.company.get(t.company_id) || {};
  const cm = L.compliance.get(t.compliance_id) || {};
  const docs = L.docsByTask.get(t.task_id) || [];
  const quarter = P.quarterOf(t.month);
  const half = P.halfOf(t.month);
  const ds = SE.displayStatus(t, todayISO, dueSoonDays);
  const cal = P.calendarOf(t.fy, t.month);
  return {
    task_id: t.task_id,
    company_id: t.company_id,
    company_name: co.name || t.company_id,
    company_short: co.short_code || '',
    module: cm.module || '',
    compliance_id: t.compliance_id,
    compliance_name: cm.name || t.compliance_id,
    form_name: cm.form_name || '',
    frequency: cm.frequency || '',
    statutory: !!cm.statutory,
    fy: t.fy,
    period_key: t.period_key,
    month: t.month,
    month_label: cal ? `${P.MONTH_BY_KEY[t.month].short} ${cal.year}` : t.month,
    quarter, half,
    period_label: P.periodLabel(t.fy, t.period_key),
    due_date: t.due_date,
    due_date_source: t.due_date_source,
    days_left: SE.daysLeft(t, todayISO),
    responsible: t.responsible || '',
    reviewer: t.reviewer || '',
    status: SE.normUserStatus(t.status) || 'Not Started',
    display_status: ds,
    applicable: t.applicable !== false,
    na_source: t.na_source || null,
    completion_date: t.completion_date || '',
    completed_late: SE.completedLate(t),
    remarks: t.remarks || '',
    doc_count: docs.length,
    doc_names: docs.map(d => d.original_name || d.title || '').filter(Boolean),
    updated_at: t.updated_at, updated_by: t.updated_by,
  };
}

function groupBy(rows, keyFn, labelFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, { key: k, label: labelFn(r), rows: [] });
    map.get(k).rows.push(r);
  }
  return [...map.values()].map(g => ({ key: g.key, label: g.label, ...SE.stats(g.rows) }));
}

/** Dashboard payload for a list of view rows */
function dashboard(rows, settings) {
  const windows = settings.upcoming_windows || [7, 15, 30];
  const open = rows.filter(r => r.display_status !== 'Completed' && r.display_status !== 'N/A');
  const byDue = (a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.task_id.localeCompare(b.task_id);
  const upcoming = {};
  for (const w of windows) upcoming[w] = open.filter(r => r.days_left !== null && r.days_left >= 0 && r.days_left <= w).sort(byDue).map(r => r.task_id);
  return {
    kpis: SE.stats(rows),
    by_company: groupBy(rows, r => r.company_id, r => r.company_name).sort((a, b) => a.label.localeCompare(b.label)),
    by_module: groupBy(rows, r => r.module, r => r.module).sort((a, b) => a.label.localeCompare(b.label)),
    upcoming,
    overdue: open.filter(r => r.display_status === 'Overdue').sort(byDue).map(r => r.task_id),
  };
}

/** Free-text search over task fields and document names */
function matchesSearch(row, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return true;
  return [row.task_id, row.company_name, row.company_short, row.compliance_name, row.compliance_id, row.form_name,
    row.responsible, row.reviewer, row.module, ...row.doc_names].some(v => String(v || '').toLowerCase().includes(s));
}

module.exports = { selectTasks, lookups, viewRow, dashboard, matchesSearch, groupBy };
