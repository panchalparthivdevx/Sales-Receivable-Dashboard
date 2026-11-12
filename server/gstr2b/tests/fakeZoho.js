/**
 * A fake Zoho Books organisation for tests. Rows and details have the SHAPE verified against the live DevX / Neddle
 * organisations (list rows without amounts; details with taxes[], line_item_taxes[], custom_field_hash …).
 * All names, numbers and amounts are synthetic.
 */

'use strict';

const { gstin } = require('./helpers');

const ORG = '60099999999';
const REC_A = gstin('24', 'AAFCD1234E');           // Gujarat registration
const REC_B = gstin('27', 'AAFCD1234E', '2');      // Maharashtra registration (same PAN)
const SUP_GJ = gstin('24', 'AAACS1111A');
const SUP_MH = gstin('27', 'AAACR5055K');

const BRANCHES = [
  { id: 'br_a', name: 'Ahmedabad Office', gstin: REC_A, state_code: 'GJ', state: 'Gujarat', active: true, primary: true, registration_id: 'r1' },
  { id: 'br_b', name: 'Mumbai Office', gstin: REC_B, state_code: 'MH', state: 'Maharashtra', active: true, primary: false, registration_id: 'r2' },
  { id: 'br_x', name: 'Unmapped Branch', gstin: '', state_code: '', state: '', active: true, primary: false, registration_id: '' },
];

const tax = (kind, rate, taxable) => {
  const t = Math.round(taxable * rate) / 100;
  return kind === 'igst' ? [{ tax_name: `IGST${rate} (${rate}%)`, tax_amount: t }]
    : [{ tax_name: `SGST${rate / 2} (${rate / 2}%)`, tax_amount: t / 2 }, { tax_name: `CGST${rate / 2} (${rate / 2}%)`, tax_amount: t / 2 }];
};

/** A bill → { row (list shape), detail (detail shape) } */
function bill(o) {
  const taxable = o.taxable ?? 1000, rate = o.rate ?? 18, kind = o.tax || 'intra';
  const taxes = o.rcm || o.noTax ? [] : tax(kind === 'inter' ? 'igst' : 'intra', rate, taxable);
  const taxTotal = taxes.reduce((s, t) => s + t.tax_amount, 0);
  const tds = o.tds ?? 0;
  const total = o.totalOverride ?? (taxable + taxTotal - tds);
  const lmt = o.lmt || '2026-10-15T10:00:00+0530';
  const g = 'gst' in o ? o.gst : SUP_GJ;
  const row = {
    bill_id: o.id, vendor_id: o.vendor || 'v1', vendor_name: o.name || 'Synthetic Vendor', gst_no: g || '', gst_treatment: o.treatment || (g ? 'business_gst' : 'business_none'),
    status: o.status || 'open', bill_number: o.no, reference_number: '', date: o.date || '2026-10-12', currency_code: o.cur || 'INR', total, tds_total: tds, balance: total,
    last_modified_time: lmt, created_time: lmt, is_opening_balance: o.opening ? 'true' : 'false', branch_id: o.branch || 'br_a', branch_name: 'x', location_id: o.branch || 'br_a',
  };
  if (o.inv !== null) { row.cf_vendor_bill_date_unformatted = o.inv || o.date || '2026-10-12'; }
  const lines = [{ line_item_id: 'l1', account_id: 'acc1', account_name: 'Expense', item_total: taxable, tax_percentage: rate, tax_name: kind === 'inter' ? `IGST${rate}` : `GST${rate}`, hsn_or_sac: '', itc_eligibility: 'eligible',
    line_item_taxes: taxes.map(t => ({ ...t, tax_id: 't' })), reverse_charge_tax_amount: o.rcm ? Math.round(taxable * rate) / 100 : undefined, project_id: o.project || '', project_name: o.project ? 'Project X' : '' }];
  const detail = {
    bill_id: o.id, bill_number: o.no, vendor_id: row.vendor_id, vendor_name: row.vendor_name, gst_no: row.gst_no, gst_treatment: row.gst_treatment, status: row.status, date: row.date,
    branch_id: row.branch_id, branch_name: 'x', source_of_supply: kind === 'inter' ? 'MH' : 'GJ', destination_of_supply: o.dest || 'GJ',
    is_reverse_charge_applied: !!o.rcm, is_inclusive_tax: false, sub_total: taxable, tax_total: taxTotal, total, adjustment: o.adjustment ?? 0, discount_total: o.discount ?? 0,
    tds_amount: tds, taxes, line_items: lines, payments: o.payments || [], vendor_credits_applied: 0, balance: total, currency_code: row.currency_code,
    last_modified_time: lmt, created_time: lmt, gst_return_details: { return_period: '', status: '' }, custom_fields: o.inv === null ? [] : [{ api_name: 'cf_vendor_bill_date', value: o.inv || o.date || '2026-10-12' }],
    custom_field_hash: o.inv === null ? {} : { cf_vendor_bill_date_unformatted: o.inv || o.date || '2026-10-12' },
  };
  return { row, detail };
}

function credit(o) {
  const taxable = o.taxable ?? 500, taxes = tax(o.tax === 'inter' ? 'igst' : 'intra', 18, taxable);
  const taxTotal = taxes.reduce((s, t) => s + t.tax_amount, 0);
  const lmt = o.lmt || '2026-10-20T10:00:00+0530';
  const row = { vendor_credit_id: o.id, vendor_credit_number: o.no, reference_number: o.ref || '', status: o.status || 'open', date: o.date || '2026-10-18', vendor_id: 'v1', vendor_name: 'Synthetic Vendor', currency_code: 'INR', total: taxable + taxTotal, last_modified_time: lmt, branch_id: o.branch || 'br_a' };
  const detail = { vendor_credit_id: o.id, vendor_credit_number: o.no, reference_number: row.reference_number, status: row.status, date: row.date, vendor_id: 'v1', vendor_name: row.vendor_name, gst_no: 'gst' in o ? o.gst : SUP_GJ, gst_treatment: 'business_gst',
    branch_id: row.branch_id, source_of_supply: 'GJ', destination_of_supply: 'GJ', sub_total: taxable, total: row.total, taxes, line_items: [{ item_total: taxable, line_item_taxes: taxes }], bill_id: o.bill || 'b1', bill_number: o.billNo || 'INV/1',
    bills_credited: [{ bill_id: o.bill || 'b1', bill_number: o.billNo || 'INV/1' }], last_modified_time: lmt, reason_for_debit_note: 'others', custom_field_hash: o.cfDate ? { cf_bill_date_unformatted: o.cfDate } : {}, custom_fields: [] };
  return { row, detail };
}

function expense(o) {
  const taxable = o.taxable ?? 200, taxes = o.noTax ? [] : tax('intra', 18, taxable);
  const taxAmt = taxes.reduce((s, t) => s + t.tax_amount, 0);
  const lmt = o.lmt || '2026-10-22T10:00:00+0530';
  const row = { expense_id: o.id, date: o.date || '2026-10-21', total: taxable + taxAmt, total_without_tax: taxable, vendor_id: '', vendor_name: 'Cafe', status: 'recorded', currency_code: 'INR', reference_number: o.ref || '', branch_id: o.branch || 'br_a', last_modified_time: lmt };
  const detail = { expense_id: o.id, date: row.date, gst_no: 'gst' in o ? o.gst : SUP_GJ, gst_treatment: 'business_gst', vendor_name: 'Cafe', sub_total: taxable, total: row.total, tax_amount: taxAmt, taxes, reference_number: row.reference_number, branch_id: row.branch_id,
    source_of_supply: 'GJ', destination_of_supply: 'GJ', line_items: [{ item_total: taxable, line_item_taxes: taxes }], status: 'recorded', last_modified_time: lmt, itc_eligibility: 'eligible' };
  return { row, detail };
}

/** Fake read-only Zoho client with the same interface as lib/zohoRead.js */
function makeFake({ pageSize = 3 } = {}) {
  const store = { bills: new Map(), credits: new Map(), expenses: new Map() };
  const log = [];
  const state = { branches: BRANCHES, failDetail: new Set() };
  const gone = id => Object.assign(new Error('The bill does not exist.'), { gone: true, response: { status: 404, data: { code: 1002 } } });
  const zr = {
    calls: { total: 0 }, log, store, state,
    identity: () => 'fake credentials', errText: e => e.message, isGone: e => !!(e && e.gone), dedicated: () => false,
    async listBranches() { zr.calls.total++; log.push('GET /branches'); return state.branches; },
    async get(org, path, params = {}, opts = {}) {
      if (opts.before) await opts.before();
      zr.calls.total++; log.push(`GET ${path}`);
      const m = path.match(/^\/(bills|vendorcredits|expenses)\/(.+)$/);
      if (!m) throw new Error(`fake: unsupported GET ${path}`);
      const coll = store[{ bills: 'bills', vendorcredits: 'credits', expenses: 'expenses' }[m[1]]];
      const e = coll.get(m[2]);
      if (!e) throw gone(m[2]);
      if (state.failDetail.has(m[2])) throw Object.assign(new Error('Zoho: internal error'), { response: { status: 500, data: { message: 'internal error' } } });
      return { [{ bills: 'bill', vendorcredits: 'vendor_credit', expenses: 'expense' }[m[1]]]: e.detail };
    },
    async list(org, path, key, params = {}, opts = {}) {
      const coll = store[{ '/bills': 'bills', '/vendorcredits': 'credits', '/expenses': 'expenses' }[path]];
      let rows = [...coll.values()].map(e => e.row);
      if (params.date_start) rows = rows.filter(r => r.date >= params.date_start);
      if (params.date_end) rows = rows.filter(r => r.date <= params.date_end);
      const sortCol = params.sort_column || 'date';
      rows.sort((a, b) => (String(a[sortCol]) < String(b[sortCol]) ? -1 : 1) * (params.sort_order === 'D' ? -1 : 1));
      const all = [];
      for (let p = 0; p * pageSize < Math.max(rows.length, 1); p++) {
        if (opts.before) await opts.before();
        zr.calls.total++; log.push(`LIST ${path} page ${p + 1}`);
        const page = rows.slice(p * pageSize, (p + 1) * pageSize);
        const more = (p + 1) * pageSize < rows.length;
        if (opts.onPage) { const go = await opts.onPage(page, p + 1, {}); if (go === false) return { rows: all, complete: false }; } else all.push(...page);
        if (!more) break;
      }
      return { rows: all, complete: true };
    },
    // test helpers
    put(kind, e) { store[kind].set(e.row.bill_id || e.row.vendor_credit_id || e.row.expense_id, e); },
    remove(kind, id) { store[kind].delete(id); },
  };
  return zr;
}

module.exports = { ORG, REC_A, REC_B, SUP_GJ, SUP_MH, BRANCHES, bill, credit, expense, makeFake };
