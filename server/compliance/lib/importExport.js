/**
 * Excel template, import and export.
 *
 * Import is two-step:
 *   1. Preview  — parse + validate against a COPY of the data. Nothing is written.
 *   2. Confirm  — automatic backup, then the same validation runs on the real data and all
 *                 valid rows are saved in ONE write. Rows with errors are skipped and listed
 *                 in the downloadable error report (Sheet, Row, Field, Error, Suggested Fix).
 *
 * Cell rules: blank = leave unchanged · #CLEAR = empty the value · a row whose first cell
 * starts with "#" is an example/comment row and is ignored.
 * Sheets are processed in order Companies → Compliances → Applicability → Tasks, so a new
 * company or compliance can be used by tasks in the same file.
 */

'use strict';

const XLSX = require('xlsx');
const C  = require('./columns');
const F  = require('./fields');
const P  = require('./period');
const M  = require('./masters');
const T  = require('./tasks');
const SE = require('./statusEngine');

// ── Template / export ─────────────────────────────────────────────────────────

function sheetFromRows(columns, rows) {
  const ws = XLSX.utils.aoa_to_sheet([columns.map(c => c.header), ...rows]);
  ws['!cols'] = columns.map(c => ({ wch: c.width || 16 }));
  return ws;
}

function exampleRow(columns) {
  return columns.map((c, i) => {
    const v = c.example ?? '';
    if (i === 0) return `# EXAMPLE (ignored)${v ? ' — ' + v : ''}`;
    return v;
  });
}

const yn = b => (b ? 'Yes' : 'No');

function companyRows(state) {
  return state.companies.map(c => [c.name, c.short_code, c.status, c.zoho_org_id || '', c.remarks || '']);
}
function complianceRows(state) {
  return state.compliances.map(c => [c.id, c.name, c.module, c.frequency, c.due_rule, c.form_name || '', c.active_months || '', yn(c.statutory), c.remarks || '', yn(c.active !== false)]);
}
function applicabilityRows(state) {
  const co = new Map(state.companies.map(c => [c.id, c]));
  return state.applicability.map(a => [co.get(a.company_id)?.short_code || a.company_id, a.compliance_id, a.applicable, a.responsible || '', a.reviewer || '', a.remarks || '']);
}
function taskRows(state, { fy } = {}) {
  const co = new Map(state.companies.map(c => [c.id, c]));
  const cm = new Map(state.compliances.map(c => [c.id, c]));
  return state.tasks
    .filter(t => !fy || t.fy === fy)
    .sort((a, b) => a.fy.localeCompare(b.fy) || P.MONTH_BY_KEY[a.month].idx - P.MONTH_BY_KEY[b.month].idx || a.task_id.localeCompare(b.task_id))
    .map(t => [t.task_id, co.get(t.company_id)?.short_code || t.company_id, t.fy, P.MONTH_BY_KEY[t.month].short, P.quarterOf(t.month), P.halfOf(t.month),
      cm.get(t.compliance_id)?.module || '', t.compliance_id, cm.get(t.compliance_id)?.name || '', t.applicable === false ? 'No' : 'Yes',
      F.fmtDMY(t.due_date), t.responsible || '', t.reviewer || '', SE.normUserStatus(t.status) || 'Not Started', F.fmtDMY(t.completion_date), t.remarks || '']);
}

function instructionsSheet(settings) {
  const lines = [
    ['Compliance Dashboard — Excel Import Template'],
    [''],
    ['HOW TO USE'],
    ['1. Fill the sheets you need (Companies, Compliances, Applicability, Tasks). You can leave a sheet empty.'],
    ['2. Do not rename sheets or column headings.'],
    ['3. Rows whose first cell starts with # are examples/comments and are ignored. Delete or keep them.'],
    ['4. In the app: Compliance Dashboard > Master > Import Excel > choose file > Preview. Nothing is saved at Preview.'],
    ['5. Check the preview, download the error report if there are errors, then click Confirm Import.'],
    ['   A backup of all compliance data is taken automatically before anything is saved.'],
    [''],
    ['CELL RULES'],
    ['Blank cell      = leave the existing value unchanged (for updates).'],
    ['#CLEAR          = empty the existing value.'],
    ['Dates           = DD-MM-YYYY, e.g. 20-09-2026.'],
    ['Quarter / Half  = optional; they are checked against Month. August + Q1 is rejected. They are always calculated from Month.'],
    ['Status          = Not Started, In Progress or Completed. Due Soon / Overdue are calculated by the system. N/A comes from Applicable = No.'],
    [''],
    ['HOW ROWS ARE MATCHED'],
    ...C.SHEET_ORDER.map(k => [`${C.SHEETS[k].sheet}: ${C.SHEETS[k].keyHelp}`]),
    [''],
    ['COLUMNS'],
    ...C.SHEET_ORDER.flatMap(k => C.SHEETS[k].columns.map(c => [`${C.SHEETS[k].sheet} › ${c.header}${c.required ? ' (required for new rows)' : ''}${c.info ? ' (read-only)' : ''}: ${c.help || ''}`])),
    [''],
    ['DUE DATE RULE SYNTAX (Compliance Master)'],
    ['11th of following month            → day 11 of the month after the period'],
    ['last day of following month        → last day of the month after the period'],
    ['7th of same month                  → day 7 of the period\'s last month'],
    ['15th of 2 months after             → day 15, two months after the period'],
    ['31-Jul                             → the first 31 July after the period ends'],
    ['7th of following month; MAR=30-Apr → monthly rule with a different date for March'],
    ['Q1=31-Jul; Q2=31-Oct; Q3=31-Jan; Q4=31-May → quarterly dates'],
    ['Days are clamped to month length (31st in February becomes 28th/29th).'],
    [''],
    [`Valid FYs (Lists / Settings): ${settings.fy_list.join(', ')}`],
    [`Valid modules: ${settings.modules.map(m => m.key).join(', ')}`],
  ];
  const ws = XLSX.utils.aoa_to_sheet(lines);
  ws['!cols'] = [{ wch: 130 }];
  return ws;
}

function listsSheet(state, settings) {
  const cols = {
    'FY': settings.fy_list,
    'Month': P.MONTHS.map(m => m.short),
    'Quarter': P.QUARTER_KEYS,
    'Half Year': P.HALF_KEYS,
    'Module': settings.modules.map(m => m.key),
    'Frequency': P.FREQUENCIES,
    'Status': SE.USER_STATUSES,
    'Yes/No': ['Yes', 'No'],
    'Company Short Code': state.companies.map(c => c.short_code),
    'Compliance ID': state.compliances.map(c => c.id),
  };
  const headers = Object.keys(cols);
  const n = Math.max(...Object.values(cols).map(v => v.length));
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(headers.map(h => cols[h][i] ?? ''));
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  ws['!cols'] = headers.map(() => ({ wch: 20 }));
  return ws;
}

/**
 * Workbook for download.
 *   withData = false → empty template with example rows
 *   withData = true  → current masters + tasks (optionally one FY) — edit and re-import to bulk update
 */
function buildWorkbook(state, settings, { withData = false, fy } = {}) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, instructionsSheet(settings), 'Instructions');
  const data = {
    companies: withData ? companyRows(state) : [],
    compliances: withData ? complianceRows(state) : [],
    applicability: withData ? applicabilityRows(state) : [],
    tasks: withData ? taskRows(state, { fy }) : [],
  };
  for (const k of C.SHEET_ORDER) {
    const cols = C.SHEETS[k].columns;
    XLSX.utils.book_append_sheet(wb, sheetFromRows(cols, [exampleRow(cols), ...data[k]]), C.SHEETS[k].sheet);
  }
  XLSX.utils.book_append_sheet(wb, listsSheet(state, settings), 'Lists');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Error report workbook (Sheet, Row, Field, Error, Suggested Fix) */
function buildErrorReport(errors) {
  const cols = C.ERROR_REPORT;
  const wb = XLSX.utils.book_new();
  const rows = errors.map(e => cols.map(c => e[c.key] ?? ''));
  XLSX.utils.book_append_sheet(wb, sheetFromRows(cols, rows), 'Errors');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ── Parse ─────────────────────────────────────────────────────────────────────

const norm = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Read an uploaded workbook. Returns
 *   { sheets: { companies: [{ row, values }], ... }, problems: [{ sheet, row, field, error, fix }], found: [...] }
 */
function parseWorkbook(buffer) {
  let wb;
  try { wb = XLSX.read(buffer, { type: 'buffer', cellDates: false }); }
  catch (e) { return { sheets: {}, problems: [{ sheet: '', row: '', field: '', error: 'The file could not be read as an Excel workbook.', fix: 'Use the downloaded template (.xlsx).' }], found: [] }; }

  const out = { sheets: {}, problems: [], found: [] };
  for (const k of C.SHEET_ORDER) {
    const def = C.SHEETS[k];
    const name = wb.SheetNames.find(n => norm(n) === norm(def.sheet));
    if (!name) continue;
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false });
    if (!aoa.length) continue;
    const headers = aoa[0].map(h => norm(h));
    const colIndex = {};
    for (const c of def.columns) {
      const i = headers.findIndex(h => h === norm(c.header) || h === norm(c.key));
      if (i >= 0) colIndex[c.key] = i;
    }
    headers.forEach((h, i) => {
      if (h && !def.columns.some(c => norm(c.header) === h || norm(c.key) === h)) {
        out.problems.push({ sheet: def.sheet, row: 1, field: aoa[0][i], error: `Unknown column "${aoa[0][i]}" — ignored.`, fix: 'Use the column headings from the template.', severity: 'warning' });
      }
    });
    const rows = [];
    for (let r = 1; r < aoa.length; r++) {
      const line = aoa[r];
      if (!line || line.every(v => String(v ?? '').trim() === '')) continue;
      const first = String(line[0] ?? '').trim();
      if (first.startsWith('#') && first.toUpperCase() !== F.CLEAR_TOKEN) continue;     // example/comment row
      const values = {};
      for (const c of def.columns) {
        if (c.info || colIndex[c.key] === undefined) continue;
        values[c.key] = F.fromCell(line[colIndex[c.key]]);
      }
      rows.push({ row: r + 1, values });
    }
    out.sheets[k] = rows;
    out.found.push(def.sheet);
  }
  if (!out.found.length) out.problems.push({ sheet: '', row: '', field: '', error: 'No Companies, Compliances, Applicability or Tasks sheet found.', fix: 'Use the downloaded template and keep the sheet names.' });
  return out;
}

// ── Validate / apply ──────────────────────────────────────────────────────────

/**
 * Run parsed rows against `state` (a COPY for preview, the real data for confirm).
 * ctx: { settings, user, now, today }
 * Returns { actions, errors, skipped, counts, audit: [{ entity, id, action, changes, summary }] }
 */
function run(state, parsed, ctx) {
  const actions = [], errors = [], skipped = [], audit = [];
  const counts = {};
  const bump = (sheet, what) => { counts[sheet] = counts[sheet] || { create: 0, update: 0, nochange: 0, skipped: 0, error: 0 }; counts[sheet][what]++; };
  const fail = (sheet, row, errs) => { for (const e of errs) errors.push({ sheet, row, field: e.field, error: e.error, fix: e.fix || '' }); bump(sheet, 'error'); };

  for (const k of C.SHEET_ORDER) {
    const rows = parsed.sheets[k];
    if (!rows) continue;
    const sheet = C.SHEETS[k].sheet;
    const seen = new Map();
    for (const { row, values } of rows) {
      // ---- duplicate within the file ----
      let fileKey = null;
      if (k === 'companies') fileKey = values.short_code ? String(values.short_code).toUpperCase() : null;
      if (k === 'compliances') fileKey = values.id ? String(values.id).toUpperCase() : null;
      if (k === 'applicability') fileKey = values.company && values.compliance_id ? `${String(values.company).toUpperCase()}|${String(values.compliance_id).toUpperCase()}` : null;
      if (k === 'tasks') {
        if (values.task_id) fileKey = String(values.task_id).toUpperCase();
        else {
          const id = T.resolveIdentity(state, values, ctx.settings);
          if (!id.errors.length) fileKey = `${id.company.id}|${id.compliance.id}|${id.fy}|${id.periodKey}`;
        }
      }
      if (fileKey && seen.has(fileKey)) {
        skipped.push({ sheet, row, field: '', error: `Duplicate of row ${seen.get(fileKey)} in this file — skipped.`, fix: 'Keep only one row for this item.' });
        bump(sheet, 'skipped');
        continue;
      }
      if (fileKey) seen.set(fileKey, row);

      // ---- apply to state ----
      let r;
      if (k === 'companies') r = M.saveCompany(state, values, { ...ctx, mode: 'upsert' });
      else if (k === 'compliances') r = M.saveCompliance(state, values, { ...ctx, mode: 'upsert' });
      else if (k === 'applicability') r = M.saveApplicability(state, values, ctx);
      else if (values.task_id) r = T.updateTask(state, values.task_id, values, ctx);
      else r = T.createTask(state, values, { ...ctx, source: 'import' });

      if (!r.ok) {
        if (r.duplicate) {
          skipped.push({ sheet, row, field: 'task_id', error: r.errors[0].error + ' — skipped.', fix: r.errors[0].fix });
          bump(sheet, 'skipped');
        } else fail(sheet, row, r.errors);
        continue;
      }
      bump(sheet, r.action);
      if (r.action !== 'nochange') {
        const id = k === 'companies' ? r.record.short_code : k === 'compliances' ? r.record.id
          : k === 'applicability' ? `${r.company.short_code}|${r.compliance.id}` : r.record.task_id;
        actions.push({ sheet, row, action: r.action, id, effects: r.effects || [] });
        audit.push({ entity: k === 'companies' ? 'company' : k === 'compliances' ? 'compliance' : k === 'applicability' ? 'applicability' : 'task',
          id: k === 'companies' ? r.record.id : id, action: r.action, changes: r.changes || [], summary: `Excel import (${sheet} row ${row})${(r.effects || []).length ? ' — ' + r.effects.join(' ') : ''}` });
      }
    }
  }
  return { actions, errors: [...(parsed.problems || []).filter(p => p.severity !== 'warning'), ...errors], warnings: (parsed.problems || []).filter(p => p.severity === 'warning'), skipped, counts, audit };
}

module.exports = { buildWorkbook, buildErrorReport, parseWorkbook, run, taskRows };
