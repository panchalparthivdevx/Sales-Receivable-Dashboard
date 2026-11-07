/**
 * Defaults and validation for bb_config: companies, bill categories (with their keywords and
 * category-specific fields), team members and settings. Everything here is editable in the app;
 * the defaults only seed an empty configuration.
 */

'use strict';

const crypto = require('crypto');

const STATUSES = {
  received:      'Received',
  extracted:     'Extracted',
  needs_input:   'Needs Input',
  ready:         'Ready for Draft',
  draft_created: 'Draft Created',
  reviewed:      'Reviewed',
  duplicate:     'Duplicate',
  failed:        'Failed',
  not_bill:      'Not a Bill',
};

// Bill categories = workflow and ownership (who handles the bill, which extra fields it needs).
// They are NOT expense accounts — the account is chosen per line from history / mappings / the team.
// Keywords are matched against the bill's lines, description and email; edit them in the app.
const DEFAULT_CATEGORIES = [
  { id: 'rent_cam', name: 'Developers / Landlords & CAM',
    keywords: ['rent', 'lease rent', 'lease', 'licence fee', 'license fee', 'leave and license', 'common area maintenance', 'cam charges', 'cam', 'maintenance charges', 'landlord', 'premises', 'monthly compensation'] },
  { id: 'brokers_consultants', name: 'Brokers & Consultants',
    keywords: ['brokerage', 'broker', 'commission', 'consultancy', 'consulting', 'consultant', 'professional fees', 'professional charges', 'advisory', 'retainer', 'retainership', 'legal fees'] },
  { id: 'hk_security_gardening', name: 'Housekeeping, Security & Gardening',
    keywords: ['housekeeping', 'house keeping', 'cleaning', 'janitorial', 'security services', 'security guard', 'guard', 'manpower', 'gardening', 'gardener', 'landscaping', 'pest control', 'hygiene'] },
  { id: 'pantry_vending_parking', name: 'Tea & Coffee, Vending & Parking',
    keywords: ['tea', 'coffee', 'vending', 'vending machine', 'beverages', 'pantry', 'snacks', 'parking', 'valet', 'car parking'] },
  { id: 'furniture_fixtures', name: 'Furniture & Fixtures',
    keywords: ['furniture', 'chair', 'chairs', 'table', 'desk', 'workstation', 'cabinet', 'sofa', 'pedestal', 'storage unit', 'fixtures', 'modular furniture'] },
  { id: 'electrical_projects', name: 'Electrical & Projects',
    keywords: ['electrical', 'electrical work', 'wiring', 'cabling', 'lighting', 'light fixtures', 'panel', 'mcb', 'civil work', 'interior', 'fit out', 'fit-out', 'false ceiling', 'partition', 'flooring', 'project'] },
  { id: 'repairs_maintenance', name: 'Repairs & Maintenance (R&M)',
    keywords: ['repair', 'repairs', 'repairing', 'maintenance', 'servicing', 'service charges', 'plumbing', 'carpentry', 'painting', 'replacement', 'breakdown'] },
  { id: 'amc', name: 'Annual Maintenance Contract (AMC)',
    keywords: ['amc', 'annual maintenance contract', 'annual maintenance', 'comprehensive maintenance contract', 'preventive maintenance', 'maintenance contract'] },
  { id: 'fundraising', name: 'Equity & Debt Fundraising',
    keywords: ['fundraising', 'fund raising', 'placement fee', 'investment banking', 'debt syndication', 'syndication fee', 'arranger fee', 'success fee', 'due diligence', 'valuation', 'merchant banking', 'rating fee', 'term sheet'] },
].map(c => ({ ...c, active: true, fields: [], vendor_category_aliases: [] }));

const DEFAULT_COMPANIES = [
  { id: 'devx',   name: 'Dev Accelerator Ltd',             org_id: '60027116474', gstins: [], pans: [], name_hints: ['dev accelerator', 'devx'] },
  { id: 'neddle', name: 'Needle And Thread Designs LLP',  org_id: '60007894213', gstins: [], pans: [], name_hints: ['needle and thread', 'needle & thread', 'neddle'] },
];

const DEFAULT_SETTINGS = {
  history_days: 120,            // "previous 3–4 months" of the vendor's bills
  history_max_bills: 10,        // detail calls per vendor (Zoho daily API limit is shared with the syncs)
  similarity_threshold: 0.5,    // 0–1: how close a line must be to a historical line to reuse its account
  category_min_score: 3,        // keyword score a category needs to be chosen without the team
  auto_create_drafts: false,    // switched on by the user once the Zoho draft test has passed
  poll_minutes: 15,
  mail_scope: 'likely_bills',   // 'likely_bills' | 'all_attachments'
  mail_lookback_days: 7,        // first poll of a newly connected mailbox reaches back this far
  draft_capability: {},         // org_id → { verified, status, checked_at, by, detail }
  zoho_access: {},              // org_id → { read, create, checked_at, detail }
};

// Category-specific field definition (configured by the user — none are invented here)
const FIELD_TYPES = ['text', 'number', 'date', 'dropdown', 'reference'];
const FIELD_SOURCES = ['extraction', 'history', 'mapping', 'team'];
const REFERENCE_KINDS = ['zoho_branch', 'zoho_project', 'zoho_vendor'];
const ZOHO_TARGETS = ['none', 'bill_custom_field', 'bill_field', 'line_field'];
const EXTRACTION_KEYS = ['po_number', 'service_period_from', 'service_period_to', 'place_of_supply', 'description', 'due_date', 'irn', 'buyer_gstin'];

const newId = (p = '') => p + crypto.randomBytes(6).toString('hex');
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

function defaults() {
  return {
    version: 1,
    companies: DEFAULT_COMPANIES.map(c => ({ ...c })),
    categories: DEFAULT_CATEGORIES.map(c => ({ ...c, keywords: [...c.keywords] })),
    team: [],
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** Fill in anything a stored configuration is missing (new settings, new default companies) */
function merge(cfg) {
  const d = defaults();
  if (!cfg) return d;
  const out = { ...d, ...cfg };
  out.settings = { ...d.settings, ...(cfg.settings || {}) };
  out.companies = cfg.companies?.length ? cfg.companies : d.companies;
  out.categories = Array.isArray(cfg.categories) ? cfg.categories : d.categories;
  out.team = Array.isArray(cfg.team) ? cfg.team : [];
  return out;
}

function cleanList(v, max = 200) {
  return (Array.isArray(v) ? v : String(v || '').split(/[,\n]/))
    .map(s => String(s).trim()).filter(Boolean).slice(0, max);
}

/** Validate one category-specific field definition; returns { field } or { error } */
function validateField(f) {
  const label = String(f.label || '').trim();
  if (!label) return { error: 'Every field needs a name' };
  const type = FIELD_TYPES.includes(f.type) ? f.type : null;
  if (!type) return { error: `Field "${label}": choose a type (${FIELD_TYPES.join(', ')})` };
  const options = type === 'dropdown' ? cleanList(f.options, 100) : [];
  if (type === 'dropdown' && !options.length) return { error: `Field "${label}": a dropdown needs at least one option` };
  const reference = type === 'reference' ? (REFERENCE_KINDS.includes(f.reference) ? f.reference : null) : null;
  if (type === 'reference' && !reference) return { error: `Field "${label}": choose what it refers to (${REFERENCE_KINDS.join(', ')})` };
  const source = FIELD_SOURCES.includes(f.source) ? f.source : 'team';
  const extraction_key = source === 'extraction' ? (EXTRACTION_KEYS.includes(f.extraction_key) ? f.extraction_key : null) : null;
  if (source === 'extraction' && !extraction_key) return { error: `Field "${label}": choose which bill detail fills it (${EXTRACTION_KEYS.join(', ')})` };
  const zt = ZOHO_TARGETS.includes(f.zoho?.target) ? f.zoho.target : 'none';
  const zkey = String(f.zoho?.key || '').trim();
  if (zt !== 'none' && !/^[A-Za-z0-9_]{1,80}$/.test(zkey)) return { error: `Field "${label}": the Zoho field needs its API name (e.g. cf_service_period or branch_id)` };
  const v = f.validation || {};
  if (v.regex) { try { new RegExp(v.regex); } catch (_) { return { error: `Field "${label}": the validation pattern is not valid` }; } }
  const num = x => (x === '' || x == null || Number.isNaN(Number(x)) ? null : Number(x));
  return {
    field: {
      id: f.id && /^[a-z0-9_]{1,40}$/.test(f.id) ? f.id : slug(label) || newId('f'),
      label, description: String(f.description || '').trim().slice(0, 500), type, options, reference,
      mandatory: !!f.mandatory, default: f.default == null ? '' : String(f.default).slice(0, 200),
      source, extraction_key,
      zoho: { target: zt, key: zt === 'none' ? '' : zkey },
      validation: { regex: v.regex ? String(v.regex).slice(0, 200) : '', min: num(v.min), max: num(v.max), message: String(v.message || '').slice(0, 200) },
    },
  };
}

function validateCategories(list) {
  if (!Array.isArray(list)) return { error: 'Categories must be a list' };
  const ids = new Set();
  const out = [];
  for (const c of list) {
    const name = String(c.name || '').trim();
    if (!name) return { error: 'Every category needs a name' };
    const id = c.id && /^[a-z0-9_]{1,40}$/.test(c.id) ? c.id : slug(name) || newId('c');
    if (ids.has(id)) return { error: `Two categories share the id "${id}"` };
    ids.add(id);
    const fields = [];
    const fids = new Set();
    for (const f of c.fields || []) {
      const r = validateField(f);
      if (r.error) return { error: `${name}: ${r.error}` };
      if (fids.has(r.field.id)) return { error: `${name}: two fields share the id "${r.field.id}"` };
      fids.add(r.field.id);
      fields.push(r.field);
    }
    out.push({
      id, name, active: c.active !== false,
      keywords: cleanList(c.keywords).map(k => k.toLowerCase()),
      vendor_category_aliases: cleanList(c.vendor_category_aliases).map(k => k.toLowerCase()),
      fields,
    });
  }
  return { categories: out };
}

const PROVIDERS = ['microsoft', 'microsoft_app', 'gmail', 'none'];
const REVIEW_ROLES = ['preparer', 'reviewer', 'approver'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateMember(m, cfg, existing) {
  const name = String(m.name || '').trim();
  if (!name) return { error: 'Name is required' };
  const email = String(m.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { error: 'A valid email address is required' };
  const dupe = cfg.team.find(t => t.email === email && t.id !== existing?.id);
  if (dupe) return { error: `${email} is already set up for ${dupe.name}` };
  const provider = PROVIDERS.includes(m.provider) ? m.provider : 'microsoft';
  const catIds = new Set(cfg.categories.map(c => c.id));
  const companyIds = new Set(cfg.companies.map(c => c.id));
  const companies = cleanList(m.companies).filter(c => companyIds.has(c));
  if (!companies.length) return { error: 'Choose the company / Zoho Books organisation' };
  const review_role = REVIEW_ROLES.includes(m.review_role) ? m.review_role : 'preparer';
  const providerChanged = existing && (existing.provider !== provider || existing.email !== email);
  return {
    member: {
      id: existing?.id || newId('m'),
      name, email, provider,
      categories: cleanList(m.categories).filter(c => catIds.has(c)),
      companies, review_role,
      review_scope: String(m.review_scope || '').trim().slice(0, 300),
      dashboard_user: String(m.dashboard_user || '').trim().slice(0, 80),
      active: m.active !== false,
      connection: providerChanged || !existing
        ? { status: provider === 'none' ? 'not_applicable' : 'not_connected' }
        : existing.connection,
      created_at: existing?.created_at || new Date().toISOString(),
    },
    providerChanged,
  };
}

function validateSettings(input, cur) {
  const s = { ...cur };
  const int = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  if ('history_days' in input) s.history_days = int(input.history_days, 30, 365, cur.history_days);
  if ('history_max_bills' in input) s.history_max_bills = int(input.history_max_bills, 1, 30, cur.history_max_bills);
  if ('similarity_threshold' in input) { const n = Number(input.similarity_threshold); if (n >= 0.2 && n <= 0.95) s.similarity_threshold = n; }
  if ('category_min_score' in input) s.category_min_score = int(input.category_min_score, 1, 20, cur.category_min_score);
  if ('poll_minutes' in input) s.poll_minutes = int(input.poll_minutes, 5, 240, cur.poll_minutes);
  if ('mail_lookback_days' in input) s.mail_lookback_days = int(input.mail_lookback_days, 0, 90, cur.mail_lookback_days);
  if ('mail_scope' in input && ['likely_bills', 'all_attachments'].includes(input.mail_scope)) s.mail_scope = input.mail_scope;
  if ('auto_create_drafts' in input) s.auto_create_drafts = !!input.auto_create_drafts;
  return s;
}

function validateCompanies(list, cur) {
  if (!Array.isArray(list)) return { error: 'Companies must be a list' };
  const byId = new Map(cur.map(c => [c.id, c]));
  const out = [];
  for (const c of list) {
    const base = byId.get(c.id);
    if (!base) return { error: `Unknown company "${c.id}"` };
    const gstins = cleanList(c.gstins).map(g => g.toUpperCase()).filter(g => /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(g));
    const pans = cleanList(c.pans).map(p => p.toUpperCase()).filter(p => /^[A-Z]{5}\d{4}[A-Z]$/.test(p));
    out.push({ ...base, gstins, pans, name_hints: cleanList(c.name_hints ?? base.name_hints).map(s => s.toLowerCase()) });
  }
  return { companies: out };
}

module.exports = {
  STATUSES, FIELD_TYPES, FIELD_SOURCES, REFERENCE_KINDS, ZOHO_TARGETS, EXTRACTION_KEYS, PROVIDERS, REVIEW_ROLES,
  defaults, merge, validateCategories, validateField, validateMember, validateSettings, validateCompanies, newId, slug,
};
