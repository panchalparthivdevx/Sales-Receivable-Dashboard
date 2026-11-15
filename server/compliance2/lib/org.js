/**
 * Organisation masters: group → legal entity → registrations → establishments (branches), and people (directors /
 * signatories, whose obligations are per person, not per company).
 *
 * Identity: every record has an immutable id (E-…, R-…, B-…, P-…). Names are labels — a rename keeps the id and is
 * kept in name_history.
 *
 * Data status: 'illustrative' (demo only), 'draft' (entered or imported, not yet approved), 'approved'. Live tasks are
 * only generated for approved entities and approved registrations.
 *
 * Portal passwords never belong here: any field that looks like a password / OTP / secret is refused.
 */

'use strict';

const U = require('./util');
const V = require('./validate');
const CAT = require('./catalogue');

const EMPTY = () => ({ groups: [{ id: 'G-1', name: 'Group' }], entities: [], registrations: [], establishments: [], people: [] });
const FREQ = ['monthly', 'quarterly', 'half_yearly', 'annual'];
const REGIMES = ['regular', 'qrmp', 'composition', 'other'];

const SECRET_WORDS = new Set(['password', 'passwd', 'pwd', 'pass', 'passcode', 'otp', 'secret', 'credential', 'credentials']);

/** Refuses any key that looks like a credential, anywhere in the input */
function refuseSecrets(obj, path = '') {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    // whole words of the key only ("secretarial_audit_required" is fine, "portal_password" is not)
    const words = String(k).toLowerCase().split(/[^a-z0-9]+|(?<=[a-z])(?=[0-9])/);
    if (words.some(w => SECRET_WORDS.has(w))) throw U.httpError(400, `"${path}${k}" looks like a password or secret. Portal passwords must never be stored in this module.`);
    if (v && typeof v === 'object') refuseSecrets(v, `${path}${k}.`);
  }
}

const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const optDate = (v, label, errors) => { const s = str(v, 10); if (s && !U.isDate(s)) errors.push(`${label} must be a date (YYYY-MM-DD)`); return s || null; };
const bool3 = v => (v === true || v === 'true' || v === 'Yes' || v === 'yes' ? true : v === false || v === 'false' || v === 'No' || v === 'no' ? false : null);
const num = v => (v === '' || v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);

const ENTITY_FLAGS = ['has_employees', 'has_exports', 'has_fdi', 'has_odi', 'has_ecb', 'has_international_transactions', 'has_specified_domestic_transactions',
  'has_reportable_sft', 'has_msme_dues_over_45_days', 'has_deposit_or_loan_receipts', 'cost_audit_sector', 'secretarial_audit_required', 'consolidated_financials',
  'has_secured_listed_ncds', 'high_value_debt_listed'];
// what is listed on a stock exchange (only when listed = true): shares, debt securities (NCDs), or both
const LISTING_TYPES = ['equity', 'debt', 'equity_and_debt'];
const REG_FLAGS = ['uses_iff', 'deducts_salary', 'deducts_non_salary', 'deducts_non_resident', 'collects_tcs'];
const EST_FLAGS = ['engages_contract_labour', 'pays_property_tax'];
const FY_FACTS = ['turnover', 'net_worth', 'net_profit', 'paid_up_capital', 'borrowings', 'headcount'];

function cleanFlags(src, keys) {
  const out = {};
  for (const k of keys) { const b = bool3(src?.[k]); if (b !== null) out[k] = b; }
  return out;
}

/** Validates and normalises an entity. Returns { value, errors, warnings } */
function cleanEntity(input, org, existing) {
  refuseSecrets(input);
  const errors = [], warnings = [];
  const e = {
    legal_name: str(input.legal_name, 200), short_code: str(input.short_code, 12).toUpperCase().replace(/[^A-Z0-9]/g, ''),
    type: str(input.type, 20), cin: '', llpin: '', pan: '', incorporation_date: optDate(input.incorporation_date, 'Incorporation date', errors),
    listed: bool3(input.listed), listing_type: LISTING_TYPES.includes(input.listing_type) ? input.listing_type : null, exchanges: (Array.isArray(input.exchanges) ? input.exchanges : String(input.exchanges || '').split(',')).map(x => str(x, 20)).filter(Boolean),
    fy: 'April–March', zoho_org_id: str(input.zoho_org_id, 30), group_id: str(input.group_id, 20) || 'G-1',
    status: input.status === 'inactive' ? 'inactive' : 'active', flags: cleanFlags(input.flags, ENTITY_FLAGS), notes: str(input.notes, 2000),
  };
  if (!e.legal_name) errors.push('Legal name is required');
  if (!e.short_code) errors.push('Short code is required (used in file names, e.g. DEVX)');
  if (!CAT.ENTITY_TYPES[e.type]) errors.push(`Entity type must be one of: ${Object.keys(CAT.ENTITY_TYPES).join(', ')}`);
  const kind = CAT.entityKind(e.type);
  // a draft may be saved without its PAN (e.g. carried over from Compliance v1); approval needs it
  if (input.pan) { const r = V.pan(input.pan, kind); e.pan = r.value; errors.push(...r.errors); warnings.push(...r.warnings); } else warnings.push('PAN not recorded — needed before approval');
  if (kind === 'company') {
    if (input.cin) { const r = V.cin(input.cin, { listed: e.listed, listingType: e.listing_type }); e.cin = r.value; errors.push(...r.errors); warnings.push(...r.warnings); } else warnings.push('CIN not recorded');
    if (e.listed === null) warnings.push('Listed status not recorded — SEBI obligations will show "needs review"');
    if (e.listed === true && !e.listing_type) warnings.push('Listed, but whether shares, debt securities (NCDs) or both are listed is not recorded — SEBI obligations will show "needs review"');
    if (e.listed === true && e.listing_type !== 'debt' && e.type === 'PRIVATE') warnings.push('A private company cannot have listed shares — check the listing type');
  }
  if (kind === 'llp') {
    if (input.llpin) { const r = V.llpin(input.llpin); e.llpin = r.value; errors.push(...r.errors); } else warnings.push('LLPIN not recorded');
    if (e.listed === true) errors.push('An LLP cannot be marked listed');
    e.listed = false;
  }
  if (e.listed !== true) e.listing_type = null;
  if (e.listed === true && !e.exchanges.length) warnings.push('Listed, but no stock exchange recorded');
  // FY facts (threshold history): { '2025-26': { turnover, … , source } }
  e.fy_facts = {};
  for (const [fy, f] of Object.entries(input.fy_facts || {})) {
    if (!U.validFy(fy)) { errors.push(`"${fy}" is not a financial year`); continue; }
    const row = {};
    for (const k of FY_FACTS) { const n = num(f?.[k]); if (Number.isNaN(n)) errors.push(`${fy} ${k} must be a number`); else if (n !== null) row[k] = n; }
    const ta = bool3(f?.tax_audit_required); if (ta !== null) row.tax_audit_required = ta;
    row.source = str(f?.source, 300);
    if (Object.keys(row).length > 1) e.fy_facts[fy] = row;
  }
  // duplicates
  const others = org.entities.filter(x => x.id !== existing?.id);
  if (e.pan && others.some(x => x.pan === e.pan)) errors.push(`Another entity already has PAN ${e.pan}`);
  if (e.cin && others.some(x => x.cin === e.cin)) errors.push(`Another entity already has CIN ${e.cin}`);
  if (e.short_code && others.some(x => x.short_code === e.short_code)) errors.push(`Short code ${e.short_code} is already used`);
  if (e.legal_name && others.some(x => x.legal_name.toLowerCase() === e.legal_name.toLowerCase())) warnings.push(`Another entity is already called "${e.legal_name}"`);
  return { value: e, errors, warnings };
}

function cleanRegistration(input, org, existing) {
  refuseSecrets(input);
  const errors = [], warnings = [];
  const ent = org.entities.find(x => x.id === input.entity_id);
  const r = {
    entity_id: str(input.entity_id, 30), type: str(input.type, 30), number: '', state: '', active_from: optDate(input.active_from, 'Active from', errors),
    active_to: optDate(input.active_to, 'Active to / expiry', errors), filing_frequency: str(input.filing_frequency, 20) || null, regime: str(input.regime, 20) || null,
    jurisdiction: str(input.jurisdiction, 200), authority: str(input.authority, 200), establishment_ids: Array.isArray(input.establishment_ids) ? input.establishment_ids.map(x => str(x, 30)) : [],
    portal_url: str(input.portal_url, 300), flags: cleanFlags(input.flags, REG_FLAGS), status: input.status === 'inactive' ? 'inactive' : 'active', notes: str(input.notes, 2000),
  };
  if (!ent) errors.push('Choose the legal entity this registration belongs to');
  if (!CAT.REG_TYPES[r.type]) errors.push(`Registration type must be one of: ${Object.keys(CAT.REG_TYPES).join(', ')}`);
  const st = input.state ? V.stateOf(input.state) : null;
  if (input.state && !st) errors.push(`State "${input.state}" is not a known state / UT code`);
  r.state = st ? st.abbr : '';
  const raw = str(input.number, 40);
  if (!raw) errors.push('Registration number is required (record it as pending if not yet known — do not invent one)');
  else if (r.type.startsWith('GST_')) {
    const tans = org.registrations.filter(x => x.entity_id === r.entity_id && x.type === 'TAN').map(x => x.number);
    const v = V.gstin(raw, { kind: r.type, entityPan: ent?.pan, entityTan: tans, state: r.state || undefined });
    r.number = v.value; errors.push(...v.errors); warnings.push(...v.warnings);
    if (!r.state && v.state) r.state = v.state;
  } else if (r.type === 'TAN') { const v = V.tan(raw); r.number = v.value; errors.push(...v.errors); }
  else if (r.type === 'PF') { const v = V.pfCode(raw); r.number = v.value; errors.push(...v.errors); warnings.push(...v.warnings); }
  else if (r.type === 'ESIC') { const v = V.esicCode(raw); r.number = v.value; errors.push(...v.errors); warnings.push(...v.warnings); }
  else r.number = V.norm(raw);
  if (['PT_PTRC', 'PT_PTEC', 'LWF', 'SHOPS_EST'].includes(r.type) && !r.state) errors.push('A state is required for state registrations');
  if (r.type.startsWith('GST_') && !r.state) errors.push('A GST registration needs its state');
  if (r.filing_frequency && !FREQ.includes(r.filing_frequency)) errors.push(`Filing frequency must be one of: ${FREQ.join(', ')}`);
  if (r.regime && !REGIMES.includes(r.regime)) errors.push(`Regime must be one of: ${REGIMES.join(', ')}`);
  if (r.type === 'GST_REGULAR') {
    if (!r.filing_frequency) warnings.push('Filing frequency (monthly / quarterly QRMP) not recorded — GST return applicability will show "needs review"');
    if (r.regime === 'qrmp' && r.filing_frequency && r.filing_frequency !== 'quarterly') errors.push('A QRMP registration files quarterly');
    if (r.filing_frequency === 'quarterly' && !r.regime) r.regime = 'qrmp';
  }
  if (['PT_PTRC', 'PT_PTEC', 'LWF'].includes(r.type) && !r.filing_frequency) warnings.push('Periodicity not recorded — its tasks stay unscheduled until it is');
  if (r.active_from && r.active_to && r.active_to < r.active_from) errors.push('Active to is before active from');
  for (const id of r.establishment_ids) if (!org.establishments.some(b => b.id === id && b.entity_id === r.entity_id)) errors.push(`Establishment ${id} is not one of this entity's establishments`);
  if (r.number && org.registrations.some(x => x.id !== existing?.id && x.type === r.type && x.number === r.number && x.status === 'active')) errors.push(`${CAT.REG_TYPES[r.type] || r.type} ${r.number} is already recorded`);
  return { value: r, errors, warnings };
}

function cleanEstablishment(input, org) {
  refuseSecrets(input);
  const errors = [], warnings = [];
  const st = input.state ? V.stateOf(input.state) : null;
  const b = {
    entity_id: str(input.entity_id, 30), name: str(input.name, 200), kind: str(input.kind, 20) || 'office', state: st ? st.abbr : '', city: str(input.city, 100), address: str(input.address, 500),
    headcount: num(input.headcount), flags: cleanFlags(input.flags, EST_FLAGS), active_from: optDate(input.active_from, 'Active from', errors), active_to: optDate(input.active_to, 'Active to', errors),
    status: input.status === 'inactive' ? 'inactive' : 'active', notes: str(input.notes, 2000),
  };
  if (!org.entities.some(x => x.id === b.entity_id)) errors.push('Choose the legal entity');
  if (!b.name) errors.push('Name is required');
  if (!st) errors.push('State is required');
  if (Number.isNaN(b.headcount)) errors.push('Headcount must be a number');
  if (b.headcount === null) warnings.push('Headcount not recorded — headcount-based obligations will show "needs review"');
  return { value: b, errors, warnings };
}

function cleanPerson(input, org) {
  refuseSecrets(input);
  const errors = [];
  const p = {
    name: str(input.name, 200), din: str(input.din, 12).replace(/\D/g, ''), dsc_expiry: optDate(input.dsc_expiry, 'DSC expiry', errors),
    roles: (Array.isArray(input.roles) ? input.roles : []).map(x => ({ entity_id: str(x.entity_id, 30), designation: str(x.designation, 80), from: x.from || null, to: x.to || null })),
    status: input.status === 'inactive' ? 'inactive' : 'active', notes: str(input.notes, 1000),
  };
  if (!p.name) errors.push('Name is required');
  if (p.din && !/^\d{8}$/.test(p.din)) errors.push('DIN / DPIN must be 8 digits');
  for (const r of p.roles) if (!org.entities.some(x => x.id === r.entity_id)) errors.push(`Role entity ${r.entity_id} not found`);
  if (p.din && org.people.some(x => x.din === p.din && x.id !== input.id)) errors.push(`DIN ${p.din} is already recorded for another person`);
  return { value: p, errors, warnings: [] };
}

const KINDS = {
  entity: { list: 'entities', prefix: 'E-', clean: cleanEntity },
  registration: { list: 'registrations', prefix: 'R-', clean: cleanRegistration },
  establishment: { list: 'establishments', prefix: 'B-', clean: cleanEstablishment },
  person: { list: 'people', prefix: 'P-', clean: cleanPerson },
};

/**
 * Create or update one master record inside a transaction's org document. Returns { record, before, warnings }.
 * Throws 400 with all errors. `expectedRev` protects against saving over someone else's newer edit.
 */
function upsert(org, kind, input, { actor, id, expectedRev, illustrative } = {}) {
  const K = KINDS[kind];
  if (!K) throw U.httpError(400, `Unknown master "${kind}"`);
  const list = org[K.list];
  const existing = id ? list.find(x => x.id === id) : null;
  if (id && !existing) throw U.httpError(404, `${kind} ${id} not found`);
  if (existing && expectedRev !== undefined && expectedRev !== null && Number(expectedRev) !== existing.rev) {
    throw U.httpError(409, `This ${kind} was changed by ${existing.updated_by || 'someone'} since you opened it. Reload and apply your change again.`);
  }
  // a person's DIN is shown masked: an update without a (new) DIN keeps the stored one
  if (kind === 'person' && existing && (input.din === undefined || /^\D/.test(String(input.din || '')))) input = { ...input, din: existing.din };
  const { value, errors, warnings } = K.clean({ ...input, id }, org, existing);
  if (errors.length) throw U.httpError(400, errors.join('; '), { errors, warnings });
  const now = U.nowIso();
  if (existing) {
    const before = U.clone(existing);
    if (kind === 'entity' && existing.legal_name !== value.legal_name) {
      existing.name_history = [...(existing.name_history || []), { name: existing.legal_name, until: now, changed_by: actor.name }];
    }
    // an approved record that is changed in a way that matters goes back to draft until approved again
    const material = kind === 'entity' ? ['pan', 'cin', 'llpin', 'type', 'listed'] : kind === 'registration' ? ['number', 'type', 'state', 'filing_frequency', 'regime', 'active_from', 'active_to'] : [];
    const changed = material.filter(k => JSON.stringify(before[k]) !== JSON.stringify(value[k]));
    Object.assign(existing, value, { warnings, updated_at: now, updated_by: actor.name, updated_by_id: actor.id, rev: (existing.rev || 0) + 1 });
    if (changed.length && existing.data_status === 'approved') { existing.data_status = 'draft'; existing.approval_note = `Changed (${changed.join(', ')}) after approval — needs approval again`; }
    return { record: existing, before, warnings };
  }
  const rec = { id: U.uid(K.prefix), ...value, warnings, data_status: illustrative ? 'illustrative' : 'draft', created_at: now, created_by: actor.name, created_by_id: actor.id, updated_at: now, updated_by: actor.name, rev: 1 };
  list.push(rec);
  return { record: rec, before: null, warnings };
}

/** Approve entity master data (and, optionally, its registrations). */
function approve(org, kind, id, actor) {
  const K = KINDS[kind];
  const rec = org[K.list].find(x => x.id === id);
  if (!rec) throw U.httpError(404, `${kind} ${id} not found`);
  if (rec.data_status === 'illustrative') throw U.httpError(400, 'Illustrative (demo) records cannot be approved as real master data');
  if (kind === 'entity') {
    const missing = [!rec.pan && 'PAN', CAT.entityKind(rec.type) === 'company' && !rec.cin && 'CIN', CAT.entityKind(rec.type) === 'llp' && !rec.llpin && 'LLPIN', CAT.entityKind(rec.type) === 'company' && rec.listed === null && 'listed status', rec.listed === true && !rec.listing_type && 'listing type (shares / NCDs / both)'].filter(Boolean);
    if (missing.length) throw U.httpError(400, `Record the ${missing.join(', ')} before approving this entity`);
  }
  if (kind === 'registration') {
    const ent = org.entities.find(x => x.id === rec.entity_id);
    if (ent?.data_status !== 'approved') throw U.httpError(400, 'Approve the entity first');
  }
  const before = U.clone(rec);
  Object.assign(rec, { data_status: 'approved', approved_by: actor.name, approved_by_id: actor.id, approved_at: U.nowIso(), approval_note: '', rev: (rec.rev || 0) + 1 });
  return { record: rec, before };
}

const activeIn = (rec, start, end) => rec.status !== 'inactive' && (!rec.active_from || rec.active_from <= end) && (!rec.active_to || rec.active_to >= start);

/** Readable label of a scope (for lists and exports) */
function scopeLabel(org, scopeType, scopeId) {
  if (scopeType === 'entity') { const e = org.entities.find(x => x.id === scopeId); return e ? `${e.legal_name} (PAN ${e.pan})` : scopeId; }
  if (scopeType === 'registration') { const r = org.registrations.find(x => x.id === scopeId); return r ? `${r.state ? `${r.state} · ` : ''}${r.type.replace('_', ' ')} ${r.number}` : scopeId; }
  if (scopeType === 'establishment') { const b = org.establishments.find(x => x.id === scopeId); return b ? `${b.name} (${b.state})` : scopeId; }
  if (scopeType === 'person') { const p = org.people.find(x => x.id === scopeId); return p ? `${p.name}${p.din ? ` (DIN ••••${p.din.slice(-4)})` : ''}` : scopeId; }
  return scopeId;
}

module.exports = { EMPTY, FREQ, REGIMES, LISTING_TYPES, ENTITY_FLAGS, REG_FLAGS, EST_FLAGS, FY_FACTS, KINDS, refuseSecrets, upsert, approve, activeIn, scopeLabel, bool3 };
