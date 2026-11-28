/**
 * Test helpers: a temporary store, a Zoho stand-in (GET only: chart of accounts and bill details, counting calls) and the
 * central sync lists the module reads.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../lib/store');
const files = require('../lib/files');

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cftest-'));
  store.configure({ dir: path.join(root, 'data'), useDb: false });
  files.configure({ dir: path.join(root, 'files'), blob: null });
  return root;
}

// DevX-like chart of accounts: the category trees go several levels down
const COA = [
  { account_id: 'a_brk_root', account_name: 'Brokerage Charges', parent_account_name: 'Other General Charges', account_type: 'expense' },
  { account_id: 'a_brk_client', account_name: 'Client Brokerage Charges', parent_account_name: 'Brokerage Charges', account_type: 'expense' },
  { account_id: 'a_brk_amd1', account_name: 'Ahmedabad - 1 Brokerage Charges', parent_account_name: 'Client Brokerage Charges', account_type: 'expense' },
  { account_id: 'a_rent', account_name: 'Office Rent', parent_account_name: 'Direct Expenses', account_type: 'expense' },
  { account_id: 'a_rent_binori', account_name: 'Office Rent_Amd_Binori-3', parent_account_name: 'Office Rent', account_type: 'expense' },
  { account_id: 'a_el', account_name: 'Electricity Expense', parent_account_name: 'Direct Expenses', account_type: 'expense' },
  { account_id: 'a_el_first', account_name: 'Electricity_Amd_The First_10Th Floor', parent_account_name: 'Electricity Expense', account_type: 'expense' },
  { account_id: 'a_cam', account_name: 'Maintenance Charges', parent_account_name: 'Direct Expenses', account_type: 'expense' },
  { account_id: 'a_hk', account_name: 'Housekeeping Service', parent_account_name: 'Direct Expenses', account_type: 'expense' },
];

/** Zoho-shaped bill detail */
function rawBill({ id, no, date, due = '', vid, vn, br = 'Amd_The First', lines, payments = [], credits = [], tds = 0, status = 'open' }) {
  const sub = lines.reduce((s, l) => s + l.amt, 0), tax = lines.reduce((s, l) => s + (l.tax || 0), 0);
  const total = sub + tax - tds;
  const paid = payments.reduce((s, p) => s + p.amount, 0) + credits.reduce((s, c) => s + c.amount, 0);
  return {
    bill_id: id, bill_number: no || `NO-${id}`, date, due_date: due, status, last_modified_time: `${date}T10:00:00+0530`, vendor_id: vid, vendor_name: vn, branch_name: br,
    currency_code: 'INR', exchange_rate: 1, sub_total: sub, tax_total: tax, tds_amount: tds, total, balance: total - paid, adjustment: 0, reference_number: '',
    line_items: lines.map(l => ({ account_id: l.acc, account_name: l.acc, description: l.desc || '', item_total: l.amt, line_item_taxes: l.tax ? [{ tax_amount: l.tax }] : [], tax_name: l.tax ? 'GST18' : '' })),
    payments: payments.map(p => ({ payment_id: p.id, payment_number: p.no || '', date: p.date, apply_date: p.apply || p.date, amount: p.amount, reference_number: p.ref || '', payment_mode: 'ICICI Bank' })),
    vendor_credits: credits.map(c => ({ vendor_credit_id: c.id, vendor_credit_number: c.no || '', date: c.date, amount: c.amount })),
  };
}
const listRow = (raw, extra = {}) => ({ bill_id: raw.bill_id, bill_number: raw.bill_number, date: raw.date, due_date: raw.due_date, status: raw.status, vendor_id: raw.vendor_id,
  vendor_name: raw.vendor_name, branch_name: raw.branch_name, total: raw.total, balance: raw.balance, last_modified_time: raw.last_modified_time, cf_vendor_category: '', ...extra });

/** Zoho stand-in: GET /chartofaccounts (paged) and GET /bills/{id}; counts every call */
function fakeZr(details, { coa = COA } = {}) {
  const calls = [];
  return {
    calls,
    errText: e => `Zoho: ${e.message}`,
    async get(org, p) {
      calls.push(p);
      const m = p.match(/^\/bills\/(\w+)$/);
      if (m) { if (!details[m[1]]) throw Object.assign(new Error('Bill not found'), { response: { status: 404 } }); return { bill: details[m[1]] }; }
      throw new Error(`unexpected ${p}`);
    },
    async list(org, p, key, params) {
      calls.push(`${p}?${params.filter_by}&${params.sort_column}`);
      return { rows: coa, pages: 1, complete: true };
    },
  };
}

module.exports = { tempDirs, COA, rawBill, listRow, fakeZr, store, files };
