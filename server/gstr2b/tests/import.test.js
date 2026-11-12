/**
 * GSTR-2B import — SYNTHETIC statements built from the documented layout (the official sample files are not
 * available offline; this verifies the parser's logic against that layout, not against a real portal download).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { gstin } = require('./helpers');
const { parseStatement } = require('../lib/import2b');

const REC = gstin('24', 'AAFCD1234E');
const S1 = gstin('27', 'AAACR5055K');
const S2 = gstin('29', 'AAACI4798L');
const ISD = gstin('27', 'AAACT2803M');

const jsonFile = obj => Buffer.from(JSON.stringify(obj));
function statement(docdata, extra = {}) {
  return { chksum: 'x', data: { data: { gstin: REC, rtnprd: '102026', version: '1.0', gendt: '14-11-2026', docdata, ...extra } } };
}
const item = (rt, txval, igst, cgst, sgst, cess = 0) => ({ num: 1, rt, txval, igst, cgst, sgst, cess });

const FULL = () => statement({
  b2b: [{ ctin: S1, trdnm: 'Synthetic Supplier One', supprd: '092026', supfildt: '11-10-2026', inv: [
    { inum: 'INV/001', typ: 'R', dt: '25-09-2026', val: 1180, pos: '24', rev: 'N', itcavl: 'Y', rsn: '', diffprcnt: 1, srctyp: 'e-Invoice', irn: 'abc', irngendate: '26-09-2026', items: [item(18, 1000, 0, 90, 90)] },
    { inum: 'INV/002', typ: 'R', dt: '26-09-2026', val: 2360, pos: '24', rev: 'N', itcavl: 'N', rsn: 'P', items: [item(18, 1000, 0, 90, 90), item(18, 1000, 0, 90, 90)] },
  ] }],
  b2ba: [{ ctin: S2, trdnm: 'Synthetic Supplier Two', supprd: '092026', supfildt: '12-10-2026', inv: [
    { oinum: 'OLD-5', oidt: '10-08-2026', inum: 'NEW-5', dt: '10-08-2026', val: 590, pos: '24', rev: 'N', itcavl: 'Y', items: [item(18, 500, 90, 0, 0)] } ] }],
  cdnr: [{ ctin: S1, trdnm: 'Synthetic Supplier One', supprd: '092026', supfildt: '11-10-2026', nt: [
    { ntnum: 'CN-1', typ: 'C', suptyp: 'R', dt: '30-09-2026', val: 118, pos: '24', rev: 'N', itcavl: 'Y', items: [item(18, 100, 0, 9, 9)] },
    { ntnum: 'DN-1', typ: 'D', suptyp: 'R', dt: '30-09-2026', val: 59, pos: '24', rev: 'N', itcavl: 'Y', items: [item(18, 50, 0, 4.5, 4.5)] } ] }],
  cdnra: [{ ctin: S1, trdnm: 'Synthetic Supplier One', supprd: '092026', supfildt: '11-10-2026', nt: [
    { onttyp: 'C', ontnum: 'CN-0', ontdt: '01-09-2026', ntnum: 'CN-0A', typ: 'C', suptyp: 'R', dt: '01-09-2026', val: 59, pos: '24', rev: 'N', itcavl: 'Y', items: [item(18, 50, 0, 4.5, 4.5)] } ] }],
  isd: [{ ctin: ISD, trdnm: 'Synthetic HO', supprd: '092026', supfildt: '11-10-2026', doclist: [{ doctyp: 'ISDI', docnum: 'ISD/1', docdt: '30-09-2026', igst: 0, cgst: 50, sgst: 50, cess: 0, itcelg: 'Y' }] }],
  impg: [{ refdt: '05-10-2026', recdt: '06-10-2026', portcode: 'INMUN1', boenum: '1234567', boedt: '04-10-2026', isamd: 'N', txval: 10000, igst: 1800, cess: 0 }],
  impgsez: [{ ctin: S2, trdnm: 'Synthetic SEZ Unit', boe: [{ refdt: '05-10-2026', recdt: '06-10-2026', portcode: 'INMUN1', boenum: '7654321', boedt: '04-10-2026', isamd: 'N', txval: 2000, igst: 360, cess: 0 }] }],
  ecom: [{ ctin: S2, trdnm: 'Synthetic ECO', supprd: '092026', supfildt: '11-10-2026', inv: [{ inum: 'ECO/1', typ: 'R', dt: '28-09-2026', val: 118, pos: '24', rev: 'N', itcavl: 'Y', items: [item(18, 100, 18, 0, 0)] }] }],
  itcrev: [{ b2b: [{ ctin: S1, trdnm: 'Synthetic Supplier One', supprd: '092026', supfildt: '11-10-2026', inv: [{ inum: 'REV/1', typ: 'R', dt: '01-04-2026', val: 118, pos: '24', rev: 'N', itcavl: 'N', items: [item(18, 100, 0, 9, 9)] }] }] }],
  somethingnew: [{ x: 1 }],
});

test('JSON: every known section is read, summed correctly and typed (invoice / credit / debit / amendment)', () => {
  const r = parseStatement(jsonFile(FULL()), 'gstr2b.json');
  assert.equal(r.format, 'json');
  assert.equal(r.meta.gstin, REC); assert.equal(r.meta.period, '2026-10'); assert.equal(r.meta.gendt, '2026-11-14');
  const by = s => r.docs.filter(d => d.section === s);
  assert.equal(by('b2b').length, 2); assert.equal(by('b2ba').length, 1); assert.equal(by('cdnr').length, 2); assert.equal(by('cdnra').length, 1);
  assert.equal(by('isd').length, 1); assert.equal(by('impg').length, 1); assert.equal(by('impgsez').length, 1); assert.equal(by('ecom').length, 1); assert.equal(by('itcrev').length, 1);
  // items are summed exactly (two items of ₹90 + ₹90)
  const i2 = by('b2b')[1];
  assert.deepEqual(i2.amounts, { taxable: 200000, igst: 0, cgst: 18000, sgst: 18000, cess: 0 });
  assert.equal(i2.itc_available, 'N'); assert.equal(i2.reason, 'P');
  // notes
  assert.deepEqual(by('cdnr').map(d => d.doc_type), ['CRN', 'DBN']);
  assert.equal(by('cdnr')[0].sign, -1);
  assert.equal(by('cdnr')[1].amounts.cgst, 450);                              // 4.50 → 450 paise, no float drift
  // amendments keep the original identity and share a lineage with it
  const a = by('b2ba')[0];
  assert.equal(a.is_amendment, true); assert.deepEqual(a.orig, { doc_no: 'OLD-5', doc_date: '2026-08-10', doc_type: 'INV' });
  assert.equal(a.lineage.doc_no_norm, 'OLD5'); assert.equal(a.doc_no, 'NEW-5');
  assert.equal(by('cdnra')[0].orig.doc_type, 'CRN');
  // matchable sections vs reasons for the rest
  assert.ok(by('b2b')[0].matchable && by('cdnr')[0].matchable);
  for (const s of ['isd', 'impg', 'impgsez', 'ecom', 'itcrev']) assert.ok(!by(s)[0].matchable && by(s)[0].unsupported_reason, s);
  // an unrecognised section is LISTED, never silently dropped
  assert.equal(r.unsupported.length, 1); assert.equal(r.unsupported[0].section, 'somethingnew');
  // section totals are reported for comparison with the portal
  assert.equal(r.sections.b2b.count, 2); assert.equal(r.sections.b2b.amounts.taxable, 300000);
  assert.equal(r.sections.cdnr.signed.taxable, -10000 + 5000);
});

test('JSON: invoice-level amounts are accepted; disagreement with items is reported', () => {
  const ok = parseStatement(jsonFile(statement({ b2b: [{ ctin: S1, inv: [{ inum: 'A1', dt: '01-10-2026', val: 118, txval: 100, igst: 0, cgst: 9, sgst: 9, cess: 0 }] }] })), 'a.json');
  assert.deepEqual(ok.docs[0].amounts, { taxable: 10000, igst: 0, cgst: 900, sgst: 900, cess: 0 });
  assert.equal(ok.errors.length, 0);
  const bad = parseStatement(jsonFile(statement({ b2b: [{ ctin: S1, inv: [{ inum: 'A2', dt: '01-10-2026', txval: 100, cgst: 9, sgst: 9, items: [item(18, 100, 0, 9, 8)] }] }] })), 'b.json');
  assert.ok(bad.errors.some(e => /do not equal the sum/.test(e.message)));
  assert.equal(bad.docs.length, 1);                                           // still imported, with the issue recorded
});

test('JSON: problem rows are KEPT with an issue code and a row-level error (nothing dropped)', () => {
  const r = parseStatement(jsonFile(statement({ b2b: [{ ctin: 'BADGSTIN', inv: [
    { inum: '', dt: '31-02-2026', items: [item(18, 100, 0, 9, 9)] },
    { inum: 'OK-1', dt: '01-10-2026', items: [item(18, 100, 0, 9, 9)] },
  ] }] })), 'p.json');
  assert.equal(r.docs.length, 2);
  const [bad, ok] = r.docs;
  assert.ok(bad.incomplete && bad.issues.includes('doc_no_missing') && bad.issues.includes('doc_date_invalid') && bad.issues.includes('invalid_gstin'));
  assert.ok(r.errors.every(e => e.ref && e.message));
  assert.ok(r.errors.some(e => e.ref === 'b2b[0].inv[0]' && /date/.test(e.field)));
  assert.ok(ok.issues.includes('invalid_gstin'));                             // the GSTIN belongs to the whole supplier block
});

test('JSON: control totals against the portal counterparty summary (cpsumm)', () => {
  const doc = statement({ b2b: [{ ctin: S1, inv: [
    { inum: 'A', dt: '01-10-2026', items: [item(18, 100, 0, 9, 9)] }, { inum: 'B', dt: '02-10-2026', items: [item(18, 200, 0, 18, 18)] } ] }] },
  { cpsumm: { b2b: [{ ctin: S1, ttldocs: 2, txval: 300, igst: 0, cgst: 27, sgst: 27, cess: 0 }] } });
  assert.equal(parseStatement(jsonFile(doc), 'c.json').control.ok, true);
  doc.data.data.cpsumm.b2b[0].cgst = 28;
  const r = parseStatement(jsonFile(doc), 'c.json');
  assert.equal(r.control.ok, false); assert.deepEqual(r.control.diffs[0].components, ['cgst']);
  doc.data.data.cpsumm.b2b[0].cgst = 27; doc.data.data.cpsumm.b2b[0].ttldocs = 3;
  assert.equal(parseStatement(jsonFile(doc), 'c.json').control.ok, false);   // a missing document is caught by the count
});

test('JSON: data root is found under different wrappers; unusable files are rejected with a clear message', () => {
  const inner = { gstin: REC, rtnprd: '092026', docdata: { b2b: [{ ctin: S1, inv: [{ inum: 'W1', dt: '01-09-2026', items: [item(18, 100, 0, 9, 9)] }] }] } };
  for (const wrapped of [inner, { data: inner }, { status: 1, data: { chksum: 'c', data: inner } }]) assert.equal(parseStatement(jsonFile(wrapped), 'x.json').docs.length, 1);
  assert.throws(() => parseStatement(jsonFile({ data: { gstin: REC, b2b: [] } }), 'x.json'), /No GSTR-2B document data/);
  assert.throws(() => parseStatement(Buffer.from('hello world'), 'x.txt'), /not a GSTR-2B JSON or Excel/);
  assert.throws(() => parseStatement(Buffer.from('{ broken'), 'x.json'), /could not be read/);
});

// ── Excel ──
function workbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const B2B_HEAD = [
  ['GSTIN of supplier', 'Trade/Legal name', 'Invoice details', null, null, null, 'Place of supply', 'Supply Attract Reverse Charge', 'Rate(%)', 'Taxable Value (₹)', 'Tax Amount', null, null, null, 'GSTR-1/IFF/GSTR-5 Period', 'GSTR-1/IFF/GSTR-5 Filing Date', 'ITC Availability', 'Reason', 'Applicable % of Tax Rate', 'Source', 'IRN', 'IRN Date'],
  [null, null, 'Invoice number', 'Invoice type', 'Invoice Date', 'Invoice Value(₹)', null, null, null, null, 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)', null, null, null, null, null, null, null, null],
];
const CDN_HEAD = [
  ['GSTIN of supplier', 'Trade/Legal name', 'Note details', null, null, null, null, 'Place of supply', 'Supply Attract Reverse Charge', 'Rate(%)', 'Taxable Value (₹)', 'Tax Amount', null, null, null, 'GSTR-1/IFF/GSTR-5 Period', 'GSTR-1/IFF/GSTR-5 Filing Date', 'ITC Availability', 'Reason', 'Applicable % of Tax Rate', 'Source', 'IRN', 'IRN Date'],
  [null, null, 'Note number', 'Note type', 'Note Supply type', 'Note date', 'Note Value (₹)', null, null, null, null, 'Integrated Tax(₹)', 'Central Tax(₹)', 'State/UT Tax(₹)', 'Cess(₹)', null, null, null, null, null, null, null, null],
];

test('Excel: header-driven read, rate-wise rows of one invoice aggregated, identity read from the top rows', () => {
  const buf = workbook({
    'Read me': [['Instructions'], ['Some text']],
    'B2B': [['Goods and Services Tax - GSTR-2B'], ['Financial Year', '2026-27'], ['Tax Period', 'October'], ['GSTIN', REC], ['Legal name of the registered person', 'Synthetic Co'], ['Date of generation', '14-11-2026'], [],
      ...B2B_HEAD,
      [S1, 'Synthetic Supplier One', 'INV/10', 'Regular', '05-10-2026', 2360, '24-Gujarat', 'No', 18, 1000, 0, 90, 90, 0, 'Oct-26', '11-11-2026', 'Yes', '', 100, 'e-Invoice', 'irn1', '06-10-2026'],
      [S1, 'Synthetic Supplier One', 'INV/10', 'Regular', '05-10-2026', 2360, '24-Gujarat', 'No', 18, 1000, 0, 90, 90, 0, 'Oct-26', '11-11-2026', 'Yes', '', 100, 'e-Invoice', 'irn1', '06-10-2026'],
      [S2, 'Synthetic Supplier Two', 'X-1', 'Regular', 45600, 118, '24-Gujarat', 'Yes', 18, 100, 18, 0, 0, 0, 'Oct-26', '11-11-2026', 'No', 'P', 100, '', '', ''],
      ['Total', null, null, null, null, 9999]],
    'B2B-CDNR': [['Tax Period', 'October'], ...CDN_HEAD, [S1, 'Synthetic Supplier One', 'CN-9', 'Credit note', 'Regular', '08-10-2026', 118, '24-Gujarat', 'No', 18, 100, 0, 9, 9, 0, 'Oct-26', '11-11-2026', 'Yes', '', 100, '', '', ''],
      [S1, 'Synthetic Supplier One', 'DN-9', 'Debit note', 'Regular', '09-10-2026', 59, '24-Gujarat', 'No', 18, 50, 0, 4.5, 4.5, 0, 'Oct-26', '11-11-2026', 'Yes', '', 100, '', '', '']],
    'ITC Available': [['Summary sheet']],
    'Mystery': Array.from({ length: 10 }, (_, i) => [`row ${i}`, i]),
  });
  const r = parseStatement(buf, 'GSTR2B.xlsx');
  assert.equal(r.format, 'xlsx');
  assert.equal(r.meta.gstin, REC); assert.equal(r.meta.period, '2026-10'); assert.equal(r.meta.gendt, '2026-11-14');
  const inv = r.docs.filter(d => d.section === 'b2b');
  assert.equal(inv.length, 2, 'two invoices; INV/10 spans two rate rows');
  const i10 = inv.find(d => d.doc_no === 'INV/10');
  assert.deepEqual(i10.amounts, { taxable: 200000, igst: 0, cgst: 18000, sgst: 18000, cess: 0 });     // two rows summed
  assert.equal(i10.invoice_value, 236000);                                                              // invoice value taken once, not doubled
  assert.equal(i10.rate_lines.length, 2); assert.equal(i10.src.rows.length, 2);
  const x1 = inv.find(d => d.doc_no === 'X-1');
  assert.equal(x1.doc_date, '2024-11-04');                                                              // Excel serial 45600 read as a date
  assert.equal(x1.rcm, true); assert.equal(x1.itc_available, 'N'); assert.equal(x1.reason, 'P');
  const notes = r.docs.filter(d => d.section === 'cdnr');
  assert.deepEqual(notes.map(d => d.doc_type), ['CRN', 'DBN']);
  assert.equal(notes[1].amounts.cgst, 450);
  assert.ok(r.unsupported.some(u => u.section === 'Mystery'), 'an unknown sheet is listed');
  assert.equal(r.docs.some(d => d.doc_no === '9999'), false, 'the Total row is not a document');
});

test('Excel: a sheet whose required columns cannot be found is reported and skipped — never half-read', () => {
  const buf = workbook({ 'B2B': [['Tax Period', 'October'], ['GSTIN', REC], ['Supplier', 'Amount', 'When'], ['x', 1, 2]] });
  const r = parseStatement(buf, 'bad.xlsx');
  assert.equal(r.docs.length, 0);
  assert.ok(r.errors.length >= 1); assert.ok(r.unsupported.length >= 1);
});

test('the same bytes always give the same fingerprint (duplicate-upload protection input)', () => {
  const a = parseStatement(jsonFile(FULL()), 'a.json'), b = parseStatement(jsonFile(FULL()), 'renamed.json');
  assert.equal(a.sha256, b.sha256);
  const c = FULL(); c.data.data.gendt = '15-11-2026';
  assert.notEqual(parseStatement(jsonFile(c), 'c.json').sha256, a.sha256);
});
