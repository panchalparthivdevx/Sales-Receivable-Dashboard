/**
 * TDS Section-wise (V3): challan header + section allocation lines + evidence + review.
 *
 * Store document "<sp>_tds": { sections: [section master], challans: [], allocations: [] }
 *
 * Section master entry: { id, act ('1961' | '2025'), code (exactly as on the portal), legacy_ref (an old-Act label kept for
 *   navigation and comparison only), nature, effective_from, effective_to, status 'requires_verification' | 'verified',
 *   source, verified_by, verified_at }
 *   • A new-Act code is never replaced by its old alias. An allocation whose (act, code) is not a VERIFIED master entry for the
 *     liability month is marked mapping 'unverified' — accepted, but listed as needing verification, never as an approved mapping.
 *   • No tax rate is inferred from a section.
 *
 * Challan: { id, entity_id, registration_id (the TAN), tan, itns ('281' | '281N'), deductee_type ('company' | 'non_company'),
 *   act, tax_year, paid_date, bsr_code, challan_serial, cin, components { tax, surcharge, cess, interest, fee, other }, total,
 *   evidence [attachment ids], status 'recorded' | 'reversed', review { status, prepared_by, reviewed_by … }, history[] }
 *   • total = the sum of the components (checked);
 *   • ITNS 281 (legacy) carries one section per challan; ITNS 281N up to 20 distinct section codes (portal manual — verify the
 *     current limit before relying on it; it is a setting here, not a law).
 *
 * Allocation: { id, challan_id, entity_id, registration_id, tan, liability_month, act, section_code, legacy_ref, nature,
 *   deductee_category, principal, surcharge, cess, mapping, evidence [ids], status 'active' | 'reversed', history[] }
 *   • the principal (and surcharge, cess) allocated across a challan never exceeds the challan's component — a challan's cash
 *     is counted ONCE, and each rupee of principal is allocated once;
 *   • several challans (partial deposits) may cover the same month and section;
 *   • interest, fees and other charges stay on the challan (separately identified) — section reports show principal only;
 *   • corrections are reversals (kept), never deletions.
 */

'use strict';

const U = require('./util');
const P = require('./payments');

const ACTS = { 1961: 'Income-tax Act, 1961', 2025: 'Income-tax Act, 2025' };
const ITNS = { 281: 'ITNS 281 (legacy) — one section per challan', '281N': 'ITNS 281N — several section codes per deductee type' };
const DEDUCTEE = { company: 'Company deductees', non_company: 'Non-company deductees' };
const COMPONENTS = ['tax', 'surcharge', 'cess', 'interest', 'fee', 'other'];
const MAX_281N_CODES = 20;
const REVIEW = ['draft', 'ready_for_review', 'reviewed'];

/**
 * Seed master — familiar old-Act references (labels for navigation) and the one new-Act mapping the official FAQ names.
 * Every entry starts as "requires verification": someone must check it against the portal's current code list.
 */
const SEED = [
  ['1961', '192', '192', 'Salary'], ['1961', '194A', '194A', 'Interest other than interest on securities'], ['1961', '194C', '194C', 'Payments to contractors'],
  ['1961', '194H', '194H', 'Commission or brokerage'], ['1961', '194-I(a)', '194-I', 'Rent — plant / machinery / equipment'],
  ['1961', '194-I(b)', '194-I', 'Rent — land / building / furniture'], ['1961', '194J(a)', '194J', 'Fees for technical services'],
  ['1961', '194J(b)', '194J', 'Fees for professional services'], ['1961', '194Q', '194Q', 'Purchase of goods'], ['1961', '195', '195', 'Payments to non-residents'],
  ['2025', '393(1) Table Sl. No. 6(i)', '194C', 'Payments to contractors (official FAQ: corresponds to 194C)'],
];
const SEED_SOURCE = 'https://www.incometax.gov.in/iec/foportal/help/all-topics/e-filing-services/tax-payments-faq';
const EMPTY = () => ({ sections: [], challans: [], allocations: [] });

function seed(doc) {
  if (doc.sections.length) return 0;
  for (const [act, code, legacy, nature] of SEED) {
    doc.sections.push({ id: U.uid('SM-'), act, code, legacy_ref: legacy, nature, effective_from: act === '2025' ? '2026-04-01' : '1961-04-01', effective_to: act === '1961' ? '2026-03-31' : null,
      status: 'requires_verification', source: SEED_SOURCE, created_at: U.nowIso() });
  }
  return SEED.length;
}

const norm = s => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
const money = v => { const n = P.num(v); return n === null ? 0 : n; };
const r2 = n => Math.round(n * 100) / 100;

/** The verified master entry for an (act, code) on a liability month, or null */
function mappingFor(doc, act, code, month) {
  const d = `${month}-01`;
  return doc.sections.find(s => s.act === act && norm(s.code) === norm(code) && s.status === 'verified' && s.effective_from <= d && (!s.effective_to || s.effective_to >= d)) || null;
}

function addSection(doc, input, actor) {
  const s = { act: String(input.act || ''), code: String(input.code || '').trim().slice(0, 60), legacy_ref: String(input.legacy_ref || '').trim().slice(0, 30), nature: String(input.nature || '').trim().slice(0, 200),
    effective_from: input.effective_from, effective_to: input.effective_to || null, source: String(input.source || '').trim().slice(0, 500) };
  const errors = [];
  if (!ACTS[s.act]) errors.push('Act must be 1961 or 2025');
  if (!s.code) errors.push('Section / table code (exactly as on the portal) is required');
  if (!s.nature) errors.push('Nature of payment is required');
  if (!U.isDate(s.effective_from)) errors.push('Effective from date is required');
  if (s.effective_to && (!U.isDate(s.effective_to) || s.effective_to < s.effective_from)) errors.push('Effective to must be a date after effective from');
  if (doc.sections.some(x => x.act === s.act && norm(x.code) === norm(s.code) && x.effective_from === s.effective_from)) errors.push('This section code is already in the master for that date');
  if (errors.length) throw U.httpError(400, errors.join('; '));
  const rec = { id: U.uid('SM-'), ...s, status: 'requires_verification', created_by: actor.name, created_at: U.nowIso() };
  doc.sections.push(rec);
  return rec;
}

function verifySection(doc, id, input, actor) {
  const s = doc.sections.find(x => x.id === id);
  if (!s) throw U.httpError(404, 'Section not found');
  if (s.status === 'verified') throw U.httpError(400, 'Already verified');
  if (String(input.source || '').trim().length < 5) throw U.httpError(400, 'Quote the official source you checked (portal code list / notification) — the seed link alone is not a verification');
  if (s.created_by && s.created_by === actor.name) throw U.httpError(403, 'Another person must verify a section you added');
  Object.assign(s, { status: 'verified', source: String(input.source).trim().slice(0, 500), verified_by: actor.name, verified_by_id: actor.id, verified_at: U.nowIso() });
  return s;
}

// ── Challans ──────────────────────────────────────────────────────────────────
function cleanChallan(input, org) {
  const errors = [];
  const reg = org.registrations.find(r => r.id === input.registration_id);
  const c = {
    entity_id: String(input.entity_id || ''), registration_id: String(input.registration_id || ''), tan: reg?.number || '', itns: String(input.itns || ''),
    deductee_type: String(input.deductee_type || ''), act: String(input.act || ''), tax_year: String(input.tax_year || '').trim().slice(0, 12), paid_date: String(input.paid_date || ''),
    bsr_code: String(input.bsr_code || '').trim(), challan_serial: String(input.challan_serial || '').trim(), cin: String(input.cin || '').trim().slice(0, 40),
    components: {}, notes: String(input.notes || '').slice(0, 2000),
  };
  if (!org.entities.some(e => e.id === c.entity_id)) errors.push('Choose the company');
  if (!reg || reg.type !== 'TAN' || reg.entity_id !== c.entity_id) errors.push('Choose one of this company\'s TAN registrations');
  if (!ITNS[c.itns]) errors.push('Payment type must be ITNS 281 or 281N');
  if (!DEDUCTEE[c.deductee_type]) errors.push('Deductee type must be company or non_company');
  if (!ACTS[c.act]) errors.push('Governing Act must be 1961 or 2025');
  if (!c.tax_year) errors.push('Assessment year / tax year is required (as on the challan)');
  if (!U.isDate(c.paid_date)) errors.push('Payment (tender) date is required');
  if (!/^\d{7}$/.test(c.bsr_code)) errors.push('BSR code must be 7 digits');
  if (!/^\d{1,5}$/.test(c.challan_serial)) errors.push('Challan serial number must be up to 5 digits');
  for (const k of COMPONENTS) {
    const n = P.num(input.components?.[k]);
    if (Number.isNaN(n) || (n !== null && n < 0)) errors.push(`${k} must be a positive amount or blank`);
    c.components[k] = n ?? 0;
  }
  c.total = r2(COMPONENTS.reduce((a, k) => a + c.components[k], 0));
  const stated = P.num(input.total);
  if (stated !== null && !Number.isNaN(stated) && Math.abs(stated - c.total) > 0.01) errors.push(`The challan total ${stated} does not equal its components (${c.total})`);
  if (c.total <= 0) errors.push('The challan has no amount');
  return { value: c, errors };
}
const challanKey = c => `${c.registration_id}|${c.bsr_code}|${c.paid_date}|${c.challan_serial}`;

function addChallan(doc, input, { org, actor, illustrative = false }) {
  const { value, errors } = cleanChallan(input, org);
  if (errors.length) throw U.httpError(400, errors.join('; '), { errors });
  const dupe = doc.challans.find(x => x.status !== 'reversed' && challanKey(x) === challanKey(value));
  if (dupe) throw U.httpError(409, `This challan (BSR ${value.bsr_code}, ${value.paid_date}, serial ${value.challan_serial}) is already recorded (${dupe.id})`);
  const now = U.nowIso();
  const c = { id: U.uid('CH-'), ...value, evidence: [], illustrative, status: 'recorded', review: { status: 'draft', prepared_by: actor.name, prepared_by_id: actor.id }, created_at: now, history: [{ at: now, by: actor.name, action: 'recorded' }] };
  doc.challans.push(c);
  return c;
}

function allocatedOn(doc, challanId, exceptId) {
  const out = { tax: 0, surcharge: 0, cess: 0, codes: new Set() };
  for (const a of doc.allocations) {
    if (a.challan_id !== challanId || a.status !== 'active' || a.id === exceptId) continue;
    out.tax += a.principal; out.surcharge += a.surcharge; out.cess += a.cess; out.codes.add(`${a.act}|${norm(a.section_code)}`);
  }
  out.tax = r2(out.tax); out.surcharge = r2(out.surcharge); out.cess = r2(out.cess);
  return out;
}

/** Add or edit an allocation line on a challan */
function allocate(doc, input, { actor, editId }) {
  const ch = doc.challans.find(x => x.id === input.challan_id);
  if (!ch) throw U.httpError(404, 'Challan not found');
  if (ch.status === 'reversed') throw U.httpError(400, 'This challan is reversed');
  if (ch.review.status === 'reviewed') throw U.httpError(400, 'This challan is reviewed and locked — reopen the review to change allocations');
  const a = {
    challan_id: ch.id, entity_id: ch.entity_id, registration_id: ch.registration_id, tan: ch.tan, liability_month: String(input.liability_month || ''), act: String(input.act || ch.act),
    section_code: String(input.section_code || '').trim().slice(0, 60), legacy_ref: String(input.legacy_ref || '').trim().slice(0, 30), nature: String(input.nature || '').trim().slice(0, 200),
    deductee_category: String(input.deductee_category || ch.deductee_type), principal: money(input.principal), surcharge: money(input.surcharge), cess: money(input.cess),
    evidence: Array.isArray(input.evidence) ? input.evidence.map(String) : ch.evidence.slice(),
  };
  const errors = [];
  if (!P.isMonth(a.liability_month)) errors.push('Deduction / liability month is required (YYYY-MM) — it is separate from the payment month');
  if (a.act !== ch.act) errors.push(`The allocation's Act must match the challan (${ACTS[ch.act]})`);
  if (!a.section_code) errors.push('Section code exactly as paid is required');
  if (a.deductee_category !== ch.deductee_type) errors.push('The deductee type must be the challan\'s deductee type');
  if ([a.principal, a.surcharge, a.cess].some(v => Number.isNaN(v) || v < 0)) errors.push('Amounts must be positive');
  if (a.principal <= 0) errors.push('Principal TDS allocated must be more than zero');
  if (P.isMonth(a.liability_month) && ch.paid_date < `${a.liability_month}-01`) errors.push(`The challan was paid (${ch.paid_date}) before the liability month ${a.liability_month} started — check the period or the challan`);
  const used = allocatedOn(doc, ch.id, editId);
  if (r2(used.tax + a.principal) > ch.components.tax + 0.001) errors.push(`Allocations would exceed the challan's tax (principal) of ${ch.components.tax}: ${used.tax} already allocated, ${r2(ch.components.tax - used.tax)} left`);
  if (r2(used.surcharge + a.surcharge) > ch.components.surcharge + 0.001) errors.push(`Surcharge allocated would exceed the challan's surcharge (${ch.components.surcharge})`);
  if (r2(used.cess + a.cess) > ch.components.cess + 0.001) errors.push(`Cess allocated would exceed the challan's cess (${ch.components.cess})`);
  const key = `${a.act}|${norm(a.section_code)}`;
  const codes = new Set([...used.codes, key]);
  if (ch.itns === '281' && codes.size > 1) errors.push('An ITNS 281 (legacy) challan carries one section only — record the other section on its own challan');
  if (ch.itns === '281N' && codes.size > MAX_281N_CODES) errors.push(`An ITNS 281N challan carries at most ${MAX_281N_CODES} section codes (verify the current portal limit)`);
  const dupe = doc.allocations.find(x => x.id !== editId && x.status === 'active' && x.challan_id === ch.id && x.liability_month === a.liability_month && `${x.act}|${norm(x.section_code)}` === key);
  if (dupe) errors.push(`This challan already has an allocation for ${a.section_code} / ${a.liability_month} (${dupe.id}) — edit it instead`);
  for (const id of a.evidence) if (!ch.evidence.includes(id) && !input.allow_other_evidence) errors.push(`Evidence ${id} is not attached to this challan`);
  if (errors.length) throw U.httpError(400, errors.join('; '), { errors });
  const map = mappingFor(doc, a.act, a.section_code, a.liability_month);
  a.mapping = map ? 'verified' : 'unverified';
  if (map && !a.legacy_ref) a.legacy_ref = map.legacy_ref;
  if (map && !a.nature) a.nature = map.nature;
  const now = U.nowIso();
  if (editId) {
    const old = doc.allocations.find(x => x.id === editId);
    if (!old || old.status !== 'active') throw U.httpError(404, 'Allocation not found');
    if (old.challan_id !== ch.id) throw U.httpError(400, 'An allocation cannot move to another challan — reverse it and allocate again');
    const before = U.clone(old);
    Object.assign(old, a);
    old.history.push({ at: now, by: actor.name, action: 'edited', before: { principal: before.principal, section_code: before.section_code, liability_month: before.liability_month } });
    return old;
  }
  const rec = { id: U.uid('AL-'), ...a, status: 'active', created_by: actor.name, created_at: now, history: [{ at: now, by: actor.name, action: 'allocated' }] };
  doc.allocations.push(rec);
  return rec;
}

function reverseAllocation(doc, id, reason, actor) {
  const a = doc.allocations.find(x => x.id === id);
  if (!a || a.status !== 'active') throw U.httpError(404, 'Allocation not found');
  const ch = doc.challans.find(x => x.id === a.challan_id);
  if (ch?.review.status === 'reviewed') throw U.httpError(400, 'The challan is reviewed and locked');
  if (String(reason || '').trim().length < 5) throw U.httpError(400, 'A reason is required');
  a.status = 'reversed';
  a.history.push({ at: U.nowIso(), by: actor.name, action: 'reversed', note: reason });
  return a;
}

function reverseChallan(doc, id, reason, actor) {
  const ch = doc.challans.find(x => x.id === id);
  if (!ch || ch.status === 'reversed') throw U.httpError(404, 'Challan not found');
  if (String(reason || '').trim().length < 5) throw U.httpError(400, 'A reason is required');
  ch.status = 'reversed';
  ch.history.push({ at: U.nowIso(), by: actor.name, action: 'reversed', note: reason });
  for (const a of doc.allocations) if (a.challan_id === id && a.status === 'active') { a.status = 'reversed'; a.history.push({ at: U.nowIso(), by: actor.name, action: 'reversed with challan', note: reason }); }
  return ch;
}

/** Review: draft → ready_for_review (preparer; needs evidence + allocations) → reviewed (a different person) */
function review(doc, id, action, note, actor) {
  const ch = doc.challans.find(x => x.id === id);
  if (!ch || ch.status === 'reversed') throw U.httpError(404, 'Challan not found');
  const st = balance(doc, ch);
  if (action === 'submit') {
    if (ch.review.status !== 'draft') throw U.httpError(400, 'Only a draft can be submitted');
    if (!ch.evidence.length) throw U.httpError(400, 'Attach the paid challan before submitting for review');
    if (!st.allocations) throw U.httpError(400, 'Allocate the principal to section codes before submitting for review');
    ch.review = { ...ch.review, status: 'ready_for_review', prepared_by: actor.name, prepared_by_id: actor.id, submitted_at: U.nowIso() };
  } else if (action === 'approve') {
    if (ch.review.status !== 'ready_for_review') throw U.httpError(400, 'Only a challan ready for review can be reviewed');
    if (ch.review.prepared_by_id === actor.id) throw U.httpError(403, 'You prepared this challan, so another person must review it');
    ch.review = { ...ch.review, status: 'reviewed', reviewed_by: actor.name, reviewed_by_id: actor.id, reviewed_at: U.nowIso(), note: String(note || '').slice(0, 1000) };
  } else if (action === 'return') {
    if (!['ready_for_review', 'reviewed'].includes(ch.review.status)) throw U.httpError(400, 'Nothing to return');
    if (String(note || '').trim().length < 5) throw U.httpError(400, 'Say why it goes back');
    if (ch.review.status === 'reviewed' && ch.review.prepared_by_id === actor.id) throw U.httpError(403, 'The preparer cannot reopen a reviewed challan');
    ch.review = { ...ch.review, status: 'draft', returned_by: actor.name, returned_at: U.nowIso(), note: String(note).slice(0, 1000) };
  } else throw U.httpError(400, 'action must be submit, approve or return');
  ch.history.push({ at: U.nowIso(), by: actor.name, action: `review_${action}`, note: note || '' });
  return ch;
}

/** Allocated vs challan components for one challan */
function balance(doc, ch) {
  const used = allocatedOn(doc, ch.id);
  const lines = doc.allocations.filter(a => a.challan_id === ch.id && a.status === 'active');
  return { allocations: lines.length, principal_allocated: used.tax, principal_unallocated: r2(ch.components.tax - used.tax), surcharge_unallocated: r2(ch.components.surcharge - used.surcharge),
    cess_unallocated: r2(ch.components.cess - used.cess), charges: r2(ch.components.interest + ch.components.fee + ch.components.other), codes: used.codes.size };
}

/** Reconciliation queue: challans with principal / surcharge / cess not yet allocated, or with no evidence */
function queue(doc, visible = () => true) {
  return doc.challans.filter(c => c.status !== 'reversed' && visible(c.entity_id)).map(c => ({ challan: c, ...balance(doc, c) }))
    .filter(x => x.principal_unallocated > 0.005 || x.surcharge_unallocated > 0.005 || x.cess_unallocated > 0.005 || !x.challan.evidence.length)
    .map(x => ({ ...x, reasons: [x.principal_unallocated > 0.005 && `₹${x.principal_unallocated} principal unallocated`, x.surcharge_unallocated > 0.005 && 'surcharge unallocated', x.cess_unallocated > 0.005 && 'cess unallocated', !x.challan.evidence.length && 'no paid-challan evidence'].filter(Boolean) }));
}

/**
 * Monthly section rows — allocations (principal only) joined with TDS liability inputs (lib/recon.js, type TDS) on the exact
 * normalised scope (entity, TAN, liability month, Act, code). No liability input = "not entered", never zero.
 */
function monthlyRows(doc, { liabilities = [], tasks = [], visible = () => true, filter = {} } = {}) {
  const byKey = new Map();
  const keyOf = (e, tan, m, act, code) => `${e}|${norm(tan)}|${m}|${act}|${norm(code)}`;
  const add = (k, base) => byKey.get(k) || byKey.set(k, { ...base, allocations: [], principal: 0, surcharge: 0, cess: 0, liability: null, liability_records: [], challans: new Set(), evidence: 0, review: new Set(), paid_dates: new Set(), mappings: new Set() }).get(k);
  for (const a of doc.allocations) {
    if (a.status !== 'active' || !visible(a.entity_id)) continue;
    const ch = doc.challans.find(c => c.id === a.challan_id);
    if (!ch || ch.status === 'reversed') continue;
    const row = add(keyOf(a.entity_id, a.tan, a.liability_month, a.act, a.section_code), { entity_id: a.entity_id, registration_id: a.registration_id, tan: a.tan, liability_month: a.liability_month, act: a.act, section_code: a.section_code, legacy_ref: a.legacy_ref, nature: a.nature });
    row.allocations.push(a.id); row.principal = r2(row.principal + a.principal); row.surcharge = r2(row.surcharge + a.surcharge); row.cess = r2(row.cess + a.cess);
    row.challans.add(ch.id); row.paid_dates.add(ch.paid_date); row.review.add(ch.review.status); row.mappings.add(a.mapping); if (a.evidence.length) row.evidence += 1;
  }
  for (const rec of liabilities) {
    if (!visible(rec.entity_id)) continue;
    for (const line of rec.rows || []) {
      const liab = P.num(line.liability);
      const row = add(keyOf(rec.entity_id, rec.registration_number, rec.month, String(line.act || ''), line.code), { entity_id: rec.entity_id, registration_id: rec.registration_id, tan: rec.registration_number, liability_month: rec.month, act: String(line.act || ''), section_code: line.code, legacy_ref: line.alias || '', nature: '' });
      row.liability = liab === null ? row.liability : r2((row.liability || 0) + liab);
      row.liability_records.push({ id: rec.id, status: rec.status });
    }
  }
  const dueOf = (e, reg, m) => tasks.find(t => t.rule_id === 'TDS-DEP' && t.entity_id === e && t.registration_id === reg && t.period_key === `M:${m}`)?.effective_due || null;
  return [...byKey.values()].map(r => {
    const due = dueOf(r.entity_id, r.registration_id, r.liability_month);
    const dates = [...r.paid_dates].sort();
    const mappings = [...r.mappings];
    return { ...r, challans: [...r.challans], paid_dates: dates, review: [...r.review], mappings, due_date: due,
      balance: r.liability === null ? null : r2(Math.max(0, r.liability - r.principal)), excess: r.liability === null ? null : r2(Math.max(0, r.principal - r.liability)),
      late: !!(due && dates.some(d => d > due)), mapping_unverified: mappings.includes('unverified') };
  }).filter(r => (!filter.entity_ids?.length || filter.entity_ids.includes(r.entity_id)) && (!filter.registration_ids?.length || filter.registration_ids.includes(r.registration_id))
    && (!filter.months?.length || filter.months.includes(r.liability_month)) && (!filter.payment_months?.length || r.paid_dates.some(d => filter.payment_months.includes(d.slice(0, 7))))
    && (!filter.section || norm(r.section_code) === norm(filter.section) || norm(r.legacy_ref) === norm(filter.section)))
    .sort((a, b) => a.liability_month.localeCompare(b.liability_month) || a.tan.localeCompare(b.tan) || a.section_code.localeCompare(b.section_code));
}

/** Month × section pivot of principal deposited (allocations only) */
function pivot(rows) {
  const months = U.uniq(rows.map(r => r.liability_month)).sort();
  const sections = U.uniq(rows.map(r => `${r.act}|${r.section_code}`)).sort();
  const cells = {};
  for (const r of rows) { const k = `${r.act}|${r.section_code}`; cells[k] = cells[k] || {}; cells[k][r.liability_month] = r2((cells[k][r.liability_month] || 0) + r.principal); }
  return { months, sections: sections.map(k => { const [act, code] = k.split('|'); return { key: k, act, code, legacy_ref: rows.find(r => `${r.act}|${r.section_code}` === k)?.legacy_ref || '', cells: cells[k], total: r2(Object.values(cells[k]).reduce((a, b) => a + b, 0)) }; }),
    totals: Object.fromEntries(months.map(m => [m, r2(rows.filter(r => r.liability_month === m).reduce((a, r) => a + r.principal, 0))])) };
}

/**
 * Closing gate for a monthly TDS deposit task: at least one active allocation for the task's company, TAN and month, on a
 * challan with paid-challan evidence. Equal amounts never close a task by themselves.
 */
function closeCheck(doc, task) {
  if (task.rule_id !== 'TDS-DEP') return { ok: true };
  const month = String(task.period_key || '').replace(/^M:/, '');
  const lines = doc.allocations.filter(a => a.status === 'active' && a.entity_id === task.entity_id && a.registration_id === task.registration_id && a.liability_month === month);
  if (!lines.length) return { ok: false, reason: `Record the section-wise allocation for ${month} in TDS Section-wise before closing this task` };
  const withEvidence = lines.filter(a => { const ch = doc.challans.find(c => c.id === a.challan_id); return ch && ch.status !== 'reversed' && ch.evidence.length; });
  if (!withEvidence.length) return { ok: false, reason: 'Attach the paid challan to the TDS challan record before closing this task' };
  return { ok: true, allocations: lines.length };
}

module.exports = { ACTS, ITNS, DEDUCTEE, COMPONENTS, MAX_281N_CODES, REVIEW, EMPTY, seed, mappingFor, addSection, verifySection, addChallan, allocate, reverseAllocation, reverseChallan, review, balance, queue, monthlyRows, pivot, closeCheck, norm };
