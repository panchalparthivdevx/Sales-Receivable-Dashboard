/**
 * Statutory payment register (V7) — one record per actual cash payment / challan, for every section EXCEPT TDS (TDS uses its
 * section-wise challan + allocation workflow, lib/tds.js, so no TDS amount is ever counted twice).
 *
 * Record: { id, entity_id, registration_id, section, liability_month, paid_date, reference, principal, interest, fee,
 *           components {…optional breakdown}, evidence [file ids], notes, illustrative, status 'recorded' | 'reversed',
 *           reversal_of, created_by, created_at, history[] }
 *   • liability month (the period the payment is for) and payment date are separate — a March liability paid in April is
 *     reported in March on the liability basis and in April on the payment basis;
 *   • reference is unique per entity + registration + section (case-insensitive);
 *   • a correction is a REVERSAL record (negative amounts, linked to the original) — nothing is deleted or overwritten;
 *   • an optional breakdown (GST heads, PF / ESIC components, PT type) must add up to the principal;
 *   • a missing month in a report means "no recorded payment", never a confirmed nil liability.
 */

'use strict';

const U = require('./util');

const SECTIONS = ['GST', 'TDS', 'Provident Fund', 'ESIC', 'Professional Tax', 'Income Tax', 'ROC / LLP', 'SEBI / exchange', 'FEMA / RBI', 'Other statutory'];
const PAYABLE = SECTIONS.filter(s => s !== 'TDS');
const COMPONENTS = {
  GST: ['igst', 'cgst', 'sgst', 'cess'],
  'Provident Fund': ['ee_pf', 'er_epf', 'er_eps', 'edli', 'admin'],
  ESIC: ['ee', 'er'],
};
const EMPTY = () => ({ payments: [] });
const num = v => (v === '' || v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : NaN);
const isMonth = m => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));

/** task category → report section */
const SECTION_OF_CATEGORY = { GST: 'GST', 'TDS/TCS': 'TDS', 'Provident Fund': 'Provident Fund', ESIC: 'ESIC', 'Professional Tax': 'Professional Tax', 'Income Tax': 'Income Tax',
  'ROC/LLP': 'ROC / LLP', 'SEBI/Exchange': 'SEBI / exchange', 'FEMA/RBI': 'FEMA / RBI' };
const sectionOfCategory = c => SECTION_OF_CATEGORY[c] || 'Other statutory';

function clean(input, { org, existing }) {
  const errors = [];
  const p = {
    entity_id: String(input.entity_id || ''), registration_id: input.registration_id || null, section: String(input.section || ''),
    liability_month: String(input.liability_month || ''), paid_date: String(input.paid_date || ''), reference: String(input.reference || '').trim().slice(0, 100),
    principal: num(input.principal), interest: num(input.interest) ?? 0, fee: num(input.fee) ?? 0, components: {}, notes: String(input.notes || '').slice(0, 2000),
    pt_type: input.pt_type || null, state: input.state || null,
  };
  const ent = org.entities.find(e => e.id === p.entity_id);
  if (!ent) errors.push('Choose the company');
  if (!PAYABLE.includes(p.section)) errors.push(p.section === 'TDS' ? 'TDS is recorded in TDS Section-wise (challan and section allocations), not here' : `Section must be one of: ${PAYABLE.join(', ')}`);
  if (p.registration_id && !org.registrations.some(r => r.id === p.registration_id && r.entity_id === p.entity_id)) errors.push('The registration is not one of this company\'s registrations');
  if (!isMonth(p.liability_month)) errors.push('Liability month is required (YYYY-MM) — the period the payment is for');
  if (!U.isDate(p.paid_date)) errors.push('Payment date is required');
  if (!p.reference) errors.push('Payment reference (challan / CIN / CPIN / TRRN / UTR) is required');
  for (const k of ['principal', 'interest', 'fee']) if (Number.isNaN(p[k])) errors.push(`${k} must be a number`);
  if (p.principal === null) errors.push('Principal / tax amount is required (enter 0 only for a payment of interest or fees alone)');
  if (!existing?.reversal && [p.principal, p.interest, p.fee].some(v => v < 0)) errors.push('Amounts cannot be negative — record a reversal instead');
  const comp = COMPONENTS[p.section];
  if (comp && input.components && Object.values(input.components).some(v => v !== '' && v !== null && v !== undefined)) {
    for (const k of comp) { const n = num(input.components[k]); if (Number.isNaN(n)) errors.push(`${k} must be a number`); else p.components[k] = n ?? 0; }
    const sum = Object.values(p.components).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - (p.principal || 0)) > 0.01) errors.push(`The breakdown adds up to ${sum}, not the principal ${p.principal}`);
  }
  if (p.section === 'Professional Tax' && p.pt_type && !['PTRC', 'PTEC'].includes(p.pt_type)) errors.push('PT type must be PTRC or PTEC');
  if (U.isDate(p.paid_date) && isMonth(p.liability_month) && p.paid_date < `${p.liability_month}-01`) errors.push('The payment date is before the start of the liability month — check the month');
  return { value: p, errors };
}

const refKey = p => `${p.entity_id}|${p.registration_id || ''}|${p.section}|${p.reference.toUpperCase()}`;

function add(doc, input, { org, actor, illustrative = false }) {
  const { value, errors } = clean(input, { org });
  if (errors.length) throw U.httpError(400, errors.join('; '), { errors });
  const dupe = doc.payments.find(x => x.status !== 'reversed' && !x.reversal_of && refKey(x) === refKey(value));
  if (dupe) throw U.httpError(409, `Payment reference ${value.reference} is already recorded for this company, registration and section (${dupe.id})`);
  const now = U.nowIso();
  const rec = { id: U.uid('PY-'), ...value, evidence: [], illustrative, status: 'recorded', reversal_of: null, created_by: actor.name, created_by_id: actor.id, created_at: now, history: [{ at: now, by: actor.name, action: 'recorded' }] };
  doc.payments.push(rec);
  return rec;
}

/** A correction: a reversal record (negative amounts) linked to the original; the original is kept, marked reversed */
function reverse(doc, id, reason, actor) {
  const p = doc.payments.find(x => x.id === id);
  if (!p) throw U.httpError(404, 'Payment not found');
  if (p.status === 'reversed' || p.reversal_of) throw U.httpError(400, 'This payment is already reversed (or is itself a reversal)');
  if (String(reason || '').trim().length < 5) throw U.httpError(400, 'A reason is required');
  const now = U.nowIso();
  const r = { ...U.clone(p), id: U.uid('PY-'), reference: `${p.reference} (reversal)`, principal: -p.principal, interest: -p.interest, fee: -p.fee,
    components: Object.fromEntries(Object.entries(p.components || {}).map(([k, v]) => [k, -v])), status: 'recorded', reversal_of: p.id, notes: reason,
    created_by: actor.name, created_by_id: actor.id, created_at: now, history: [{ at: now, by: actor.name, action: 'reversal', note: reason }] };
  p.status = 'reversed';
  p.history.push({ at: now, by: actor.name, action: 'reversed', note: reason });
  doc.payments.push(r);
  return { original: p, reversal: r };
}

module.exports = { SECTIONS, PAYABLE, COMPONENTS, EMPTY, clean, add, reverse, sectionOfCategory, isMonth, num };
