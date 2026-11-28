/**
 * Management Cash Flow — configuration: the companies (Zoho organisations) and the categories (tabs).
 *
 * A category is decided by the expense account on the bill line: a line belongs to Brokerage when its account is
 * "Brokerage Charges" or any account under it in Zoho's chart of accounts (Client Brokerage Charges, Ahmedabad - 1
 * Brokerage Charges …), and so on. One bill can carry lines of two categories (a landlord bill with rent and an
 * electricity recharge); each category gets its own part of the bill.
 *
 * Which bills are read in detail (each detail is one Zoho call) is narrowed first by what the synced bill list already
 * shows: the bill's "Vendor Category", the vendor master's category, words in the vendor's name, or a vendor that has
 * had a bill of the category before. The detail then decides, line by line.
 */

'use strict';

const CATEGORY_ORDER = ['brokerage', 'rent', 'electricity'];

const DEFAULTS = {
  companies: [
    { id: 'devx', name: 'Dev Accelerator Ltd', org_id: '60027116474' },
    { id: 'neddle', name: 'Needle And Thread Designs LLP', org_id: '60007894213' },
  ],
  categories: {
    brokerage: {
      label: 'Brokerage Charges', kind: 'outflow',
      account_roots: ['Brokerage Charges'],
      bill_vendor_categories: ['brokrage', 'brokerage'],
      vendor_master_categories: ['brokers'],
      name_hints: ['brokerage', 'broker'],
    },
    rent: {
      label: 'Rent Expense', kind: 'outflow',
      account_roots: ['Office Rent'],
      bill_vendor_categories: ['landlord'],
      vendor_master_categories: ['rent/maint. vendors'],
      name_hints: [],
    },
    electricity: {
      label: 'Electricity Charges', kind: 'outflow',
      account_roots: ['Electricity Expense'],
      bill_vendor_categories: ['electricity'],
      vendor_master_categories: [],
      name_hints: ['electricity', 'electric', 'torrent power', 'vij company', 'vidyut', 'msedcl', 'bses', 'tata power', 'adani electricity', 'power distribution', 'discom'],
    },
  },
  settings: {
    pace_ms: 1200,          // one Zoho call every 1.2 s (≈ 50 a minute, well inside Zoho's 150 a minute shared by the whole app)
    step_seconds_pc: 600,   // a refresh step on the office PC
    step_seconds_online: 230, // a refresh step online (Vercel ends a request after 300 s)
    balance_tolerance: 1,   // ₹ — a bill whose figures here differ from Zoho's balance by more is flagged
  },
};

const clone = v => JSON.parse(JSON.stringify(v));

/** Stored configuration over the defaults (a category or company added later is picked up) */
function merge(saved) {
  const c = clone(DEFAULTS);
  if (!saved || typeof saved !== 'object') return c;
  if (Array.isArray(saved.companies) && saved.companies.length) c.companies = saved.companies;
  for (const k of Object.keys(c.categories)) {
    const s = saved.categories?.[k];
    if (s && typeof s === 'object') c.categories[k] = { ...c.categories[k], ...s, kind: c.categories[k].kind };
  }
  c.settings = { ...c.settings, ...(saved.settings || {}) };
  return c;
}

const lower = a => (Array.isArray(a) ? a : String(a || '').split(',')).map(x => String(x).trim().toLowerCase()).filter(Boolean);

/** A configuration change from the page → clean values only */
function cleanCategoryPatch(patch = {}) {
  const out = {};
  for (const k of CATEGORY_ORDER) {
    const p = patch[k];
    if (!p) continue;
    out[k] = {};
    if (p.account_roots !== undefined) out[k].account_roots = (Array.isArray(p.account_roots) ? p.account_roots : String(p.account_roots).split(',')).map(s => String(s).trim()).filter(Boolean).slice(0, 30);
    for (const f of ['bill_vendor_categories', 'vendor_master_categories', 'name_hints']) if (p[f] !== undefined) out[k][f] = lower(p[f]).slice(0, 40);
  }
  return out;
}

module.exports = { DEFAULTS, CATEGORY_ORDER, merge, cleanCategoryPatch };
