/**
 * Zoho → canonical Books document. Inputs have the shape verified against the live organisations; values are synthetic.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/canonBooks');
const { ORG, REC_A, REC_B, SUP_GJ, BRANCHES, bill, credit, expense } = require('./fakeZoho');
const { gstin } = require('./helpers');

const ctx = (over = {}) => ({
  company: { id: 'devx', org_id: ORG, invoice_date_field: 'cf_vendor_bill_date', credit_date_field: 'cf_bill_date', credit_number_field: 'vendor_credit_number', ...over },
  branches: new Map(BRANCHES.map(b => [b.id, { name: b.name, gstin: b.gstin, state: b.state_code }])), vendors: new Map(),
});
const full = (b, c = ctx(), kind = 'bill') => C.fromDetail(b.detail, b.row, c, kind);

test('intra-state bill: CGST + SGST split, recipient GSTIN from the branch, supplier invoice date from the custom field', () => {
  const d = full(bill({ id: 'b1', no: 'INV/001', taxable: 9800, date: '2026-11-06', inv: '2026-11-04' }));
  assert.deepEqual(d.amounts, { taxable: 980000, igst: 0, cgst: 88200, sgst: 88200, cess: 0 });
  assert.equal(d.tax_total, 176400);
  assert.equal(d.invoice_value, 980000 + 176400);
  assert.equal(d.recipient_gstin, REC_A); assert.equal(d.supplier.gstin, SUP_GJ);
  assert.equal(d.doc_date, '2026-11-04'); assert.equal(d.date_assumed, false); assert.equal(d.posting_date, '2026-11-06'); assert.equal(d.accounting_period, '2026-11');
  assert.equal(d.doc_type, 'INV'); assert.equal(d.excluded, null); assert.equal(d.detail_pending, false);
  assert.equal(d.zoho_url, `https://books.zoho.in/app/${ORG}#/bills/b1`);
  assert.equal(d.id, `zb:${ORG}:bill:b1`);
  assert.deepEqual(d.data_quality, []);                                      // all control checks pass
});

test('inter-state bill: IGST; the recipient is the registration of the branch it was booked to', () => {
  const d = full(bill({ id: 'b2', no: 'X-9', tax: 'inter', taxable: 3500000, branch: 'br_b', dest: 'MH' }));
  assert.equal(d.amounts.igst, 63000000); assert.equal(d.amounts.cgst, 0);
  assert.equal(d.recipient_gstin, REC_B);
});

test('TDS: Zoho "total" is net of TDS and is never the invoice value', () => {
  const d = full(bill({ id: 'b3', no: 'T-1', taxable: 3500000, tds: 70000 }));
  assert.equal(d.zoho_total_net, (3500000 + 630000 - 70000) * 100);
  assert.equal(d.invoice_value, (3500000 + 630000) * 100);
  assert.notEqual(d.invoice_value, d.zoho_total_net);
  assert.equal(d.tds_amount, 7000000);
  assert.deepEqual(d.data_quality, []);                                      // sub_total + tax − TDS = total holds
});

test('reverse charge: Zoho keeps the tax on the lines; components are derived (flagged) so they compare with GSTR-2B, invoice value excludes it', () => {
  const d = full(bill({ id: 'b4', no: 'R-1', taxable: 102500, rcm: true }));
  assert.equal(d.rcm, true);
  assert.equal(d.rcm_tax, 1845000);
  assert.deepEqual(d.amounts, { taxable: 10250000, igst: 0, cgst: 922500, sgst: 922500, cess: 0 });     // RCM tax split CGST / SGST for an intra-state supply
  assert.ok(d.data_quality.includes('rcm_components_derived'));
  assert.equal(d.invoice_value, 10250000);                                                              // the supplier charged no tax
  assert.ok(!d.data_quality.includes('arith_check_failed'));
  const inter = bill({ id: 'b4b', no: 'R-2', taxable: 1000, rcm: true, tax: 'inter' }); inter.detail.line_items[0].reverse_charge_tax_name = 'IGST18';
  assert.equal(full(inter).amounts.igst, 18000);
});

test('SEZ / zero-rated bill carries zero tax', () => {
  const d = full(bill({ id: 'b5', no: 'S-1', taxable: 21960, tax: 'inter', rate: 0, treatment: 'business_sez' }));
  assert.equal(d.tax_total, 0); assert.equal(d.excluded, null);
});

test('bill-level discount reduces the taxable value; the control check still holds', () => {
  const b = bill({ id: 'b6', no: 'D-1', taxable: 1000 });
  b.detail.discount_total = 100; b.detail.sub_total = 1100; b.detail.total = 1000 + 180;
  const d = full(b);
  assert.equal(d.amounts.taxable, 100000); assert.ok(d.data_quality.includes('bill_level_discount')); assert.ok(!d.data_quality.includes('arith_check_failed'));
});

test('supplier invoice date is found in the list row, the detail hash or the custom-field list; else the posting date, marked ASSUMED', () => {
  const base = () => bill({ id: 'd1', no: 'A', date: '2026-10-12', inv: '2026-10-05' });
  const a = base(); const fromRow = C.fromDetail({ ...a.detail, custom_fields: [], custom_field_hash: {} }, a.row, ctx(), 'bill');
  assert.equal(fromRow.doc_date, '2026-10-05');                                               // from the list row's *_unformatted
  const b = base(); b.row = { ...b.row }; delete b.row.cf_vendor_bill_date_unformatted;
  assert.equal(C.fromDetail({ ...b.detail, custom_fields: [] }, b.row, ctx(), 'bill').doc_date, '2026-10-05');   // detail hash
  assert.equal(C.fromDetail({ ...b.detail, custom_field_hash: {} }, b.row, ctx(), 'bill').doc_date, '2026-10-05'); // custom_fields[]
  const none = bill({ id: 'd2', no: 'B', date: '2026-10-12', inv: null });
  const n = full(none);
  assert.equal(n.doc_date, '2026-10-12'); assert.equal(n.date_assumed, true);
  assert.equal(full(base(), ctx({ invoice_date_field: '' })).date_assumed, true);            // no field configured at all
});

test('list stage: exclusions are decided from the list row alone (no detail call wasted)', () => {
  const c = ctx();
  const reason = o => C.fromList(bill(o).row, c, 'bill').excluded;
  assert.equal(reason({ id: 'x1', no: '1' }), null);
  assert.equal(reason({ id: 'x2', no: '2', status: 'void' }), 'void');
  assert.equal(reason({ id: 'x3', no: '3', gst: '' }), 'no_supplier_gstin');
  assert.equal(reason({ id: 'x4', no: '4', treatment: 'business_registered_composition' }), 'composition_supplier');
  assert.equal(reason({ id: 'x5', no: '5', cur: 'USD' }), 'foreign_currency');
  assert.equal(reason({ id: 'x6', no: '6', opening: true }), 'opening_balance');
  assert.equal(reason({ id: 'x7', no: '7', branch: 'br_x' }), 'recipient_unmapped');
  assert.equal(reason({ id: 'x8', no: '8', treatment: 'overseas', gst: SUP_GJ }), 'no_supplier_gstin');
  const ok = C.fromList(bill({ id: 'x9', no: '9' }).row, c, 'bill');
  assert.equal(ok.detail_pending, true); assert.equal(ok.amounts, null);
  // a registration that Zoho does not know → documents are listed under that branch's GSTIN, flagged unmapped only when it is blank
  assert.equal(ok.recipient_gstin, REC_A);
});

test('list stage: scope — documents of a switched-off GSTIN, and documents before the first month synced, wait without a detail call', () => {
  const on = new Set([REC_A]);                                                            // REC_B (Maharashtra) is switched off
  const c = { ...ctx(), activeGstins: on, periodFrom: '2026-08-01' };
  const of = o => C.fromList(bill(o).row, c, 'bill');
  const inScope = of({ id: 's1', no: '1', date: '2026-10-12' });
  assert.equal(inScope.excluded, null); assert.equal(inScope.detail_pending, true);
  const off = of({ id: 's2', no: '2', date: '2026-10-12', branch: 'br_b', dest: 'MH', tax: 'inter' });
  assert.equal(off.excluded, 'gstin_off'); assert.equal(off.detail_pending, false); assert.equal(off.excluded_text, C.EXCLUSIONS.gstin_off); assert.equal(off.recipient_gstin, REC_B);
  const old = of({ id: 's3', no: '3', date: '2026-07-31' });
  assert.equal(old.excluded, 'outside_period'); assert.equal(old.detail_pending, false);
  assert.equal(of({ id: 's4', no: '4', date: '2026-08-01' }).detail_pending, true, 'the first synced day is in scope');
  // a credit is dated by its posting date as well; the reasons that need no detail call still come first
  assert.equal(C.fromList(credit({ id: 'sc', no: 'C-1', date: '2025-03-01' }).row, c, 'vendor_credit').excluded, 'outside_period');
  assert.equal(of({ id: 's5', no: '5', status: 'void', date: '2026-07-01' }).excluded, 'void');
  // no GSTIN set up yet (null) and no months synced yet (null) restrict nothing
  const open = { ...ctx(), activeGstins: null, periodFrom: null };
  assert.equal(C.fromList(bill({ id: 's6', no: '6', date: '2020-01-01', branch: 'br_b', dest: 'MH', tax: 'inter' }).row, open, 'bill').detail_pending, true);
  assert.equal(C.scopeExclusion(REC_B, '2026-10-01', { activeGstins: on, periodFrom: null }), 'gstin_off');
  assert.equal(C.scopeExclusion('', '2020-01-01', { activeGstins: on, periodFrom: '2026-08-01' }), 'outside_period', 'no recipient GSTIN: only the period rule can apply');
});

test('invalid supplier GSTIN (check digit) is kept and flagged — never "corrected"', () => {
  const typo = SUP_GJ.slice(0, 14) + (SUP_GJ[14] === 'A' ? 'B' : 'A');
  const d = full(bill({ id: 'g1', no: 'G-1', gst: typo }));
  assert.equal(d.supplier.gstin, typo); assert.equal(d.supplier.gstin_valid, false);
});

test('tax-type vs place-of-supply control: IGST on an intra-state supply is flagged', () => {
  const b = bill({ id: 'p1', no: 'P-1', tax: 'inter' }); b.detail.source_of_supply = 'GJ'; b.detail.destination_of_supply = 'GJ';
  assert.ok(full(b).data_quality.includes('igst_on_intra_state'));
  const c = bill({ id: 'p2', no: 'P-2', tax: 'intra' }); c.detail.source_of_supply = 'MH'; c.detail.destination_of_supply = 'GJ';
  assert.ok(full(c).data_quality.includes('cgst_sgst_on_inter_state'));
});

test('a total that does not follow from the parts is flagged, not silently trusted', () => {
  const d = full(bill({ id: 'a1', no: 'AR-1', taxable: 1000, totalOverride: 1500 }));
  assert.ok(d.data_quality.includes('arith_check_failed'));
});

test('vendor credit → credit note: number / date fields are configurable; the original bill link is kept', () => {
  const c = credit({ id: 'c1', no: 'CN/55', ref: 'REFX', date: '2026-10-18', cfDate: '2026-10-16', bill: 'b9', billNo: 'INV/9' });
  const a = C.fromDetail(c.detail, c.row, ctx(), 'vendor_credit');
  assert.equal(a.doc_type, 'CRN'); assert.equal(a.doc_no, 'CN/55'); assert.equal(a.doc_date, '2026-10-16'); assert.equal(a.date_assumed, false);
  assert.deepEqual(a.linked_bill, { bill_id: 'b9', bill_number: 'INV/9' });
  assert.equal(a.amounts.cgst, 4500); assert.equal(a.supplier.gstin, SUP_GJ);
  const b = C.fromDetail(c.detail, c.row, ctx({ credit_number_field: 'reference_number', credit_date_field: '' }), 'vendor_credit');
  assert.equal(b.doc_no, 'REFX'); assert.equal(b.doc_date, '2026-10-18'); assert.equal(b.date_assumed, true);
  // list stage: credit rows carry no GSTIN, so they are never excluded for it there
  assert.equal(C.fromList(c.row, ctx(), 'vendor_credit').excluded, null);
  assert.equal(C.fromDetail(credit({ id: 'c2', no: 'C2', gst: '' }).detail, c.row, ctx(), 'vendor_credit').excluded, 'no_supplier_gstin');
});

test('GST-bearing expense: only those with GST are in scope; its date is never trusted as an invoice date', () => {
  const e = expense({ id: 'e1', ref: 'SUP-INV-7' });
  assert.equal(C.fromList(e.row, ctx(), 'expense').excluded, null);
  assert.equal(C.fromList(expense({ id: 'e2', noTax: true }).row, ctx(), 'expense').excluded, 'no_gst');
  const d = C.fromDetail(e.detail, e.row, ctx(), 'expense');
  assert.equal(d.date_assumed, true); assert.equal(d.doc_no, 'SUP-INV-7'); assert.equal(d.amounts.cgst, 1800);
  const blank = C.fromDetail(expense({ id: 'e3' }).detail, expense({ id: 'e3' }).row, ctx(), 'expense');
  assert.equal(blank.excluded, 'incomplete'); assert.ok(blank.data_quality.includes('no_document_number'));
  assert.equal(C.fromDetail(expense({ id: 'e4', gst: '' }).detail, e.row, ctx(), 'expense').excluded, 'no_supplier_gstin');
});

test('the document hash changes with anything that matters to a match, and only then', () => {
  const a = full(bill({ id: 'h1', no: 'H-1', taxable: 1000 })), a2 = full(bill({ id: 'h1', no: 'H-1', taxable: 1000 }));
  assert.equal(a.hash, a2.hash);
  assert.notEqual(a.hash, full(bill({ id: 'h1', no: 'H-1', taxable: 1001 })).hash);
  assert.notEqual(a.hash, full(bill({ id: 'h1', no: 'H-2', taxable: 1000 })).hash);
  assert.notEqual(a.hash, full(bill({ id: 'h1', no: 'H-1', taxable: 1000, status: 'void' })).hash);
});
