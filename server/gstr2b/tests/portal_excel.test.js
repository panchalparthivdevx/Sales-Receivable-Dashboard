/**
 * GSTR-2B Excel in the GST portal's REAL layout.
 *
 * The heading rows in portal_headings.json were copied from the workbook the portal produced for GSTR-2B of September 2026
 * (downloaded 12 Nov 2026): titles and column headings only. Every document row below is INVENTED (synthetic).
 *
 * Why this file exists: the earlier Excel test used headings I had guessed ("Note details" over the credit/debit-note columns).
 * The portal's heading is "Credit note/Debit note details", which the reader mistook for the note-type column, so credit and
 * debit notes were never read; amendment sheets ignored their "Original Details / Revised Details" headings and lost their first
 * rows; and a sheet with no documents (most sheets, most months) was reported as a problem.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const N = require('../lib/normalize');
const { parseStatement } = require('../lib/import2b');
const { gstin } = require('./helpers');
const HEAD = require('./portal_headings.json');

const REC = gstin('08', 'AAACT1234F');
const S1 = gstin('24', 'AAACS1111A'), S2 = gstin('27', 'AAACR5055K'), S3 = gstin('29', 'AAACE2222B');
const ECO_G = gstin('07', 'AAACF3333C'), ISD_G = gstin('27', 'AAACI4444D');

/** A data row of the given width with values at the given 0-based column positions (the rest empty, like merged cells) */
const put = (width, cells) => { const r = Array(width).fill(null); for (const [i, v] of Object.entries(cells)) r[+i] = v; return r; };
const widthOf = name => Math.max(...HEAD[name].map(r => r.length));

/** A workbook shaped like the portal's: Read me, the summary sheet, then every document sheet with the real headings + the given rows */
function book(rowsBySheet = {}) {
  const wb = XLSX.utils.book_new();
  const add = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  add('Read me', [['Goods and Services Tax - GSTR-2B'], ['Financial Year', '2026-27'], ['Tax Period', 'September'], ['GSTIN', REC], ['Legal Name', 'SYNTHETIC CO LIMITED'], ['Trade Name (if any)', 'SYNTHETIC CO LIMITED'], ['Date of generation', '31/10/2026']]);
  add('ITC Available', [['FORM GSTR-2B'], ['FORM SUMMARY - ITC Available'], ['S.no.', 'Heading', 'GSTR-3B table', 'Integrated Tax (₹)', 'Central Tax (₹)', 'State/UT Tax (₹)', 'Cess (₹)']]);
  for (const name of Object.keys(HEAD)) add(name, [...HEAD[name], ...(rowsBySheet[name] || [])]);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const parse = rowsBySheet => parseStatement(book(rowsBySheet), 'GSTR2B.xlsx');
const b2bRow = (o = {}) => put(widthOf('B2B'), { 0: S1, 1: 'Synthetic Supplier One', 2: 'INV/001', 3: 'Regular', 4: '05/09/2026', 5: 11800, 6: '24-Gujarat', 7: 'No', 8: 10000, 9: 0, 10: 900, 11: 900, 12: 0, 13: "Sep'26", 14: '11/10/2026', 15: 'Yes', 16: '', 17: '', 18: 'e-Invoice', 19: 'irn-1', 20: '06/09/2026', ...o });

test('the portal\'s B2B sheet: every column is read, and a workbook of mostly empty sheets raises no problem and no notice', () => {
  const r = parse({ B2B: [
    b2bRow(),
    b2bRow({ 0: S2, 1: 'Synthetic Supplier Two', 2: 'X-77', 4: '12/09/2026', 5: 2360, 6: '27-Maharashtra', 7: 'Yes', 8: 2000, 9: 360, 10: 0, 11: 0, 15: 'No', 16: 'POS', 17: 100, 18: '', 19: '', 20: '' }),
  ] });
  assert.equal(r.format, 'xlsx');
  assert.equal(r.meta.gstin, REC); assert.equal(r.meta.period, '2026-09'); assert.equal(r.meta.gendt, '2026-10-31'); assert.equal(r.meta.legal_name, 'SYNTHETIC CO LIMITED');
  assert.equal(r.docs.length, 2);
  const a = r.docs[0], b = r.docs[1];
  assert.equal(a.supplier.gstin, S1); assert.equal(a.supplier.name, 'Synthetic Supplier One'); assert.equal(a.doc_no, 'INV/001'); assert.equal(a.doc_date, '2026-09-05'); assert.equal(a.inv_type, 'Regular');
  assert.equal(a.invoice_value, 1180000); assert.deepEqual(a.amounts, { taxable: 1000000, igst: 0, cgst: 90000, sgst: 90000, cess: 0 });
  assert.equal(a.pos, '24-Gujarat'); assert.equal(a.rcm, false); assert.equal(a.itc_available, 'Y'); assert.equal(a.supplier.filing_period, "Sep'26"); assert.equal(a.supplier.filing_date, '2026-10-11');
  assert.equal(a.source_type, 'e-Invoice'); assert.equal(a.irn, 'irn-1'); assert.equal(a.irn_date, '2026-09-06');
  assert.equal(b.rcm, true); assert.equal(b.itc_available, 'N'); assert.equal(b.reason, 'POS'); assert.equal(b.amounts.igst, 36000); assert.equal(b.doc_date, '2026-09-12');
  assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []); assert.deepEqual(r.unsupported, []);
  assert.equal(r.sections.b2b.count, 2);
});

test('credit and debit notes (B2B-CDNR): the "Credit note/Debit note details" columns are read as number, type, date and value', () => {
  const w = widthOf('B2B-CDNR');
  const note = (o = {}) => put(w, { 0: S1, 1: 'Synthetic Supplier One', 2: 'CN-9', 3: 'Credit Note', 4: 'Regular', 5: '08/09/2026', 6: 118, 7: '24-Gujarat', 8: 'No', 9: 100, 10: 0, 11: 9, 12: 9, 13: 0, 20: "Sep'26", 21: '11/10/2026', 22: 'Yes', ...o });
  const r = parse({ 'B2B-CDNR': [note(), note({ 2: 'DN-4', 3: 'Debit Note', 5: '09/09/2026', 6: 59, 9: 50, 11: 4.5, 12: 4.5 })] });
  const notes = r.docs.filter(d => d.section === 'cdnr');
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map(d => [d.doc_no, d.doc_type, d.doc_date, d.invoice_value]), [['CN-9', 'CRN', '2026-09-08', 11800], ['DN-4', 'DBN', '2026-09-09', 5900]]);
  assert.deepEqual(notes[0].amounts, { taxable: 10000, igst: 0, cgst: 900, sgst: 900, cess: 0 });
  assert.equal(notes[1].amounts.cgst, 450);
  assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []);
  assert.equal(r.sections.cdnr.signed.cgst, -900 + 450, 'a credit note counts negatively and a debit note positively in the signed totals');
});

test('amendment sheets: the ORIGINAL columns identify the amended document, the REVISED columns carry its new details — and no data row is mistaken for a heading', () => {
  const w = widthOf('B2BA');
  const amend = (i, o = {}) => put(w, { 0: `100${i}`, 1: '01/08/2026', 2: S1, 3: 'Synthetic Supplier One', 4: `100${i}/R`, 5: 'Regular', 6: '03/08/2026', 7: 11800, 8: '24-Gujarat', 9: 'No', 10: 10000, 11: 0, 12: 900, 13: 900, 14: 0, 21: "Aug'26", 22: '11/09/2026', 23: 'Yes', ...o });
  const r = parse({ 'B2BA': [1, 2, 3, 4, 5].map(i => amend(i)) });
  const docs = r.docs.filter(d => d.section === 'b2ba');
  assert.equal(docs.length, 5, 'all five amended invoices are read — the first rows are not swallowed as headings');
  const d = docs[0];
  assert.equal(d.is_amendment, true);
  assert.deepEqual(d.orig, { doc_no: '1001', doc_date: '2026-08-01', doc_type: 'INV' });
  assert.equal(d.doc_no, '1001/R'); assert.equal(d.doc_date, '2026-08-03'); assert.equal(d.invoice_value, 1180000);
  assert.equal(d.lineage.doc_no_norm, N.normDocNo('1001'), 'the lineage is the ORIGINAL number, so the amendment supersedes it');
  assert.equal(d.amounts.taxable, 1000000);
  assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []);

  const wc = widthOf('B2B-CDNRA');
  const noteA = i => put(wc, { 0: 'Credit Note', 1: `CN-${i}`, 2: '01/08/2026', 3: S2, 4: 'Synthetic Supplier Two', 5: `CN-${i}/R`, 6: 'Credit Note', 7: 'Regular', 8: '04/08/2026', 9: 590, 10: '27-Maharashtra', 11: 'No', 12: 500, 13: 90, 14: 0, 15: 0, 16: 0, 23: "Aug'26", 24: '11/09/2026', 25: 'Yes' });
  const r2 = parse({ 'B2B-CDNRA': [7, 8, 9, 10].map(noteA) });
  const n = r2.docs.filter(x => x.section === 'cdnra');
  assert.equal(n.length, 4, 'all four amended notes are read');
  assert.deepEqual(n.map(x => [x.doc_type, x.doc_no, x.orig.doc_no, x.orig.doc_date, x.doc_date]), [7, 8, 9, 10].map(i => ['CRN', `CN-${i}/R`, `CN-${i}`, '2026-08-01', '2026-08-04']));
  assert.equal(n[0].amounts.igst, 9000);
  assert.deepEqual(r2.errors, []);
});

test('a workbook with no documents at all says nothing about each empty sheet — one plain notice that every sheet only has its headings', () => {
  const r = parse({});
  assert.deepEqual(r.errors, []); assert.deepEqual(r.unsupported, []);
  assert.equal(r.warnings.length, 1); assert.match(r.warnings[0], /no document in any of them/);
  assert.equal(r.docs.length, 0);
  assert.equal(r.meta.gstin, REC); assert.equal(r.meta.period, '2026-09');
});

test('e-commerce, ISD and import sheets: the supplier / ECO GSTIN, the ISD cess and the bill-of-entry number and date are found', () => {
  const eco = put(widthOf('ECO'), { 0: ECO_G, 1: 'Synthetic Marketplace', 2: 'E-55', 3: 'Invoice', 4: '10/09/2026', 5: 1180, 6: '24-Gujarat', 7: 1000, 8: 0, 9: 90, 10: 90, 11: 0, 12: "Sep'26", 13: '11/10/2026', 14: 'Yes' });
  const isd = put(widthOf('ISD'), { 0: ISD_G, 1: 'Synthetic ISD', 2: 'ISD Credit Note', 3: 'ISD/9', 4: '12/09/2026', 5: 'INV-5', 6: '01/09/2026', 7: 100, 8: 50, 9: 50, 10: 7, 11: "Sep'26", 12: '11/10/2026', 13: 'Yes' });
  const sez = put(widthOf('IMPGSEZ'), { 0: S3, 1: 'Synthetic SEZ Unit', 2: '05/09/2026', 3: 'INMAA1', 4: 1234567, 5: '06/09/2026', 6: 10000, 7: 1800, 8: 0 });
  const imp = put(widthOf('IMPG'), { 0: '05/09/2026', 1: 'INMAA1', 2: 7654321, 3: '06/09/2026', 4: 20000, 5: 3600, 6: 0 });
  const r = parse({ ECO: [eco], ISD: [isd], IMPGSEZ: [sez], IMPG: [imp] });
  const by = s => r.docs.filter(d => d.section === s);
  assert.equal(by('ecom').length, 1); assert.equal(by('ecom')[0].supplier.gstin, ECO_G); assert.equal(by('ecom')[0].doc_no, 'E-55'); assert.deepEqual(by('ecom')[0].issues, []);
  assert.equal(by('isd').length, 1); assert.equal(by('isd')[0].amounts.cess, 700, 'the ISD cess column is not mistaken for State/UT tax'); assert.equal(by('isd')[0].doc_type, 'CRN'); assert.equal(by('isd')[0].doc_no, 'ISD/9');
  assert.equal(by('impgsez').length, 1); assert.equal(by('impgsez')[0].doc_no, '1234567'); assert.equal(by('impgsez')[0].doc_date, '2026-09-06'); assert.deepEqual(by('impgsez')[0].issues, []);
  assert.equal(by('impg').length, 1); assert.equal(by('impg')[0].doc_no, '7654321'); assert.equal(by('impg')[0].doc_date, '2026-09-06'); assert.equal(by('impg')[0].amounts.igst, 360000); assert.deepEqual(by('impg')[0].issues, []);
  assert.deepEqual(r.errors, []);
  assert.ok(Object.values(r.sections).filter(s => !s.matchable).length === 4, 'these sections are read but not matched in Phase 1');
});

test('a sheet that has documents but headings the reader cannot place is still reported and skipped, never half-read', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Tax Period', 'September'], ['GSTIN', REC]]), 'Read me');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Title'], ['Supplier', 'Amount', 'When'], [S1, 1000, '05/09/2026']]), 'B2B');
  const r = parseStatement(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'odd.xlsx');
  assert.equal(r.docs.length, 0);
  assert.ok(r.errors.length >= 1 && r.unsupported.length >= 1);
});
