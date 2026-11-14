/**
 * Financial Reporting — management inputs that the financial statements cannot supply.
 *
 * Every record carries: company, basis (where it matters), period end or effective date, unit, source, branch / project
 * where applicable, who entered it and when. Records are entered on the Management Inputs tab or uploaded from the Excel
 * template of their type (same columns). Nothing here has a default value: an empty input means "not provided", and every
 * report that needs it says so (see REQUIRED_BY).
 */

'use strict';

const XLSX = require('xlsx');
const crypto = require('crypto');

const COMPANY = 'Dev Accelerator Ltd';
const str = { t: 'text' }, num = { t: 'number' }, date = { t: 'date' };

const TYPES = {
  budget: { label: 'Budgets', unit: '₹ lakh', help: 'Budget by statement line (and branch / project where budgeted that way) for a period. Several budget versions can be kept (e.g. "Original FY27", "Revised Q2").',
    fields: [['version', 'Budget version', str, true], ['line', 'Line (e.g. Revenue from operations, EBITDA, Employee benefits expense)', str, true], ['periodStart', 'Period start', date, false], ['periodEnd', 'Period end', date, true], ['amount', 'Amount (₹ lakh)', num, true], ['branch', 'Branch', str, false], ['project', 'Project', str, false]] },
  branch_capacity: { label: 'Branch seats, occupancy & area', unit: 'seats / sq ft', help: 'One row per branch per change: capacity seats, occupied seats and operational area from the effective date until the next row for that branch. Used time-weighted for unit economics.',
    fields: [['branch', 'Branch', str, true], ['effectiveDate', 'Effective from', date, true], ['capacitySeats', 'Capacity seats', num, true], ['occupiedSeats', 'Occupied seats', num, false], ['areaSqft', 'Operational area (sq ft)', num, false]] },
  branch_opening: { label: 'Branch opening dates', unit: 'date', help: 'Opening (and closing) date of each centre — used for like-for-like and ramp-up views.',
    fields: [['branch', 'Branch', str, true], ['effectiveDate', 'Opening date', date, true], ['closingDate', 'Closing date', date, false], ['model', 'Model (straight lease / furnished by landlord / revenue share)', str, false]] },
  client_revenue: { label: 'Client cohorts & revenue', unit: '₹ lakh', help: 'Revenue by client by period, with the client\'s first-revenue month (cohort). Used for retention, churn and concentration when invoice data is not enough.',
    fields: [['client', 'Client', str, true], ['periodStart', 'Period start', date, false], ['periodEnd', 'Period end', date, true], ['revenue', 'Revenue (₹ lakh)', num, true], ['service', 'Service line', str, false], ['cohort', 'Cohort (first revenue month, YYYY-MM)', str, false], ['branch', 'Branch', str, false]] },
  collection_forecast: { label: 'Collection forecast', unit: '₹ lakh', help: 'Expected customer collections by month (and branch / client where forecast that way).',
    fields: [['periodEnd', 'Month end', date, true], ['amount', 'Expected collections (₹ lakh)', num, true], ['branch', 'Branch', str, false], ['client', 'Client', str, false]] },
  payment_forecast: { label: 'Payment forecast', unit: '₹ lakh', help: 'Expected payments by month and category (rent, salaries, vendors, taxes, capex, debt service).',
    fields: [['periodEnd', 'Month end', date, true], ['amount', 'Expected payments (₹ lakh)', num, true], ['category', 'Category', str, true], ['branch', 'Branch', str, false]] },
  debt_schedule: { label: 'Debt principal & interest schedule', unit: '₹ lakh', help: 'Scheduled principal and interest by facility and month — used for maturity profile and debt-service coverage.',
    fields: [['lender', 'Lender', str, true], ['facility', 'Facility', str, true], ['periodEnd', 'Due date / month end', date, true], ['principal', 'Scheduled principal (₹ lakh)', num, true], ['interest', 'Scheduled interest (₹ lakh)', num, false], ['outstanding', 'Outstanding after payment (₹ lakh)', num, false]] },
  covenant: { label: 'Covenants', unit: 'as defined', help: 'Each covenant exactly as in the loan agreement: metric, definition, test and threshold. Optionally the tested value for a period.',
    fields: [['lender', 'Lender', str, true], ['facility', 'Facility', str, true], ['metric', 'Metric (e.g. DSCR, Debt/EBITDA, Security cover)', str, true], ['definition', 'Definition (as in the agreement)', str, true], ['operator', 'Test (>= or <=)', str, true], ['threshold', 'Threshold', num, true], ['frequency', 'Test frequency', str, false], ['periodEnd', 'Tested period end (optional)', date, false], ['testedValue', 'Tested value (optional)', num, false]] },
  capex: { label: 'Capex budgets, commitments & payments', unit: '₹ lakh', help: 'By project / centre: budget, commitments (POs, agreements) and payments to date.',
    fields: [['project', 'Project / centre', str, true], ['periodEnd', 'As at', date, true], ['budget', 'Budget (₹ lakh)', num, false], ['committed', 'Committed (₹ lakh)', num, false], ['paid', 'Paid to date (₹ lakh)', num, false], ['expectedOpening', 'Expected opening', date, false], ['seats', 'Planned seats', num, false]] },
  cost_class: { label: 'Fixed / variable cost classification', unit: 'class', help: 'Classification of each expense line or note item as fixed, variable or semi-variable (for break-even and operating leverage).',
    fields: [['item', 'Expense line or note item', str, true], ['class', 'Class (Fixed / Variable / Semi-variable)', str, true], ['variableShare', 'Variable share for semi-variable (0–1)', num, false]] },
  share_data: { label: 'Share counts, dilution, dividends & market price', unit: 'nos / ₹', help: 'Dated share data for EPS checks and valuation: shares outstanding, weighted shares for the trailing twelve months, dilutive shares, dividend per share and the market price on that date.',
    fields: [['effectiveDate', 'As at', date, true], ['sharesOutstanding', 'Equity shares outstanding (nos)', num, false], ['weightedShares', 'Weighted average shares, trailing 12 months (nos)', num, false], ['dilutiveShares', 'Dilutive potential shares (nos)', num, false], ['dividendPerShare', 'Dividend per share declared (₹)', num, false], ['marketPrice', 'Market price (₹)', num, false]] },
  target: { label: 'Management targets', unit: 'as stated', help: 'Targets by metric and period (approved by management). Alert thresholds are set under Settings.',
    fields: [['metric', 'Metric', str, true], ['periodEnd', 'Period end', date, true], ['target', 'Target value', num, true], ['unit', 'Unit', str, false]] },
};

// Kept on Data Validation & Reconciliation (planning sections) instead of here; older records of these types still count
const MOVED = { budget: 'Budget', branch_opening: 'Branch master', collection_forecast: 'Collections & payments forecast', payment_forecast: 'Collections & payments forecast', debt_schedule: 'Debt & covenants', covenant: 'Debt & covenants' };

// What each report / ratio needs from these inputs
const REQUIRED_BY = {
  'CFO Overview': ['budget', 'branch_capacity', 'collection_forecast', 'payment_forecast', 'debt_schedule', 'covenant', 'capex', 'target'],
  'Financial Performance': ['budget', 'cost_class'],
  'Ratio Analytics': ['share_data', 'debt_schedule', 'covenant', 'branch_capacity'],
  'Branch Performance': ['branch_capacity', 'branch_opening', 'budget'],
  'AR & Collections': ['collection_forecast'],
  'AP & Payments': ['payment_forecast'],
  'Cash & Treasury': ['collection_forecast', 'payment_forecast', 'debt_schedule'],
  'Debt & Covenants': ['debt_schedule', 'covenant'],
  'Capex & Expansion': ['capex', 'branch_opening', 'branch_capacity'],
  'Client & Revenue Analytics': ['client_revenue'],
};

function validate(type, rec) {
  const T = TYPES[type];
  if (!T) return [`Unknown input type "${type}"`];
  const errs = [];
  for (const [k, label, kind, req] of T.fields) {
    const v = rec.values?.[k];
    if (req && (v == null || v === '')) { errs.push(`${label} is required`); continue; }
    if (v == null || v === '') continue;
    if (kind.t === 'number' && !Number.isFinite(Number(v))) errs.push(`${label} must be a number`);
    if (kind.t === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) errs.push(`${label} must be a date (YYYY-MM-DD)`);
  }
  if (type === 'covenant' && rec.values?.operator && !['>=', '<='].includes(String(rec.values.operator).trim())) errs.push('Test must be >= or <=');
  if (type === 'cost_class' && rec.values?.class && !/^(fixed|variable|semi[- ]?variable)$/i.test(rec.values.class)) errs.push('Class must be Fixed, Variable or Semi-variable');
  if (!rec.source) errs.push('Source is required (where the figure comes from)');
  return errs;
}

/** Normalise one record: typed values, date fields lifted to the record (used for period matching) */
function normalise(type, raw, user) {
  const T = TYPES[type];
  const values = {};
  for (const [k, , kind] of T.fields) {
    let v = raw.values ? raw.values[k] : raw[k];
    if (v === undefined || v === null || v === '') continue;
    if (kind.t === 'number') v = Number(String(v).replace(/,/g, ''));
    if (kind.t === 'date') v = toIsoDate(v);
    if (kind.t === 'text') v = String(v).trim();
    values[k] = v;
  }
  return {
    id: raw.id || crypto.randomBytes(6).toString('hex'), type, company: raw.company || COMPANY, basis: raw.basis || 'SA',
    branch: values.branch || raw.branch || null, project: values.project || raw.project || null, unit: raw.unit || T.unit,
    source: (raw.source || '').trim(), periodStart: values.periodStart || null, periodEnd: values.periodEnd || null, effectiveDate: values.effectiveDate || null,
    values, by: user || null, at: new Date().toISOString(),
  };
}

function toIsoDate(v) {
  if (v instanceof Date && !isNaN(v)) return new Date(v.getTime() + 12 * 3600e3).toISOString().slice(0, 10);
  if (typeof v === 'number' && v > 20000 && v < 80000) { const d = XLSX.SSF.parse_date_code(v); return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`; }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}

/** Excel template: an instructions sheet and a data sheet with the exact column headings */
function template(type) {
  const T = TYPES[type];
  const wb = XLSX.utils.book_new();
  const head = ['Company', 'Basis (Standalone / Consolidated)', 'Source', ...T.fields.map(f => f[1] + (f[3] ? ' *' : ''))];
  const ws = XLSX.utils.aoa_to_sheet([head]);
  ws['!cols'] = head.map(h => ({ wch: Math.max(14, Math.min(48, h.length + 2)) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  const info = XLSX.utils.aoa_to_sheet([[`${T.label} — upload template`], [T.help], [`Unit: ${T.unit}. Dates as YYYY-MM-DD or DD/MM/YYYY. Columns marked * are required. Company defaults to ${COMPANY}; basis defaults to Standalone.`], ['Every row needs a Source (e.g. "Board-approved budget 12-Apr-2026", "Loan agreement clause 7.2").'], [], ['Column', 'Required', 'Type'], ...T.fields.map(f => [f[1], f[3] ? 'yes' : '', f[2].t])]);
  info['!cols'] = [{ wch: 60 }, { wch: 10 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, info, 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Parse an uploaded template → { records, errors } (nothing is saved here) */
function parseUpload(type, buf, user) {
  const T = TYPES[type];
  const wb = XLSX.read(buf, { cellDates: true });
  const ws = wb.Sheets.Data || wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  if (!rows.length) return { records: [], errors: ['The sheet is empty'] };
  const head = rows[0].map(h => String(h || '').replace(/\s*\*$/, '').trim().toLowerCase());
  const col = label => head.indexOf(label.toLowerCase());
  const records = [], errors = [];
  rows.slice(1).forEach((r, i) => {
    if (!r || r.every(x => x == null || x === '')) return;
    const values = {};
    for (const [k, label] of T.fields) { const c = col(label); if (c >= 0) values[k] = r[c]; }
    const basisRaw = String(r[col('basis (standalone / consolidated)')] || '').toLowerCase();
    const rec = normalise(type, { values, company: r[col('company')] || COMPANY, basis: /cons/.test(basisRaw) ? 'CO' : 'SA', source: r[col('source')] || '' }, user);
    const e = validate(type, rec);
    if (e.length) errors.push(`Row ${i + 2}: ${e.join('; ')}`); else records.push(rec);
  });
  return { records, errors };
}

function emptyStore() { return { records: [], settings: { thresholds: {}, alerts: {}, gstOnReceivables: null } }; }

/** Which inputs are present, and what each report is waiting for */
function coverage(store, planning = {}) {
  const counts = {};
  for (const r of store.records || []) counts[r.type] = (counts[r.type] || 0) + 1;
  for (const [t, n] of Object.entries(planning)) counts[t] = (counts[t] || 0) + (n || 0);
  const reports = Object.fromEntries(Object.entries(REQUIRED_BY).map(([rep, types]) => [rep, types.map(t => ({ type: t, label: TYPES[t].label, records: counts[t] || 0, where: MOVED[t] || null }))]));
  return { counts, reports, alertsSet: Object.keys(store.settings?.alerts || {}).length };
}

module.exports = { TYPES, MOVED, REQUIRED_BY, validate, normalise, template, parseUpload, emptyStore, coverage, COMPANY };
