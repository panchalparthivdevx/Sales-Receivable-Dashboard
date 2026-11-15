/**
 * Reconciliation inputs (V8) — monthly source figures entered (or imported) once, then read by the reports.
 *
 * Store document "<sp>_recon": { records: [] }
 * Record: { id, type, entity_id, registration_id, registration_number, month, vendor_gstin (VENDOR only), values {}, rows [],
 *           status 'draft' | 'ready_for_review' | 'reviewed', prepared_by(_id), reviewed_by(_id), evidence [attachment ids],
 *           notes, illustrative, version, revisions [{ version, at, by, snapshot }], history [], rev }
 *   • key = company + registration + month + type (+ supplier GSTIN for vendor records) — one record per key;
 *   • a blank number is MISSING (null), 0 is a confirmed zero; missing never counts as a match;
 *   • Ready for review needs every number, the references and at least one evidence file; Reviewed needs a different person
 *     with the review right (enforced here, not by the screen);
 *   • changing a reviewed record makes a new version (the reviewed figures stay in `revisions`).
 *
 * Calculations are the demo's (reconciliation.js), unchanged: signed per-head GST differences (never netted for alerts),
 * PF payroll-vs-ECR by component, ESIC per-member expectation with the stated rounding, vendor score
 * 60 × (1 − on-time / known-due) + 40 × (vendor hold / assessed ITC), TDS liability vs principal allocations.
 */

'use strict';

const U = require('./util');
const P = require('./payments');

const TYPES = { GST: 'GST monthly liability & settlement', VENDOR: 'Vendor filing & ITC assessment', PF: 'Payroll / ECR reconciliation', ESIC: 'Payroll / ESIC reconciliation', TDS: 'TDS monthly liability control', PT: 'Professional Tax payroll control' };
const REG_OF = { GST: ['GST_REGULAR', 'GST_COMPOSITION', 'GST_ISD'], VENDOR: ['GST_REGULAR', 'GST_COMPOSITION', 'GST_ISD'], PF: ['PF'], ESIC: ['ESIC'], TDS: ['TAN'], PT: ['PT_PTRC', 'PT_PTEC'] };
const STATUSES = { draft: 'Draft', ready_for_review: 'Ready for review', reviewed: 'Reviewed' };
const GST_HEADS = ['IGST', 'CGST', 'SGST / UTGST', 'Cess'];
const FILING = ['Unknown', 'On time', 'Late', 'Not filed', 'Not due', 'Not applicable'];

const GRID = {
  GST: [['head', 'Tax head', 'text'], ['g1', 'GSTR-1 liability', 'signed'], ['g1a', 'GSTR-1A net amendment', 'signed'], ['adjust', 'Comparable-scope adjustment', 'signed'], ['declared', 'GSTR-3B comparable outward liability', 'signed'], ['cash', 'Outward liability paid via cash', 'number'], ['credit', 'Outward liability paid via ITC', 'number'], ['otherCash', 'Other tax cash debit incl. RCM', 'number'], ['otherCredit', 'Other permitted ITC debit, excl. RCM', 'number'], ['totalLiability', 'Total GSTR-3B tax liability', 'number']],
  PF: [['employee', 'Employee / masked UAN key', 'text'], ['pGross', 'Payroll gross', 'number'], ['pBasic', 'Payroll basic (context only)', 'number'], ['pWage', 'Payroll EPF wages', 'number'], ['pEE', 'Payroll employee PF', 'number'], ['pER', 'Payroll employer EPF', 'number'], ['pEPS', 'Payroll employer EPS', 'number'], ['eGross', 'ECR gross', 'number'], ['eWage', 'ECR EPF wages', 'number'], ['eEE', 'ECR employee PF', 'number'], ['eER', 'ECR employer EPF', 'number'], ['eEPS', 'ECR employer EPS', 'number']],
  ESIC: [['employee', 'Employee / masked IP key', 'text'], ['covered', 'Covered: Yes/No/Unknown', 'select:Yes|No|Unknown'], ['eeExempt', 'Employee exempt', 'select:No|Yes|Unknown'], ['erExempt', 'Employer exempt', 'select:No|Yes|Unknown'], ['wage', 'ESI contributory wages', 'number'], ['pEE', 'Payroll employee ESI', 'number'], ['pER', 'Payroll employer ESI', 'number'], ['portalEE', 'Portal employee ESI', 'number'], ['portalER', 'Portal employer ESI', 'number']],
  TDS: [['act', 'Governing Act (1961 / 2025)', 'text'], ['code', 'Actual section / table code', 'text'], ['alias', 'Legacy reference (label)', 'text'], ['liability', 'TDS deducted / payable', 'number']],
};
const FIELDS = {
  GST: [['arn1', 'GSTR-1 / IFF ARN', 'text'], ['arn1a', 'GSTR-1A ARN (if applicable)', 'text'], ['arn3', 'GSTR-3B ARN', 'text'], ['scope', 'Comparable tables / scope mapping', 'text'], ['adjustReason', 'Amendment / scope adjustment reason', 'text'], ['ledgerRef', 'Cash / credit ledger debit references', 'text']],
  VENDOR: [['vendor', 'Supplier name', 'text'], ['vendorGstin', 'Supplier GSTIN', 'text'], ['s1', 'GSTR-1 / IFF status', `select:${FILING.join('|')}`, 'Unknown'], ['s3', 'GSTR-3B status', `select:${FILING.join('|')}`, 'Unknown'], ['due1', 'GSTR-1 / IFF applicable due date', 'date'], ['file1', 'GSTR-1 / IFF filing date', 'date'], ['due3', 'GSTR-3B applicable due date', 'date'], ['file3', 'GSTR-3B filing date', 'date'], ['checked', 'Filing-status checked on', 'date'], ['source', 'Portal / evidence source reference', 'text'], ['invoiceRef', 'Invoice-level working reference', 'text'], ['invoiceITC', 'Invoice ITC assessed (₹)', 'number'], ['reflected', 'ITC reflected in GSTR-2B (₹; informational)', 'number'], ['eligible', 'Assessed eligible ITC (₹)', 'number'], ['vendorHold', 'ITC held for evidenced vendor non-compliance (₹)', 'number'], ['blocked', 'Statutorily blocked ITC, e.g. 17(5) (₹)', 'number'], ['otherHold', 'Other / unresolved ITC (₹)', 'number'], ['holdReason', 'Vendor hold cause / legal assessment', 'text']],
  PF: [['reference', 'ECR / TRRN reference', 'text'], ['payrollRef', 'Payroll file / version', 'text'], ['pAdmin', 'Payroll expected admin charges (₹)', 'number'], ['pEdli', 'Payroll expected EDLI (₹)', 'number'], ['pOther', 'Payroll other adjustments (signed ₹)', 'signed'], ['eAdmin', 'ECR / challan admin charges (₹)', 'number'], ['eEdli', 'ECR / challan EDLI (₹)', 'number'], ['eOther', 'ECR / challan other adjustments (signed ₹)', 'signed'], ['challan', 'Challan total excl. interest / damages (₹)', 'number'], ['paid', 'Actual payment excl. interest / damages (₹)', 'number'], ['paidDate', 'Actual payment date', 'date']],
  ESIC: [['reference', 'ESIC challan reference', 'text'], ['payrollRef', 'Payroll file / version', 'text'], ['eeRate', 'Employee rate (%)', 'number', 0.75], ['erRate', 'Employer rate (%)', 'number', 3.25], ['rateSource', 'Rate / exemption source and override reason', 'text'], ['rounding', 'Per-member calculation policy', 'select:Next rupee|Two decimals', 'Next rupee'], ['challanEE', 'Challan employee contribution (₹)', 'number'], ['challanER', 'Challan employer contribution (₹)', 'number'], ['paid', 'Actual paid contribution excl. interest (₹)', 'number'], ['paidDate', 'Payment date', 'date']],
  TDS: [['reference', 'Monthly deduction working reference', 'text'], ['returnRef', 'Statement / return reference (if available)', 'text']],
  PT: [['state', 'State / jurisdiction', 'text'], ['ptType', 'Registration type', 'select:PTRC|PTEC', 'PTRC'], ['employees', 'Liable employees (PTRC only)', 'number'], ['payrollWages', 'Payroll wage base (₹; context)', 'number'], ['deducted', 'Payroll PT deducted (₹; PTRC)', 'number'], ['assessed', 'Assessed period liability (₹)', 'number'], ['paid', 'Actual PT paid (₹)', 'number'], ['reference', 'Challan / payment reference', 'text'], ['returnRef', 'Return acknowledgement', 'text'], ['paidDate', 'Payment date', 'date'], ['ruleSource', 'State slab / periodicity / rule source', 'text']],
};
const EMPTY = () => ({ records: [] });

// ── Numbers (blank = missing) ─────────────────────────────────────────────────
const num = v => (v !== '' && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
const sum = (a, k) => a.reduce((s, r) => s + (num(r[k]) ?? 0), 0);
const diff = (a, b) => (num(a) === null || num(b) === null ? null : Number(a) - Number(b));
const total = (a, ks) => (a.length && a.every(r => ks.every(k => num(r[k]) !== null)) ? ks.reduce((s, k) => s + sum(a, k), 0) : null);
const r2 = n => (n === null ? null : Math.round(n * 100) / 100);

// ── Calculations (from the demo) ──────────────────────────────────────────────
function missing(r) {
  const v = r.values || {}, x = [];
  for (const [k, l, t] of FIELDS[r.type]) if ((t === 'number' || t === 'signed') && num(v[k]) === null) x.push(l);
  if (GRID[r.type] && (!r.rows?.length || r.rows.some(row => GRID[r.type].some(([k, , t]) => (t === 'number' || t === 'signed') && num(row[k]) === null)))) x.push('Missing row values / unmatched source');
  if (r.type === 'ESIC' && r.rows.some(row => ['covered', 'eeExempt', 'erExempt'].some(k => row[k] === 'Unknown'))) x.push('Coverage / exemption unknown');
  if (r.type === 'VENDOR' && (!v.checked || !v.source || ['s1', 's3'].some(k => v[k] === 'Unknown'))) x.push('Unknown filing status / source');
  if (r.type === 'VENDOR') for (const [k, d, f] of [['s1', 'due1', 'file1'], ['s3', 'due3', 'file3']]) if ((['On time', 'Late'].includes(v[k]) && (!v[d] || !v[f])) || (v[k] === 'Not filed' && !v[d])) x.push('Filing date / due-date evidence missing');
  return U.uniq(x);
}

function gst(r) {
  const rows = r.rows || [];
  const ok = rows.length === 4 && rows.every(x => GRID.GST.filter(f => f[2] !== 'text').every(([k]) => num(x[k]) !== null));
  if (!ok) return null;
  const outward = sum(rows, 'g1') + sum(rows, 'g1a') + sum(rows, 'adjust'), declared = sum(rows, 'declared'), outPaid = sum(rows, 'cash') + sum(rows, 'credit');
  const cash = sum(rows, 'cash') + sum(rows, 'otherCash'), credit = sum(rows, 'credit') + sum(rows, 'otherCredit');
  const heads = rows.map(x => {
    const g = Number(x.g1) + Number(x.g1a) + Number(x.adjust), paid = Number(x.cash) + Number(x.credit), c = Number(x.cash) + Number(x.otherCash), cr = Number(x.credit) + Number(x.otherCredit);
    return { head: x.head, outward: g, declared: Number(x.declared), variance: g - Number(x.declared), outPaid: paid, paidVariance: g - paid, liability: Number(x.totalLiability), cash: c, credit: cr, gap: Number(x.totalLiability) - c - cr };
  });
  return { outward, declared, outPaid, variance: outward - declared, paidVariance: outward - outPaid, cash, credit, total: cash + credit, liability: sum(rows, 'totalLiability'), settlementGap: sum(rows, 'totalLiability') - cash - credit,
    absVariance: heads.reduce((s, h) => s + Math.abs(h.variance), 0), heads };
}

function pf(r) {
  const rows = r.rows || [], v = r.values || {};
  let p = total(rows, ['pEE', 'pER', 'pEPS']), e = total(rows, ['eEE', 'eER', 'eEPS']);
  if (p !== null && ['pAdmin', 'pEdli', 'pOther'].every(k => num(v[k]) !== null)) p += Number(v.pAdmin) + Number(v.pEdli) + Number(v.pOther); else p = null;
  if (e !== null && ['eAdmin', 'eEdli', 'eOther'].every(k => num(v[k]) !== null)) e += Number(v.eAdmin) + Number(v.eEdli) + Number(v.eOther); else e = null;
  const employees = rows.map(x => ({ employee: x.employee, basic: num(x.pBasic), ...Object.fromEntries(['Gross', 'Wage', 'EE', 'ER', 'EPS'].map(k => [k.toLowerCase(), diff(x[`p${k}`], x[`e${k}`])])),
    complete: GRID.PF.filter(f => f[2] === 'number').every(([k]) => num(x[k]) !== null) }));
  return { payroll: p, ecr: e, variance: diff(p, e), challanGap: diff(v.challan, e), paidGap: diff(v.paid, v.challan), employees,
    absContribution: rows.reduce((s, x) => s + ['EE', 'ER', 'EPS'].reduce((n, k) => n + Math.abs((num(x[`p${k}`]) ?? 0) - (num(x[`e${k}`]) ?? 0)), 0), 0) };
}

function esiExpected(r, row, key) {
  const v = r.values || {};
  if (row.covered === 'Unknown' || !['Yes', 'No'].includes(row.covered) || row[`${key}Exempt`] === 'Unknown' || num(row.wage) === null || num(v[`${key}Rate`]) === null) return null;
  if (row.covered === 'No' || row[`${key}Exempt`] === 'Yes') return 0;
  const n = (Number(row.wage) * Number(v[`${key}Rate`])) / 100;
  return v.rounding === 'Next rupee' ? Math.ceil(n - 1e-9) : Math.round((n + Number.EPSILON) * 100) / 100;
}
function esi(r) {
  const rows = r.rows || [], v = r.values || {};
  const ees = rows.map(x => esiExpected(r, x, 'ee')), ers = rows.map(x => esiExpected(r, x, 'er'));
  const out = { ee: ees.length && ees.every(x => x !== null) ? ees.reduce((a, b) => a + b, 0) : null, er: ers.length && ers.every(x => x !== null) ? ers.reduce((a, b) => a + b, 0) : null,
    pEE: total(rows, ['pEE']), pER: total(rows, ['pER']), portalEE: total(rows, ['portalEE']), portalER: total(rows, ['portalER']), challanEE: num(v.challanEE), challanER: num(v.challanER) };
  const challanTotal = out.challanEE !== null && out.challanER !== null ? out.challanEE + out.challanER : null;
  return { ...out, payrollMinusChallanEE: diff(out.pEE, v.challanEE), payrollMinusChallanER: diff(out.pER, v.challanER), expectedMinusChallanEE: diff(out.ee, v.challanEE), expectedMinusChallanER: diff(out.er, v.challanER),
    portalMinusChallanEE: diff(out.portalEE, v.challanEE), portalMinusChallanER: diff(out.portalER, v.challanER), paidMinusChallan: diff(v.paid, challanTotal),
    employees: rows.map(x => ({ employee: x.employee, covered: x.covered, eeExempt: x.eeExempt, erExempt: x.erExempt, wage: num(x.wage), expectedEE: esiExpected(r, x, 'ee'), expectedER: esiExpected(r, x, 'er'), pEE: num(x.pEE), pER: num(x.pER), portalEE: num(x.portalEE), portalER: num(x.portalER), deltaEE: diff(x.pEE, x.portalEE), deltaER: diff(x.pER, x.portalER) })) };
}

/** Vendor scorecard: grouped by supplier GSTIN; one filing observation per supplier / month / return (across recipients) */
function vendor(list) {
  const groups = {};
  for (const r of list) { const k = String(r.values?.vendorGstin || 'Unknown').toUpperCase(); (groups[k] = groups[k] || []).push(r); }
  return Object.entries(groups).map(([gstin, rs]) => {
    const statuses = new Map(); let conflict = false;
    for (const r of rs) for (const k of ['s1', 's3']) { const id = `${r.month}|${k}`; if (statuses.has(id) && statuses.get(id) !== r.values[k]) conflict = true; statuses.set(id, r.values[k]); }
    const values = [...statuses.values()], due = values.filter(x => ['On time', 'Late', 'Not filed'].includes(x)), on = due.filter(x => x === 'On time').length;
    const vals = rs.map(r => r.values);
    const base = sum(vals, 'invoiceITC'), hold = sum(vals, 'vendorHold');
    const unknown = conflict || rs.some(r => missing(r).length) || values.includes('Unknown') || !due.length || base <= 0;
    const risk = unknown ? null : Math.round(60 * (1 - on / due.length) + 40 * Math.min(1, hold / base));
    return { gstin, name: rs[0].values.vendor, risk, due: due.length, on, base, hold, blocked: sum(vals, 'blocked'), other: sum(vals, 'otherHold'), eligible: sum(vals, 'eligible'), conflict, records: rs.map(r => r.id),
      why: risk === null ? (conflict ? 'Conflicting statuses for the same month and return' : !due.length ? 'No known due filings' : base <= 0 ? 'No assessed invoice ITC' : 'Unknown status or incomplete inputs') : `60 × (1 − ${on}/${due.length}) + 40 × min(1, ${hold}/${base})` };
  }).sort((a, b) => (b.risk ?? -1) - (a.risk ?? -1));
}

/** TDS liability rows joined to principal allocations (exact act + code + TAN + month) */
function tdsLines(r, tdsDoc) {
  return (r.rows || []).map(x => {
    const ds = (tdsDoc?.allocations || []).filter(a => a.status === 'active' && a.entity_id === r.entity_id && String(a.tan).toUpperCase() === String(r.registration_number).toUpperCase() && a.liability_month === r.month
      && a.act === String(x.act || '').trim() && String(a.section_code).trim().toUpperCase() === String(x.code || '').trim().toUpperCase());
    const deposited = ds.reduce((s, a) => s + a.principal, 0);
    return { act: x.act, code: x.code, alias: x.alias, liability: num(x.liability), deposited: ds.length ? r2(deposited) : null, gap: ds.length ? r2(diff(x.liability, deposited)) : null, allocations: ds.length, state: ds.length ? 'allocated' : 'unreconciled' };
  });
}

function pt(r) {
  const v = r.values || {}, ptec = v.ptType === 'PTEC';
  return { state: v.state, type: v.ptType, deducted: ptec ? null : num(v.deducted), assessed: num(v.assessed), paid: num(v.paid), deductionMinusAssessed: ptec ? null : diff(v.deducted, v.assessed), assessedMinusPaid: diff(v.assessed, v.paid), ruleSource: v.ruleSource || '' };
}

function calc(r, { tdsDoc } = {}) {
  if (r.type === 'GST') return gst(r);
  if (r.type === 'PF') return pf(r);
  if (r.type === 'ESIC') return esi(r);
  if (r.type === 'TDS') return { lines: tdsLines(r, tdsDoc) };
  if (r.type === 'PT') return pt(r);
  if (r.type === 'VENDOR') { const v = r.values; return { invoiceITC: num(v.invoiceITC), eligible: num(v.eligible), vendorHold: num(v.vendorHold), blocked: num(v.blocked), otherHold: num(v.otherHold), reflected: num(v.reflected), s1: v.s1, s3: v.s3 }; }
  return null;
}

// ── Cleaning and validation ───────────────────────────────────────────────────
function cleanValue(t, raw) {
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  if (t === 'number' || t === 'signed') return s === '' ? '' : s;
  if (t === 'date') return s.slice(0, 10);
  if (t.startsWith('select:')) return s;
  return s.slice(0, 500);
}

function clean(input, { org }) {
  const type = String(input.type || '');
  if (!TYPES[type]) throw U.httpError(400, `Type must be one of: ${Object.keys(TYPES).join(', ')}`);
  const reg = org.registrations.find(x => x.id === input.registration_id);
  const r = { type, entity_id: String(input.entity_id || ''), registration_id: String(input.registration_id || ''), registration_number: reg?.number || '', month: String(input.month || ''), values: {}, rows: [], notes: String(input.notes || '').slice(0, 4000) };
  for (const [k, , t, d] of FIELDS[type]) { const v = input.values?.[k]; r.values[k] = cleanValue(t, v === undefined || v === '' ? (d ?? '') : v); }
  if (GRID[type]) {
    const rows = Array.isArray(input.rows) ? input.rows.slice(0, 5000) : [];
    r.rows = type === 'GST' ? GST_HEADS.map((head, i) => { const src = rows.find(x => x?.head === head) || rows[i] || {}; const o = {}; for (const [k, , t] of GRID.GST) o[k] = k === 'head' ? head : cleanValue(t, src[k]); return o; })
      : rows.map(src => { const o = {}; for (const [k, , t] of GRID[type]) o[k] = cleanValue(t, src?.[k] ?? (t.startsWith('select:') ? t.slice(7).split('|')[0] : '')); return o; });
  }
  if (type === 'VENDOR') r.vendor_gstin = String(r.values.vendorGstin || '').toUpperCase();
  if (type === 'PT' && reg) { r.values.state = r.values.state || reg.state; r.values.ptType = reg.type === 'PT_PTEC' ? 'PTEC' : 'PTRC'; }
  return { r, reg };
}

/** Returns the first error (the demo's wording), or '' — status-dependent checks use `status` */
function validate(r, { org, reg, records, status }) {
  const v = r.values;
  if (!org.entities.some(e => e.id === r.entity_id)) return 'Choose the company';
  if (!reg || reg.entity_id !== r.entity_id || !REG_OF[r.type].includes(reg.type)) return `Choose one of this company's ${r.type === 'TDS' ? 'TAN' : r.type === 'PT' ? 'Professional Tax' : r.type === 'PF' ? 'PF' : r.type === 'ESIC' ? 'ESIC' : 'GST'} registrations`;
  if (!P.isMonth(r.month)) return 'Enter the liability / wage month (YYYY-MM)';
  for (const [k, l, t] of FIELDS[r.type]) {
    if (['number', 'signed'].includes(t) && v[k] !== '' && (num(v[k]) === null || (t === 'number' && Number(v[k]) < 0))) return `Invalid amount: ${l}`;
    if (t === 'date' && v[k] && !U.isDate(v[k])) return `Invalid date: ${l}`;
    if (t.startsWith('select:') && v[k] && !t.slice(7).split('|').includes(v[k])) return `Invalid choice: ${l}`;
  }
  for (const row of r.rows || []) for (const [k, l, t] of GRID[r.type] || []) {
    if (['number', 'signed'].includes(t) && row[k] !== '' && (num(row[k]) === null || (t === 'number' && Number(row[k]) < 0))) return `Invalid row value: ${l}`;
    if (t.startsWith('select:') && !t.slice(7).split('|').includes(row[k])) return `Invalid row choice: ${l}`;
  }
  if (['PF', 'ESIC'].includes(r.type)) { const keys = r.rows.map(x => String(x.employee || '').trim()); if (keys.some(k => !k) || new Set(keys).size !== keys.length) return 'Use a unique non-empty employee key per row.'; }
  if (r.type === 'VENDOR') {
    if (!v.vendor || !v.vendorGstin) return 'Enter supplier name and GSTIN.';
    if (['invoiceITC', 'eligible', 'vendorHold', 'blocked', 'otherHold'].every(k => num(v[k]) !== null) && Math.abs(Number(v.invoiceITC) - Number(v.eligible) - Number(v.vendorHold) - Number(v.blocked) - Number(v.otherHold)) > 0.01) return 'Eligible + vendor hold + statutory blocked + other/unresolved must equal assessed invoice ITC (no overlap).';
    if (Number(v.vendorHold) > 0 && !v.holdReason) return 'Explain the evidenced vendor-related hold.';
    for (const [k, d, f] of [['s1', 'due1', 'file1'], ['s3', 'due3', 'file3']]) {
      if (v[f] && v.checked && v[f] > v.checked) return 'Filing dates cannot be later than the status checked date.';
      if (v[k] === 'On time' && v[f] && v[d] && v[f] > v[d]) return 'On-time status conflicts with filing / due date.';
      if (v[k] === 'Late' && v[f] && v[d] && v[f] <= v[d]) return 'Late status conflicts with filing / due date.';
      if (status !== 'draft' && ['On time', 'Late'].includes(v[k]) && (!v[f] || !v[d])) return 'Provide filing and applicable due dates for assessed filing statuses.';
      if (status !== 'draft' && v[k] === 'Not filed' && (!v[d] || !v.checked || v[d] >= v.checked)) return 'A non-filed overdue return requires an elapsed due date and status check date.';
    }
  }
  if (r.type === 'GST' && r.rows.some(x => Number(x.adjust) || Number(x.g1a)) && !v.adjustReason) return 'Explain GSTR-1A / comparable-scope adjustments.';
  if (r.type === 'TDS') {
    const keys = r.rows.map(x => `${String(x.act || '').trim().toUpperCase()}|${String(x.code || '').trim().toUpperCase()}`);
    if (!r.rows.length || r.rows.some(x => !x.act || !x.code) || new Set(keys).size !== keys.length) return 'Enter unique governing Act / actual section combinations.';
    if (r.rows.some(x => !['1961', '2025'].includes(String(x.act).trim()))) return 'Governing Act must be 1961 or 2025.';
  }
  if (r.type === 'ESIC' && (Number(v.eeRate) > 100 || Number(v.erRate) > 100)) return 'Rates must be between 0 and 100.';
  if (r.type === 'ESIC' && (Number(v.eeRate) !== 0.75 || Number(v.erRate) !== 3.25 || r.rows.some(x => x.covered === 'No' || x.eeExempt === 'Yes' || x.erExempt === 'Yes')) && !v.rateSource) return 'Document the rate override, coverage or exemption basis.';
  if (status !== 'draft') {
    if (missing(r).length) return `Complete missing numeric fields and unknown statuses before submitting for review (${missing(r).slice(0, 3).join('; ')}).`;
    if (!r.evidence?.length) return 'Attach source evidence before submitting for review.';
    if (r.type === 'GST' && (!v.arn1 || !v.arn3 || !v.scope || !v.ledgerRef)) return 'Enter return ARNs, comparable scope and ledger references.';
    if (['PF', 'ESIC'].includes(r.type) && (!v.reference || !v.payrollRef)) return 'Enter payroll and challan/ECR references.';
  }
  const dupe = records.find(x => x.id !== r.id && x.type === r.type && x.entity_id === r.entity_id && x.registration_id === r.registration_id && x.month === r.month && (r.type !== 'VENDOR' || x.vendor_gstin === r.vendor_gstin) && !!x.illustrative === !!r.illustrative);
  if (dupe) return 'A record already exists for this company, registration, month and type/supplier. Edit that record.';
  return '';
}

const snapshot = r => ({ values: U.clone(r.values), rows: U.clone(r.rows), notes: r.notes, evidence: r.evidence.slice(), status: r.status, reviewed_by: r.reviewed_by || null });

/** Create or update a record (always saved as a draft by the actor = preparer) */
function save(doc, input, { org, actor, id, rev, illustrative = false }) {
  const { r, reg } = clean(input, { org });
  const old = id ? doc.records.find(x => x.id === id) : null;
  if (id && !old) throw U.httpError(404, 'Record not found');
  if (old && rev !== undefined && Number(rev) !== old.rev) throw U.httpError(409, 'Someone changed this record since you opened it — reload it');
  if (old && (old.type !== r.type || old.entity_id !== r.entity_id)) throw U.httpError(400, 'Type and company cannot change — create a new record');
  r.id = old?.id; r.illustrative = old ? old.illustrative : illustrative; r.evidence = old ? old.evidence.slice() : [];
  const err = validate(r, { org, reg, records: doc.records, status: 'draft' });
  if (err) throw U.httpError(400, err);
  const now = U.nowIso();
  if (!old) {
    const rec = { ...r, id: U.uid('RC-'), status: 'draft', prepared_by: actor.name, prepared_by_id: actor.id, reviewed_by: null, version: 1, revisions: [], rev: 1, created_at: now, history: [{ at: now, by: actor.name, action: 'created', status: 'draft' }] };
    doc.records.push(rec);
    return rec;
  }
  if (old.status === 'reviewed') { old.revisions.push({ version: old.version, at: now, by: actor.name, snapshot: snapshot(old) }); old.version += 1; }
  Object.assign(old, { registration_id: r.registration_id, registration_number: r.registration_number, month: r.month, values: r.values, rows: r.rows, notes: r.notes, vendor_gstin: r.vendor_gstin,
    status: 'draft', prepared_by: actor.name, prepared_by_id: actor.id, reviewed_by: null, reviewed_by_id: null, rev: old.rev + 1 });
  old.history.push({ at: now, by: actor.name, action: 'edited', status: 'draft', version: old.version });
  return old;
}

function transition(doc, id, action, { org, actor, note, rev }) {
  const r = doc.records.find(x => x.id === id);
  if (!r) throw U.httpError(404, 'Record not found');
  if (rev !== undefined && Number(rev) !== r.rev) throw U.httpError(409, 'Someone changed this record since you opened it — reload it');
  const reg = org.registrations.find(x => x.id === r.registration_id);
  const now = U.nowIso();
  if (action === 'submit') {
    if (r.status !== 'draft') throw U.httpError(400, 'Only a draft can be submitted');
    const err = validate(r, { org, reg, records: doc.records, status: 'ready_for_review' });
    if (err) throw U.httpError(400, err);
    r.status = 'ready_for_review';
    r.prepared_by = actor.name; r.prepared_by_id = actor.id;
  } else if (action === 'review') {
    if (r.status !== 'ready_for_review') throw U.httpError(400, 'Only a record that is ready for review can be marked reviewed');
    if (r.prepared_by_id === actor.id) throw U.httpError(403, 'You prepared this record, so a separate reviewer must review it');
    const err = validate(r, { org, reg, records: doc.records, status: 'reviewed' });
    if (err) throw U.httpError(400, err);
    r.status = 'reviewed'; r.reviewed_by = actor.name; r.reviewed_by_id = actor.id; r.reviewed_at = now;
  } else if (action === 'return') {
    if (r.status === 'draft') throw U.httpError(400, 'It is already a draft');
    if (String(note || '').trim().length < 5) throw U.httpError(400, 'Say why it goes back to the preparer');
    if (r.status === 'reviewed') { r.revisions.push({ version: r.version, at: now, by: actor.name, snapshot: snapshot(r) }); r.version += 1; }
    r.status = 'draft'; r.reviewed_by = null; r.reviewed_by_id = null;
  } else throw U.httpError(400, 'action must be submit, review or return');
  r.rev += 1;
  r.history.push({ at: now, by: actor.name, action, status: r.status, note: String(note || '').slice(0, 1000) });
  return r;
}

// ── CSV grid template / import (strict headers, from the demo) ────────────────
function parseCsv(text) {
  const result = []; let row = [], cell = '', quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quote && text[i + 1] === '"') { cell += '"'; i++; } else quote = !quote; }
    else if (c === ',' && !quote) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quote) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(x => x.trim())) result.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (quote) throw U.httpError(400, 'Unclosed CSV quote.');
  if (cell || row.length) { row.push(cell); result.push(row); }
  return result;
}
function templateRows(type) {
  const f = GRID[type];
  if (!f) throw U.httpError(400, 'This type has no grid');
  return [f.map(x => x[0]), ...(type === 'GST' ? GST_HEADS.map(h => f.map(([k]) => (k === 'head' ? h : ''))) : [f.map(([k, , t]) => (k === 'employee' ? 'EMP-001' : k === 'act' ? '1961' : t.startsWith('select:') ? t.slice(7).split('|')[0] : ''))])];
}
function importGrid(type, text) {
  const f = GRID[type];
  if (!f) throw U.httpError(400, 'This type has no grid');
  const data = parseCsv(String(text || '').replace(/^﻿/, ''));
  if (!data.length || JSON.stringify(data[0].map(s => s.trim())) !== JSON.stringify(f.map(x => x[0]))) throw U.httpError(400, 'CSV headers must exactly match the downloaded template.');
  const rows = data.slice(1).map((v, i) => {
    if (v.length !== f.length) throw U.httpError(400, `Wrong column count at row ${i + 2}`);
    const o = {};
    f.forEach(([k, l, t], j) => {
      const value = v[j].trim().replace(/^'(?=[=+@-])/, '');
      if ((t === 'number' || t === 'signed') && value !== '' && (num(value) === null || (t === 'number' && Number(value) < 0))) throw U.httpError(400, `Invalid number at row ${i + 2}: ${l}`);
      if (t.startsWith('select:') && !t.slice(7).split('|').includes(value)) throw U.httpError(400, `Invalid choice at row ${i + 2}: ${l}`);
      o[k] = value;
    });
    return o;
  });
  if (!rows.length) throw U.httpError(400, 'CSV has no data rows.');
  if (type === 'GST' && JSON.stringify(rows.map(r => r.head)) !== JSON.stringify(GST_HEADS)) throw U.httpError(400, 'GST requires the four template tax heads in order.');
  return rows;
}

module.exports = { TYPES, REG_OF, STATUSES, GST_HEADS, GRID, FIELDS, EMPTY, num, missing, gst, pf, esi, esiExpected, vendor, tdsLines, pt, calc, clean, validate, save, transition, parseCsv, templateRows, importGrid };
