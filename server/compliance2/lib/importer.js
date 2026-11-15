/**
 * Master-data import (Excel / CSV) with preview — and the one-off carry-over of Compliance v1's companies.
 *
 * Template sheets: Entities, FY_Facts, Registrations, Establishments, People. Rows refer to their entity by short code.
 * Preview runs every row through the same validation as the screens (org.js) on a copy of the masters and reports, per
 * row, "new" / "update" / "unchanged" / errors / warnings. Commit re-reads the same file, repeats the checks and saves
 * ONLY when there is not a single error — all rows or none. Imported records are drafts until approved.
 */

'use strict';

const XLSX = require('xlsx');
const U = require('./util');
const ORG = require('./org');

const YES = v => (v === undefined || v === null || String(v).trim() === '' ? undefined : /^(y|yes|true|1)$/i.test(String(v).trim()) ? true : /^(n|no|false|0)$/i.test(String(v).trim()) ? false : String(v));

const SHEETS = {
  Entities: ['short_code', 'legal_name', 'type', 'pan', 'cin', 'llpin', 'listed', 'listing_type', 'exchanges', 'incorporation_date', 'zoho_org_id', ...ORG.ENTITY_FLAGS, 'notes'],
  FY_Facts: ['entity_short_code', 'fy', ...ORG.FY_FACTS, 'tax_audit_required', 'source'],
  Registrations: ['entity_short_code', 'type', 'number', 'state', 'filing_frequency', 'regime', 'active_from', 'active_to', 'jurisdiction', 'authority', 'portal_url', ...ORG.REG_FLAGS, 'notes'],
  Establishments: ['entity_short_code', 'name', 'kind', 'state', 'city', 'address', 'headcount', ...ORG.EST_FLAGS, 'active_from', 'active_to', 'notes'],
  People: ['name', 'din', 'dsc_expiry', 'roles', 'notes'],
};
const REQUIRED = { Entities: ['short_code', 'legal_name', 'type'], FY_Facts: ['entity_short_code', 'fy'], Registrations: ['entity_short_code', 'type', 'number'], Establishments: ['entity_short_code', 'name', 'state'], People: ['name'] };

function template() {
  const wb = XLSX.utils.book_new();
  const notes = [['Compliance Dashboard Vr.2.0 — master data import template'], [''],
    ['Fill one sheet per kind of record. Refer to the entity by its short code. Yes / No columns accept Yes, No or blank (blank = not recorded).'],
    ['Never put portal passwords, OTPs or other secrets in any column — the import refuses them.'],
    ['Listed: Yes / No. If Yes, listing_type: equity (shares), debt (NCDs only) or equity_and_debt.'],
    ['Entity type: PRIVATE, PUBLIC, OPC, SECTION8, LLP, FOREIGN, OTHER.  Dates: YYYY-MM-DD.  FY: 2025-26.  States: two-letter GST codes (GJ, MH, KA …).'],
    ['Registration type: GST_REGULAR, GST_COMPOSITION, GST_ISD, GST_TDS, GST_TCS, GST_NRTP, GST_OIDAR, TAN, PF, ESIC, PT_PTRC, PT_PTEC, LWF, IEC, SHOPS_EST, TRADE_LICENCE, FIRE_NOC, FSSAI, POLLUTION, SEZ_UNIT, OTHER_LICENCE.'],
    ['Filing frequency: monthly, quarterly, half_yearly, annual.  Regime: regular, qrmp, composition, other.'],
    ['People roles: SHORTCODE:Designation separated by ";" — e.g. DEVX:Director; NTD:Designated partner.'],
    ['Imported records are drafts until approved in Masters. Import is all-or-nothing: one error stops the whole file.']];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(notes), 'Read_me');
  for (const [name, cols] of Object.entries(SHEETS)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols]), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** File → { Entities: [rows], … } (CSV = one sheet, named by its header) */
function parse(buffer, name) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const out = {};
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { defval: '', raw: false });
    let kind = Object.keys(SHEETS).find(k => k.toLowerCase() === sn.toLowerCase());
    if (!kind && /\.csv$/i.test(name || '') && rows.length) kind = Object.keys(SHEETS).find(k => REQUIRED[k].every(c => c in rows[0]));
    if (!kind) continue;
    const unknown = rows.length ? Object.keys(rows[0]).filter(c => !SHEETS[kind].includes(c)) : [];
    out[kind] = { rows, unknown };
  }
  return out;
}

const s = v => String(v ?? '').trim();
const flagsFrom = (r, keys) => Object.fromEntries(keys.map(k => [k, YES(r[k])]).filter(([, v]) => v !== undefined));

/** Runs the import on a COPY of org → { org (changed copy), results, errors, counts } */
function apply(orgIn, sheets, actor) {
  const org = U.clone(orgIn);
  const results = [];
  let errors = 0;
  const byCode = code => org.entities.find(e => e.short_code === s(code).toUpperCase());
  const run = (sheet, rowNo, fn) => {
    try { const r = fn(); results.push({ sheet, row: rowNo, ...r }); }
    catch (e) { errors++; results.push({ sheet, row: rowNo, action: 'error', error: e.message, errors: e.errors || [e.message] }); }
  };
  const missingReq = (kind, r) => REQUIRED[kind].filter(c => !s(r[c]));
  const upd = (kind, existing, input, label) => {
    if (existing) {
      const before = U.stable(existing);
      const res = ORG.upsert(org, kind, { ...existing, ...input }, { actor, id: existing.id });
      return { action: U.stable(res.record) === before ? 'unchanged' : 'update', label, warnings: res.warnings };
    }
    const res = ORG.upsert(org, kind, input, { actor });
    return { action: 'new', label, warnings: res.warnings };
  };
  for (const [i, r] of (sheets.Entities?.rows || []).entries()) run('Entities', i + 2, () => {
    const miss = missingReq('Entities', r); if (miss.length) throw new Error(`Missing ${miss.join(', ')}`);
    const code = s(r.short_code).toUpperCase();
    // a row updates the entity with ITS short code only — a PAN already used by another entity is an error, never a silent rename
    const existing = org.entities.find(e => e.short_code === code);
    const panOwner = s(r.pan) && org.entities.find(e => e.pan === s(r.pan).toUpperCase());
    if (panOwner && panOwner !== existing) throw new Error(`Another entity already has PAN ${panOwner.pan} (${panOwner.short_code} ${panOwner.legal_name}) — use its short code to update it`);
    const input = { legal_name: s(r.legal_name), short_code: code, type: s(r.type).toUpperCase(), pan: s(r.pan), cin: s(r.cin), llpin: s(r.llpin), listed: YES(r.listed), listing_type: s(r.listing_type).toLowerCase() || null,
      exchanges: s(r.exchanges), incorporation_date: s(r.incorporation_date), zoho_org_id: s(r.zoho_org_id), notes: s(r.notes), flags: { ...(existing?.flags || {}), ...flagsFrom(r, ORG.ENTITY_FLAGS) }, fy_facts: existing?.fy_facts || {} };
    return upd('entity', existing, input, `${code} ${s(r.legal_name)}`);
  });
  for (const [i, r] of (sheets.FY_Facts?.rows || []).entries()) run('FY_Facts', i + 2, () => {
    const miss = missingReq('FY_Facts', r); if (miss.length) throw new Error(`Missing ${miss.join(', ')}`);
    const e = byCode(r.entity_short_code); if (!e) throw new Error(`No entity with short code ${r.entity_short_code}`);
    const row = { ...Object.fromEntries(ORG.FY_FACTS.map(k => [k, s(r[k])])), tax_audit_required: YES(r.tax_audit_required), source: s(r.source) };
    return upd('entity', e, { ...e, fy_facts: { ...e.fy_facts, [s(r.fy)]: row } }, `${e.short_code} FY ${s(r.fy)}`);
  });
  for (const [i, r] of (sheets.Establishments?.rows || []).entries()) run('Establishments', i + 2, () => {
    const miss = missingReq('Establishments', r); if (miss.length) throw new Error(`Missing ${miss.join(', ')}`);
    const e = byCode(r.entity_short_code); if (!e) throw new Error(`No entity with short code ${r.entity_short_code}`);
    const existing = org.establishments.find(b => b.entity_id === e.id && b.name.toLowerCase() === s(r.name).toLowerCase());
    return upd('establishment', existing, { entity_id: e.id, name: s(r.name), kind: s(r.kind), state: s(r.state), city: s(r.city), address: s(r.address), headcount: s(r.headcount),
      flags: flagsFrom(r, ORG.EST_FLAGS), active_from: s(r.active_from), active_to: s(r.active_to), notes: s(r.notes) }, `${e.short_code} ${s(r.name)}`);
  });
  for (const [i, r] of (sheets.Registrations?.rows || []).entries()) run('Registrations', i + 2, () => {
    const miss = missingReq('Registrations', r); if (miss.length) throw new Error(`Missing ${miss.join(', ')}`);
    const e = byCode(r.entity_short_code); if (!e) throw new Error(`No entity with short code ${r.entity_short_code}`);
    const type = s(r.type).toUpperCase();
    const existing = org.registrations.find(x => x.type === type && x.number === s(r.number).toUpperCase().replace(/\s+/g, ''));
    if (existing && existing.entity_id !== e.id) throw new Error(`${type} ${s(r.number)} is already recorded for another entity`);
    return upd('registration', existing, { entity_id: e.id, type, number: s(r.number), state: s(r.state), filing_frequency: s(r.filing_frequency), regime: s(r.regime),
      active_from: s(r.active_from), active_to: s(r.active_to), jurisdiction: s(r.jurisdiction), authority: s(r.authority), portal_url: s(r.portal_url), flags: flagsFrom(r, ORG.REG_FLAGS), notes: s(r.notes) }, `${e.short_code} ${type} ${s(r.number)}`);
  });
  for (const [i, r] of (sheets.People?.rows || []).entries()) run('People', i + 2, () => {
    const miss = missingReq('People', r); if (miss.length) throw new Error(`Missing ${miss.join(', ')}`);
    const roles = s(r.roles).split(';').map(x => x.trim()).filter(Boolean).map(x => {
      const [code, ...d] = x.split(':'); const e = byCode(code);
      if (!e) throw new Error(`Role "${x}": no entity with short code ${code}`);
      return { entity_id: e.id, designation: d.join(':').trim() };
    });
    const din = s(r.din).replace(/\D/g, '');
    const existing = din ? org.people.find(p => p.din === din) : org.people.find(p => p.name.toLowerCase() === s(r.name).toLowerCase());
    return upd('person', existing, { id: existing?.id, name: s(r.name), din, dsc_expiry: s(r.dsc_expiry), roles, notes: s(r.notes) }, s(r.name));
  });
  const counts = results.reduce((c, r) => { c[r.action] = (c[r.action] || 0) + 1; return c; }, {});
  const unknownColumns = Object.entries(sheets).filter(([, v]) => v.unknown?.length).map(([k, v]) => `${k}: ${v.unknown.join(', ')}`);
  return { org, results, errors, counts, unknown_columns: unknownColumns };
}

/** Compliance v1 companies → Entities rows (drafts; type guessed from the name and flagged) */
function fromV1(v1data) {
  return (v1data?.companies || []).map(c => {
    const n = String(c.name || '');
    const type = /\bLLP\b/i.test(n) ? 'LLP' : /\b(pvt|private)\b/i.test(n) ? 'PRIVATE' : /limited|ltd/i.test(n) ? 'PUBLIC' : 'OTHER';
    return { short_code: c.short_code, legal_name: n, type, zoho_org_id: c.zoho_org_id || '', notes: `Carried over from Compliance v1 (${c.id}). Entity type guessed from the name — check it. PAN, CIN / LLPIN and listed status must be recorded before approval.` };
  });
}

module.exports = { SHEETS, template, parse, apply, fromV1 };
