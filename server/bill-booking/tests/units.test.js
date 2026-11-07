'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
require('./helpers');

const T = require('../lib/text');
const EX = require('../lib/extract');
const M = require('../lib/match');
const A = require('../lib/accounts');
const D = require('../lib/duplicates');
const C = require('../lib/config');
const V = require('../lib/validate');
const DR = require('../lib/draft');
const SEC = require('../lib/secrets');

test('dates are read day-first, impossible dates rejected', () => {
  assert.equal(T.parseDate('05/11/2026'), '2026-11-05');
  assert.equal(T.parseDate('5-Nov-2026'), '2026-11-05');
  assert.equal(T.parseDate('05.11.26'), '2026-11-05');
  assert.equal(T.parseDate('5th November 2026'), '2026-11-05');
  assert.equal(T.parseDate('31/02/2026'), '');
});

test('invoice numbers compare without punctuation; descriptions by meaning words', () => {
  assert.equal(T.normInvoice('INV/24-25/001'), T.normInvoice('inv 24 25 001'));
  assert.ok(T.similarity('Housekeeping services for Oct', 'House keeping manpower October') >= 0.5);
  assert.equal(T.similarity('Office rent', 'Repair of AC'), 0);
});

const SAMPLE = `Clean Co Facility Services
TAX INVOICE
GSTIN: 24ABCDE1234F1Z5
Bill To: Dev Accelerator Ltd  GSTIN 24AAFCD1234E1Z5
Invoice No: CC/120   Invoice Date: 05/11/2026
Due Date: 20/11/2026
Description of Services        SAC     Amount
Housekeeping manpower services for October 2026   998533   10,000.00
Taxable Value 10,000.00
CGST @ 9% 900.00
SGST @ 9% 900.00
Grand Total 11,800.00`;

test('built-in reader finds GSTINs, invoice details and totals of a GST invoice', () => {
  const r = EX.normalise(EX.parseText(SAMPLE, { ownGstins: new Set(['24AAFCD1234E1Z5']) }));
  assert.equal(r.doc_type.value, 'tax_invoice');
  assert.equal(r.fields.vendor_gstin, '24ABCDE1234F1Z5');
  assert.equal(r.fields.buyer_gstin, '24AAFCD1234E1Z5');
  assert.equal(r.fields.invoice_number, 'CC/120');
  assert.equal(r.fields.invoice_date, '2026-11-05');
  assert.equal(r.fields.due_date, '2026-11-20');
  assert.equal(r.fields.sub_total, 10000);
  assert.equal(r.fields.tax_total, 1800);
  assert.equal(r.fields.total, 11800);
  assert.match(r.lines[0].description, /Housekeeping manpower/);
});

test('quotations, proformas and statements are recognised as not bills', () => {
  assert.equal(EX.docTypeFromText('QUOTATION\nQuote No: Q-12', '').value, 'quotation');
  assert.equal(EX.docTypeFromText('PROFORMA INVOICE', '').value, 'proforma_invoice');
  assert.equal(EX.docTypeFromText('Statement of Account\nApr-Oct', '').value, 'statement');
  assert.equal(EX.docTypeFromText('Purchase Order\nPO No 1', 'Purchase Order').value, 'purchase_order');
  assert.equal(EX.docTypeFromText('TAX INVOICE\nPO No: 55', 'TAX INVOICE ... invoice').value, 'tax_invoice');
});

test('company comes from the billed-to GSTIN; otherwise flagged as assumed from the mailbox', () => {
  const companies = [{ id: 'devx', name: 'DevX', gstins: ['24AAFCD1234E1Z5'], pans: [], name_hints: [] }, { id: 'neddle', name: 'Neddle', gstins: [], pans: [], name_hints: ['needle and thread'] }];
  assert.equal(M.detectCompany({ fields: { buyer_gstin: '27AAFCD1234E1Z9' }, companies }).id, 'devx');   // same PAN, other state
  assert.equal(M.detectCompany({ fields: {}, text: 'Bill to: Needle and Thread Designs', companies }).id, 'neddle');
  const assumed = M.detectCompany({ fields: {}, text: '', member: { companies: ['devx'] }, companies });
  assert.equal(assumed.id, 'devx'); assert.equal(assumed.sure, false);
  assert.equal(M.detectCompany({ fields: { buyer_gstin: '29ZZZZZ1111Z1Z1' }, companies }).unknownGstin, true);
});

test('vendor: unique active GSTIN matches; same-PAN or name-only needs the team', () => {
  const vendors = M.vendorIndex([
    { contact_id: 'a', contact_name: 'Clean Co Facility Services', gst_no: '24ABCDE1234F1Z5', status: 'active' },
    { contact_id: 'b', contact_name: 'Clean Co Facility Services (MH)', gst_no: '27ABCDE1234F1Z1', status: 'active' },
  ]);
  assert.equal(M.matchVendor({ fields: { vendor_gstin: '24ABCDE1234F1Z5' }, vendors }).id, 'a');
  const pan = M.matchVendor({ fields: { vendor_gstin: '29ABCDE1234F1Z2' }, vendors });
  assert.equal(pan.id, ''); assert.equal(pan.match, 'pan'); assert.equal(pan.candidates.length, 2);
  // two vendors with near-identical names: the team chooses
  const twin = M.matchVendor({ fields: { vendor_name: 'Clean Co Facility Services' }, vendors });
  assert.equal(twin.id, ''); assert.equal(twin.candidates.length, 2);
  const one = M.matchVendor({ fields: { vendor_name: 'Clean Co Facility Services' }, vendors: vendors.slice(0, 1) });
  assert.equal(one.id, 'a'); assert.equal(one.match, 'name');
  // a GSTIN on the bill that no vendor has is never matched by name alone
  assert.equal(M.matchVendor({ fields: { vendor_gstin: '07QQQQQ1234Q1Z1', vendor_name: 'Clean Co Facility Services' }, vendors: vendors.slice(0, 1) }).id, '');
});

test('category: bill wording decides; member category alone never does', () => {
  const cats = C.defaults().categories;
  const bill = { fields: { description: 'Housekeeping manpower services for October' }, lines: [], source_ref: {} };
  const r = M.categorise({ bill, categories: cats, member: { categories: ['amc'] } });
  assert.equal(r.id, 'hk_security_gardening');
  const none = M.categorise({ bill: { fields: { description: 'Charges' }, lines: [], source_ref: {} }, categories: cats, member: { categories: ['amc'] } });
  assert.equal(none.id, ''); assert.match(none.basis, /choose/);
  const amc = M.categorise({ bill: { fields: { description: 'Annual maintenance contract for DG set Apr-Mar' }, lines: [], source_ref: {} }, categories: cats });
  assert.equal(amc.id, 'amc');
});

const hist = [
  { bill_id: 'h1', bill_number: 'A1', date: '2026-09-01', lines: [{ description: 'Housekeeping manpower services', account_id: 'hk', account_name: 'HK', tax_id: 'g18', hsn_or_sac: '998533' }] },
  { bill_id: 'h2', bill_number: 'A2', date: '2026-08-01', lines: [{ description: 'Repair of vacuum cleaner', account_id: 'rm', account_name: 'R&M', tax_id: 'g18' }] },
];

test('account comes from a similar historical line, not from the vendor alone', () => {
  const ok = A.fromHistory({ description: 'Housekeeping manpower services for October', hsn_sac: '998533' }, hist, 0.5);
  assert.equal(ok.account.id, 'hk'); assert.equal(ok.account.source, 'history'); assert.equal(ok.account.ref.bill_number, 'A1');
  const none = A.fromHistory({ description: 'Supply of garden plants' }, hist, 0.5);
  assert.equal(none.account, null); assert.equal(none.status, 'no_match'); assert.equal(none.alternatives.length, 2);
  // the same description booked to two accounts → the team decides
  const mixed = A.fromHistory({ description: 'Housekeeping manpower services' }, [...hist, { bill_id: 'h3', bill_number: 'A3', date: '2026-07-01', lines: [{ description: 'Housekeeping manpower services', account_id: 'rm', account_name: 'R&M' }] }], 0.5);
  assert.equal(mixed.status, 'inconsistent'); assert.equal(mixed.account, null);
  // a clearly closer line wins over a looser one
  const closer = A.fromHistory({ description: 'Housekeeping services' }, [...hist, { bill_id: 'h3', bill_number: 'A3', date: '2026-07-01', lines: [{ description: 'Housekeeping services', account_id: 'rm', account_name: 'R&M' }] }], 0.5);
  assert.equal(closer.account.id, 'rm');
});

test('a confirmed mapping wins; vendor-wide mapping is the fallback', () => {
  const mappings = [
    { company: 'devx', vendor_id: 'v', category_id: '', description: '', account_id: 'wide', account_name: 'Wide', created_by: 'x' },
    { company: 'devx', vendor_id: 'v', category_id: 'c', description: 'Deep cleaning of carpets', account_id: 'deep', account_name: 'Deep', created_by: 'x' },
  ];
  assert.equal(A.mappingFor({ description: 'Deep cleaning of carpets in cabin' }, { mappings, company: 'devx', vendorId: 'v', categoryId: 'c', threshold: 0.5 }).m.account_id, 'deep');
  assert.equal(A.mappingFor({ description: 'Something else' }, { mappings, company: 'devx', vendorId: 'v', categoryId: 'c', threshold: 0.5 }).m.account_id, 'wide');
  assert.equal(A.mappingFor({ description: 'x' }, { mappings, company: 'neddle', vendorId: 'v', threshold: 0.5 }), null);
});

test('GST tax only when confirmed: same rate and split as history, never guessed', () => {
  const taxes = [{ id: 'g18', name: 'GST18', percentage: 18, type: 'tax_group' }, { id: 'i18', name: 'IGST18', percentage: 18, specific: 'igst' }];
  const intra = { cgst: 900, sgst: 900, igst: 0, tax_total: 1800, sub_total: 10000 };
  const ok = A.suggestTax({ amount: 10000, tax_rate: 18 }, 'hk', { fields: intra, taxes, historyBills: hist });
  assert.equal(ok.tax.id, 'g18'); assert.equal(ok.tax.source, 'history');
  const inter = A.suggestTax({ amount: 10000, tax_rate: 18 }, 'hk', { fields: { igst: 1800, tax_total: 1800, sub_total: 10000 }, taxes, historyBills: hist });
  assert.equal(inter.tax, null); assert.match(inter.issue, /IGST 18%/);
  const nohist = A.suggestTax({ amount: 10000, tax_rate: 18 }, 'new', { fields: intra, taxes, historyBills: hist });
  assert.equal(nohist.tax, null); assert.equal(nohist.needed, true);
  const nogst = A.suggestTax({ amount: 100 }, 'hk', { fields: { tax_total: 0, sub_total: 100 }, taxes, historyBills: hist });
  assert.equal(nogst.needed, false);
});

test('duplicates: same file, same invoice number, already in Zoho, possible match', () => {
  const base = { company: 'devx', vendor: { id: 'v' }, fields: { invoice_number: 'CC/120', invoice_date: '2026-11-01', total: 11800 }, status: 'ready' };
  const a = { ...base, id: 'BB-1', created_at: '2026-11-01T00:00:00Z', file: { sha256: 'h1' } };
  assert.equal(D.check({ ...base, id: 'BB-2', created_at: '2026-11-02T00:00:00Z', file: { sha256: 'h1' } }, [a]).certainty, 'exact');
  assert.equal(D.check({ ...base, id: 'BB-2', created_at: '2026-11-02T00:00:00Z', file: { sha256: 'h2' }, fields: { ...base.fields, invoice_number: 'cc-120' } }, [a]).certainty, 'likely');
  assert.equal(D.check({ ...base, id: 'BB-2', created_at: '2026-11-02T00:00:00Z', file: { sha256: 'h2' }, fields: { ...base.fields, total: 9000 } }, [a]).certainty, 'revised');
  assert.equal(D.check({ ...base, id: 'BB-2', created_at: '2026-11-02T00:00:00Z', file: { sha256: 'h2' }, fields: { ...base.fields, invoice_number: 'X9' } }, [a]).certainty, 'possible');
  assert.equal(D.check({ ...base, id: 'BB-3', created_at: '2026-11-03T00:00:00Z', file: { sha256: 'h3' } }, [], [{ bill_id: 'z1', vendor_id: 'v', bill_number: 'CC/120', date: '2026-11-01', status: 'open' }]).certainty, 'zoho');
  // the original itself is not a duplicate of the later copy
  assert.equal(D.check(a, [{ ...base, id: 'BB-2', created_at: '2026-11-02T00:00:00Z', file: { sha256: 'h1' } }]), null);
});

test('category fields: mandatory, type and pattern checks', () => {
  const v = C.validateField({ label: 'Service month', type: 'text', mandatory: true, source: 'team', validation: { regex: '^[A-Z][a-z]{2}-\\d{4}$' }, zoho: { target: 'bill_custom_field', key: 'cf_service_month' } });
  assert.ok(v.field);
  assert.match(V.fieldValue(v.field, { cat_fields: {} }).error, /required/);
  assert.match(V.fieldValue(v.field, { cat_fields: { service_month: { value: 'october', source: 'manual' } } }).error, /format/);
  assert.equal(V.fieldValue(v.field, { cat_fields: { service_month: { value: 'Oct-2026', source: 'manual' } } }).error, '');
  assert.ok(C.validateField({ label: 'X', type: 'dropdown', options: [] }).error);
  assert.ok(C.validateField({ label: 'X', type: 'text', zoho: { target: 'bill_field', key: 'bad key!' } }).error);
});

test('draft payload: is_draft, accounts, confirmed tax, branch/TDS, custom fields', () => {
  const bill = {
    id: 'BB-1', source: 'email', source_ref: { mailbox: 'a@x' },
    vendor: { id: 'v' }, fields: { invoice_number: 'CC/1', invoice_date: '2026-11-01', due_date: '2026-11-15', round_off: 0.2 },
    lines: [{ description: 'HK', amount: 1000, quantity: 1, rate: 1000, hsn_sac: '998533', account: { id: 'acc', name: 'HK', source: 'history', basis: 'b' }, tax: { id: 'g18', name: 'GST18', source: 'history', basis: 'b' } }],
    bill_level: { branch: { id: 'br_1' }, tds: { id: 'tds' } },
    cat_field_state: { service_month: { value: 'Oct-2026' } }, category: { name: 'HK', basis: 'x' }, issues: [],
  };
  const p = DR.buildPayload(bill, { category: { fields: [{ id: 'service_month', type: 'text', zoho: { target: 'bill_custom_field', key: 'cf_service_month' } }] }, customFieldIds: { cf_service_month: 'cf_1' } });
  assert.equal(p.is_draft, true);
  assert.deepEqual(p.line_items[0], { account_id: 'acc', description: 'HK', quantity: 1, rate: 1000, item_order: 1, tax_id: 'g18', hsn_or_sac: '998533' });
  assert.equal(p.branch_id, 'br_1'); assert.equal(p.tds_tax_id, 'tds'); assert.equal(p.adjustment, 0.2);
  assert.deepEqual(p.custom_fields, [{ customfield_id: 'cf_1', value: 'Oct-2026' }]);
  assert.match(DR.reviewComment(bill), /Line 1 account HK/);
});

test('mailbox tokens are sealed and OAuth state is tamper-proof', () => {
  const box = SEC.seal({ refresh_token: 'secret-refresh' });
  assert.ok(!JSON.stringify(box).includes('secret-refresh'));
  assert.equal(SEC.open(box).refresh_token, 'secret-refresh');
  const st = SEC.signState({ m: 'm1' });
  assert.equal(SEC.readState(st).m, 'm1');
  assert.equal(SEC.readState(st.replace(/.$/, c => (c === 'A' ? 'B' : 'A'))), null);
});
