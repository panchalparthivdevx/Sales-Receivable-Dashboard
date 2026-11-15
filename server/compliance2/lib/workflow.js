/**
 * Task workflow — maker / checker / filer / verifier, enforced here (on the server), whatever the screen shows.
 *
 *   Not started → In progress → Ready for review ─┬─ Changes requested → (back to the maker)
 *                                                  └─ Approved to file → Filed awaiting verification ─┬─ Completed (closed, locked)
 *                                                                                                       └─ back to Approved to file
 * Rules:
 *   • The checker who approves the filing pack (or asks for changes) is not the person who prepared it.
 *   • The filer records the actual submission (date and time, acknowledgement / challan reference, amounts). Uploading a
 *     document never marks anything filed.
 *   • The verifier who closes is neither the preparer nor the filer, ticks that the acknowledgement was checked, and
 *     cannot close while mandatory evidence is missing — unless a missing-evidence exception was approved (with a reason)
 *     by an approver other than the person who asked for it.
 *   • A completed task is locked. Re-opening (a revised return or a correction) creates a NEW task version next to it;
 *     the original stays as filed.
 *   • Every action carries the task's `rev`: an action based on an older view of the task is refused (409).
 */

'use strict';

const U = require('./util');
const T = require('./tasks');

const TRANSITIONS = {
  start:           { from: ['not_started', 'changes_requested'], to: 'in_progress', right: 'prepare', label: 'Start work' },
  submit:          { from: ['not_started', 'in_progress', 'changes_requested'], to: 'ready_for_review', right: 'prepare', label: 'Submit for review' },
  request_changes: { from: ['ready_for_review'], to: 'changes_requested', right: 'review', note: true, notPreparer: true, label: 'Request changes' },
  approve_filing:  { from: ['ready_for_review'], to: 'approved_to_file', right: 'review', notPreparer: true, label: 'Approve to file' },
  record_filing:   { from: ['approved_to_file'], to: 'filed_awaiting_verification', right: 'file', label: 'Record filing / payment' },
  return_to_filer: { from: ['filed_awaiting_verification'], to: 'approved_to_file', right: 'verify', note: true, notPreparer: true, notFiler: true, label: 'Send back to filer' },
  verify_close:    { from: ['filed_awaiting_verification'], to: 'completed', right: 'verify', notPreparer: true, notFiler: true, label: 'Verify acknowledgement & close' },
};

const num = v => (v === '' || v === null || v === undefined ? 0 : Number(v));
const AMOUNT_KEYS = ['tax', 'interest', 'late_fee', 'penalty', 'other'];

/** Validates the filing record of record_filing → { filing, warnings } */
function cleanFiling(t, input, nowMs) {
  const errors = [], warnings = [];
  const f = input || {};
  const at = Date.parse(f.filed_at);
  if (!f.filed_at || Number.isNaN(at)) errors.push(`${t.nature === 'payment' ? 'Payment' : 'Filing'} date and time is required`);
  else if (!/[+-]\d{2}:\d{2}$|Z$/.test(f.filed_at)) errors.push('Filing time must include its time zone (the screen sends Indian time, +05:30)');
  else if (at > nowMs + 5 * 60000) errors.push('The filing date and time is in the future');
  const isPayment = t.nature === 'payment';
  const isInternal = t.nature === 'internal';
  const nil = !!f.nil_return;
  const ack = String(f.ack_no || '').trim().slice(0, 100);
  if (!isInternal && !isPayment && !ack) errors.push(`The ${t.filing_ack === 'ARN' ? 'ARN' : t.filing_ack === 'SRN' ? 'SRN' : t.filing_ack === 'TRRN' ? 'TRRN' : 'acknowledgement / reference number'} is required`);
  const p = f.payment || {};
  const amounts = {};
  for (const k of AMOUNT_KEYS) {
    const n = num(p.amounts?.[k]);
    if (!Number.isFinite(n) || n < 0) errors.push(`${k.replace('_', ' ')} must be a positive amount or blank`);
    amounts[k] = Math.round(n * 100) / 100;
  }
  const paid = AMOUNT_KEYS.some(k => amounts[k] > 0);
  const payment = { date: p.date || null, ref_type: String(p.ref_type || '').slice(0, 30), reference: String(p.reference || '').trim().slice(0, 100), bsr_code: String(p.bsr_code || '').trim(), challan_serial: String(p.challan_serial || '').trim(), amounts };
  if (isPayment && !nil && !paid) errors.push('Enter the amount paid (or tick "nil" with a remark if nothing was payable)');
  if (paid || isPayment) {
    if (!nil || paid) {
      if (!U.isDate(payment.date)) errors.push('Payment date is required');
      if (!payment.reference) errors.push('Payment reference (challan / CIN / CPIN / TRRN / UTR) is required');
    }
  }
  if (t.payment_ref === 'TDS' && paid) {
    if (payment.bsr_code && !/^\d{7}$/.test(payment.bsr_code)) warnings.push('BSR code is usually 7 digits');
    if (payment.challan_serial && !/^\d{5}$/.test(payment.challan_serial)) warnings.push('Challan serial number is usually 5 digits');
    if (!payment.bsr_code || !payment.challan_serial) warnings.push('BSR code and challan serial number not recorded');
  }
  if (nil && !String(f.remarks || '').trim()) errors.push('A nil filing needs a remark');
  if (errors.length) throw U.httpError(400, errors.join('; '), { errors });
  const filing = {
    filed_at: new Date(at).toISOString(), filed_on: new Date(at + U.IST_MS).toISOString().slice(0, 10), ack_type: t.filing_ack, ack_no: ack,
    portal_status: String(f.portal_status || '').slice(0, 100), nil_return: nil, payment: paid || isPayment ? payment : null, remarks: String(f.remarks || '').slice(0, 2000), warnings,
  };
  return { filing, warnings };
}

function checkRev(t, rev) {
  if (rev === undefined || rev === null || Number(rev) !== t.rev) {
    throw U.httpError(409, `This task was changed by ${t.updated_by || 'someone'} since you opened it (now version ${t.rev}). Reload it and try again.`, { current_rev: t.rev });
  }
}

/**
 * Apply a workflow action. ctx: { actor, docs (linked documents), nowMs }. Returns { task, warnings, revision? }.
 * For 'reopen' the caller stores the returned revision task in the same FY document.
 */
function act(t, action, input, ctx) {
  const { actor } = ctx;
  checkRev(t, input?.rev);
  const tr = TRANSITIONS[action];
  const can = r => !!actor.rights?.[r];
  const warnings = [];
  const note = String(input?.note || '').trim().slice(0, 2000);
  if (tr) {
    if (t.locked) throw U.httpError(400, 'This task is closed and locked. Re-open it (creates a new version) to change anything.');
    if (!can(tr.right)) throw U.httpError(403, `"${tr.label}" needs the ${tr.right} right`);
    if (!tr.from.includes(t.status)) throw U.httpError(400, `"${tr.label}" is not possible while the task is "${T.STATUS[t.status]}"`);
    if (tr.note && !note) throw U.httpError(400, 'A note is required');
    if (tr.notPreparer && t.workflow?.prepared_by_id && t.workflow.prepared_by_id === actor.id) throw U.httpError(403, 'You prepared this task, so you cannot review or verify it — an independent person must');
    if (tr.notFiler && t.workflow?.filed_by_id && t.workflow.filed_by_id === actor.id) throw U.httpError(403, 'You recorded the filing, so you cannot verify it — an independent person must');
    const docs = ctx.docs || [];
    const present = new Set(docs.filter(d => d.status === 'active' && d.current?.scan_status !== 'infected').map(d => d.doc_type));
    if (action === 'submit') {
      const need = (t.evidence_rule?.review || []).filter(k => !present.has(k));
      if (need.length) throw U.httpError(400, `Upload the ${need.join(', ').replace(/_/g, ' ')} before submitting for review`);
      t.workflow = { ...t.workflow, prepared_by: actor.name, prepared_by_id: actor.id, submitted_at: U.nowIso() };
    }
    if (action === 'start' && !t.workflow?.started_at) t.workflow = { ...t.workflow, started_by: actor.name, started_at: U.nowIso() };
    if (action === 'request_changes') t.workflow = { ...t.workflow, changes_requested_by: actor.name, changes_requested_at: U.nowIso(), last_change_request: note };
    if (action === 'approve_filing') t.workflow = { ...t.workflow, checked_by: actor.name, checked_by_id: actor.id, checked_at: U.nowIso(), check_note: note };
    if (action === 'record_filing') {
      const r = cleanFiling(t, input?.filing, ctx.nowMs);
      t.filing = r.filing;
      warnings.push(...r.warnings);
      t.workflow = { ...t.workflow, filed_by: actor.name, filed_by_id: actor.id, filed_recorded_at: U.nowIso() };
    }
    if (action === 'return_to_filer') t.workflow = { ...t.workflow, returned_by: actor.name, returned_at: U.nowIso(), return_note: note };
    if (action === 'verify_close') {
      if (input?.ack_verified !== true) throw U.httpError(400, 'Tick that you checked the acknowledgement / challan against the portal before closing');
      if (!t.filing?.filed_at) throw U.httpError(400, 'There is no filing record to verify');
      const missing = T.requiredDocs(t).filter(k => !present.has(k));
      if (missing.length && t.exception?.status !== 'approved') {
        throw U.httpError(400, `Mandatory evidence is missing: ${missing.join(', ').replace(/_/g, ' ')}. Upload it, or ask for an exception (with a reason) and have it approved.`, { missing });
      }
      t.workflow = { ...t.workflow, verified_by: actor.name, verified_by_id: actor.id, verified_at: U.nowIso(), verify_note: note };
      t.locked = true;
      t.closed_at = U.nowIso();
    }
    const from = t.status;
    t.status = tr.to;
    T.hist(t, actor, action, note, { from, to: tr.to });
  } else if (action === 'request_exception') {
    if (t.locked) throw U.httpError(400, 'This task is closed');
    if (!can('prepare') && !can('file')) throw U.httpError(403, 'Asking for an exception needs the prepare or file right');
    if (note.length < 10) throw U.httpError(400, 'Explain why the evidence is missing (at least a sentence)');
    const missing = T.requiredDocs(t).filter(k => !(ctx.docs || []).some(d => d.status === 'active' && d.doc_type === k));
    if (!missing.length) throw U.httpError(400, 'No mandatory evidence is missing');
    t.exception = { status: 'requested', missing, reason: note, requested_by: actor.name, requested_by_id: actor.id, requested_at: U.nowIso() };
    T.hist(t, actor, 'exception_requested', note);
  } else if (action === 'decide_exception') {
    if (!can('approve')) throw U.httpError(403, 'Deciding an exception needs the approve right');
    if (t.exception?.status !== 'requested') throw U.httpError(400, 'There is no open exception request');
    if (t.exception.requested_by_id === actor.id) throw U.httpError(403, 'You asked for this exception, so another approver must decide it');
    if (!['approve', 'reject'].includes(input?.decision)) throw U.httpError(400, 'decision must be approve or reject');
    if (!note) throw U.httpError(400, 'A note is required');
    t.exception = { ...t.exception, status: input.decision === 'approve' ? 'approved' : 'rejected', decided_by: actor.name, decided_by_id: actor.id, decided_at: U.nowIso(), decision_note: note };
    T.hist(t, actor, `exception_${t.exception.status}`, note);
  } else if (action === 'reopen') {
    if (!can('approve')) throw U.httpError(403, 'Re-opening a closed task needs the approve right');
    if (t.status !== 'completed') throw U.httpError(400, 'Only a completed task can be re-opened');
    if (t.revised_by_task) throw U.httpError(400, `This filing already has a newer version (${t.revised_by_task})`);
    if (note.length < 10) throw U.httpError(400, 'Explain why it is re-opened (revised return, correction …)');
    const kind = input?.kind === 'correction' ? 'correction' : 'revised_return';
    const rv = U.clone(t);
    const now = U.nowIso();
    Object.assign(rv, {
      id: T.taskId(t.fy), identity: T.identity(t.scope_type, t.scope_id, t.rule_id, t.period_key, t.filing_version + 1), filing_version: t.filing_version + 1,
      revision_of: t.id, revision_kind: kind, revision_reason: note, revised_by_task: null, status: 'in_progress', locked: false, closed_at: null,
      workflow: { started_by: actor.name, started_at: now }, filing: null, exception: null, rev: 1, created_at: now, created_by: actor.name, updated_at: now, updated_by: actor.name,
      history: [{ at: now, by: actor.name, by_id: actor.id, action: 'revision_created', note: `${kind === 'correction' ? 'Correction' : 'Revised return'} of ${t.id} (version ${t.filing_version}): ${note}` }],
    });
    t.revised_by_task = rv.id;
    T.hist(t, actor, 'reopened', `New version ${rv.filing_version} created as ${rv.id}: ${note}`);
    t.rev++; t.updated_at = now; t.updated_by = actor.name;
    return { task: t, revision: rv, warnings };
  } else {
    throw U.httpError(400, `Unknown action "${action}"`);
  }
  t.rev++;
  t.updated_at = U.nowIso();
  t.updated_by = actor.name;
  return { task: t, warnings };
}

const EDITABLE = ['owner_id', 'backup_owner_id', 'checker_id', 'priority', 'remarks', 'internal_target_override'];

/** Edit planning fields (people, priority, remarks, internal target) or enter a manual due date */
function edit(t, patch, { actor, nameOf }) {
  checkRev(t, patch?.rev);
  if (t.locked) throw U.httpError(400, 'This task is closed and locked');
  const isOwner = actor.id && (t.owner_id === actor.id || t.backup_owner_id === actor.id);
  if (!actor.rights.master && !(actor.rights.prepare && isOwner)) throw U.httpError(403, 'Editing a task needs the master-data right, or the prepare right as its owner');
  const changes = [];
  for (const k of Object.keys(patch)) {
    if (k === 'rev' || k === 'manual_due' || k === 'reason') continue;
    if (!EDITABLE.includes(k)) throw U.httpError(400, `"${k}" cannot be edited here`);
    if (['owner_id', 'backup_owner_id', 'checker_id'].includes(k) && !actor.rights.master) throw U.httpError(403, 'Assigning people needs the master-data right');
    if (k === 'priority' && !['high', 'medium', 'low'].includes(patch[k])) throw U.httpError(400, 'priority must be high, medium or low');
    if (k === 'internal_target_override' && patch[k] && !U.isDate(patch[k])) throw U.httpError(400, 'Internal target must be a date');
    const v = k === 'remarks' ? String(patch[k] || '').slice(0, 4000) : patch[k] || '';
    if (t[k] !== v) { changes.push({ field: k, from: t[k], to: v }); t[k] = v; }
  }
  if (patch.manual_due !== undefined) {
    if (!actor.rights.master) throw U.httpError(403, 'Entering a due date needs the master-data right');
    if (t.original_due && t.due_source !== 'manual') throw U.httpError(400, 'This task\'s due date comes from its rule. Change the rule (new version) or record an approved extension instead.');
    if (!U.isDate(patch.manual_due)) throw U.httpError(400, 'Due date must be a date');
    if (!String(patch.reason || '').trim()) throw U.httpError(400, 'Say where the due date comes from (the notice, order, contract …)');
    changes.push({ field: 'original_due', from: t.original_due, to: patch.manual_due });
    Object.assign(t, { original_due: patch.manual_due, due_source: 'manual', due_basis: `Entered by ${actor.name}: ${String(patch.reason).slice(0, 300)}`, due_pending: '', due_error: '' });
  }
  if (changes.some(c => c.field.endsWith('_id'))) { t.owner_name = nameOf(t.owner_id); t.backup_owner_name = nameOf(t.backup_owner_id); t.checker_name = nameOf(t.checker_id); }
  if (changes.some(c => c.field === 'internal_target_override' || c.field === 'original_due')) T.setInternalTarget(t, null);
  if (!changes.length) return { task: t, changes };
  T.hist(t, actor, 'edited', changes.map(c => `${c.field}: ${c.from || '—'} → ${c.to || '—'}`).join('; '));
  t.rev++; t.updated_at = U.nowIso(); t.updated_by = actor.name;
  return { task: t, changes };
}

/** Which actions this actor could take on this task now (for the screen; the server re-checks everything) */
function available(t, actor) {
  const out = [];
  for (const [k, tr] of Object.entries(TRANSITIONS)) {
    if (t.locked || !tr.from.includes(t.status) || !actor.rights?.[tr.right]) continue;
    const blockedBy = (tr.notPreparer && t.workflow?.prepared_by_id === actor.id) ? 'you prepared it' : (tr.notFiler && t.workflow?.filed_by_id === actor.id) ? 'you recorded the filing' : null;
    out.push({ action: k, label: tr.label, note: !!tr.note, blocked: blockedBy });
  }
  if (!t.locked && (actor.rights?.prepare || actor.rights?.file) && t.exception?.status !== 'requested' && t.exception?.status !== 'approved') out.push({ action: 'request_exception', label: 'Ask for missing-evidence exception', note: true });
  if (t.exception?.status === 'requested' && actor.rights?.approve) out.push({ action: 'decide_exception', label: 'Decide exception', note: true, blocked: t.exception.requested_by_id === actor.id ? 'you asked for it' : null });
  if (t.status === 'completed' && !t.revised_by_task && actor.rights?.approve) out.push({ action: 'reopen', label: 'Re-open (new version)', note: true });
  return out;
}

module.exports = { TRANSITIONS, act, edit, available, cleanFiling, checkRev };
