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
    section_aliases: {},          // 26AS section code → section family, overriding the built-in table (ACT2025_CODES: 1009 → 194I …)
  },
  // Zoho calls: paced well under Zoho's 150 a minute per user, because the dashboard's other modules share the same Zoho user.
  // ledger_rate_per_min: the account-transactions REPORT has a much lower limit of its own — on 22 Nov 2026 Zoho blocked it for an hour
  // (code 43) after ~50 calls in 38 seconds, while ordinary lists kept answering. Its calls are therefore paced separately and slowly.
  sync: { rate_per_min: 80, ledger_rate_per_min: 25, concurrency: 3, daily_budget: 20000, step_seconds: 150 },
  // Office PC only: a daily "changes" sync of the current financial year (the shared sync runs on the hour, GSTR-2B at :20)
  schedule: { enabled: true, times: ['13:40'] },
  access: {},                     // userId → { entities: [id] | null }
};

/**
 * Section codes of the Income-tax Act, 2025 as printed in PART-I of the Tax Year 2026-27 statement ("Section Code" 1001 …), with the
 * statement's own legend ("Section Code | Section | Description", seen on a real statement 23 Nov 2026) and the Income-tax Act, 1961
 * section each one continues — the family Zoho Books still names its TDS (Zoho's Sep 2026 invoices: 194I, 194C, 194J, 194A, 194H).
 * Codes not listed (non-resident payments 1039–1057, TCS 1068+) keep their code as the family; Settings → section aliases override.
 */
const ACT2025_CODES = {
  1001: ['192', '392', 'Salary — government employees (other than Union)'], 1002: ['192', '392', 'Salary — other employees'], 1003: ['192', '392', 'Salary — Indian government employees'],
  1004: ['192A', '392(7)', 'Accumulated balance due to an employee'],
  1005: ['194D', '393(1) Sl. 1(i)', 'Commission or brokerage — insurance'], 1006: ['194H', '393(1) Sl. 1(ii)', 'Commission or brokerage — others'],
  1007: ['194IB', '393(1) Sl. 2(i)', 'Rent paid by an individual / HUF'], 1008: ['194I', '393(1) Sl. 2(ii).D(a)', 'Rent on machinery etc.'], 1009: ['194I', '393(1) Sl. 2(ii).D(b)', 'Rent other than machinery etc.'],
  1010: ['194IA', '393(1) Sl. 3(i)', 'Transfer of immovable property'], 1011: ['194IC', '393(1) Sl. 3(ii)', 'Joint development agreement consideration'], 1012: ['194LA', '393(1) Sl. 3(iii)', 'Compensation on acquisition of immovable property'],
  1013: ['194K', '393(1) Sl. 4(i)', 'Income from mutual fund units'], 1014: ['194LBA', '393(1) Sl. 4(ii)', 'Interest from business trust units'], 1015: ['194LBA', '393(1) Sl. 4(ii)', 'Dividend from business trust units'],
  1016: ['194LBA', '393(1) Sl. 4(ii)', 'Rent from REIT units'], 1017: ['194LBB', '393(1) Sl. 4(iii)', 'Income from investment fund units'], 1018: ['194LBC', '393(1) Sl. 4(iv)', 'Income from securitisation trust'],
  1019: ['193', '393(1) Sl. 5(i)', 'Interest on securities'], 1020: ['194A', '393(1) Sl. 5(ii).D(a)', 'Interest other than on securities — senior citizen'],
  1021: ['194A', '393(1) Sl. 5(ii).D(b)', 'Interest other than on securities — others'], 1022: ['194A', '393(1) Sl. 5(iii)', 'Interest other than on securities'],
  1023: ['194C', '393(1) Sl. 6(i).D(a)', 'Contract work — individual / HUF contractor'], 1024: ['194C', '393(1) Sl. 6(i).D(b)', 'Contract work — other contractors'],
  1025: ['194M', '393(1) Sl. 6(ii)', 'Contract / professional fees paid by an individual / HUF'], 1026: ['194J', '393(1) Sl. 6(iii).D(a)', 'Fees for technical services / royalty'],
  1027: ['194J', '393(1) Sl. 6(iii).D(b)', 'Fees for professional services'], 1028: ['194J', '393(1) Sl. 6(iii).D(b)', 'Director\'s remuneration / fees'],
  1029: ['194', '393(1) Sl. 7', 'Dividends'], 1030: ['194DA', '393(1) Sl. 8(i)', 'Life insurance policy payout'], 1031: ['194Q', '393(1) Sl. 8(ii)', 'Purchase of goods'],
  1032: ['194P', '393(1) Sl. 8(iii)', 'Specified senior citizen'], 1033: ['194R', '393(1) Sl. 8(iv)', 'Business benefit or perquisite'], 1034: ['194R', '393(1) Sl. 8(iv) Note 6', 'Business benefit or perquisite in kind'],
  1035: ['194O', '393(1) Sl. 8(v)', 'E-commerce participant'], 1036: ['194S', '393(1) Sl. 8(vi)', 'Virtual digital asset — paid by individual / HUF'],
  1037: ['194S', '393(1) Sl. 8(vi)', 'Virtual digital asset'], 1038: ['194S', '393(1) Sl. 8(vi) Note 6', 'Virtual digital asset in kind'],
  1058: ['194B', '393(3) Sl. 1', 'Winnings — lottery, crossword, games'], 1059: ['194B', '393(3) Sl. 1 Note 2', 'Winnings in kind'], 1060: ['194BA', '393(3) Sl. 2', 'Winnings from online games'],
  1061: ['194BA', '393(3) Sl. 2 Note 2', 'Winnings from online games in kind'], 1062: ['194BB', '393(3) Sl. 3', 'Winnings from horse races'], 1063: ['194G', '393(3) Sl. 4', 'Commission on lottery tickets'],
  1064: ['194N', '393(3) Sl. 5.D(a)', 'Cash withdrawal — co-operative society'], 1065: ['194N', '393(3) Sl. 5.D(b)', 'Cash withdrawal — others'], 1066: ['194EE', '393(3) Sl. 6', 'National Savings Scheme payments'],
  1067: ['194T', '393(3) Sl. 7', 'Payments to partners'],
};
/** "1009" → { code, family: '194I', section: '393(1) Sl. 2(ii).D(b)', label } or null */
function act2025(code) {
  const c = String(code || '').trim();
  const x = /^10\d\d$/.test(c) ? ACT2025_CODES[c] : null;
  return x ? { code: c, family: x[0], section: x[1], label: x[2] } : null;
}

/** Section codes → the family used for comparison: 194I(a)/194I(b) → 194I, 194J(a)/(b) → 194J, Act 2025 codes 1001… → their 1961 section; others as written */
function sectionFamily(code, aliases = {}) {
  const raw = String(code || '').toUpperCase().replace(/\s+/g, '');
  if (!raw) return '';
  if (aliases[raw]) return aliases[raw];
  const a25 = act2025(raw);
  if (a25) return a25.family;
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

module.exports = { DEFAULT_CONFIG, merge, validateEntities, validateSettings, validateAccess, accessOf, canSeeEntity, sectionFamily, ledgerSection, ledgerFy, act2025, ACT2025_CODES };
