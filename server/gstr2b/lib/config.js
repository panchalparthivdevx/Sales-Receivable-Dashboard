/**
 * GSTR-2B Reco — configuration: companies, recipient GSTINs and their branches, matching settings, schedule,
 * sync limits and per-user access. Nothing is pre-filled: organisation ids, GSTINs and branch mappings are set up
 * on the onboarding screen and verified against Zoho (see index.js /onboard/*).
 */

'use strict';

const N = require('./normalize');
const { DEFAULTS: MATCH_DEFAULTS } = require('./match');

const DEFAULT_CONFIG = {
  version: 1,
  companies: [],
  settings: { ...MATCH_DEFAULTS, tol_p: { ...MATCH_DEFAULTS.tol_p }, period_basis: 'record', closing_soon_days: 60 },
  // Hours as requested (1, 3, 6, 9 PM IST) with a 20-minute offset: the dashboard's main Zoho sync runs on the hour and
  // the Neddle MSME sync at :10, so this module never competes with them for Zoho's per-minute limit.
  schedule: { enabled: true, times: ['13:20', '15:20', '18:20', '21:20'] },
  // Zoho calls: how fast, how many at once and how many a day. The numbers are set against what Zoho itself reports for the organisation
  // (response headers, checked live on 12 Nov 2026 for DevX: 90,000 calls a day shared by every integration, 150 a minute and 20 at once
  // per Zoho user) — rate_per_min leaves a third of the minute allowance to the dashboard's other modules, which use the same Zoho user.
  //   rate_per_min   calls a minute this module may make ("more" is faster — the earlier "pause between calls" was easy to set the wrong way)
  //   concurrency    calls in flight at once (the rate, not this, decides the speed; it only stops slow answers from holding the queue)
  //   daily_budget   this module's own calls per India-time day
  //   zoho_reserve   the sync also stops when Zoho says the WHOLE organisation has this few calls left today (kept for the other integrations)
  //   slice_seconds  online only: a Vercel request may run 300 s, and after the step the run still saves and reconciles (a step is capped at 180 s)
  sync: { rate_per_min: 90, concurrency: 4, daily_budget: 30000, zoho_reserve: 15000, slice_seconds: 180 },
  access: {},                      // userId → { companies: [id] | null, gstins: [gstin] | null }  (null / missing = everything the right allows)
  // Email reminders to the owners of open rows (lib/reminders.js). Off until switched on in Settings → Email reminders.
  //   time / days    when the daily email goes out, India time (days: 0 = Sunday … 6 = Saturday)
  //   soon_days      rows due within this many days are listed too (0 = only overdue and due today)
  //   undated        open rows without a due date: listed 'weekly' (on the first sending day of the week), 'daily' or 'never'
  //   on_assign      an email at once to the person rows are given to (not when they assign rows to themselves)
  //   summary_to     addresses that get one summary of everybody's overdue and due rows
  //   emails         user id → address. The dashboard's user list has no email addresses, so they are kept here
  //   app_url        the dashboard's address, for the button in the email
  reminders: { enabled: false, time: '10:00', days: [1, 2, 3, 4, 5, 6], soon_days: 2, undated: 'weekly', on_assign: true, summary_to: [], emails: {}, app_url: '' },
};

const PERIOD_BASES = { record: 'Reconciliation record (GSTR-2B period, else Books month)', books: 'Books accounting month', portal: 'GSTR-2B return period', invoice: 'Invoice date month' };

// When the online copy is called by Vercel's scheduler (vercel.json "crons" — a test keeps the two in step). Minutes past each hour, the same
// in UTC and in India time (IST is UTC + 5:30 and the four minutes are 15 apart); the night run also looks for documents deleted in Zoho.
const ONLINE_SCHEDULE = { minutes: [7, 22, 37, 52], every_min: 15, recheck_utc: '19:30', recheck_ist: '01:00' };

/** Sync limits as stored → as used. Limits saved by the first version ("pause between calls" and a budget sized for Zoho's old 10,000-a-day plan) are dropped. */
function syncLimits(stored) {
  const s = stored || {};
  if (s.rate_per_min === undefined) return { ...DEFAULT_CONFIG.sync, ...(s.slice_seconds ? { slice_seconds: s.slice_seconds } : {}) };
  const { pace_ms, ...rest } = s;                                   // eslint-disable-line no-unused-vars
  return { ...DEFAULT_CONFIG.sync, ...rest };
}

function merge(raw) {
  const c = raw || {};
  return {
    ...DEFAULT_CONFIG, ...c,
    settings: { ...DEFAULT_CONFIG.settings, ...(c.settings || {}), tol_p: { ...DEFAULT_CONFIG.settings.tol_p, ...((c.settings || {}).tol_p || {}) } },
    schedule: { ...DEFAULT_CONFIG.schedule, ...(c.schedule || {}) },
    sync: syncLimits(c.sync),
    companies: c.companies || [],
    access: c.access || {},
    reminders: { ...DEFAULT_CONFIG.reminders, ...(c.reminders || {}) },
  };
}

const slug = s => /^[a-z0-9][a-z0-9_-]{1,23}$/.test(s);
const err = message => ({ error: message });

/** Companies as sent by the onboarding screen → validated copies (or { error }) */
function validateCompanies(list, existing = []) {
  if (!Array.isArray(list)) return err('companies must be a list');
  const out = [], ids = new Set(), orgs = new Set(), gstins = new Map();
  for (const c of list) {
    const id = String(c.id || '').trim().toLowerCase();
    if (!slug(id)) return err(`Company id "${c.id}" must be 2–24 characters: lower-case letters, digits, "-" or "_"`);
    if (ids.has(id)) return err(`Company id "${id}" is used twice`);
    ids.add(id);
    const name = String(c.name || '').trim();
    if (!name) return err(`Company "${id}" needs a name`);
    const org = String(c.org_id || '').trim();
    if (!c.demo && !/^\d{6,20}$/.test(org)) return err(`${name}: the Zoho organisation id must be digits only`);
    if (org && orgs.has(org)) return err(`${name}: Zoho organisation ${org} is already set up for another company`);
    if (org) orgs.add(org);
    const prev = existing.find(x => x.id === id);
    if (prev && prev.org_id && org && prev.org_id !== org) return err(`${name}: the Zoho organisation of an existing company cannot be changed — add a new company instead`);
    const regs = [];
    for (const r of c.registrations || []) {
      const g = N.normGstin(r.gstin);
      const info = N.gstinInfo(g);
      if (!info.format_ok) return err(`${name}: "${r.gstin}" is not a valid GSTIN format`);
      if (!info.checksum_ok && !c.demo) return err(`${name}: GSTIN ${g} fails the GSTIN check digit — it contains a typing error`);
      if (gstins.has(g)) return err(`GSTIN ${g} is set up under both "${gstins.get(g)}" and "${name}" — a GSTIN belongs to one company`);
      gstins.set(g, name);
      const g9 = {};
      for (const [fy, d] of Object.entries(r.gstr9_filed || {})) { if (d) { const iso = N.parseDate(d); if (!iso || !/^\d{4}-\d{2}$/.test(fy)) return err(`${name}: GSTR-9 date for ${g} / ${fy} is not valid`); g9[fy] = iso; } }
      regs.push({
        gstin: g, label: String(r.label || '').trim().slice(0, 80), branch_ids: [...new Set((r.branch_ids || []).map(String))],
        active: r.active !== false, gstr9_filed: g9, verified: r.verified || null,
      });
    }
    out.push({
      id, name, short: String(c.short || name).slice(0, 24), org_id: org, active: c.active !== false, demo: !!c.demo,
      invoice_date_field: String(c.invoice_date_field ?? 'cf_vendor_bill_date').trim(),
      credit_date_field: String(c.credit_date_field ?? '').trim(),
      credit_number_field: c.credit_number_field === 'reference_number' ? 'reference_number' : 'vendor_credit_number',
      registrations: regs,
    });
  }
  return { companies: out };
}

/** Settings: tolerances (paise) and matching limits — bounded so a typo cannot disable matching safeguards */
function validateSettings(input, current) {
  const s = { ...current, tol_p: { ...current.tol_p } };
  const num = (v, lo, hi, name) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be between ${lo} and ${hi}`); return n; };
  try {
    if (input.tol_p) for (const k of Object.keys(current.tol_p)) if (input.tol_p[k] !== undefined) s.tol_p[k] = Math.round(num(input.tol_p[k], 0, 10000, `Tolerance for ${k} (paise)`));
    if (input.date_window_days !== undefined) s.date_window_days = Math.round(num(input.date_window_days, 0, 31, 'Date window'));
    if (input.fuzzy_edit_distance !== undefined) s.fuzzy_edit_distance = Math.round(num(input.fuzzy_edit_distance, 0, 3, 'Number difference'));
    if (input.group_enabled !== undefined) s.group_enabled = !!input.group_enabled;
    if (input.group_max !== undefined) s.group_max = Math.round(num(input.group_max, 2, 6, 'Group size'));
    if (input.group_date_window_days !== undefined) s.group_date_window_days = Math.round(num(input.group_date_window_days, 0, 31, 'Group date window'));
    if (input.normal_gap_months !== undefined) s.normal_gap_months = Math.round(num(input.normal_gap_months, 0, 3, 'Normal reporting gap'));
    if (input.closing_soon_days !== undefined) s.closing_soon_days = Math.round(num(input.closing_soon_days, 1, 180, 'Closing-soon days'));
    if (input.period_basis !== undefined) { if (!PERIOD_BASES[input.period_basis]) throw new Error('Unknown period basis'); s.period_basis = input.period_basis; }
  } catch (e) { return err(e.message); }
  return { settings: s };
}

function validateSchedule(input, current) {
  const s = { ...current };
  if (input.enabled !== undefined) s.enabled = !!input.enabled;
  if (input.times !== undefined) {
    if (!Array.isArray(input.times) || input.times.length > 12) return err('Give up to 12 times, like 13:20');
    const t = [];
    for (const x of input.times) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(x))) return err(`"${x}" is not a time (use 24-hour HH:MM, India time)`); t.push(String(x)); }
    s.times = [...new Set(t)].sort();
  }
  return { schedule: s };
}

function validateSyncLimits(input, current) {
  const s = { ...current };
  const num = (v, lo, hi, name) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name} must be between ${lo} and ${hi}`); return n; };
  try {
    // Upper limits follow what Zoho allows one user (150 calls a minute, 20 at once, 90,000 a day for the whole organisation on DevX's plan);
    // a smaller plan simply answers "slow down" and the sync waits, so a high number here can never get the organisation blocked.
    if (input.rate_per_min !== undefined) s.rate_per_min = num(input.rate_per_min, 10, 120, 'Zoho calls per minute');
    if (input.concurrency !== undefined) s.concurrency = num(input.concurrency, 1, 6, 'Calls at the same time');
    if (input.daily_budget !== undefined) s.daily_budget = num(input.daily_budget, 100, 80000, 'Zoho calls per day for this module');
    if (input.zoho_reserve !== undefined) s.zoho_reserve = num(input.zoho_reserve, 0, 60000, 'Calls kept free for the other integrations');
    if (input.slice_seconds !== undefined) s.slice_seconds = num(input.slice_seconds, 30, 250, 'Seconds per sync step');
  } catch (e) { return err(e.message); }
  return { sync: syncLimits({ ...s, rate_per_min: s.rate_per_min ?? DEFAULT_CONFIG.sync.rate_per_min }) };
}

const EMAIL = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"'.]{2,}$/;
const isEmail = s => typeof s === 'string' && s.length <= 254 && EMAIL.test(s);

/** Email reminders: when they go out, what they list and where to (addresses are per user id — only for users that exist) */
function validateReminders(input, current, users = []) {
  const s = { ...current, emails: { ...(current.emails || {}) } };
  try {
    if (input.enabled !== undefined) s.enabled = !!input.enabled;
    if (input.on_assign !== undefined) s.on_assign = !!input.on_assign;
    if (input.time !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.time))) throw new Error(`"${input.time}" is not a time (use 24-hour HH:MM, India time)`); s.time = String(input.time); }
    if (input.days !== undefined) {
      const d = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number))].filter(n => Number.isInteger(n) && n >= 0 && n <= 6).sort();
      if (!d.length) throw new Error('Choose at least one day of the week for the reminders');
      s.days = d;
    }
    if (input.soon_days !== undefined) { const n = Math.round(Number(input.soon_days)); if (!Number.isFinite(n) || n < 0 || n > 14) throw new Error('"Days before the due date" must be between 0 and 14'); s.soon_days = n; }
    if (input.undated !== undefined) { if (!['never', 'weekly', 'daily'].includes(input.undated)) throw new Error('Rows without a due date: choose never, weekly or daily'); s.undated = input.undated; }
    if (input.summary_to !== undefined) {
      const list = [...new Set((Array.isArray(input.summary_to) ? input.summary_to : String(input.summary_to || '').split(/[,;\s]+/)).map(x => String(x).trim().toLowerCase()).filter(Boolean))];
      if (list.length > 10) throw new Error('The summary can go to at most 10 addresses');
      for (const e of list) if (!isEmail(e)) throw new Error(`"${e}" is not an email address`);
      s.summary_to = list;
    }
    if (input.emails !== undefined) {
      for (const [uid, raw] of Object.entries(input.emails || {})) {
        const e = String(raw || '').trim().toLowerCase();
        if (!e) { delete s.emails[uid]; continue; }
        const u = users.find(x => String(x.id) === String(uid));
        if (!u) throw new Error(`Unknown user ${uid}`);
        if (!isEmail(e)) throw new Error(`"${e}" is not an email address (${u.name || u.username})`);
        s.emails[uid] = e;
      }
    }
    if (input.app_url !== undefined) {
      const u = String(input.app_url || '').trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(u)) throw new Error('The dashboard address must start with https:// (or http://)');
      s.app_url = u;
    }
  } catch (e) { return err(e.message); }
  return { reminders: s };
}

/** Which companies / GSTINs a user may see: null = unrestricted. */
function accessOf(cfg, user) {
  if (!user || user.role === 'admin') return { companies: null, gstins: null };
  const a = (cfg.access || {})[user.id] || {};
  return { companies: Array.isArray(a.companies) ? a.companies : null, gstins: Array.isArray(a.gstins) ? a.gstins.map(N.normGstin) : null };
}
const canSeeCompany = (acc, id) => !acc.companies || acc.companies.includes(id);
function canSeeGstin(acc, company, gstin) {
  if (!canSeeCompany(acc, company.id)) return false;
  return !acc.gstins || acc.gstins.includes(gstin);
}
function visibleRegistrations(cfg, acc) {
  const out = [];
  for (const co of cfg.companies) for (const r of co.registrations) if (canSeeGstin(acc, co, r.gstin)) out.push({ company: co, reg: r });
  return out;
}

function validateAccess(input, users) {
  const out = {};
  for (const [uid, a] of Object.entries(input || {})) {
    if (!users.some(u => u.id === uid)) return err(`Unknown user ${uid}`);
    out[uid] = { companies: Array.isArray(a.companies) && a.companies.length ? a.companies.map(String) : null, gstins: Array.isArray(a.gstins) && a.gstins.length ? a.gstins.map(N.normGstin) : null };
  }
  return { access: out };
}

module.exports = { DEFAULT_CONFIG, PERIOD_BASES, ONLINE_SCHEDULE, syncLimits, merge, validateCompanies, validateSettings, validateSchedule, validateSyncLimits, validateReminders, isEmail, validateAccess, accessOf, canSeeCompany, canSeeGstin, visibleRegistrations };
