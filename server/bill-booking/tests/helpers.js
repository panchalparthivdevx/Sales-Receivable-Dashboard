/**
 * Test helpers: a temporary store, a fake Zoho (records every write), fake synced data and a fake
 * reader, so the whole workflow runs without Zoho, mailboxes or Claude.
 */

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-bill-booking';

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const files = require('../lib/files');
const LK = require('../lib/lookups');
const PL = require('../lib/pipeline');

const ORG = '60027116474';
const OWN_GSTIN = '24AAFCD1234E1Z5';     // DevX (test value)
const V_GSTIN = '24ABCDE1234F1Z5';       // vendor

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bbtest-'));
  const data = path.join(root, 'data'), fdir = path.join(root, 'files');
  store.configure({ dir: data, useDb: false });
  files.configure({ dir: fdir, blob: null });
  return { root, data, fdir };
}

function fakeZoho(opts = {}) {
  const calls = [];
  const z = {
    calls,
    created: [],
    billStatus: opts.billStatus || 'draft',
    existing: opts.existing || [],
    zohoStatusOf: {},
    errText: e => `Zoho: ${e.message}`,
    billUrl: (org, id) => `https://books.zoho.in/app/${org}#/bills/${id}`,
    async chartOfAccounts() { calls.push('coa'); return [
      { id: 'acc_hk', name: 'Housekeeping Expenses', type: 'expense' },
      { id: 'acc_rm', name: 'Repairs & Maintenance', type: 'expense' },
      { id: 'acc_rent', name: 'Office Rent', type: 'expense' },
    ]; },
    async taxes() { return [
      { id: 'tx_gst18', name: 'GST18', percentage: 18, type: 'tax_group', specific: '' },
      { id: 'tx_igst18', name: 'IGST18', percentage: 18, type: 'tax', specific: 'igst' },
      { id: 'tx_gst12', name: 'GST12', percentage: 12, type: 'tax_group', specific: '' },
    ]; },
    async branches() { return [{ id: 'br_1', name: 'Ahmedabad' }, { id: 'br_2', name: 'Mumbai' }]; },
    async projects() { return []; },
    async ownGstins() { return [OWN_GSTIN]; },
    async vendorBills() { calls.push('vendorBills'); return opts.vendorBills || []; },
    async billDetail(org, id) { calls.push(`detail:${id}`); return (opts.details || {})[id]; },
    async findBill(org, vendorId, number) { calls.push(`find:${number}`); return z.existing.filter(b => b.bill_number === number); },
    async createBill(org, payload) {
      calls.push('create');
      if (opts.createError) throw Object.assign(new Error(opts.createError), { response: { data: { message: opts.createError } } });
      const bill = { bill_id: `zb_${z.created.length + 1}`, bill_number: payload.bill_number, status: z.billStatus,
        sub_total: payload.line_items.reduce((s, l) => s + l.rate * l.quantity, 0), total: 0 };
      z.created.push({ org, payload, bill });
      return bill;
    },
    async attach(org, id, buf, name) { calls.push(`attach:${id}:${name}:${buf ? buf.length : 0}`); },
    async deleteBill(org, id) { calls.push(`delete:${id}`); },
    async send(method, org, p) { calls.push(`${method}:${p}`); return {}; },
    async getBill(org, id) {
      calls.push(`get:${id}`);
      if (!(id in z.zohoStatusOf)) return { bill_id: id, status: 'draft' };
      const s = z.zohoStatusOf[id];
      return s === null ? null : { bill_id: id, status: s, last_modified_by: 'Reviewer R' };
    },
    async checkAccess() { return { read: true, create: true, detail: [] }; },
  };
  return z;
}

const VENDORS = [
  { contact_id: 'v_hk', contact_name: 'Clean Co Facility Services', gst_no: V_GSTIN, pan_no: 'ABCDE1234F', email: 'billing@cleanco.in', status: 'active', cf_vendor_category: 'HK Salary (Recurring)' },
  { contact_id: 'v_other', contact_name: 'Other Vendor LLP', gst_no: '27ZZZZZ9999Z1Z5', email: 'a@other.in', status: 'active' },
];

/** History for v_hk: two bills of housekeeping on acc_hk with GST18, one repair on acc_rm */
function hkHistory() {
  const mk = (id, num, date, lines) => ({ bill_id: id, bill_number: num, date, status: 'paid', lmt: `${date}T10:00:00+0530`, vendor_id: 'v_hk',
    branch_id: 'br_1', branch_name: 'Ahmedabad', tds_tax_id: 'tds_194c', tds_tax_name: 'TDS 194C 2%', custom_fields: [{ customfield_id: 'cf_1', api_name: 'cf_service_month', label: 'Service month', value: 'Sep-2026' }], lines });
  const today = new Date();
  const d = n => new Date(today.getTime() - n * 86400000).toISOString().slice(0, 10);
  const details = {
    hb1: mk('hb1', 'CC/101', d(40), [{ description: 'Housekeeping manpower services for September', account_id: 'acc_hk', account_name: 'Housekeeping Expenses', tax_id: 'tx_gst18', tax_name: 'GST18', tax_percentage: 18, hsn_or_sac: '998533' }]),
    hb2: mk('hb2', 'CC/087', d(70), [{ description: 'Housekeeping manpower services for August', account_id: 'acc_hk', account_name: 'Housekeeping Expenses', tax_id: 'tx_gst18', tax_name: 'GST18', tax_percentage: 18, hsn_or_sac: '998533' }]),
    hb3: mk('hb3', 'CC/090', d(60), [{ description: 'Repair of vacuum cleaner machine', account_id: 'acc_rm', account_name: 'Repairs & Maintenance', tax_id: 'tx_gst18', tax_name: 'GST18', tax_percentage: 18 }]),
  };
  const vendorBills = Object.values(details).map(b => ({ bill_id: b.bill_id, bill_number: b.bill_number, date: b.date, status: 'paid', total: 1000, tds_total: 20, lmt: b.lmt }));
  return { details, vendorBills };
}

/** Reader stand-in: returns what a reading of the given file "says" (keyed by file name) */
function fakeExtract(map) {
  return async (buf, mime, ctx) => {
    const r = map[ctx.fileName] || map['*'];
    if (r instanceof Error) throw r;
    return {
      engine: 'claude', text: r.text || '', text_method: 'pdf_text', pages: 1, warnings: [],
      doc_type: { value: r.doc_type || 'tax_invoice', basis: 'Heading reads "Tax Invoice"' },
      fields: { vendor_name: 'Clean Co Facility Services', vendor_gstin: V_GSTIN, buyer_name: 'Dev Accelerator Ltd', buyer_gstin: OWN_GSTIN,
        invoice_number: 'CC/120', invoice_date: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10), due_date: '', currency: 'INR',
        sub_total: 10000, cgst: 900, sgst: 900, igst: 0, cess: 0, tax_total: 1800, round_off: 0, total: 11800,
        description: 'Housekeeping manpower services for October', po_number: '', place_of_supply: 'Gujarat',
        service_period_from: '', service_period_to: '', irn: '', reverse_charge: false, ...(r.fields || {}) },
      lines: r.lines || [{ description: 'Housekeeping manpower services for October', hsn_sac: '998533', quantity: 1, rate: 10000, amount: 10000, tax_rate: 18, tax_amount: 1800 }],
      confidence: 'high', notes: '', unreadable: false,
    };
  };
}

function setup(opts = {}) {
  const dirs = tempDirs();
  const h = hkHistory();
  const zc = fakeZoho({ details: h.details, vendorBills: h.vendorBills, ...opts.zoho });
  const synced = { devx: { vendors_all: { data: VENDORS }, bills_fy: opts.billsFy || null } };
  const lookups = LK.create({ store, zc, readSynced: async (co, e) => synced[co]?.[e] || null });
  const logs = [];
  const pipeline = PL.create({ store, zc, lookups, files, extractFn: fakeExtract(opts.reads || { '*': {} }), log: { error: m => logs.push(m) } });
  return { ...dirs, zc, lookups, pipeline, store, files, synced, logs, history: h };
}

async function seedConfig(patch = {}) {
  const C = require('../lib/config');
  await store.tx(async t => {
    const c = C.merge(t.doc('bb_config'));
    c.team = [{ id: 'm1', name: 'Asha', email: 'asha@devx.work', provider: 'microsoft', categories: ['hk_security_gardening'], companies: ['devx'], review_role: 'preparer', active: true, connection: { status: 'not_connected' } }];
    Object.assign(c.settings, patch.settings || {});
    if (patch.categories) c.categories = patch.categories(c.categories);
    t.setDoc('bb_config', c);
  });
}

const pdf = (s = 'x') => Buffer.from(`%PDF-1.4\n% test ${s}\n`);

module.exports = { setup, seedConfig, pdf, store, files, ORG, OWN_GSTIN, V_GSTIN, VENDORS, fakeZoho, fakeExtract, tempDirs };
