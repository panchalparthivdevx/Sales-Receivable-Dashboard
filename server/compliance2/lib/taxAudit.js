/**
 * Annual tax-audit working papers (V10): liability lots, paid challans allocated to lots, and the schedules
 *   • Employee contributions — legacy Form 3CD clause 20(b) / section 36(1)(va)
 *   • Opening employer liabilities — clause 26(A) (section 43B)
 *   • Current-year employer liabilities — clause 26(B) (section 43B, paid by 31 March / after year-end up to the
 *     company's verified section 139(1) cut-off / beyond)
 * These are REVIEW working papers, not filed forms. FY 2025-26 uses legacy Form 3CD labels; from tax year 2026-27 the
 * Income-tax Act, 2025 forms apply and the mapping is shown as NOT VERIFIED until someone checks the current form.
 *
 * Store document "<sp>_taxaudit": { lots: [], payments: [], settings: { "<entity>|<fy>": { cutoff, source, confirmed, reviewer } } }
 * Lot: { id, entity_id, registration_id, fy, opening, kind, month (wage month), received (date received from employees /
 *        incurred), baseline (original statutory due date), extended, due_source, due_verified, deduction ('yes'|'no'),
 *        classification ('pending'|'approved'), prior (opening: earlier tax treatment), state (PT), amount, history[] }
 * Payment: { id, entity_id, reference, paid_date, basis ('paid_challan'|'trrn_only'), proof [file ids], total,
 *            allocations [{ lot_id, amount }], recorded_by(_id), verified, verified_by(_id), history[] }
 *   • allocations never exceed the payment total or a lot's amount; a lot that has allocations cannot change identity;
 *   • only VERIFIED payments on a paid-challan / bank basis count; TRRN generation alone is not payment;
 *   • a consolidated challan is never spread across employees or lots equally — every allocation is entered explicitly.
 */

'use strict';

const U = require('./util');
const P = require('./payments');

const KINDS = ['Employee PF', 'Employee ESIC', 'Employer EPF', 'Employer EPS', 'PF EDLI', 'PF admin charges', 'Employer ESIC', 'Professional Tax · PTRC', 'Professional Tax · PTEC'];
const isEE = k => k.startsWith('Employee ');
const EMPTY = () => ({ lots: [], payments: [], settings: {} });
const r2 = n => Math.round(n * 100) / 100;

/** Year-specific form label — never present a legacy working paper as a ready-to-file new-year form */
function formFor(fy) {
  const s = U.fyStartYear(fy);
  if (s <= 2025) return { form: 'Form 3CD (Income-tax Act, 1961)', clauses: { employee: 'Clause 20(b)', opening: 'Clause 26(A)', current: 'Clause 26(B)' }, mapped: true, note: 'Legacy Form 3CD clause references, used as working-paper labels.' };
  return { form: 'Tax year 2026-27 onwards — Form 26 (Income-tax Act, 2025)', clauses: { employee: 'Employee contributions (mapping not verified)', opening: 'Opening statutory dues (mapping not verified)', current: 'Current statutory dues (mapping not verified)' }, mapped: false,
    note: 'UNMAPPED YEAR: the Income-tax Act, 2025 form and clause numbers have not been verified here. These are working papers only — verify the current form and section mapping before any export is used for filing.' };
}

function lotErrors(l, doc) {
  const errors = [];
  const { start, end } = U.fyBounds(l.fy);
  if (!l.registration_id || l.amount === null || Number.isNaN(l.amount) || !l.received || !P.isMonth(l.month)) errors.push('Enter registration, amount, wage month and actual receipt / incurrence date.');
  if (l.amount !== null && l.amount < 0) errors.push('Amount cannot be negative');
  if (!KINDS.includes(l.kind)) errors.push(`Kind must be one of: ${KINDS.join(', ')}`);
  if (l.received && !U.isDate(l.received)) errors.push('Receipt / incurrence date is not a date');
  if (l.opening && l.received >= start) errors.push('An opening liability must exist before 1 April.');
  if (!l.opening && l.received && (l.received < start || l.received > end)) errors.push('A current-year receipt / liability date must fall within the selected FY.');
  if (l.opening && isEE(l.kind)) errors.push('Employee PF / ESIC is not an employer opening 43B liability.');
  if (l.kind.startsWith('Professional') && !l.state) errors.push('Enter the PT state / jurisdiction.');
  if (l.due_verified && (!l.baseline || !l.due_source)) errors.push('A verified due date needs the original due date and its source / notification reference.');
  if (l.baseline && !U.isDate(l.baseline)) errors.push('Original due date is not a date');
  if (l.extended && (!U.isDate(l.extended) || !l.due_source || l.extended < l.baseline)) errors.push('Give the notification reference and an extension not before the original due date.');
  if (doc.lots.some(x => x.id !== l.id && x.status !== 'withdrawn' && x.entity_id === l.entity_id && x.registration_id === l.registration_id && x.kind === l.kind && x.fy === l.fy && x.month === l.month && x.opening === l.opening && (x.state || '') === (l.state || '')))
    errors.push('Duplicate monthly component. Edit the existing liability.');
  return errors;
}

const allocatedTo = (doc, lotId, exceptPayment) => r2(doc.payments.filter(p => p.status !== 'reversed' && p.id !== exceptPayment).flatMap(p => p.allocations).filter(a => a.lot_id === lotId).reduce((s, a) => s + a.amount, 0));

function saveLot(doc, input, { org, actor, id }) {
  const old = id ? doc.lots.find(x => x.id === id) : null;
  if (id && !old) throw U.httpError(404, 'Liability not found');
  const l = {
    id: old?.id, entity_id: String(input.entity_id || ''), registration_id: String(input.registration_id || ''), fy: String(input.fy || ''), opening: !!input.opening, kind: String(input.kind || ''),
    month: String(input.month || ''), received: String(input.received || ''), baseline: input.baseline || '', extended: input.extended || '', due_source: String(input.due_source || '').trim().slice(0, 300),
    due_verified: !!input.due_verified, deduction: input.deduction === 'yes' ? 'yes' : 'no', classification: old?.classification || 'pending',
    prior: String(input.prior || '').slice(0, 300), state: String(input.state || '').trim().slice(0, 40), amount: P.num(input.amount), notes: String(input.notes || '').slice(0, 2000),
  };
  if (!U.validFy(l.fy)) throw U.httpError(400, 'Choose the financial year');
  if (!org.entities.some(e => e.id === l.entity_id)) throw U.httpError(400, 'Choose the company');
  if (!org.registrations.some(r => r.id === l.registration_id && r.entity_id === l.entity_id)) throw U.httpError(400, 'Choose one of this company\'s registrations');
  const errors = lotErrors(l, doc);
  const allocated = old ? allocatedTo(doc, old.id) : 0;
  if (allocated && old && ['entity_id', 'registration_id', 'fy', 'month', 'kind', 'opening', 'state'].some(k => old[k] !== l[k])) errors.push('An allocated liability cannot change its company, registration, year, month, kind or state — correct the payment allocations first.');
  if (l.amount !== null && l.amount < allocated) errors.push(`The liability cannot be below its existing payment allocations (${allocated}).`);
  // the classification is approved only by approveLot (another person); a change to what was approved sends it back to pending
  if (old && old.classification === 'approved' && ['amount', 'baseline', 'extended', 'due_source', 'deduction', 'received'].some(k => JSON.stringify(old[k]) !== JSON.stringify(l[k]))) l.classification = 'pending';
  if (errors.length) throw U.httpError(400, errors.join(' '), { errors });
  const now = U.nowIso();
  if (!old) {
    const rec = { ...l, id: U.uid('LT-'), status: 'active', original_amount: l.amount, created_by: actor.name, created_by_id: actor.id, created_at: now, history: [{ at: now, by: actor.name, action: 'created', amount: l.amount }] };
    doc.lots.push(rec);
    return rec;
  }
  const changed = Object.keys(l).filter(k => k !== 'id' && JSON.stringify(old[k]) !== JSON.stringify(l[k]));
  old.history.push({ at: now, by: actor.name, action: 'edited', fields: changed, before: Object.fromEntries(changed.map(k => [k, old[k]])) });
  Object.assign(old, l);
  return old;
}

/** A reviewer (not the person who entered the lot) approves the classification */
function approveLot(doc, id, actor) {
  const l = doc.lots.find(x => x.id === id);
  if (!l) throw U.httpError(404, 'Liability not found');
  if (l.created_by_id === actor.id) throw U.httpError(403, 'You entered this liability, so another person must approve its classification');
  l.classification = 'approved';
  l.history.push({ at: U.nowIso(), by: actor.name, action: 'classification_approved' });
  return l;
}

function savePayment(doc, input, { org, actor, id }) {
  const old = id ? doc.payments.find(x => x.id === id) : null;
  if (id && !old) throw U.httpError(404, 'Payment not found');
  if (old?.verified) throw U.httpError(400, 'A verified payment is locked — un-verify it first (a reviewer action)');
  const p = { entity_id: String(input.entity_id || ''), reference: String(input.reference || '').trim().slice(0, 100), paid_date: String(input.paid_date || ''), basis: input.basis === 'trrn_only' ? 'trrn_only' : 'paid_challan',
    total: P.num(input.total), proof: Array.isArray(input.proof) ? input.proof.map(String) : (old?.proof || []),
    allocations: (Array.isArray(input.allocations) ? input.allocations : []).map(a => ({ lot_id: String(a.lot_id || ''), amount: P.num(a.amount) })).filter(a => a.amount !== null && a.amount > 0) };
  const errors = [];
  if (!org.entities.some(e => e.id === p.entity_id)) errors.push('Choose the company');
  if (!p.reference) errors.push('Payment reference (challan / TRRN / CIN / UTR) is required');
  if (!U.isDate(p.paid_date)) errors.push('Actual payment date is required');
  if (p.total === null || Number.isNaN(p.total) || p.total <= 0) errors.push('Paid / challan total is required');
  if (doc.payments.some(x => x.id !== old?.id && x.status !== 'reversed' && x.entity_id === p.entity_id && x.reference.toUpperCase() === p.reference.toUpperCase())) errors.push('This payment reference already exists.');
  if (!p.allocations.length) errors.push('Allocate at least one liability component.');
  if (new Set(p.allocations.map(a => a.lot_id)).size !== p.allocations.length) errors.push('Each liability appears once per payment.');
  if (p.allocations.reduce((s, a) => s + a.amount, 0) > (p.total || 0) + 0.001) errors.push('Allocations exceed the paid / challan total.');
  for (const a of p.allocations) {
    const l = doc.lots.find(x => x.id === a.lot_id && x.status !== 'withdrawn');
    if (!l) { errors.push(`Liability ${a.lot_id} not found`); continue; }
    if (l.entity_id !== p.entity_id) errors.push('Every allocation must belong to the selected company.');
    if (r2(a.amount + allocatedTo(doc, l.id, old?.id)) > l.amount + 0.001) errors.push(`Allocation exceeds the remaining liability of ${l.kind} ${l.month} (${r2(l.amount - allocatedTo(doc, l.id, old?.id))} left).`);
    if (U.isDate(p.paid_date) && (p.paid_date < l.received || (l.opening && p.paid_date < U.fyBounds(l.fy).start))) errors.push(`The payment date precedes the liability ${l.kind} ${l.month} or its schedule period.`);
  }
  if (errors.length) throw U.httpError(400, U.uniq(errors).join(' '), { errors });
  const now = U.nowIso();
  if (!old) {
    const rec = { id: U.uid('TP-'), ...p, status: 'recorded', verified: false, recorded_by: actor.name, recorded_by_id: actor.id, created_at: now, history: [{ at: now, by: actor.name, action: 'recorded' }] };
    doc.payments.push(rec);
    return rec;
  }
  Object.assign(old, p);
  old.history.push({ at: now, by: actor.name, action: 'edited' });
  return old;
}

/** Verification by someone other than the person who recorded it; needs a paid-challan / bank basis and proof */
function verifyPayment(doc, id, verified, actor) {
  const p = doc.payments.find(x => x.id === id);
  if (!p || p.status === 'reversed') throw U.httpError(404, 'Payment not found');
  if (p.recorded_by_id === actor.id) throw U.httpError(403, 'You recorded this payment, so another person must verify it');
  if (verified) {
    if (p.basis === 'trrn_only') throw U.httpError(400, 'TRRN generation is not payment — verify against the paid challan / bank statement');
    if (!p.proof.length) throw U.httpError(400, 'Attach the paid challan or bank proof before verifying');
  }
  p.verified = !!verified;
  Object.assign(p, verified ? { verified_by: actor.name, verified_by_id: actor.id, verified_at: U.nowIso() } : { verified_by: null, verified_by_id: null, verified_at: null });
  p.history.push({ at: U.nowIso(), by: actor.name, action: verified ? 'verified' : 'unverified' });
  return p;
}

function reversePayment(doc, id, reason, actor) {
  const p = doc.payments.find(x => x.id === id);
  if (!p || p.status === 'reversed') throw U.httpError(404, 'Payment not found');
  if (String(reason || '').trim().length < 5) throw U.httpError(400, 'A reason is required');
  p.status = 'reversed';
  p.history.push({ at: U.nowIso(), by: actor.name, action: 'reversed', note: reason });
  return p;
}

function saveSettings(doc, input, actor) {
  const fy = String(input.fy || '');
  if (!U.validFy(fy)) throw U.httpError(400, 'Choose the financial year');
  const cutoff = String(input.cutoff || '');
  if (!U.isDate(cutoff) || cutoff <= U.fyBounds(fy).end) throw U.httpError(400, 'The return due date (section 139(1) cut-off) must be a date after the FY end.');
  if (!String(input.source || '').trim()) throw U.httpError(400, 'Give the source of the cut-off (notification / circular / audit applicability)');
  const source = String(input.source).trim().slice(0, 300);
  const key = `${input.entity_id}|${fy}`;
  const old = doc.settings[key];
  const same = old && old.cutoff === cutoff && old.source === source;
  if (input.confirmed && !same) throw U.httpError(400, 'Save the cut-off first; another person then confirms it');
  if (input.confirmed && old.set_by_id === actor.id) throw U.httpError(403, 'You set this cut-off, so another person must confirm it');
  doc.settings[key] = same && input.confirmed
    ? { ...old, confirmed: true, confirmed_by: actor.name, confirmed_by_id: actor.id, confirmed_at: U.nowIso() }
    : { entity_id: input.entity_id, fy, cutoff, source, confirmed: false, set_by: actor.name, set_by_id: actor.id, at: U.nowIso() };
  return doc.settings[key];
}

// ── Schedules ─────────────────────────────────────────────────────────────────
function paidFor(doc, l, asOf, includeUnverified = false) {
  return doc.payments.filter(p => p.status !== 'reversed' && p.entity_id === l.entity_id && p.paid_date <= asOf && (includeUnverified || (p.verified && p.basis !== 'trrn_only')))
    .flatMap(p => p.allocations.filter(a => a.lot_id === l.id).map(a => ({ amount: a.amount, paid: p.paid_date, ref: p.reference, verified: p.verified, basis: p.basis, payment_id: p.id })))
    .sort((a, b) => a.paid.localeCompare(b.paid));
}

/** Employee contribution 20(b): each allocation judged on its own date; on the due date = on time */
function employee(doc, l, asOf) {
  const due = l.extended || l.baseline || null;
  const ps = paidFor(doc, l, asOf);
  const paid = r2(ps.reduce((s, p) => s + p.amount, 0));
  const on = due ? r2(ps.filter(p => p.paid <= due).reduce((s, p) => s + p.amount, 0)) : null;
  const late = due ? r2(ps.filter(p => p.paid > due).reduce((s, p) => s + p.amount, 0)) : null;
  const unpaid = r2(Math.max(0, l.amount - paid));
  const overdue = due && asOf > due ? unpaid : 0;
  const ready = !!due && l.due_verified && l.classification === 'approved';
  return { due, due_kind: l.extended ? 'extended' : l.baseline ? 'baseline' : null, payments: ps.map(p => ({ ...p, delay_days: due ? Math.max(0, U.daysBetween(due, p.paid)) : null })), paid, on, late, unpaid, overdue,
    pending: due && asOf <= due ? unpaid : 0, ready, exposure: ready ? r2((late || 0) + overdue) : null,
    unverified: r2(paidFor(doc, l, asOf, true).filter(p => !p.verified || p.basis === 'trrn_only').reduce((s, p) => s + p.amount, 0)),
    state: !ready ? 'Due date / classification needs review' : late > 0 || overdue > 0 ? 'Late or unpaid after due date' : unpaid > 0 ? 'Pending — not yet due' : 'Paid on or before due date' };
}

/** Section 43B for employer lots — paid in the FY, after year-end up to the cut-off, beyond */
function s43(doc, l, asOf) {
  const { start, end } = U.fyBounds(l.fy);
  const cfg = doc.settings[`${l.entity_id}|${l.fy}`] || {};
  const ps = paidFor(doc, l, asOf);
  const inFY = r2(ps.filter(p => p.paid >= start && p.paid <= end).reduce((s, p) => s + p.amount, 0));
  const before = r2(ps.filter(p => p.paid < start).reduce((s, p) => s + p.amount, 0));
  const after = cfg.cutoff ? r2(ps.filter(p => p.paid > end && p.paid <= cfg.cutoff).reduce((s, p) => s + p.amount, 0)) : null;
  const closing = r2(Math.max(0, l.amount - before - inFY));
  const claimable = l.deduction === 'yes' && l.classification === 'approved';
  const final = !!cfg.cutoff && cfg.confirmed && asOf >= cfg.cutoff;
  return { inFY, after, closing, unpaidCutoff: after === null ? null : r2(Math.max(0, closing - after)), cutoff: cfg.cutoff || null, cutoff_confirmed: !!cfg.confirmed, final, claimable,
    adjustment: claimable && after !== null && final ? r2(Math.max(0, closing - after)) : null,
    state: !claimable ? (l.deduction === 'no' ? 'Not claimed as a deduction — no adjustment' : 'Classification needs review') : !cfg.cutoff ? 'Cut-off not set' : !final ? 'Provisional (before the confirmed cut-off)' : 'Final' };
}

function schedules(doc, { fy, entityIds, registrationIds, asOf, visible = () => true }) {
  const lots = doc.lots.filter(l => l.status !== 'withdrawn' && l.fy === fy && visible(l.entity_id) && (!entityIds?.length || entityIds.includes(l.entity_id)) && (!registrationIds?.length || registrationIds.includes(l.registration_id)));
  const months = Array.from({ length: 12 }, (_, i) => { const [y, m] = U.addMonths(U.fyStartYear(fy), 4, i); return `${y}-${String(m).padStart(2, '0')}`; });
  const ee = lots.filter(l => isEE(l.kind) && !l.opening);
  const groups = U.uniq(ee.map(l => `${l.entity_id}|${l.registration_id}|${l.kind}`));
  const employeeRows = [];
  for (const g of groups) {
    const [e, r, k] = g.split('|');
    const own = ee.filter(l => l.entity_id === e && l.registration_id === r && l.kind === k);
    for (const m of U.uniq([...months, ...own.map(l => l.month)]).sort()) {
      const l = own.find(x => x.month === m);
      employeeRows.push(l ? { entity_id: e, registration_id: r, kind: k, month: m, lot: l, calc: employee(doc, l, asOf) } : { entity_id: e, registration_id: r, kind: k, month: m, lot: null, calc: null, note: 'No input for this month' });
    }
  }
  const opening = lots.filter(l => !isEE(l.kind) && l.opening).map(l => ({ lot: l, calc: s43(doc, l, asOf) }));
  const current = lots.filter(l => !isEE(l.kind) && !l.opening).map(l => ({ lot: l, calc: s43(doc, l, asOf) }));
  const sumOf = (list, f) => r2(list.reduce((s, x) => s + (f(x) || 0), 0));
  const eeLots = employeeRows.filter(x => x.lot);
  return {
    fy, as_of: asOf, form: formFor(fy), months, employee: employeeRows, opening, current,
    kpis: {
      employee_received: sumOf(eeLots, x => x.lot.amount), employee_late: sumOf(eeLots, x => x.calc.late), employee_unpaid: sumOf(eeLots, x => x.calc.unpaid), employee_exposure: sumOf(eeLots.filter(x => x.calc.exposure !== null), x => x.calc.exposure),
      employee_unresolved: eeLots.filter(x => !x.calc.ready).length, missing_months: employeeRows.filter(x => !x.lot).length,
      opening_total: sumOf(opening, x => x.lot.amount), opening_paid: sumOf(opening, x => x.calc.inFY), current_total: sumOf(current, x => x.lot.amount), current_paid_fy: sumOf(current, x => x.calc.inFY),
      current_after: sumOf(current, x => x.calc.after), current_beyond: sumOf(current.filter(x => x.calc.unpaidCutoff !== null), x => x.calc.unpaidCutoff), unverified: sumOf([...eeLots, ...opening, ...current].filter(x => x.calc), x => x.calc.unverified || 0),
    },
    by_kind: KINDS.map(k => { const ls = [...current, ...opening].filter(x => x.lot.kind === k); const es = eeLots.filter(x => x.lot.kind === k); return { kind: k, amount: sumOf([...ls, ...es], x => x.lot.amount), paid_fy: sumOf(ls, x => x.calc.inFY) + sumOf(es, x => x.calc.paid) }; }).filter(x => x.amount > 0),
  };
}

/** Allocation view: every payment with its lines and the unallocated balance */
function allocationView(doc, { entityIds, visible = () => true }) {
  return doc.payments.filter(p => visible(p.entity_id) && (!entityIds?.length || entityIds.includes(p.entity_id))).map(p => {
    const allocated = r2(p.allocations.reduce((s, a) => s + a.amount, 0));
    return { ...p, allocated, unallocated: r2(p.total - allocated), lines: p.allocations.map(a => { const l = doc.lots.find(x => x.id === a.lot_id); return { ...a, kind: l?.kind, month: l?.month, fy: l?.fy, opening: l?.opening }; }) };
  });
}

module.exports = { KINDS, isEE, EMPTY, formFor, saveLot, approveLot, savePayment, verifyPayment, reversePayment, saveSettings, employee, s43, schedules, allocationView, allocatedTo };
