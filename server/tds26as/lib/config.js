/**
 * 26AS Reconciliation — configuration: legal entities (PAN, Zoho Books organisation, TDS Receivable ledgers), matching settings, sync
 * limits, schedule and per-user access. Nothing is pre-filled: entities are set up on Settings → Entities and checked against Zoho.
 */

'use strict';

const { PAN_RE, normPan } = require('./util');

const DEFAULT_CONFIG = {
  version: 1,
  entities: [],
  settings: {
    rounding_tol_p: 200,          // "Matched Rounding Diff." = absolute difference above ₹0 and up to ₹2.00 inclusive (paise)
    base_tol_bp: 50,              // amount paid in 26AS "agrees" with a Books base within 0.5 % (or the rounding tolerance, whichever is larger)
    date_close_days: 3,           // a candidate dated within 3 days of the 26AS transaction date is decisive between equal amounts …
    date_gap_days: 30,            // … or one that is at least 30 days closer than the next candidate
    near_pct: 25,                 // leftover entries of one client are paired as "Not Matched" when within 25 % and dated within near_days …
    near_days: 7,
    timing_days: 200,             // how far outside the period a credit / booking is looked for as a timing difference
    max_subset: 6,                // largest group tried when one 26AS entry covers several Books entries (or the reverse)
    section_aliases: {},          // 26AS section code → section family, e.g. the Income-tax Act, 2025 "393(1)" table items (none known yet)
  },
  // Zoho calls: paced well under Zoho's 150 a minute per user, because the dashboard's other modules share the same Zoho user.
  // ledger_rate_per_min: the account-transactions REPORT has a much lower limit of its own — on 22 Nov 2026 Zoho blocked it for an hour
  // (code 43) after ~50 calls in 38 seconds, while ordinary lists kept answering. Its calls are therefore paced separately and slowly.
  sync: { rate_per_min: 80, ledger_rate_per_min: 25, concurrency: 3, daily_budget: 20000, step_seconds: 150 },
  // Office PC only: a daily "changes" sync of the current financial year (the shared sync runs on the hour, GSTR-2B at :20)
  schedule: { enabled: true, times: ['13:40'] },
  access: {},                     // userId → { entities: [id] | null }
};

/** Section codes → the family used for comparison: 194I(a)/194I(b) → 194I, 194J(a)/(b) → 194J; others as written */
function sectionFamily(code, aliases = {}) {
  const raw = String(code || '').toUpperCase().replace(/\s+/g, '');
  if (!raw) return '';
  if (aliases[raw]) return aliases[raw];
  const m = raw.match(/^(19[2-6][A-Z]{0,3})(?:\([A-Z0-9]+\))?/);
  if (!m) return raw;
  const s = m[1];
  if (s === '194JA' || s === '194JB') return '194J';
  return s;
}
/** The section a Zoho TDS Receivable ledger is for, from its name: "TDS Receivable U/s. 194C F.Y.2025-26" → 194C, "194i" → 194I */
function ledgerSection(name) {
  const m = String(name || '').toUpperCase().match(/\b(19[2-6][A-Z]{0,2})\b/) || String(name || '').toUpperCase().match(/(19[2-6][A-Z]{0,2})/);
  return m ? sectionFamily(m[1]) : '';
}
/** "F.Y.2025-26", "F.Y 2025-2026" in a ledger name → "2025-26" (so a posting in another year's ledger can be pointed out) */
function ledgerFy(name) {
  const m = String(name || '').match(/F\.?\s*Y\.?\s*(\d{4})\s*-\s*(\d{2,4})/i);
  if (!m) return '';
  const s = +m[1];
  return `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
}

function merge(raw) {
  const c = raw || {};
  return {
    ...DEFAULT_CONFIG, ...c,
    settings: { ...DEFAULT_CONFIG.settings, ...(c.settings || {}), section_aliases: { ...((c.settings || {}).section_aliases || {}) } },
    sync: { ...DEFAULT_CONFIG.sync, ...(c.sync || {}) },
    schedule: { ...DEFAULT_CONFIG.schedule, ...(c.schedule || {}) },
    entities: c.entities || [],
    access: c.access || {},
  };
}

const slug = s => /^[a-z0-9][a-z0-9_-]{1,23}$/.test(s);
const err = message => ({ error: message });

/** Entities as sent by Settings → validated copies, or { error } */
function validateEntities(list, existing = []) {
  if (!Array.isArray(list)) return err('entities must be a list');
  const out = [], ids = new Set(), orgs = new Set(), pans = new Set();
  for (const e of list) {
    const id = String(e.id || '').trim().toLowerCase();
    if (!slug(id)) return err(`Entity id "${e.id}" must be 2–24 characters: lower-case letters, digits, "-" or "_"`);
    if (ids.has(id)) return err(`Entity id "${id}" is used twice`);
    ids.add(id);
    const name = String(e.name || '').trim();
    if (!name) return err(`Entity "${id}" needs its legal name`);
    const pan = normPan(e.pan);
    if (!PAN_RE.test(pan)) return err(`${name}: "${e.pan || ''}" is not a valid PAN (5 letters, 4 digits, 1 letter)`);
    if (pans.has(pan)) return err(`${name}: PAN ${pan} is already set up for another entity — a PAN belongs to one legal entity`);
    pans.add(pan);
    const org = String(e.org_id || '').trim();
    if (!e.demo && !/^\d{6,20}$/.test(org)) return err(`${name}: the Zoho Books organisation id must be digits only`);
    if (org && orgs.has(org)) return err(`${name}: Zoho organisation ${org} is already set up for another entity`);
    if (org) orgs.add(org);
    const prev = existing.find(x => x.id === id);
    if (prev && prev.org_id && org && prev.org_id !== org) return err(`${name}: the Zoho organisation of an existing entity cannot be changed — add a new entity instead`);
    if (prev && prev.pan && prev.pan !== pan) return err(`${name}: the PAN of an existing entity cannot be changed — its statements were checked against ${prev.pan}. Add a new entity instead`);
    const ledgers = [];
    const seen = new Set();
    for (const l of e.ledgers || []) {
      const aid = String(l.account_id || '').trim();
      if (!/^[A-Za-z0-9_-]{3,40}$/.test(aid)) return err(`${name}: ledger "${l.name || aid}" has no valid Zoho account id`);
      if (seen.has(aid)) continue;
      seen.add(aid);
      ledgers.push({ account_id: aid, name: String(l.name || '').trim().slice(0, 120), section: sectionFamily(l.section || ledgerSection(l.name)), parent: String(l.parent || '').slice(0, 120) });
    }
    if (!e.demo && e.active !== false && !ledgers.length) return err(`${name}: choose at least one TDS Receivable ledger (Settings → Entities → Find ledgers)`);
    out.push({ id, name, short: String(e.short || name).trim().slice(0, 24), pan, org_id: org, active: e.active !== false, demo: !!e.demo, ledgers,
      tan_field: String(e.tan_field ?? 'cf_organization_tan_number').trim().slice(0, 60) });
  }
  return { entities: out };
}

function validateSettings(input, current) {
  const s = { ...current, section_aliases: { ...current.section_aliases } };
  const num = (v, lo, hi, name) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be between ${lo} and ${hi}`); return Math.round(n); };
  try {
    // the ₹2 rounding tolerance is the module's definition of "Matched Rounding Diff." — allowed to be lowered, never raised beyond ₹10
    if (input.rounding_tol_p !== undefined) s.rounding_tol_p = num(input.rounding_tol_p, 0, 1000, 'Rounding tolerance (paise)');
    if (input.base_tol_bp !== undefined) s.base_tol_bp = num(input.base_tol_bp, 0, 500, 'Base tolerance (basis points)');
    if (input.date_close_days !== undefined) s.date_close_days = num(input.date_close_days, 0, 15, 'Close-date window');
    if (input.date_gap_days !== undefined) s.date_gap_days = num(input.date_gap_days, 7, 120, 'Date gap');
    if (input.near_pct !== undefined) s.near_pct = num(input.near_pct, 0, 100, 'Near-amount percentage');
    if (input.near_days !== undefined) s.near_days = num(input.near_days, 0, 60, 'Near-date window');
    if (input.timing_days !== undefined) s.timing_days = num(input.timing_days, 30, 400, 'Timing window');
    if (input.max_subset !== undefined) s.max_subset = num(input.max_subset, 2, 8, 'Largest group');
    if (input.section_aliases !== undefined) {
      const a = {};
      for (const [k, v] of Object.entries(input.section_aliases || {})) {
        const kk = String(k).toUpperCase().replace(/\s+/g, ''), vv = String(v).toUpperCase().replace(/\s+/g, '');
        if (!kk || !vv || kk.length > 40 || vv.length > 12) throw new Error(`Section alias "${k}" → "${v}" is not valid`);
        a[kk] = vv;
      }
      s.section_aliases = a;
    }
  } catch (e) { return { error: e.message }; }
  return { settings: s };
}

function validateAccess(input, entities) {
  const out = {};
  const ids = new Set(entities.map(e => e.id));
  for (const [uid, a] of Object.entries(input || {})) {
    if (!a || a.entities === null || a.entities === undefined) continue;
    const list = (a.entities || []).filter(x => ids.has(x));
    out[String(uid)] = { entities: list };
  }
  return { access: out };
}

const accessOf = (cfg, user) => (user && user.role !== 'admin' ? cfg.access[String(user.id)] || null : null);
const canSeeEntity = (acc, id) => !acc || !acc.entities || acc.entities.includes(id);

module.exports = { DEFAULT_CONFIG, merge, validateEntities, validateSettings, validateAccess, accessOf, canSeeEntity, sectionFamily, ledgerSection, ledgerFy };
