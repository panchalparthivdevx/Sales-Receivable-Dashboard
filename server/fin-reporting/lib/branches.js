/**
 * Financial Reporting — branch master.
 *
 * Fields: branch name, city, state, address, model (Furnished by Landlord / Straight Lease Model / Revenue Share Model),
 * SEZ or Non-SEZ, super built-up area (sq ft), carpet area (sq ft), total seats, expense start date, revenue start date.
 * Prefill (marked for confirmation): branch names from the dashboard's branch list, seats and area from the Finance
 * Overview capacity table, carpet / super built-up area summed from the Rent Recurring Module (latest module per office),
 * city and state from the branch code (Amd_, Pun_, …). Model, SEZ, address and the start dates are left for you.
 */

'use strict';

const XLSX = require('xlsx');
const crypto = require('crypto');
const S = require('./sources');

const MODELS = ['Furnished by Landlord', 'Straight Lease Model', 'Revenue Share Model'];
const ZONES = ['SEZ', 'Non-SEZ'];
const FIELDS = [
  ['name', 'Branch name', 'text', true], ['city', 'City', 'text', true], ['state', 'State', 'text', true], ['address', 'Branch address', 'text', false],
  ['model', 'Model (Furnished by Landlord / Straight Lease Model / Revenue Share Model)', 'text', true], ['zone', 'SEZ or Non-SEZ', 'text', true],
  ['superBuiltUp', 'Super built-up area (sq ft)', 'number', false], ['carpet', 'Carpet area (sq ft)', 'number', false], ['seats', 'Total seats', 'number', false],
  ['expenseStart', 'Branch expense start date', 'date', false], ['revenueStart', 'Branch revenue start date', 'date', false], ['status', 'Status (Operational / Under fit-out / Closed)', 'text', false], ['source', 'Source', 'text', false],
];
const CODES = { amd: ['Ahmedabad', 'Gujarat'], gnr: ['Gandhinagar', 'Gujarat'], vad: ['Vadodara', 'Gujarat'], sur: ['Surat', 'Gujarat'], surat: ['Surat', 'Gujarat'], raj: ['Rajkot', 'Gujarat'], pun: ['Pune', 'Maharashtra'], mum: ['Mumbai', 'Maharashtra'],
  hyd: ['Hyderabad', 'Telangana'], jai: ['Jaipur', 'Rajasthan'], udai: ['Udaipur', 'Rajasthan'], ind: ['Indore', 'Madhya Pradesh'], noi: ['Noida', 'Uttar Pradesh'], del: ['Delhi', 'Delhi'], ban: ['Bengaluru', 'Karnataka'], blr: ['Bengaluru', 'Karnataka'], che: ['Chennai', 'Tamil Nadu'] };

function normalise(raw, who) {
  const o = { id: raw.id || crypto.randomBytes(5).toString('hex') };
  for (const [k, , kind] of FIELDS) {
    let v = raw[k];
    if (v == null || v === '') { o[k] = null; continue; }
    if (kind === 'number') v = S.num(v); else if (kind === 'date') v = S.excelDate(v) || String(v); else v = String(v).trim();
    o[k] = v;
  }
  if (o.model) o.model = MODELS.find(m => m.toLowerCase().startsWith(o.model.toLowerCase().slice(0, 6))) || o.model;
  if (o.zone) o.zone = /non/i.test(o.zone) ? 'Non-SEZ' : /sez/i.test(o.zone) ? 'SEZ' : o.zone;
  o.by = who; o.at = new Date().toISOString();
  return o;
}
function validate(b) {
  const e = [];
  for (const [k, label, , req] of FIELDS) if (req && (b[k] == null || b[k] === '')) e.push(`${label} is required`);
  if (b.model && !MODELS.includes(b.model)) e.push(`Model must be one of: ${MODELS.join(', ')}`);
  if (b.zone && !ZONES.includes(b.zone)) e.push('Zone must be SEZ or Non-SEZ');
  for (const k of ['expenseStart', 'revenueStart']) if (b[k] && !/^\d{4}-\d{2}-\d{2}$/.test(b[k])) e.push(`${k === 'expenseStart' ? 'Expense' : 'Revenue'} start date must be a date`);
  return e;
}

/** Suggested rows for branches not yet in the master (nothing is saved until you confirm) */
async function suggestions(existing) {
  const ops = S.ops();
  const list = ops.branches ? await ops.branches() : [];
  const cap = ops.plCapacity ? await ops.plCapacity().catch(() => ({})) : {};
  const rent = await S.rentWorkbook().catch(() => ({ lines: [] }));
  const area = {};
  // latest module per office → its carpet / super built-up area, summed per branch
  const latest = {};
  for (const l of rent.lines) { const k = `${l.branch}|${l.vendor}|${l.office}`; if (!latest[k] || (l.modStart || '') > (latest[k].modStart || '')) latest[k] = l; }
  for (const l of Object.values(latest)) { const a = area[S.normName(l.branch)] || (area[S.normName(l.branch)] = { carpet: 0, sba: 0, agrStart: null }); a.carpet += l.carpet || 0; a.sba += l.sba || 0; if (l.agrStart && (!a.agrStart || l.agrStart < a.agrStart)) a.agrStart = l.agrStart; }
  const have = new Set((existing || []).map(b => S.normName(b.name)));
  const names = [...new Set([...list.map(b => b.name), ...Object.keys(cap)])];
  return names.filter(n => !have.has(S.normName(n))).map(n => {
    const code = n.split(/[_\s]/)[0].toLowerCase();
    const [city, state] = CODES[code] || [null, null];
    const a = area[S.normName(n)];
    const c = cap[n] || {};
    return { name: n, city, state, address: null, model: null, zone: null, superBuiltUp: c.sqft || (a?.sba || null), carpet: a?.carpet || null, seats: c.seats || null, expenseStart: null, revenueStart: null, status: null,
      source: ['branch list', c.seats ? 'seats/area: Finance Overview capacity' : null, a ? 'carpet area: Rent Recurring Module' : null, city ? 'city/state from the branch code — confirm' : null].filter(Boolean).join('; '), suggested: true };
  });
}

function template(rows = []) {
  const wb = XLSX.utils.book_new();
  const head = FIELDS.map(f => f[1] + (f[3] ? ' *' : ''));
  const ws = XLSX.utils.aoa_to_sheet([head, ...rows.map(r => FIELDS.map(f => r[f[0]] ?? null))]);
  ws['!cols'] = FIELDS.map(f => ({ wch: Math.max(14, Math.min(44, f[1].length + 2)) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Branches');
  const info = XLSX.utils.aoa_to_sheet([['Branch master — upload format'], [`Model: ${MODELS.join(' / ')}. Zone: SEZ or Non-SEZ. Dates as YYYY-MM-DD or DD/MM/YYYY. Areas in sq ft. Rows are matched by branch name (an existing branch is updated).`]]);
  XLSX.utils.book_append_sheet(wb, info, 'Instructions');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function parseUpload(buf, who) {
  const wb = XLSX.read(buf, { cellDates: true });
  const ws = wb.Sheets.Branches || wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const head = (aoa[0] || []).map(h => String(h || '').replace(/\s*\*$/, '').trim().toLowerCase());
  const rows = [], errors = [];
  aoa.slice(1).forEach((r, i) => {
    if (!r || r.every(x => x == null || x === '')) return;
    const raw = {};
    for (const [k, label] of FIELDS) { const c = head.indexOf(label.toLowerCase()); if (c >= 0) raw[k] = r[c]; }
    const b = normalise(raw, who);
    const e = validate(b);
    if (e.length) errors.push(`Row ${i + 2} (${b.name || '—'}): ${e.join('; ')}`); else rows.push(b);
  });
  return { rows, errors };
}

module.exports = { FIELDS, MODELS, ZONES, normalise, validate, suggestions, template, parseUpload };
