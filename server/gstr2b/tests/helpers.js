/**
 * Test helpers: document builders and a temporary store. ALL values here are SYNTHETIC test data —
 * no real supplier, invoice or amount.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-gstr2b';

const fs = require('fs');
const os = require('os');
const path = require('path');
const N = require('../lib/normalize');

const REC = '24AAFCD1234E1Z5';          // synthetic recipient GSTIN (not checked for checksum in matcher tests)
const SUP = '27AAACR5055K1Z7';          // synthetic supplier GSTIN (valid checksum)
const SUP2 = '27AAACR5055K2Z6';         // same PAN, different registration (checksum not asserted)

let seq = 0;
const rupees = v => Math.round(v * 100);

/** Books document (amounts in rupees for readability → stored as paise) */
function books(o = {}) {
  const id = o.id || `b${++seq}`;
  const no = o.no ?? `INV/${seq}`;
  return {
    id, doc_type: o.type || 'INV', recipient_gstin: o.rec || REC,
    supplier: { gstin: o.sup || SUP, name: o.name || 'Synthetic Supplier', gstin_valid: o.gstinValid !== false },
    doc_no: no, doc_no_norm: N.normDocNo(no), doc_no_core: N.docNoCore(no),
    doc_date: o.date === undefined ? '2026-10-10' : o.date, date_assumed: !!o.dateAssumed,
    amounts: { taxable: rupees(o.taxable ?? 1000), igst: rupees(o.igst ?? 0), cgst: rupees(o.cgst ?? 90), sgst: rupees(o.sgst ?? 90), cess: rupees(o.cess ?? 0) },
    invoice_value: rupees(o.value ?? ((o.taxable ?? 1000) + (o.igst ?? 0) + (o.cgst ?? 90) + (o.sgst ?? 90) + (o.cess ?? 0))), rcm: !!o.rcm, accounting_period: o.acct || '2026-10',
  };
}
/** GSTR-2B document */
function portal(o = {}) {
  const id = o.id || `p${++seq}`;
  const no = o.no ?? `INV/${seq}`;
  return {
    id, doc_type: o.type || 'INV', recipient_gstin: o.rec || REC, section: o.section || 'b2b',
    supplier: { gstin: o.sup || SUP, name: o.name || 'Synthetic Supplier', gstin_valid: o.gstinValid !== false },
    doc_no: no, doc_no_norm: N.normDocNo(no), doc_no_core: N.docNoCore(no),
    doc_date: o.date === undefined ? '2026-10-10' : o.date, period: o.period || '2026-11',
    amounts: { taxable: rupees(o.taxable ?? 1000), igst: rupees(o.igst ?? 0), cgst: rupees(o.cgst ?? 90), sgst: rupees(o.sgst ?? 90), cess: rupees(o.cess ?? 0) },
    invoice_value: rupees(o.value ?? ((o.taxable ?? 1000) + (o.igst ?? 0) + (o.cgst ?? 90) + (o.sgst ?? 90) + (o.cess ?? 0))), rcm: !!o.rcm, itc_available: o.itc || 'Y', is_amendment: !!o.amend,
  };
}
/** A Books/2B pair that should match exactly */
function pair(no, extra = {}) { return [books({ no, ...extra, ...(extra.b || {}) }), portal({ no, ...extra, ...(extra.p || {}) })]; }

/** A GSTIN with a correct check character, for tests: gstin('27', 'AAACR5055K') */
function gstin(state, pan, entity = '1') {
  const first14 = `${state}${pan}${entity}Z`;
  return first14 + N.gstinCheckChar(first14);
}

function tempDir(prefix = 'g2btest-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
const rm = dir => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} };

module.exports = { REC, SUP, SUP2, books, portal, pair, rupees, gstin, tempDir, rm };
