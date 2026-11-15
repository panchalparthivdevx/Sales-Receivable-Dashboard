/**
 * Overview (CFO dashboard) figures — always computed from the task records that passed the current filters.
 *
 *   • Exclusive workflow states (each task is in exactly one) are kept apart from FLAGS (a task can be overdue AND
 *     missing evidence AND awaiting review at the same time) — the two are reported separately.
 *   • Completion = completed ÷ statutory obligations in the filter (numerator and denominator are given). It says nothing
 *     about filing timeliness: on-time filing = filed on or before the effective statutory due date ÷ filed tasks with a
 *     known due date. Review completion = verified and closed ÷ filed. Internal controls are counted separately.
 *   • A category with no tasks is "not configured", never 100 %. Revisions (re-opened filings) are not extra obligations.
 *   • Money: only what filing records say was paid (by payment date). Unpaid liabilities need liability data — reported
 *     as not available, never estimated.
 */

'use strict';

const CAT = require('./catalogue');

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const ratio = (n, d, note) => ({ numerator: n, denominator: d, pct: pct(n, d), note });

function score(t) {
  if (t.overdue) return 1000 + Math.min(500, t.days_overdue);
  if (t.status === 'ready_for_review' || t.status === 'filed_awaiting_verification') return 600 - Math.max(0, t.days_to_due ?? 30);
  if (t.due_soon) return 500 - t.days_to_due;
  if (t.evidence_missing) return 400;
  if (t.exception?.status === 'requested') return 350;
  if (t.no_due_date) return 100;
  return 0;
}

function summarise(list) {
  const n = f => list.filter(f).length;
  return {
    total: list.length, completed: n(t => t.status === 'completed'), overdue: n(t => t.overdue), due_soon: n(t => t.due_soon),
    review: n(t => t.status === 'ready_for_review' || t.status === 'filed_awaiting_verification'), missing_evidence: n(t => t.evidence_missing), no_due_date: n(t => t.no_due_date),
  };
}

/** tasks: derived tasks (tasks.derive) the user may see, already filtered. entities: [{ id, legal_name, short_code }] */
function overview(tasks, { entities = [], registrations = [], sample = false, asOf, soonDays = 7 } = {}) {
  const originals = tasks.filter(t => t.filing_version === 1);
  const statutory = originals.filter(t => !t.internal);
  const internal = originals.filter(t => t.internal);
  const s = summarise(statutory);
  const filed = statutory.filter(t => t.filed);
  const filedWithDue = filed.filter(t => t.effective_due);
  const states = Object.fromEntries(['not_started', 'in_progress', 'ready_for_review', 'changes_requested', 'approved_to_file', 'filed_awaiting_verification', 'completed'].map(k => [k, statutory.filter(t => t.status === k).length]));
  const flagKeys = ['overdue', 'due_soon', 'evidence_missing', 'no_due_date', 'missing_rule', 'rule_unverified', 'filed_late', 'document_flags'];
  const flags = Object.fromEntries(flagKeys.map(k => [k, statutory.filter(t => t.flags.includes(k)).length]));
  const categories = CAT.CATEGORIES.map(c => {
    const list = originals.filter(t => t.category === c);
    const sm = summarise(list);
    return { category: c, configured: list.length > 0, ...sm, completion: list.length ? ratio(sm.completed, sm.total) : null, internal_only: list.length > 0 && list.every(t => t.internal) };
  });
  const companies = entities.map(e => {
    const list = statutory.filter(t => t.entity_id === e.id);
    const sm = summarise(list);
    const regs = registrations.filter(r => r.entity_id === e.id && r.status !== 'inactive');
    const withTasks = regs.filter(r => originals.some(t => t.registration_id === r.id)).length;
    return { entity_id: e.id, name: e.legal_name, short_code: e.short_code, data_status: e.data_status, ...sm, completion: list.length ? ratio(sm.completed, sm.total) : null,
      registrations: ratio(withTasks, regs.length, 'registrations that have tasks ÷ active registrations') };
  });
  const queue = statutory.concat(internal).filter(t => t.status !== 'completed').map(t => ({ t, s: score(t) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || String(a.t.effective_due || '9').localeCompare(String(b.t.effective_due || '9'))).slice(0, 60).map(x => x.t.id);
  // money: only recorded payments
  const paid = { total: 0, count: 0, by_category: {} };
  for (const t of statutory) {
    const p = t.filing?.payment;
    if (!p?.date) continue;
    const amt = Object.values(p.amounts || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    if (!amt) continue;
    paid.total += amt; paid.count++;
    paid.by_category[t.category] = (paid.by_category[t.category] || 0) + amt;
  }
  return {
    as_of: asOf, sample, soon_days: soonDays,
    totals: { obligations: s.total, ...s, open: s.total - s.completed, filed: filed.length, internal_controls: internal.length, revisions_in_progress: tasks.filter(t => t.filing_version > 1 && t.status !== 'completed').length },
    completion: ratio(s.completed, s.total, 'completed ÷ statutory obligations in the current filter (not a statement of legal compliance)'),
    on_time: ratio(filedWithDue.filter(t => t.on_time).length, filedWithDue.length, `filed on or before the effective statutory due date ÷ filed tasks with a known due date${filed.length - filedWithDue.length ? ` (${filed.length - filedWithDue.length} filed without a due date are left out)` : ''}`),
    review_completion: ratio(s.completed, filed.length, 'verified and closed ÷ filed'),
    internal: { ...summarise(internal), completion: internal.length ? ratio(summarise(internal).completed, internal.length) : null },
    states, flags, categories, companies, queue,
    payments: { ...paid, note: sample ? 'Sample amounts in demo records — not real payments.' : 'Only amounts recorded on filing records, by payment date. Unpaid liabilities need liability data and are not available.' },
  };
}

module.exports = { overview, ratio, pct };
