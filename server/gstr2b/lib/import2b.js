/**
 * GSTR-2B statement parser — official GST portal JSON and Excel downloads.
 *
 * What is verified and what is not (see DESIGN.md §4):
 *   - Table names (B2B, B2BA, B2B-CDNR, B2B-CDNRA, ISD, ISDA, IMPG, IMPGSEZ (+ amendments), ECO/ECOA, Rule 37A
 *     reversals) are from the GST portal's own GSTR-2B user manual.
 *   - The JSON key layout (docdata.b2b[].inv[] …) is from a third-party rendering of the GSTN API response; GSTN
 *     publishes no public JSON schema. The parser therefore accepts both invoice-level and item-level amounts,
 *     looks for the data root instead of assuming it, and reports anything it does not recognise.
 *   - The Excel layout is read by header text, not by fixed column positions. It has NOT been run against a real
 *     downloaded workbook yet — upload one from each GSTIN to lock the mapping (Imports → preview shows what was read).
 *
 * Nothing is silently dropped: unsupported sections are listed with their counts and kept as documents that
 * the reconciliation shows as "Excluded", rows with problems are kept with an issue code and a row-level error.
 */

'use strict';

const XLSX = require('xlsx');
const { toPaise, p0, COMPONENTS, zeroAmounts, addAmounts } = require('./money');
const N = require('./normalize');
const { sha256 } = require('./util');

// ── Sections ──────────────────────────────────────────────────────────────────
const SECTIONS = {
  b2b:     { label: 'B2B invoices', matchable: true },
  b2ba:    { label: 'B2B invoices — amendments', matchable: true },
  cdnr:    { label: 'B2B credit / debit notes', matchable: true },
  cdnra:   { label: 'B2B credit / debit notes — amendments', matchable: true },
  isd:     { label: 'ISD credits', matchable: false, reason: 'ISD credits are distributed credit, not supplier invoices — reviewed in the ITC register (Phase 2)' },
  isda:    { label: 'ISD credits — amendments', matchable: false, reason: 'ISD credits are distributed credit, not supplier invoices — reviewed in the ITC register (Phase 2)' },
  impg:    { label: 'Import of goods (bill of entry)', matchable: false, reason: 'Bill-of-entry records need customs data that Zoho Books does not hold as structured fields — supplemental import (Phase 2)' },
  impga:   { label: 'Import of goods — amendments', matchable: false, reason: 'Bill-of-entry records need customs data that Zoho Books does not hold as structured fields — supplemental import (Phase 2)' },
  impgsez: { label: 'Import from SEZ (bill of entry)', matchable: false, reason: 'Bill-of-entry records need customs data that Zoho Books does not hold as structured fields — supplemental import (Phase 2)' },
  impgasez: { label: 'Import from SEZ — amendments', matchable: false, reason: 'Bill-of-entry records need customs data that Zoho Books does not hold as structured fields — supplemental import (Phase 2)' },
  ecom:    { label: 'E-commerce operator documents (s.9(5))', matchable: false, reason: 'E-commerce operator documents are not matched in Phase 1' },
  ecoma:   { label: 'E-commerce operator documents — amendments', matchable: false, reason: 'E-commerce operator documents are not matched in Phase 1' },
  itcrev:  { label: 'ITC reversal (Rule 37A) records', matchable: false, reason: 'Rule 37A reversal records are reviewed in the ITC register (Phase 2)' },
};
const SUMMARY_SHEETS = new Set(['itcavailable', 'itcnotavailable', 'itcreversal', 'itcrejected', 'readme', 'summary']);

const pushIssue = (arr, section, ref, field, message) => arr.push({ section, ref, field, message });
const yn = v => { const s = String(v ?? '').trim().toUpperCase(); return !s ? '' : /^(Y|YES|TRUE)$/.test(s) ? 'Y' : /^(N|NO|FALSE)$/.test(s) ? 'N' : s[0]; };

// ── Entry point ───────────────────────────────────────────────────────────────
/**
 * @param {Buffer} buf
 * @param {string} fileName
 * @returns the parsed statement (see top of file); throws Error only when the file cannot be read at all
 */
function parseStatement(buf, fileName = '') {
  const out = {
    format: null, sha256: sha256(buf), file_name: fileName, size: buf.length,
    meta: { gstin: '', period: null, gendt: null, version: null, legal_name: '', raw_period: '' },
    docs: [], sections: {}, unsupported: [], errors: [], warnings: [],
    control: { declared: null, ok: null, diffs: [], note: '' }, itcsumm: null,
  };
  const head = buf.slice(0, 4).toString('latin1');
  if (head.startsWith('PK')) { out.format = 'xlsx'; parseExcel(buf, out); }
  else if (/^\s*[{[]/.test(buf.slice(0, 64).toString('utf8').replace(/^﻿/, ''))) { out.format = 'json'; parseJson(buf, out); }
  else throw new Error('This is not a GSTR-2B JSON or Excel file. Download it from the GST portal: Returns → GSTR-2B → Download.');
  finish(out);
  return out;
}

function finish(out) {
  // per-section totals (always, so the preview can be reconciled with the portal's own numbers)
  for (const d of out.docs) {
    const s = (out.sections[d.section] = out.sections[d.section] || { label: (SECTIONS[d.section] || {}).label || d.section, matchable: !!(SECTIONS[d.section] || {}).matchable, count: 0, amounts: zeroAmounts(), signed: zeroAmounts() });
    s.count++;
    s.amounts = addAmounts(s.amounts, d.amounts);
    const sign = d.doc_type === 'CRN' ? -1 : 1;
    for (const c of COMPONENTS) s.signed[c] += sign * (d.amounts[c] || 0);
  }
  out.meta.period = out.meta.period || N.parsePeriod(out.meta.raw_period);
  if (!out.meta.gstin) out.warnings.push('The file does not state which GSTIN it belongs to — confirm it on the next screen.');
  if (!out.meta.period) out.warnings.push('The file does not state its return period — confirm it on the next screen.');
  for (const d of out.docs) d.period = out.meta.period;
}

// ── JSON ──────────────────────────────────────────────────────────────────────
function findRoot(j, depth = 0) {
  if (!j || typeof j !== 'object' || depth > 5) return null;
  if (j.docdata && typeof j.docdata === 'object') return j;
  if (Array.isArray(j)) return null;
  for (const k of ['data', 'gstr2b', 'GSTR2B', 'response', 'result']) { const r = findRoot(j[k], depth + 1); if (r) return r; }
  return null;
}

function parseJson(buf, out) {
  let j;
  try { j = JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch (e) { throw new Error(`The JSON file could not be read: ${e.message}`); }
  const root = findRoot(j);
  if (!root) throw new Error('No GSTR-2B document data ("docdata") was found in this JSON file. If it is a GSTR-2A or GSTR-1 file, it cannot be imported here.');
  out.meta.gstin = N.normGstin(root.gstin || '');
  out.meta.raw_period = String(root.rtnprd || '');
  out.meta.period = N.rtnprdToPeriod(root.rtnprd);
  out.meta.gendt = N.parseDate(root.gendt) || null;
  out.meta.version = root.version || null;
  out.itcsumm = root.itcsumm || null;
  const cpsumm = root.cpsumm || null;

  for (const [section, value] of Object.entries(root.docdata)) {
    const key = section.toLowerCase();
    const def = SECTIONS[key];
    if (!def) {
      const count = Array.isArray(value) ? value.length : (value && typeof value === 'object' ? Object.keys(value).length : 1);
      out.unsupported.push({ section, label: section, count, reason: 'Section not recognised by this version of the importer — nothing from it was imported' });
      continue;
    }
    if (key === 'itcrev') { jsonItcRev(value, out); continue; }
    if (!Array.isArray(value)) { pushIssue(out.errors, key, '', '', `Section "${section}" is not a list`); continue; }
    value.forEach((sup, si) => jsonSupplierBlock(key, sup, si, out));
  }
  jsonControl(out, cpsumm);
}

function jsonSupplierBlock(section, sup, si, out) {
  if (!sup || typeof sup !== 'object') { pushIssue(out.errors, section, `[${si}]`, '', 'Supplier block is not an object'); return; }
  const base = { supplier: supplierOf(sup, section), section };
  const lists = { inv: 'inv', nt: 'nt', doclist: 'doclist', boe: 'boe' };
  let any = false;
  for (const [k] of Object.entries(lists)) {
    if (!Array.isArray(sup[k])) continue;
    any = true;
    sup[k].forEach((row, ri) => jsonDoc(section, k, row, ri, si, base, out));
  }
  // flat records (IMPG: the block is the bill of entry itself)
  if (!any && (sup.boenum || sup.portcode)) jsonDoc(section, 'boe', sup, 0, si, { supplier: supplierOf(sup, section), section }, out);
  if (!any && !(sup.boenum || sup.portcode)) pushIssue(out.errors, section, `[${si}]`, '', 'Supplier block has no documents (inv / nt / doclist / boe)');
}

function supplierOf(sup, section) {
  const gi = N.gstinInfo(sup.ctin || '');
  return { gstin: gi.gstin, name: sup.trdnm || '', pan: gi.pan, gstin_valid: section.startsWith('impg') && !gi.gstin ? true : gi.valid, state: gi.state,
    filing_period: sup.supprd || '', filing_date: N.parseDate(sup.supfildt) || null };
}

/** Amounts of one document: invoice-level fields, or the sum of items[] (both checked against each other) */
function amountsOf(row, ref, section, out) {
  const direct = { taxable: toPaise(row.txval), igst: toPaise(row.igst), cgst: toPaise(row.cgst), sgst: toPaise(row.sgst), cess: toPaise(row.cess) };
  const hasDirect = COMPONENTS.some(c => direct[c] !== null);
  let items = null;
  const rateLines = [];
  if (Array.isArray(row.items) && row.items.length) {
    items = zeroAmounts();
    for (const it of row.items) {
      const l = { rate: it.rt ?? null, taxable: p0(it.txval), igst: p0(it.igst), cgst: p0(it.cgst), sgst: p0(it.sgst), cess: p0(it.cess) };
      rateLines.push(l);
      for (const c of COMPONENTS) items[c] += l[c];
    }
  }
  if (hasDirect && items) {
    const diff = COMPONENTS.filter(c => (direct[c] ?? 0) !== items[c]);
    if (diff.length) pushIssue(out.errors, section, ref, diff.join(','), 'Invoice-level amounts do not equal the sum of the rate-wise items in the file — the invoice-level amounts were used');
  }
  const a = hasDirect ? Object.fromEntries(COMPONENTS.map(c => [c, direct[c] ?? 0])) : (items || zeroAmounts());
  return { amounts: a, rateLines, ok: hasDirect || !!items };
}

function jsonDoc(section, listKey, row, ri, si, base, out) {
  const ref = `${section}[${si}].${listKey}[${ri}]`;
  if (!row || typeof row !== 'object') { pushIssue(out.errors, section, ref, '', 'Document is not an object'); return; }
  const issues = [];
  let doc_type = 'INV', doc_no, doc_date, orig = null, is_amendment = false, invType = '';
  if (section === 'b2b' || section === 'b2ba' || section === 'ecom' || section === 'ecoma') {
    doc_no = row.inum; doc_date = N.parseDate(row.dt); invType = row.typ || '';
    if (section === 'b2ba' || section === 'ecoma') { is_amendment = true; orig = { doc_no: row.oinum || '', doc_date: N.parseDate(row.oidt) }; }
  } else if (section === 'cdnr' || section === 'cdnra') {
    doc_no = row.ntnum; doc_date = N.parseDate(row.dt); invType = row.suptyp || '';
    doc_type = String(row.typ || '').toUpperCase() === 'D' ? 'DBN' : String(row.typ || '').toUpperCase() === 'C' ? 'CRN' : 'INV';
    if (doc_type === 'INV') issues.push('note_type_unknown');
    if (section === 'cdnra') { is_amendment = true; orig = { doc_no: row.ontnum || '', doc_date: N.parseDate(row.ontdt), doc_type: String(row.onttyp || '').toUpperCase() === 'D' ? 'DBN' : 'CRN' }; }
  } else if (section === 'isd' || section === 'isda') {
    doc_no = row.docnum; doc_date = N.parseDate(row.docdt); doc_type = String(row.doctyp || '').toUpperCase() === 'ISDC' ? 'CRN' : 'INV';
    if (section === 'isda') { is_amendment = true; orig = { doc_no: row.odocnum || '', doc_date: N.parseDate(row.odocdt) }; }
  } else if (section.startsWith('impg')) {
    doc_no = row.boenum; doc_date = N.parseDate(row.boedt); is_amendment = section.endsWith('a') || section.endsWith('asez') || String(row.isamd || '').toUpperCase() === 'Y';
  } else { doc_no = row.inum || row.docnum || row.ntnum; doc_date = N.parseDate(row.dt || row.docdt); }
  const { amounts, rateLines, ok } = amountsOf(row, ref, section, out);
  if (!ok) { issues.push('amounts_missing'); pushIssue(out.errors, section, ref, 'txval/igst/cgst/sgst/cess', 'No amounts found on this document'); }
  if (!doc_no) { issues.push('doc_no_missing'); pushIssue(out.errors, section, ref, 'document number', 'Document number is missing'); }
  if (!doc_date) { issues.push('doc_date_invalid'); pushIssue(out.errors, section, ref, 'document date', `Document date "${row.dt ?? row.docdt ?? row.boedt ?? ''}" could not be read`); }
  if (base.supplier.gstin && !base.supplier.gstin_valid) { issues.push('invalid_gstin'); pushIssue(out.errors, section, ref, 'supplier GSTIN', `Supplier GSTIN ${base.supplier.gstin} fails the GSTIN check`); }
  if (!base.supplier.gstin && !section.startsWith('impg')) { issues.push('supplier_gstin_missing'); pushIssue(out.errors, section, ref, 'supplier GSTIN', 'Supplier GSTIN is missing'); }
  out.docs.push(draft({
    section, src: { ref }, supplier: base.supplier, doc_type, doc_no, doc_date, orig, is_amendment, inv_type: invType,
    amounts, rate_lines: rateLines, invoice_value: toPaise(row.val) ?? undefined,
    pos: row.pos != null ? String(row.pos) : '', rcm: yn(row.rev) === 'Y', itc_available: yn(row.itcavl || row.itcelg), reason: row.rsn || '',
    diffprcnt: row.diffprcnt ?? null, source_type: row.srctyp || '', irn: row.irn || '', irn_date: N.parseDate(row.irngendate) || null,
    issues,
  }));
}

function jsonItcRev(value, out) {
  // Rule 37A reversal records: an object of b2b / b2ba / cdnr / cdnra lists (or a list of such objects)
  const blocks = Array.isArray(value) ? value : [value];
  blocks.forEach((blk, bi) => {
    for (const k of ['b2b', 'b2ba', 'cdnr', 'cdnra']) {
      if (!Array.isArray(blk && blk[k])) continue;
      blk[k].forEach((sup, si) => {
        const before = out.docs.length;
        jsonSupplierBlock(k, sup, si, out);
        for (let i = before; i < out.docs.length; i++) {
          const d = out.docs[i];
          d.section = 'itcrev'; d.src.ref = `itcrev[${bi}].${d.src.ref}`;
          d.matchable = false; d.unsupported_reason = SECTIONS.itcrev.reason;      // a reversal record is not a supplier invoice
        }
      });
    }
  });
}

/** Control totals: the portal's own counterparty summary (cpsumm) against the documents actually read */
function jsonControl(out, cpsumm) {
  if (!cpsumm || typeof cpsumm !== 'object') { out.control.note = 'The file carries no counterparty summary (cpsumm), so the import cannot be compared with portal totals.'; return; }
  const diffs = [];
  let compared = 0;
  for (const [sec, rows] of Object.entries(cpsumm)) {
    if (!Array.isArray(rows)) continue;                                  // itcrev is an object of lists — compared as a whole below
    const key = sec.toLowerCase();
    for (const r of rows) {
      const ctin = N.normGstin(r.ctin || '');
      const docs = out.docs.filter(d => d.section === key && d.supplier.gstin === ctin && (!r.nttyp || (r.nttyp === 'D' ? d.doc_type === 'DBN' : d.doc_type === 'CRN')));
      compared++;
      const got = docs.reduce((a, d) => addAmounts(a, d.amounts), zeroAmounts());
      const want = { taxable: p0(r.txval), igst: p0(r.igst), cgst: p0(r.cgst), sgst: p0(r.sgst), cess: p0(r.cess) };
      const bad = COMPONENTS.filter(c => (key === 'isd' || key === 'isda') && c === 'taxable' ? false : got[c] !== want[c]);
      const countOk = r.ttldocs == null || Number(r.ttldocs) === docs.length;
      if (bad.length || !countOk) diffs.push({ section: key, supplier: ctin, declared_docs: r.ttldocs ?? null, read_docs: docs.length, components: bad });
    }
  }
  out.control.declared = { source: 'cpsumm', suppliers_compared: compared };
  out.control.diffs = diffs;
  out.control.ok = diffs.length === 0;
  out.control.note = diffs.length ? `${diffs.length} supplier line(s) differ from the portal's own summary` : `All ${compared} supplier summary lines in the file agree with the documents read`;
}

// ── Excel ─────────────────────────────────────────────────────────────────────
const SHEET_KEYS = [
  [/^b2bcdnra$/, 'cdnra'], [/^b2bcdnr$/, 'cdnr'], [/^b2bdnra$|^b2bdnr$/, 'itcrev'], [/^b2ba$/, 'b2ba'], [/^b2b$/, 'b2b'],
  [/^isda$/, 'isda'], [/^isd$/, 'isd'], [/^impgsezamendment$|^impgsezamendments$|^impgasez$/, 'impgasez'], [/^impgsez$/, 'impgsez'],
  [/^impgamendment$|^impgamendments$|^impga$/, 'impga'], [/^impg$/, 'impg'], [/^ecoa$/, 'ecoma'], [/^eco$/, 'ecom'],
];
const sheetKey = name => { const k = String(name).toLowerCase().replace(/[^a-z0-9]/g, ''); for (const [re, v] of SHEET_KEYS) if (re.test(k)) return v; return null; };

// header text (normalised, parents + leaf joined) → field. More specific patterns first.
const HEADERS = [
  ['oinum',   /original.*(invoice|note|document).*(number|no)\b/], ['oidt', /original.*(invoice|note|document).*date/], ['onttyp', /original.*note type/],
  ['ctin',    /gstin of (supplier|isd)|supplier gstin|^gstin$/], ['trdnm', /trade.*legal name|trade name|legal name|supplier name/],
  ['supprd',  /gstr.*period/], ['supfildt', /gstr.*filing date/],
  ['irngendate', /irn date/], ['irn', /\birn\b/],
  ['diffprcnt', /applicable.*rate/], ['rsn', /\breason\b/], ['itcavl', /itc availability/], ['srctyp', /^source$|\bsource\b/],
  ['ntyp',    /note type|credit.*debit/], ['suptyp', /note supply type|supply type/], ['invtyp', /invoice type/],
  ['val',     /(invoice|note|document|bill of entry) value/], ['pos', /place of supply/], ['rev', /reverse charge/],
  ['rate',    /^rate|\brate\b.*%/], ['txval', /taxable value/],
  ['igst',    /integrated tax/], ['cgst', /central tax/], ['sgst', /state.*tax|ut tax/], ['cess', /\bcess\b/],
  ['dt',      /(invoice|note|document|bill of entry) date|^date$/], ['inum', /(invoice|note|document|bill of entry) (number|no)\b|^number$/],
  ['portcode', /port code/], ['boenum', /bill of entry (number|no)/],
];
const norm = s => String(s ?? '').toLowerCase().replace(/[₹()]/g, ' ').replace(/[^a-z0-9%/ ]+/g, ' ').replace(/\s+/g, ' ').trim();

function parseExcel(buf, out) {
  let wb;
  try { wb = XLSX.read(buf, { type: 'buffer', cellDates: false }); } catch (e) { throw new Error(`The Excel file could not be read: ${e.message}`); }
  // statement identity: any sheet's first rows — "GSTIN", "Financial Year", "Tax Period", "Date of generation"
  for (const name of wb.SheetNames) metaFromSheet(rowsOf(wb.Sheets[name]).slice(0, 25), out);
  for (const name of wb.SheetNames) {
    const k = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SUMMARY_SHEETS.has(k)) continue;
    const section = sheetKey(name);
    if (!section) {
      const rows = rowsOf(wb.Sheets[name]);
      if (rows.length > 6) out.unsupported.push({ section: name, label: name, count: rows.length, reason: 'Sheet not recognised by this version of the importer — nothing from it was imported' });
      continue;
    }
    excelSection(section, name, rowsOf(wb.Sheets[name]), out);
  }
  out.control.note = 'Excel downloads carry no machine-readable control totals; the preview lists the totals read per section for comparison with the portal summary.';
  if (!out.docs.length && !out.unsupported.length) out.warnings.push('No document sheets (B2B, B2BA, B2B-CDNR …) were found in this workbook.');
}

const rowsOf = ws => XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });

function metaFromSheet(rows, out) {
  for (const r of rows) {
    for (let c = 0; c < r.length; c++) {
      const cell = r[c];
      if (typeof cell !== 'string') continue;
      const t = norm(cell);
      const next = () => { for (let k = c + 1; k < r.length; k++) if (r[k] !== null && r[k] !== '') return r[k]; return null; };
      const inline = cell.includes(':') ? cell.split(':').slice(1).join(':').trim() : '';
      if (/^gstin\b/.test(t) && !out.meta.gstin) { const v = inline || next(); const g = N.normGstin(v || ''); if (N.GSTIN_LIKE.test(g)) out.meta.gstin = g; }
      else if (/^(legal name|trade name)/.test(t) && !out.meta.legal_name) out.meta.legal_name = String(inline || next() || '');
      else if (/^(tax period|return period)/.test(t) && !out.meta.raw_period) out.meta.raw_period = String(inline || next() || '');
      else if (/^(financial year|fy)\b/.test(t) && !out.meta._fy) out.meta._fy = String(inline || next() || '');
      else if (/date of generation|generation date/.test(t) && !out.meta.gendt) out.meta.gendt = N.parseDate(inline || next());
    }
  }
  // "September" + "2025-26" → 2025-09
  if (!out.meta.period && out.meta.raw_period && out.meta._fy) {
    const m = String(out.meta.raw_period).trim().toUpperCase().slice(0, 3);
    const mo = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 }[m];
    const fy = String(out.meta._fy).match(/^(\d{4})/);
    if (mo && fy) out.meta.period = `${mo >= 4 ? +fy[1] : +fy[1] + 1}-${String(mo).padStart(2, '0')}`;
  }
}

/**
 * One normalised label per column from the header rows h..end. Group headings (rows above the last one) are often
 * merged cells: their text is carried to the right until the next heading, so "Invoice details" + "Invoice number"
 * reads "invoice details invoice number". The last (leaf) row is never carried.
 */
function buildLabels(rows, h, end, width) {
  const labels = Array.from({ length: width }, () => '');
  for (let r = h; r <= end; r++) {
    let carry = '';
    for (let c = 0; c < width; c++) {
      const v = rows[r][c];
      const has = v !== null && v !== undefined && v !== '';
      if (r < end) { if (has) carry = String(v); if (carry) labels[c] += ` ${carry}`; }
      else if (has) labels[c] += ` ${v}`;
    }
  }
  return labels.map(norm);
}

function excelSection(section, sheetName, rows, out) {
  // header block = from the first row that names ≥ 2 known columns until the first data row (a GSTIN, or a number in column 0)
  let h = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const hits = new Set(rows[i].map(c => HEADERS.find(([, re]) => re.test(norm(c)))?.[0]).filter(Boolean));
    if (hits.size >= 2) { h = i; break; }
  }
  if (h < 0) { pushIssue(out.errors, section, `sheet "${sheetName}"`, 'header', 'Could not find the column headings on this sheet — nothing was imported from it'); out.unsupported.push({ section: sheetName, label: SECTIONS[section].label, count: rows.length, reason: 'Column headings not recognised' }); return; }
  let end = h;
  while (end + 1 < rows.length && end - h < 4) {
    const next = rows[end + 1];
    const first = next.find(c => c !== null && c !== '');
    if (typeof first === 'string' && N.GSTIN_LIKE.test(N.normGstin(first)) && N.normGstin(first).length === 15) break;
    if (typeof first === 'number') break;
    end++;
  }
  const width = Math.max(...rows.slice(h, end + 1).map(r => r.length));
  const labels = buildLabels(rows, h, end, width);
  const col = {};
  labels.forEach((lab, c) => { const f = HEADERS.find(([, re]) => re.test(lab)); if (f && col[f[0]] === undefined) col[f[0]] = c; });
  const need = section === 'b2b' || section === 'b2ba' ? ['ctin', 'inum', 'dt'] : section === 'cdnr' || section === 'cdnra' ? ['ctin', 'inum', 'dt'] : [];
  const missing = need.filter(k => col[k] === undefined);
  if (missing.length) {
    pushIssue(out.errors, section, `sheet "${sheetName}"`, missing.join(', '), `Could not identify the column(s) for: ${missing.join(', ')} — nothing was imported from this sheet`);
    out.unsupported.push({ section: sheetName, label: SECTIONS[section].label, count: rows.length - end - 1, reason: `Required columns not found: ${missing.join(', ')}` });
    return;
  }
  const unmapped = labels.map((l, c) => (l && !Object.values(col).includes(c) ? l : null)).filter(Boolean);
  if (unmapped.length) out.warnings.push(`Sheet "${sheetName}": columns not used — ${unmapped.slice(0, 8).join('; ')}`);

  const groups = new Map();                                                   // one document may span several rate rows
  for (let r = end + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c => c === null || c === '')) continue;
    const first = String(row.find(c => c !== null && c !== '') ?? '');
    if (/^total/i.test(first)) break;
    const get = k => (col[k] === undefined ? null : row[col[k]]);
    const ref = `sheet "${sheetName}" row ${r + 1}`;
    const gi = N.gstinInfo(get('ctin') || '');
    const no = String(get('inum') ?? '').trim();
    const dateRaw = get('dt');
    const key = `${gi.gstin}|${no}|${N.parseDate(dateRaw)}|${get('ntyp') || get('invtyp') || ''}|${get('oinum') || ''}`;
    let g = groups.get(key);
    if (!g) { g = { refs: [], rows: [], gi, no, dateRaw, row0: row, get0: get }; groups.set(key, g); }
    g.refs.push(ref); g.rows.push(row);
    g.rate_lines = g.rate_lines || [];
    g.rate_lines.push({ rate: get('rate'), taxable: p0(get('txval')), igst: p0(get('igst')), cgst: p0(get('cgst')), sgst: p0(get('sgst')), cess: p0(get('cess')) });
    g.value = g.value ?? toPaise(get('val'));
  }
  for (const g of groups.values()) {
    const get = g.get0, issues = [];
    const amounts = g.rate_lines.reduce((a, l) => addAmounts(a, l), zeroAmounts());
    const ref = g.refs[0];
    const date = N.parseDate(g.dateRaw);
    if (!g.no) { issues.push('doc_no_missing'); pushIssue(out.errors, section, ref, 'document number', 'Document number is missing'); }
    if (!date) { issues.push('doc_date_invalid'); pushIssue(out.errors, section, ref, 'document date', `Document date "${g.dateRaw ?? ''}" could not be read`); }
    if (g.gi.gstin && !g.gi.valid) { issues.push('invalid_gstin'); pushIssue(out.errors, section, ref, 'supplier GSTIN', `Supplier GSTIN ${g.gi.gstin} fails the GSTIN check`); }
    const isImport = section.startsWith('impg') && !g.gi.gstin;                 // a bill of entry has no supplier GSTIN
    if (!g.gi.gstin && !isImport) { issues.push('supplier_gstin_missing'); pushIssue(out.errors, section, ref, 'supplier GSTIN', 'Supplier GSTIN is missing'); }
    const isNote = section === 'cdnr' || section === 'cdnra';
    const nt = String(get('ntyp') || '').trim().toUpperCase();
    const doc_type = isNote ? (/^D/.test(nt) ? 'DBN' : /^C/.test(nt) ? 'CRN' : 'INV') : (section === 'isd' || section === 'isda') && /credit/i.test(String(get('ntyp') || '')) ? 'CRN' : 'INV';
    if (isNote && doc_type === 'INV') issues.push('note_type_unknown');
    const isAmend = ['b2ba', 'cdnra', 'isda', 'ecoma', 'impga', 'impgasez'].includes(section);
    out.docs.push(draft({
      section, src: { ref, rows: g.refs.length > 1 ? g.refs : undefined },
      supplier: { gstin: g.gi.gstin, name: String(get('trdnm') ?? ''), pan: g.gi.pan, gstin_valid: isImport ? true : g.gi.valid, state: g.gi.state, filing_period: String(get('supprd') ?? ''), filing_date: N.parseDate(get('supfildt')) },
      doc_type, doc_no: g.no, doc_date: date,
      orig: isAmend ? { doc_no: String(get('oinum') ?? '').trim(), doc_date: N.parseDate(get('oidt')), doc_type: undefined } : null, is_amendment: isAmend,
      inv_type: String(get('invtyp') ?? get('suptyp') ?? ''),
      amounts, rate_lines: g.rate_lines, invoice_value: g.value ?? undefined,
      pos: get('pos') != null ? String(get('pos')) : '', rcm: yn(get('rev')) === 'Y', itc_available: yn(get('itcavl')), reason: String(get('rsn') ?? ''),
      diffprcnt: get('diffprcnt') ?? null, source_type: String(get('srctyp') ?? ''), irn: String(get('irn') ?? ''), irn_date: N.parseDate(get('irngendate')),
      issues,
    }));
  }
}

// ── Shared draft builder ──────────────────────────────────────────────────────
function draft(d) {
  const doc_no = String(d.doc_no ?? '').trim();
  const amounts = d.amounts;
  const tax = (amounts.igst || 0) + (amounts.cgst || 0) + (amounts.sgst || 0) + (amounts.cess || 0);
  const orig = d.orig && (d.orig.doc_no || d.orig.doc_date) ? { doc_no: String(d.orig.doc_no || '').trim(), doc_date: d.orig.doc_date || null, doc_type: d.orig.doc_type || d.doc_type } : null;
  const matchable = !!(SECTIONS[d.section] || {}).matchable;
  const incomplete = d.issues.some(i => ['doc_no_missing', 'doc_date_invalid', 'amounts_missing', 'supplier_gstin_missing'].includes(i));
  return {
    section: d.section, src: d.src, supplier: d.supplier,
    doc_type: d.doc_type, inv_type: d.inv_type || '', doc_no, doc_no_norm: N.normDocNo(doc_no), doc_no_core: N.docNoCore(doc_no), doc_date: d.doc_date || null,
    orig, is_amendment: !!d.is_amendment,
    // the key a later amendment (and any earlier version) of the same document shares: the ORIGINAL number and date
    lineage: { doc_no_norm: N.normDocNo(orig ? orig.doc_no : doc_no), doc_date: orig ? orig.doc_date : (d.doc_date || null), doc_type: orig ? orig.doc_type : d.doc_type },
    amounts, tax_total: tax, invoice_value: d.invoice_value ?? (amounts.taxable + tax), rate_lines: d.rate_lines || [],
    pos: d.pos || '', rcm: !!d.rcm, itc_available: d.itc_available || '', reason: d.reason || '', diffprcnt: d.diffprcnt ?? null,
    source_type: d.source_type || '', irn: d.irn || '', irn_date: d.irn_date || null,
    sign: d.doc_type === 'CRN' ? -1 : 1,
    matchable, unsupported_reason: matchable ? '' : (SECTIONS[d.section] || {}).reason || 'Section not matched',
    incomplete, issues: d.issues || [],
  };
}

module.exports = { parseStatement, SECTIONS };
