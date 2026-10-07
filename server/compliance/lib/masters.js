/**
 * Master data: Company Master, Compliance Master, Company Applicability.
 *
 * Every create/update — from the Master screens AND from Excel import — goes through the
 * functions below, so both paths validate identically.
 *
 * Input convention (see fields.js): undefined = unchanged, '' = empty the value.
 * Functions mutate `state` only when the result is ok. Each returns
 *   { ok, errors: [{ field, error, fix }], action: 'create'|'update'|'nochange', record, changes, effects }
 */

'use strict';

const P  = require('./period');
const R  = require('./dueDateRules');
const F  = require('./fields');
const A  = require('./audit');
const SE = require('./statusEngine');

// ── Lookups ───────────────────────────────────────────────────────────────────

function resolveCompany(state, ref) {
  const s = String(ref ?? '').trim().toLowerCase();
  if (!s) return null;
  return state.companies.find(c => c.id.toLowerCase() === s)
    || state.companies.find(c => c.short_code.toLowerCase() === s)
    || state.companies.find(c => c.name.toLowerCase() === s)
    || null;
}

function resolveCompliance(state, ref) {
  const s = String(ref ?? '').trim().toLowerCase();
  return s ? state.compliances.find(c => c.id.toLowerCase() === s) || null : null;
}

function moduleKeys(settings) { return settings.modules.map(m => m.key); }
function normModule(settings, v) {
  const s = String(v ?? '').trim().toLowerCase();
  return moduleKeys(settings).find(k => k.toLowerCase() === s) || null;
}

function nextCompanyId(state) {
  const n = state.companies.map(c => Number((c.id.match(/^CO-(\d+)$/) || [])[1] || 0));
  return `CO-${String(Math.max(0, ...n) + 1).padStart(3, '0')}`;
}

const isOpen = t => SE.normUserStatus(t.status) !== 'Completed';

// ── Company Master ────────────────────────────────────────────────────────────

const COMPANY_FIELDS = ['name', 'short_code', 'status', 'zoho_org_id', 'remarks'];

/**
 * Create or update a company. Existing company found by input.id, else by short_code.
 * opts.mode: 'upsert' (import) | 'create' | 'update'
 */
function saveCompany(state, input, { user, now, mode = 'upsert' }) {
  const errors = [];
  const err = (field, error, fix) => errors.push({ field, error, fix });

  const shortIn = F.text(input.short_code);
  let existing = input.id ? state.companies.find(c => c.id === input.id) : null;
  if (input.id && !existing) return { ok: false, errors: [{ field: 'id', error: `Company ${input.id} not found.`, fix: 'Refresh the page.' }] };
  if (!existing && shortIn && mode !== 'create') existing = state.companies.find(c => c.short_code.toLowerCase() === shortIn.toLowerCase()) || null;
  if (mode === 'create' && existing) return { ok: false, errors: [{ field: 'short_code', error: `Short Code ${existing.short_code} already exists.`, fix: 'Use a different Short Code or edit the existing company.' }] };
  if (mode === 'update' && !existing) return { ok: false, errors: [{ field: 'short_code', error: 'Company not found.', fix: 'Check the Short Code.' }] };

  const next = existing ? { ...existing } : { id: null, name: '', short_code: '', status: 'Active', zoho_org_id: '', remarks: '' };

  const name = F.text(input.name);
  if (name !== undefined) next.name = name;
  if (!next.name) err('name', 'Company Name is required.', 'Enter the legal name.');

  if (shortIn !== undefined) next.short_code = shortIn.toUpperCase();
  if (!next.short_code) err('short_code', 'Short Code is required.', 'Use 2–10 capital letters/digits, e.g. DEVX.');
  else if (!/^[A-Z0-9]{2,10}$/.test(next.short_code)) err('short_code', `Short Code "${next.short_code}" is not valid.`, 'Use 2–10 capital letters/digits, no spaces.');
  else if (state.companies.some(c => c !== existing && c.short_code === next.short_code)) err('short_code', `Short Code ${next.short_code} is used by another company.`, 'Pick a unique Short Code.');
  if (next.name && state.companies.some(c => c !== existing && c.name.toLowerCase() === next.name.toLowerCase())) err('name', `Company "${next.name}" already exists.`, 'Use the existing company.');

  const status = F.text(input.status);
  if (status !== undefined) {
    const st = ['active', 'inactive'].includes(status.toLowerCase()) ? status[0].toUpperCase() + status.slice(1).toLowerCase() : null;
    if (status === '') next.status = 'Active';
    else if (!st) err('status', `Status "${status}" is not valid.`, 'Use Active or Inactive.');
    else next.status = st;
  }

  const org = F.text(input.zoho_org_id);
  if (org !== undefined) {
    if (org && !/^\d{5,20}$/.test(org)) err('zoho_org_id', `Zoho Org ID "${org}" is not valid.`, 'Digits only, from Zoho Books > Settings > Organisation Profile.');
    else next.zoho_org_id = org;
  }
  const remarks = F.text(input.remarks);
  if (remarks !== undefined) next.remarks = remarks;

  if (errors.length) return { ok: false, errors };

  const changes = A.diff(existing, next, COMPANY_FIELDS);
  if (existing && !changes.length) return { ok: true, errors: [], action: 'nochange', record: existing, changes };
  if (!existing) {
    next.id = nextCompanyId(state);
    next.created_at = now; next.created_by = user?.name || user?.username || '';
    state.companies.push(next);
  } else {
    Object.assign(existing, next);
  }
  const rec = existing || next;
  rec.updated_at = now; rec.updated_by = user?.name || user?.username || '';
  const effects = [];
  if (existing && changes.some(c => c.field === 'short_code') && state.tasks.some(t => t.company_id === rec.id)) {
    effects.push('Existing Task IDs keep the old Short Code; new tasks use the new one.');
  }
  return { ok: true, errors: [], action: existing ? 'update' : 'create', record: rec, changes, effects };
}

function deleteCompany(state, id) {
  const co = state.companies.find(c => c.id === id);
  if (!co) return { ok: false, error: 'Company not found.' };
  if (state.tasks.some(t => t.company_id === id)) return { ok: false, error: 'This company has tasks. Set its Status to Inactive instead of deleting.' };
  state.companies = state.companies.filter(c => c.id !== id);
  state.applicability = state.applicability.filter(a => a.company_id !== id);
  return { ok: true, record: co };
}

// ── Compliance Master ─────────────────────────────────────────────────────────

const COMPLIANCE_FIELDS = ['id', 'name', 'module', 'frequency', 'due_rule', 'form_name', 'active_months', 'statutory', 'remarks', 'active'];

function saveCompliance(state, input, { user, now, settings, today, mode = 'upsert' }) {
  const errors = [];
  const err = (field, error, fix) => errors.push({ field, error, fix });

  const idIn = F.text(input.id);
  const existing = idIn ? state.compliances.find(c => c.id.toLowerCase() === idIn.toLowerCase()) || null : null;
  if (!idIn) return { ok: false, errors: [{ field: 'id', error: 'Compliance ID is required.', fix: 'e.g. GST002' }] };
  if (mode === 'create' && existing) return { ok: false, errors: [{ field: 'id', error: `Compliance ID ${existing.id} already exists.`, fix: 'Use a new ID or edit the existing one.' }] };
  if (mode === 'update' && !existing) return { ok: false, errors: [{ field: 'id', error: `Compliance ${idIn} not found.`, fix: 'Check the ID.' }] };

  const next = existing ? { ...existing } : { id: idIn.toUpperCase(), name: '', module: '', frequency: '', due_rule: '', form_name: '', active_months: '', statutory: false, remarks: '', active: true };
  if (!existing && !/^[A-Z0-9]{2,12}$/.test(next.id)) err('id', `Compliance ID "${idIn}" is not valid.`, 'Use 2–12 capital letters/digits, e.g. GST002.');
  const hasTasks = existing ? state.tasks.some(t => t.compliance_id === existing.id) : false;

  const name = F.text(input.name);
  if (name !== undefined) next.name = name;
  if (!next.name) err('name', 'Compliance Name is required.', 'e.g. GSTR-3B');

  if (input.module !== undefined) {
    const mod = normModule(settings, input.module);
    if (!mod) err('module', `Module "${input.module}" is not in the module list.`, `Use one of: ${moduleKeys(settings).join(', ')} (or add it in Lists / Settings).`);
    else next.module = mod;
  }
  if (!next.module) err('module', 'Module is required.', `Use one of: ${moduleKeys(settings).join(', ')}.`);
  else if (existing && hasTasks && next.module !== existing.module) err('module', 'Module cannot change once tasks exist.', 'Create a new Compliance ID instead.');

  if (input.frequency !== undefined) {
    const f = P.normFrequency(input.frequency);
    if (!f) err('frequency', `Frequency "${input.frequency}" is not valid.`, 'Use Monthly, Quarterly, Half-Yearly or Annual.');
    else next.frequency = f;
  }
  if (!next.frequency) err('frequency', 'Frequency is required.', 'Monthly, Quarterly, Half-Yearly or Annual.');
  else if (existing && hasTasks && next.frequency !== existing.frequency) err('frequency', 'Frequency cannot change once tasks exist.', 'Create a new Compliance ID instead.');

  const rule = F.text(input.due_rule);
  if (rule !== undefined) next.due_rule = rule;
  if (!next.due_rule) err('due_rule', 'Due Date Rule is required.', 'e.g. 11th of following month');
  else if (next.frequency) {
    const v = R.validateRule(next.due_rule, next.frequency);
    if (!v.ok) err('due_rule', v.error, 'See Instructions > Due Date Rule syntax.');
  }

  const form = F.text(input.form_name);
  if (form !== undefined) next.form_name = form;

  if (input.active_months !== undefined) {
    const ml = F.parseMonthList(input.active_months);
    if (ml === null) err('active_months', `Applicable Months "${input.active_months}" is not a list of months.`, 'e.g. JUN,DEC — or leave blank for every month.');
    else next.active_months = ml;
  }
  if (next.active_months && next.frequency && next.frequency !== 'Monthly') err('active_months', 'Applicable Months can only be used with Monthly compliances.', 'Clear it, or change Frequency to Monthly.');

  if (input.statutory !== undefined) {
    const y = F.yesNo(input.statutory);
    if (y === null) err('statutory', `Statutory Date "${input.statutory}" must be Yes or No.`, 'Yes or No');
    else next.statutory = y === 'Yes';
  }
  const remarks = F.text(input.remarks);
  if (remarks !== undefined) next.remarks = remarks;
  if (input.active !== undefined) {
    const y = F.yesNo(input.active);
    if (y === null) err('active', `Active "${input.active}" must be Yes or No.`, 'Yes or No');
    else next.active = y !== 'No';
  }

  if (errors.length) return { ok: false, errors };

  const changes = A.diff(existing, next, COMPLIANCE_FIELDS);
  if (existing && !changes.length) return { ok: true, errors: [], action: 'nochange', record: existing, changes };
  const by = user?.name || user?.username || '';
  if (!existing) { next.created_at = now; next.created_by = by; state.compliances.push(next); }
  else Object.assign(existing, next);
  const rec = existing || next;
  rec.updated_at = now; rec.updated_by = by;

  // A changed rule re-dates open tasks whose due date came from the rule (manual dates are kept)
  const effects = [];
  if (existing && changes.some(c => c.field === 'due_rule')) {
    let n = 0;
    for (const t of state.tasks) {
      if (t.compliance_id !== rec.id || !isOpen(t) || t.due_date_source === 'manual') continue;
      const d = R.dueDateFor(rec.due_rule, t.fy, t.period_key);
      if (d.ok && d.date !== t.due_date) { t.due_date = d.date; t.updated_at = now; t.updated_by = by; n++; }
    }
    if (n) effects.push(`${n} open task(s) re-dated from the new rule.`);
  }
  return { ok: true, errors: [], action: existing ? 'update' : 'create', record: rec, changes, effects };
}

function deleteCompliance(state, id) {
  const cm = state.compliances.find(c => c.id === id);
  if (!cm) return { ok: false, error: 'Compliance not found.' };
  if (state.tasks.some(t => t.compliance_id === id)) return { ok: false, error: 'This compliance has tasks. Set Active = No instead of deleting.' };
  state.compliances = state.compliances.filter(c => c.id !== id);
  state.applicability = state.applicability.filter(a => a.compliance_id !== id);
  return { ok: true, record: cm };
}

// ── Company Applicability ─────────────────────────────────────────────────────

const APPLICABILITY_FIELDS = ['applicable', 'responsible', 'reviewer', 'remarks'];

function findApplicability(state, companyId, complianceId) {
  return state.applicability.find(a => a.company_id === companyId && a.compliance_id === complianceId) || null;
}

/** Applicability (with defaults) for a company × compliance */
function applicabilityOf(state, companyId, complianceId, settings) {
  const a = findApplicability(state, companyId, complianceId);
  return {
    applicable: a ? a.applicable : (settings.applicability_default || 'Yes'),
    responsible: a?.responsible || '',
    reviewer: a?.reviewer || '',
    explicit: !!a,
  };
}

/**
 * Create/update one applicability row and push the change to OPEN tasks:
 *   Applicable No  → open tasks become N/A (na_source = 'applicability')
 *   Applicable Yes → tasks made N/A by applicability become applicable again
 *   Responsible / Reviewer → copied to open tasks that still had the old value (or none);
 *                            a person typed directly on a task is kept.
 */
function saveApplicability(state, input, { user, now, settings }) {
  const errors = [];
  const err = (field, error, fix) => errors.push({ field, error, fix });
  const co = resolveCompany(state, input.company ?? input.company_id);
  const cm = resolveCompliance(state, input.compliance_id);
  if (!co) err('company', `Company "${input.company ?? input.company_id ?? ''}" not found.`, 'Use a Short Code from the Company Master.');
  if (!cm) err('compliance_id', `Compliance "${input.compliance_id ?? ''}" not found.`, 'Use an ID from the Compliance Master.');
  if (errors.length) return { ok: false, errors };

  const existing = findApplicability(state, co.id, cm.id);
  const next = existing ? { ...existing } : { company_id: co.id, compliance_id: cm.id, applicable: settings.applicability_default || 'Yes', responsible: '', reviewer: '', remarks: '' };

  if (input.applicable !== undefined) {
    const y = F.yesNo(input.applicable);
    if (y === null) err('applicable', `Applicable "${input.applicable}" must be Yes or No.`, 'Yes or No');
    else if (y !== '') next.applicable = y;
  }
  for (const f of ['responsible', 'reviewer', 'remarks']) {
    const v = F.text(input[f]);
    if (v !== undefined) next[f] = v;
  }
  if (errors.length) return { ok: false, errors };

  const changes = A.diff(existing || { applicable: '', responsible: '', reviewer: '', remarks: '' }, next, APPLICABILITY_FIELDS);
  if (existing && !changes.length) return { ok: true, errors: [], action: 'nochange', record: existing, changes };
  const by = user?.name || user?.username || '';
  const prev = existing ? { ...existing } : applicabilityOf(state, co.id, cm.id, settings);
  if (!existing) { next.created_at = now; next.created_by = by; state.applicability.push(next); }
  else Object.assign(existing, next);
  const rec = existing || next;
  rec.updated_at = now; rec.updated_by = by;

  // Push to open tasks
  let naChanged = 0, peopleChanged = 0;
  for (const t of state.tasks) {
    if (t.company_id !== co.id || t.compliance_id !== cm.id || !isOpen(t)) continue;
    let touched = false;
    if (rec.applicable === 'No' && t.applicable !== false) { t.applicable = false; t.na_source = 'applicability'; naChanged++; touched = true; }
    if (rec.applicable === 'Yes' && t.applicable === false && t.na_source === 'applicability') { t.applicable = true; t.na_source = null; naChanged++; touched = true; }
    for (const f of ['responsible', 'reviewer']) {
      if (rec[f] !== prev[f] && (!t[f] || t[f] === prev[f])) { t[f] = rec[f]; peopleChanged++; touched = true; }
    }
    if (touched) { t.updated_at = now; t.updated_by = by; }
  }
  const effects = [];
  if (naChanged) effects.push(`${naChanged} open task(s) ${rec.applicable === 'No' ? 'marked N/A' : 'made applicable again'}.`);
  if (peopleChanged) effects.push(`Responsible/Reviewer updated on ${peopleChanged} open task field(s).`);
  return { ok: true, errors: [], action: existing ? 'update' : 'create', record: rec, changes, effects, company: co, compliance: cm };
}

module.exports = {
  resolveCompany, resolveCompliance, normModule, moduleKeys,
  saveCompany, deleteCompany, saveCompliance, deleteCompliance,
  saveApplicability, applicabilityOf, findApplicability,
  COMPANY_FIELDS, COMPLIANCE_FIELDS, APPLICABILITY_FIELDS,
};
