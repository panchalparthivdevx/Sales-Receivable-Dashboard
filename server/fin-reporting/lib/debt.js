/**
 * Financial Reporting — debt schedule and covenants (amounts in rupees).
 *
 * Facilities  one row per loan / NCD / cash credit: lender, type, sanction, outstanding as at a date, rate, repayment terms.
 * Schedule    one row per instalment: due date, principal, interest. Entered, uploaded from the template, or generated
 *             from the facility terms (EMI, equal principal or bullet) — a generated schedule can be edited row by row.
 * Covenants   per facility (or all facilities): metric, the definition exactly as in the agreement, test (>= / <=),
 *             threshold, frequency, basis. Tests record the value the lender's definition gives for a period.
 */

'use strict';

const XLSX = require('xlsx');
const crypto = require('crypto');
const S = require('./sources');

const id = () => crypto.randomBytes(5).toString('hex');
const empty = () => ({ facilities: [], schedule: [], covenants: [], tests: [] });

const FAC_FIELDS = [
  ['lender', 'Lender', 'text', true], ['facilityName', 'Facility name / reference', 'text', true], ['facilityType', 'Type (Term loan / NCD / Cash credit / Overdraft / Vehicle loan / ICD / Other)', 'text', true],
  ['basis', 'Basis (Standalone / Consolidated)', 'text', false], ['sanctionAmount', 'Sanctioned amount (₹)', 'number', false], ['sanctionDate', 'Sanction date', 'date', false],
  ['outstanding', 'Outstanding principal (₹)', 'number', true], ['outstandingAsAt', 'Outstanding as at', 'date', true], ['interestRate', 'Interest rate % p.a.', 'number', true],
  ['rateType', 'Rate type (Fixed / Floating)', 'text', false], ['repaymentType', 'Repayment (EMI / Equal principal / Bullet / Custom)', 'text', true],
  ['frequency', 'Frequency (Monthly / Quarterly / Half-yearly / Yearly)', 'text', true], ['firstDueDate', 'First instalment due on', 'date', true], ['maturityDate', 'Maturity date', 'date', true],
  ['instalment', 'Instalment / EMI amount (₹, optional)', 'number', false], ['moratoriumEnd', 'Moratorium ends on (optional)', 'date', false], ['security', 'Security / collateral', 'text', false], ['source', 'Source (sanction letter, agreement ref.)', 'text', true],
];
const SCH_FIELDS = [['facility', 'Facility name / reference', 'text', true], ['dueDate', 'Due date', 'date', true], ['principal', 'Principal (₹)', 'number', true], ['interest', 'Interest (₹)', 'number', false], ['note', 'Note', 'text', false]];
const COV_FIELDS = [['facility', 'Facility name / reference (or ALL)', 'text', true], ['metric', 'Metric (e.g. DSCR, Debt/EBITDA, Security cover, Current ratio)', 'text', true], ['definition', 'Definition exactly as in the agreement', 'text', true],
  ['operator', 'Test (>= or <=)', 'text', true], ['threshold', 'Threshold', 'number', true], ['frequency', 'Test frequency (Quarterly / Half-yearly / Yearly)', 'text', false], ['basis', 'Basis (Standalone / Consolidated)', 'text', false], ['firstTest', 'First test date', 'date', false], ['source', 'Source (clause reference)', 'text', true]];
const TEST_FIELDS = [['facility', 'Facility name / reference (or ALL)', 'text', true], ['metric', 'Metric', 'text', true], ['periodEnd', 'Test period end', 'date', true], ['value', 'Tested value (lender definition)', 'number', true], ['note', 'Workings / note', 'text', false]];

const STEP = { monthly: 1, quarterly: 3, 'half-yearly': 6, halfyearly: 6, yearly: 12, annual: 12 };
function addMonthsDate(d, k) {
  const [y, m, dd] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + k, 1));
  const dim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(dd, dim)).padStart(2, '0')}`;
}

/** Instalments from the terms. Interest accrues on the outstanding at the rate for the period between dues (actual/365). */
function generate(f) {
  const out = [];
  const step = STEP[String(f.frequency || 'monthly').toLowerCase()] || 1;
  const type = String(f.repaymentType || 'EMI').toLowerCase();
  let bal = Number(f.outstanding) || 0;
  const rate = (Number(f.interestRate) || 0) / 100;
  if (!bal || !f.firstDueDate || !f.maturityDate) return { rows: [], error: 'Outstanding, first due date and maturity date are needed to generate a schedule.' };
  const dues = [];
  for (let d = f.firstDueDate; d <= f.maturityDate && dues.length < 600; d = addMonthsDate(f.firstDueDate, step * dues.length)) { dues.push(d); }
  if (dues[dues.length - 1] !== f.maturityDate && f.maturityDate > dues[dues.length - 1]) dues.push(f.maturityDate);
  const moratorium = f.moratoriumEnd || null;
  const payDues = dues.filter(d => !moratorium || d > moratorium);
  const n = payDues.length;
  const pr = rate * step / 12;
  let emi = Number(f.instalment) || (type === 'emi' && n ? (pr ? bal * pr / (1 - Math.pow(1 + pr, -n)) : bal / n) : null);
  let prev = f.outstandingAsAt || addMonthsDate(dues[0], -step);
  let left = n;
  for (const d of dues) {
    const interest = bal * rate * Math.max(0, S.days(prev, d)) / 365;
    let principal = 0;
    if (!moratorium || d > moratorium) {
      if (type === 'bullet') principal = d === dues[dues.length - 1] ? bal : 0;
      else if (type.startsWith('equal')) principal = bal / left;
      else principal = Math.max(0, Math.min(bal, (emi || 0) - interest));
      left--;
    }
    if (d === dues[dues.length - 1]) principal = bal;
    bal = Math.max(0, bal - principal);
    out.push({ dueDate: d, principal: Math.round(principal * 100) / 100, interest: Math.round(interest * 100) / 100, closing: Math.round(bal * 100) / 100 });
    prev = d;
    if (bal <= 0.005) break;
  }
  return { rows: out, emi };
}

/** Interest by month (rupees) and principal by month, from the schedule */
function monthly(doc, basis) {
  const facIds = new Set(doc.facilities.filter(f => !basis || !f.basis || f.basis === basis).map(f => f.id));
  const interest = {}, principal = {};
  for (const r of doc.schedule) {
    if (!facIds.has(r.facilityId)) continue;
    const m = r.dueDate.slice(0, 7);
    interest[m] = (interest[m] || 0) + (Number(r.interest) || 0);
    principal[m] = (principal[m] || 0) + (Number(r.principal) || 0);
  }
  return { interest, principal };
}

function template() {
  const wb = XLSX.utils.book_new();
  const sheet = (name, fields, sample) => { const ws = XLSX.utils.aoa_to_sheet([fields.map(f => f[1] + (f[3] ? ' *' : '')), ...(sample ? [sample] : [])]); ws['!cols'] = fields.map(f => ({ wch: Math.max(14, Math.min(46, f[1].length + 2)) })); XLSX.utils.book_append_sheet(wb, ws, name); };
  const info = XLSX.utils.aoa_to_sheet([['Debt schedule & covenants — upload format'],
    ['Facilities: one row per loan / NCD / cash credit. Repayment schedule: one row per instalment (leave it empty to let the dashboard generate it from the facility terms). Covenants: exactly as in the agreement. Covenant tests: the value the lender\'s definition gives for a test period.'],
    ['Amounts in rupees. Dates as YYYY-MM-DD or DD/MM/YYYY. Columns marked * are required. The "Facility name / reference" links the sheets.'], [],
    ['Sheet', 'Column', 'Required'], ...[['Facilities', FAC_FIELDS], ['Repayment schedule', SCH_FIELDS], ['Covenants', COV_FIELDS], ['Covenant tests', TEST_FIELDS]].flatMap(([s, fs]) => fs.map(f => [s, f[1], f[3] ? 'yes' : '']))]);
  info['!cols'] = [{ wch: 22 }, { wch: 70 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, info, 'Instructions');
  sheet('Facilities', FAC_FIELDS);
  sheet('Repayment schedule', SCH_FIELDS);
  sheet('Covenants', COV_FIELDS);
  sheet('Covenant tests', TEST_FIELDS);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function parseSheet(ws, fields) {
  if (!ws) return { rows: [], errors: [] };
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const head = (aoa[0] || []).map(h => String(h || '').replace(/\s*\*$/, '').trim().toLowerCase());
  const rows = [], errors = [];
  aoa.slice(1).forEach((r, i) => {
    if (!r || r.every(x => x == null || x === '')) return;
    const o = {};
    for (const [k, label, kind, req] of fields) {
      const c = head.indexOf(label.toLowerCase());
      let v = c >= 0 ? r[c] : null;
      if (v != null && v !== '') { if (kind === 'number') v = S.num(v); else if (kind === 'date') v = S.excelDate(v); else v = String(v).trim(); }
      if (req && (v == null || v === '')) errors.push(`Row ${i + 2}: ${label} is required`);
      o[k] = v === '' ? null : v;
    }
    rows.push(o);
  });
  return { rows, errors };
}

/** Upload → a full replacement document (nothing saved here); facility names link the sheets */
function parseUpload(buf, who) {
  const wb = XLSX.read(buf, { cellDates: true });
  const f = parseSheet(wb.Sheets.Facilities, FAC_FIELDS), s = parseSheet(wb.Sheets['Repayment schedule'], SCH_FIELDS), c = parseSheet(wb.Sheets.Covenants, COV_FIELDS), t = parseSheet(wb.Sheets['Covenant tests'], TEST_FIELDS);
  const errors = [...f.errors.map(e => `Facilities ${e}`), ...s.errors.map(e => `Schedule ${e}`), ...c.errors.map(e => `Covenants ${e}`), ...t.errors.map(e => `Tests ${e}`)];
  const at = new Date().toISOString();
  const facilities = f.rows.map(r => ({ id: id(), ...r, basis: /cons/i.test(r.basis || '') ? 'CO' : 'SA', by: who, at }));
  const byName = n => facilities.find(x => String(x.facilityName).toLowerCase() === String(n || '').toLowerCase());
  const schedule = [];
  s.rows.forEach((r, i) => { const fac = byName(r.facility); if (!fac) errors.push(`Schedule row ${i + 2}: facility "${r.facility}" is not on the Facilities sheet`); else schedule.push({ facilityId: fac.id, dueDate: r.dueDate, principal: r.principal || 0, interest: r.interest || 0, note: r.note, source: 'upload' }); });
  const covenants = c.rows.map(r => ({ id: id(), facilityId: /^all$/i.test(r.facility || '') ? 'ALL' : byName(r.facility)?.id || null, facilityLabel: r.facility, ...r, basis: /cons/i.test(r.basis || '') ? 'CO' : 'SA', by: who, at }));
  covenants.forEach((cv, i) => { if (!cv.facilityId) errors.push(`Covenants row ${i + 2}: facility "${cv.facilityLabel}" is not on the Facilities sheet`); if (!['>=', '<='].includes(String(cv.operator).trim())) errors.push(`Covenants row ${i + 2}: test must be >= or <=`); });
  const tests = t.rows.map(r => { const cv = covenants.find(x => String(x.metric).toLowerCase() === String(r.metric).toLowerCase() && (String(x.facilityLabel).toLowerCase() === String(r.facility).toLowerCase())); return { id: id(), covenantId: cv?.id || null, ...r, by: who, at }; });
  tests.forEach((x, i) => { if (!x.covenantId) errors.push(`Covenant tests row ${i + 2}: no covenant "${x.metric}" for "${x.facility}"`); });
  // facilities without schedule rows get a generated one
  for (const fac of facilities) if (!schedule.some(r => r.facilityId === fac.id) && !/custom/i.test(fac.repaymentType || '')) {
    const g = generate(fac);
    if (g.error) errors.push(`${fac.facilityName}: ${g.error}`);
    for (const r of g.rows) schedule.push({ facilityId: fac.id, ...r, source: 'generated' });
  }
  return { doc: { facilities, schedule, covenants, tests }, errors };
}

/** Facilities from the Loan module (to be completed: dates and repayment terms are not all in that sheet) */
function fromLoanModule(loans, who) {
  const at = new Date().toISOString();
  return (loans?.institutional || []).filter(l => !l.isCC || l.amount).map(l => ({ id: id(), lender: l.name.split(/\s+-\s+/)[0], facilityName: l.name, facilityType: l.isCC ? 'Cash credit' : 'Term loan', basis: 'SA', sanctionAmount: l.amount || null,
    outstanding: l.principal || null, outstandingAsAt: null, interestRate: l.rate || null, repaymentType: l.isCC ? 'Bullet' : 'EMI', frequency: 'Monthly', instalment: l.emi || null, firstDueDate: null, maturityDate: null, endText: l.endDateStr || null,
    source: 'Loan module (complete outstanding-as-at, first due and maturity dates)', by: who, at }));
}

function status(cov, tests) {
  const t = tests.filter(x => x.covenantId === cov.id).sort((a, b) => (b.periodEnd || '').localeCompare(a.periodEnd || ''))[0];
  if (!t || t.value == null) return { status: 'Missing data', test: null };
  const ok = cov.operator === '>=' ? t.value >= cov.threshold : t.value <= cov.threshold;
  const headroom = cov.operator === '>=' ? t.value - cov.threshold : cov.threshold - t.value;
  return { status: ok ? 'Within threshold' : 'Breach', test: t, headroom, headroomPct: cov.threshold ? headroom / Math.abs(cov.threshold) : null };
}

/**
 * The company's Loan Master workbook ("Updated Loan Master Sheet"): one sheet, a header row starting "Loan Name", then
 * sections "Principal Outflow", "Interest Outflow" and "EMI Outflow (Balance Sheet)". Each loan has a row of monthly
 * amounts (Principal / Interest / Total) followed by its closing-balance row, under monthly columns (Apr-23 onwards,
 * past months actual, later months the schedule). Only loans marked "Live" in the Principal section are taken (plus live
 * loans that appear in the EMI section only). The outstanding is the closing principal at the end of asOfMonth (default:
 * the last complete month); every month with an amount becomes a schedule row, due on the loan's instalment day.
 * Amounts in rupees. Nothing is filled in that the sheet does not give: gaps come back as flags.
 */
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function lmMonth(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${String(d.m).padStart(2, '0')}` : null; }
  if (v instanceof Date) return v.toISOString().slice(0, 7);
  const m = String(v).trim().toLowerCase().match(/^([a-z]{3})[a-z]*[\s,.'-]*(\d{2}|\d{4})$/);
  if (m && MON[m[1]]) { const y = m[2].length === 2 ? 2000 + +m[2] : +m[2]; return `${y}-${String(MON[m[1]]).padStart(2, '0')}`; }
  const iso = S.excelDate(v);
  return iso ? iso.slice(0, 7) : null;
}
const lmNum = v => (typeof v === 'number' ? v : S.num(v));
const lmText = v => String(v ?? '').replace(/\s+/g, ' ').trim();

function parseLoanMaster(buf, who, { asOfMonth, file = 'Loan Master' } = {}) {
  const wb = XLSX.read(buf, { cellDates: false });
  const asOf = asOfMonth || S.lastCompleteMonth();
  const flags = [];
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
    const hr = rows.findIndex(r => r && /^loan name$/i.test(lmText(r[0])));
    if (hr < 0) continue;
    const head = rows[hr].map(h => lmText(h).toLowerCase());
    const col = re => head.findIndex(h => re.test(h));
    const C = { name: 0, kind: col(/^o\/s$/), lenderType: col(/^type$/), security: col(/^loan type$/), sanction: col(/sanction|disburse/), rate: col(/rate of interest/), tenure: col(/tenure/),
      start: col(/^start month/), end: col(/^end month/), loanEnd: col(/^loan end month/), day: col(/instal+ment date/), route: col(/direct or escrow/), escrow: col(/escrow name/), status: col(/closed\s*\/\s*live/), remarks: col(/^remarks/) };
    if (C.kind < 0) C.kind = 1;
    const months = [];
    rows[hr].forEach((h, c) => { if (typeof h === 'number' && h > 30000 && h < 80000) months.push({ c, m: lmMonth(h) }); });
    if (!months.length) return { facilities: [], schedule: [], flags: [`${file}: no month columns found next to the "Loan Name" heading`], live: 0, closed: 0 };

    // rows by section: { P|I|E: [{ r, name, status, sanction, …, amounts: {month: v}, closing: {month: v} }] }
    const sec = { P: [], I: [], E: [] };
    let cur = null;
    for (let r = hr + 1; r < rows.length; r++) {
      const x = rows[r];
      if (!x) continue;
      const a = lmText(x[0]), kind = lmText(x[C.kind]);
      if (a && !kind) { cur = /^principal outflow/i.test(a) ? 'P' : /^interest outflow/i.test(a) ? 'I' : /^emi outflow/i.test(a) ? 'E' : null; continue; }
      if (!cur || !a || !/^(principal|interest|total)$/i.test(kind)) continue;
      const next = /^closing/i.test(lmText((rows[r + 1] || [])[C.kind])) ? rows[r + 1] : [];
      const amounts = {}, closing = {};
      for (const { c, m } of months) { const v = lmNum(x[c]); if (v) amounts[m] = v; const cv = lmNum(next[c]); if (cv != null) closing[m] = cv; }
      sec[cur].push({ r: r + 1, name: a, status: lmText(x[C.status]), lenderType: lmText(x[C.lenderType]), security: lmText(x[C.security]), sanction: lmNum(x[C.sanction]), rate: lmNum(x[C.rate]),
        tenure: lmText(x[C.tenure]), start: lmMonth(x[C.start]), end: lmMonth(x[C.loanEnd] ?? null) || lmMonth(x[C.end]), day: parseInt(lmText(x[C.day]), 10) || null, route: lmText(x[C.route]), escrow: lmText(x[C.escrow]),
        remarks: lmText(x[C.remarks]), amounts, closing });
    }
    // a loan's interest and EMI rows: same name and sanction, else same name and start month, else the only one of that name
    const nm = S.normName;
    const partner = (list, p, used) => {
      const free = list.filter(x => !used.has(x) && nm(x.name) === nm(p.name));
      return free.find(x => x.sanction && x.sanction === p.sanction && (!p.start || !x.start || x.start === p.start)) || free.find(x => x.start && x.start === p.start) || free.find(x => x.sanction === p.sanction) || (free.length === 1 ? free[0] : null);
    };
    const usedI = new Set(), usedE = new Set();
    const at = new Date().toISOString();
    const facilities = [], schedule = [];
    const dupes = {};
    for (const x of sec.P.filter(q => /^live$/i.test(q.status))) dupes[x.name.toLowerCase()] = (dupes[x.name.toLowerCase()] || 0) + 1;
    const taken = new Map();
    // two live loans from one lender are told apart by amount and start month
    const uniqueName = (name, p) => { const k = name.toLowerCase(); const n = (taken.get(k) || 0) + 1; taken.set(k, n); return (dupes[k] || 0) < 2 ? name : `${name} (${p.sanction ? `₹${Math.round(p.sanction / 1e5)} lakh` : `#${n}`}${p.start ? `, from ${p.start}` : ''})`; };
    const dueOn = (m, day) => `${m}-${String(Math.min(day || S.daysInMonth(m), S.daysInMonth(m))).padStart(2, '0')}`;
    const build = (p, i, e, emiOnly) => {
      const fflags = [];
      const isCC = /\b(cc|cash credit|od|overdraft)\b/i.test(p.name);
      const outstanding = emiOnly ? (e.closing[asOf] ?? null) : (p.closing[asOf] ?? null);
      const prin = emiOnly ? e.amounts : p.amounts;
      const intr = emiOnly ? {} : (i?.amounts || {});
      const ms = [...new Set([...Object.keys(prin), ...Object.keys(intr)])].sort();
      const fac = { id: id(), lender: p.name.split(/\s+-\s+/)[0].trim(), facilityName: uniqueName(p.name, p), facilityType: isCC ? (/od|overdraft/i.test(p.name) ? 'Overdraft' : 'Cash credit') : emiOnly ? 'Other' : 'Term loan', basis: 'SA',
        sanctionAmount: p.sanction || null, sanctionDate: null, outstanding, outstandingAsAt: `${asOf}-${S.daysInMonth(asOf)}`, interestRate: p.rate == null ? null : p.rate < 1 ? Math.round(p.rate * 10000) / 100 : p.rate, rateType: null,
        repaymentType: 'Custom', frequency: 'Monthly', firstDueDate: ms.length ? dueOn(ms[0], p.day) : null, maturityDate: ms.length ? dueOn(ms[ms.length - 1], p.day) : (p.end ? dueOn(p.end, p.day) : null),
        instalment: (e?.amounts[S.addMonths(asOf, 1)]) || null, moratoriumEnd: null, security: [p.security, p.lenderType, p.route === 'Escrow' && p.escrow ? `escrow: ${p.escrow}` : p.route].filter(Boolean).join(' · ') || null,
        source: `${file}, row ${p.r}${p.tenure ? ` · tenure ${p.tenure}` : ''}${p.start ? ` · ${p.start} to ${p.end || '?'}` : ''}`, by: who, at, imported: 'loan-master', flags: fflags };
      for (const m of ms) schedule.push({ facilityId: fac.id, dueDate: dueOn(m, p.day), principal: Math.round((prin[m] || 0) * 100) / 100, interest: Math.round((intr[m] || 0) * 100) / 100, note: '', source: 'loan master' });
      // what the sheet leaves open
      if (outstanding == null) fflags.push(`No closing balance for ${asOf} in the sheet`);
      const futureP = ms.filter(m => m > asOf).reduce((s, m) => s + (prin[m] || 0), 0);
      if (outstanding && !isCC && Math.abs(futureP - outstanding) > Math.max(1000, outstanding * 0.001)) fflags.push(`Instalments after ${asOf} add up to ₹${Math.round(futureP).toLocaleString('en-IN')} but ₹${Math.round(outstanding).toLocaleString('en-IN')} is outstanding — the schedule in the sheet is ${futureP < outstanding ? 'incomplete' : 'larger than the balance'}`);
      if (!emiOnly && !isCC && !Object.keys(intr).length) fflags.push('No interest in the sheet (Interest row empty or missing)');
      if (emiOnly) fflags.push('In the EMI section only: no principal / interest split — the EMI is taken as principal' + (p.sanction && Math.abs(Object.values(e.amounts).reduce((s, v) => s + v, 0) - p.sanction) > 1 ? ` (instalments total ₹${Math.round(Object.values(e.amounts).reduce((s, v) => s + v, 0)).toLocaleString('en-IN')}; sanction cell says ₹${Math.round(p.sanction).toLocaleString('en-IN')})` : ''));
      if (i && i.sanction && p.sanction && i.sanction !== p.sanction) fflags.push(`Sanction ₹${Math.round(p.sanction).toLocaleString('en-IN')} in the Principal section, ₹${Math.round(i.sanction).toLocaleString('en-IN')} in the Interest section`);
      if (!p.day && ms.length && !isCC) fflags.push('No instalment date in the sheet — instalments placed at month end');
      if (isCC) fflags.push('Revolving facility: balance only, no instalments');
      facilities.push(fac);
      for (const t of fflags) flags.push(`${fac.facilityName}: ${t}`);
    };
    const liveP = sec.P.filter(p => /^live$/i.test(p.status));
    for (const p of sec.P) { const i = partner(sec.I, p, usedI); if (i) usedI.add(i); const e = partner(sec.E, p, usedE); if (e) usedE.add(e); if (liveP.includes(p)) build(p, i, e, false); }
    // live in the EMI section with no principal row at all
    for (const e of sec.E.filter(x => /^live$/i.test(x.status) && !usedE.has(x))) build(e, null, e, true);
    return { facilities, schedule, flags, live: facilities.length, closed: sec.P.filter(p => /^closed$/i.test(p.status)).length, asOf, sheet: sheetName };
  }
  return { facilities: [], schedule: [], flags: [`${file}: no sheet with a "Loan Name" heading`], live: 0, closed: 0 };
}

module.exports = { empty, generate, monthly, template, parseUpload, fromLoanModule, parseLoanMaster, status, FAC_FIELDS, SCH_FIELDS, COV_FIELDS, TEST_FIELDS, id };
