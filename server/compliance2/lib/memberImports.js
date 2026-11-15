/**
 * Payroll imports (V10): salary XLSX / CSV with sheet, header-row and column mapping; PF monthly ECR (11 fields separated by
 * "#~#"); ESIC member contribution XLSX / CSV. Matching on EXACT identifiers only (UAN / IP / employee id) — never on names.
 *
 * Store document "<sp>_imports": { batches: [] }
 * Batch: { id, entity_id, registration_id, fund 'PF' | 'ESIC', month, kind 'regular' | 'supplementary',
 *          payroll { file_id, name, sha256, sheet, header_row, mapping, rows[] }, returns { file_id, name, sha256, format, sheet, header_row, mapping, rows[] },
 *          proof [attachment ids], status 'draft' | 'reviewed', recon_id, created_by, history[] }
 * Row: { key, name, gross, basic, wage, ee, er, eps, source_row } — blank numbers are null (missing), never 0.
 *
 *   • The source files are kept (attachments.js) with their SHA-256; each row keeps its source row number (lineage).
 *   • A missing ECR entry is an exception to investigate — not proof of non-deposit. A matching ECR is not payment evidence:
 *     the paid challan and bank proof are checked separately.
 *   • A supplementary / amended return for the same fund and month is its own batch: it is never added on top of the
 *     regular batch automatically (no double counting) — the reviewer picks which one goes to reconciliation.
 *   • Native PDF / image challans are evidence only; nothing is read from them.
 */

'use strict';

const XLSX = require('xlsx');
const U = require('./util');

const FUNDS = { PF: 'Provident Fund (ECR)', ESIC: 'ESIC member contributions' };
const MAP_KEYS = ['key', 'name', 'gross', 'basic', 'wage', 'ee', 'er', 'eps'];
const MAP_LABELS = { key: 'Employee identifier (UAN / IP / employee id) *', name: 'Name (display only — never used to match)', gross: 'Gross wages', basic: 'Basic (context only)', wage: 'EPF / ESI wages', ee: 'Employee contribution *', er: 'Employer contribution (EPF / ESIC)', eps: 'Employer EPS (PF only)' };
const STATUSES = ['Missing identifier', 'Duplicate identifier', 'Return only', 'Payroll deduction missing from return', 'Payroll only · no deduction', 'Amount missing', 'Employee contribution differs', 'Amount matched · payment unverified'];
const EMPTY = () => ({ batches: [] });

const numOf = v => { const s = String(v ?? '').replace(/,/g, '').trim(); return s === '' ? null : Number.isFinite(Number(s)) ? Number(s) : NaN; };
const keyOf = v => String(v ?? '').trim().replace(/\s+/g, '').toUpperCase();
const mask = v => (String(v).length > 6 ? `••••${String(v).slice(-4)}` : String(v));

/** ECR v2 monthly text: UAN #~# name #~# gross #~# EPF wages #~# EPS wages #~# EDLI wages #~# EE #~# EPS #~# ER #~# NCP days #~# refund */
function parseEcr(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter(x => x.trim());
  if (!lines.length) throw U.httpError(400, 'The ECR file is empty');
  return lines.map((line, i) => {
    const a = line.split('#~#');
    if (a.length !== 11) throw U.httpError(400, `Monthly ECR v2 needs 11 #~# fields. Row ${i + 1} has ${a.length}. Arrear / other layouts need the spreadsheet mapping instead.`);
    if (!/^\d{12}$/.test(a[0].trim())) throw U.httpError(400, `Invalid UAN in ECR row ${i + 1}`);
    for (let j = 2; j < 11; j++) { const n = numOf(a[j]); if (n === null || Number.isNaN(n)) throw U.httpError(400, `Invalid number in ECR row ${i + 1}, field ${j + 1}`); }
    return { key: keyOf(a[0]), name: a[1].trim().slice(0, 100), gross: numOf(a[2]), wage: numOf(a[3]), eps_wage: numOf(a[4]), edli_wage: numOf(a[5]), ee: numOf(a[6]), eps: numOf(a[7]), er: numOf(a[8]), ncp_days: numOf(a[9]), refund: numOf(a[10]), basic: null, source_row: i + 1 };
  });
}

/** Spreadsheet / CSV → sheets of string rows (every cell as text, so long ids are not turned into numbers) */
function readSheets(buffer, type) {
  let wb;
  try { wb = type === 'csv' ? XLSX.read(buffer.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true }) : XLSX.read(buffer, { type: 'buffer', cellDates: false }); }
  catch (e) { throw U.httpError(400, `The spreadsheet could not be read (${e.message})`); }
  return wb.SheetNames.slice(0, 20).map(name => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false }).slice(0, 20000).map(r => r.map(c => String(c ?? '')));
    return { name, rows };
  });
}

const preview = sheets => sheets.map(s => ({ name: s.name, row_count: s.rows.length, rows: s.rows.slice(0, 25) }));

/** Applies a column mapping ({ key: column index, … }) from the header row → rows; strict number checks */
function applyMapping(sheets, { sheet, header_row, mapping }) {
  const s = sheets.find(x => x.name === sheet) || sheets[Number(sheet)] || null;
  if (!s) throw U.httpError(400, 'Choose the sheet');
  const h = Number(header_row);
  if (!Number.isInteger(h) || h < 1 || h > s.rows.length) throw U.httpError(400, 'Header row must be a row number in the sheet');
  const map = {};
  for (const k of MAP_KEYS) { const v = mapping?.[k]; map[k] = v === '' || v === null || v === undefined ? null : Number(v); if (map[k] !== null && (!Number.isInteger(map[k]) || map[k] < 0)) throw U.httpError(400, `Column for ${k} is not valid`); }
  if (map.key === null || map.ee === null) throw U.httpError(400, 'Map the employee identifier and the employee contribution');
  const data = s.rows.slice(h).map((r, i) => ({ r, row: h + i + 1 })).filter(x => x.r.some(v => String(v).trim() !== ''));
  if (!data.length) throw U.httpError(400, 'No data rows under the header row');
  const rows = data.map(({ r, row }) => {
    const o = { source_row: row };
    for (const k of MAP_KEYS) {
      const v = map[k] === null ? '' : r[map[k]] ?? '';
      if (k === 'key') { if (/^\d+(\.\d+)?[eE][+-]?\d+$/.test(String(v).trim())) throw U.httpError(400, `Scientific-notation identifier at row ${row}. Format the id column as text and export again.`); o.key = keyOf(v); }
      else if (k === 'name') o.name = String(v).trim().slice(0, 100);
      else { const n = numOf(v); if (Number.isNaN(n)) throw U.httpError(400, `Invalid ${k} at row ${row}. Remove total / footer rows and check the number columns.`); o[k] = n; }
    }
    return o;
  });
  return { sheet: s.name, header_row: h, headers: (s.rows[h - 1] || []).slice(0, 60), mapping: map, rows };
}

/** Exact-identifier matching (demo miMatch) */
function match(pay, ret) {
  if (!pay || !ret) return [];
  const ps = new Map(), rs = new Map();
  pay.forEach((r, i) => { const k = r.key || `MISSING-P-${i}`; (ps.get(k) || ps.set(k, []).get(k)).push(r); });
  ret.forEach((r, i) => { const k = r.key || `MISSING-R-${i}`; (rs.get(k) || rs.set(k, []).get(k)).push(r); });
  return [...new Set([...ps.keys(), ...rs.keys()])].map(key => {
    const p = ps.get(key) || [], r = rs.get(key) || [];
    const status = key.startsWith('MISSING-') ? 'Missing identifier' : p.length > 1 || r.length > 1 ? 'Duplicate identifier' : !p.length ? 'Return only'
      : !r.length ? (p[0].ee > 0 ? 'Payroll deduction missing from return' : 'Payroll only · no deduction')
        : p[0].ee === null || r[0].ee === null ? 'Amount missing' : Math.abs(p[0].ee - r[0].ee) > 0.01 ? 'Employee contribution differs' : 'Amount matched · payment unverified';
    return { key, masked: key.startsWith('MISSING-') ? '(no identifier)' : mask(key), recon_key: key.startsWith('MISSING-') ? key : `${mask(key)}-${U.sha256(key).slice(0, 4)}`, name: p[0]?.name || r[0]?.name || '', p: p[0] || null, r: r[0] || null, p_count: p.length, r_count: r.length, status,
      delta: p.length === 1 && r.length === 1 && p[0].ee !== null && r[0].ee !== null ? Math.round((p[0].ee - r[0].ee) * 100) / 100 : null,
      p_rows: p.map(x => x.source_row), r_rows: r.map(x => x.source_row) };
  });
}

function summary(b) {
  const m = match(b.payroll?.rows, b.returns?.rows);
  const count = Object.fromEntries(STATUSES.map(s => [s, m.filter(x => x.status === s).length]));
  const tot = (rows, k) => (rows || []).reduce((a, r) => a + (r[k] ?? 0), 0);
  return { matches: m, count, exceptions: m.filter(x => x.status !== 'Amount matched · payment unverified' && x.status !== 'Payroll only · no deduction').length,
    totals: { payroll_ee: tot(b.payroll?.rows, 'ee'), return_ee: tot(b.returns?.rows, 'ee'), payroll_er: tot(b.payroll?.rows, 'er'), return_er: tot(b.returns?.rows, 'er'), payroll_eps: tot(b.payroll?.rows, 'eps'), return_eps: tot(b.returns?.rows, 'eps') },
    members: { payroll: b.payroll?.rows?.length || 0, returns: b.returns?.rows?.length || 0 }, blocking: m.some(x => ['Duplicate identifier', 'Missing identifier'].includes(x.status)) };
}

function create(doc, input, { org, actor }) {
  const reg = org.registrations.find(r => r.id === input.registration_id);
  const b = { entity_id: String(input.entity_id || ''), registration_id: String(input.registration_id || ''), fund: String(input.fund || ''), month: String(input.month || ''), kind: input.kind === 'supplementary' ? 'supplementary' : 'regular' };
  const errors = [];
  if (!org.entities.some(e => e.id === b.entity_id)) errors.push('Choose the company');
  if (!FUNDS[b.fund]) errors.push('Fund must be PF or ESIC');
  if (!reg || reg.entity_id !== b.entity_id || reg.type !== b.fund) errors.push(`Choose this company's ${b.fund || 'PF / ESIC'} registration (establishment / employer code)`);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(b.month)) errors.push('Wage month is required (YYYY-MM)');
  if (!input.payroll?.rows?.length) errors.push('Upload and map the salary file');
  if (!input.returns?.rows?.length) errors.push(`Upload the ${b.fund === 'PF' ? 'member-wise ECR' : 'ESIC member contribution file'}`);
  if (errors.length) throw U.httpError(400, errors.join('; '));
  if (b.kind === 'regular' && doc.batches.some(x => x.entity_id === b.entity_id && x.registration_id === b.registration_id && x.fund === b.fund && x.month === b.month && x.kind === 'regular' && x.status !== 'withdrawn'))
    throw U.httpError(409, 'A regular batch already exists for this registration and month. Mark this one "supplementary / amended" (it is kept separate and never added on top), or withdraw the old one.');
  const now = U.nowIso();
  const rec = { id: U.uid('IB-'), ...b, registration_number: reg.number, payroll: input.payroll, returns: input.returns, proof: Array.isArray(input.proof) ? input.proof : [], status: 'draft', recon_id: null,
    created_by: actor.name, created_by_id: actor.id, created_at: now, history: [{ at: now, by: actor.name, action: 'imported' }] };
  doc.batches.push(rec);
  return rec;
}

/** Rows for the PF / ESIC reconciliation grid (lib/recon.js) — ESIC coverage stays "Unknown" until a person confirms it */
function toReconRows(b) {
  const s = summary(b);
  if (s.blocking) throw U.httpError(400, 'Resolve duplicate / missing identifiers before sending to reconciliation');
  const v = n => (n === null || n === undefined ? '' : String(n));
  return s.matches.map(m => (b.fund === 'PF'
    ? { employee: m.recon_key, pGross: v(m.p?.gross), pBasic: v(m.p?.basic), pWage: v(m.p?.wage), pEE: v(m.p?.ee), pER: v(m.p?.er), pEPS: v(m.p?.eps), eGross: v(m.r?.gross), eWage: v(m.r?.wage), eEE: v(m.r?.ee), eER: v(m.r?.er), eEPS: v(m.r?.eps) }
    : { employee: m.recon_key, covered: 'Unknown', eeExempt: 'Unknown', erExempt: 'Unknown', wage: v(m.p?.wage), pEE: v(m.p?.ee), pER: v(m.p?.er), portalEE: v(m.r?.ee), portalER: v(m.r?.er) }));
}

module.exports = { FUNDS, MAP_KEYS, MAP_LABELS, STATUSES, EMPTY, parseEcr, readSheets, preview, applyMapping, match, summary, create, toReconRows, mask, keyOf };
