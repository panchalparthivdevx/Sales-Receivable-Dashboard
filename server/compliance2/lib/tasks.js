/**
 * Tasks: generation, due dates, events, derived flags.
 *
 * Identity  scope_type:scope_id | rule | period | r<filing version>, e.g. "registration:R-1a2b|GST-3B-M|M:2026-04|r1".
 *           A GST task is keyed to its GSTIN, a TDS task to its TAN, ITR / advance tax to the entity (PAN), ROC to the
 *           company, labour to the PF / ESIC / PT registration or establishment, DIR-3 KYC to the person. Entity-level
 *           obligations are therefore created once per entity, never once per GSTIN. Generating twice creates nothing
 *           new; a revised return is a new filing version (r2) next to the original, never over it.
 *
 * Dates on a task (kept apart):  original_due (from the rule version)  ·  revised_due (from an approved deadline
 * extension)  ·  internal_target (company's own target)  ·  filing.filed_at (what actually happened).
 * Effective statutory due = revised_due || original_due. Filed and completed tasks keep the dates and rule version
 * they were filed under when a rule changes later.
 *
 * Derived on every read, never stored: overdue, due soon, filed late, no due date, evidence missing.
 */

'use strict';

const U = require('./util');
const DE = require('./dueEngine');
const AP = require('./applicability');
const RU = require('./rules');
const CAT = require('./catalogue');

const STATUS = {
  not_started: 'Not started', in_progress: 'In progress', ready_for_review: 'Ready for review', changes_requested: 'Changes requested',
  approved_to_file: 'Approved to file', filed_awaiting_verification: 'Filed awaiting verification', completed: 'Completed',
};
const FROZEN = ['filed_awaiting_verification', 'completed'];
const taskKey = (sp, fy) => `${sp}_tasks_${fy}`;
const identity = (scopeType, scopeId, ruleId, periodKey, fv = 1) => `${scopeType}:${scopeId}|${ruleId}|${periodKey}|r${fv}`;
// a task id carries its financial year, so it is found without an index: T202627-<random>
const taskId = fy => U.uid(`T${fy.replace('-', '')}-`);
const fyOfTaskId = id => { const m = /^T(\d{4})(\d{2})-[0-9a-f]+$/.exec(String(id)); return m ? `${m[1]}-${m[2]}` : null; };

/** The periods of a rule for one scope and financial year → { periods } or { blocked } */
function periodsFor(rule, scope, fy, events) {
  let freq = rule.frequency;
  if (freq === 'per_registration') {
    freq = scope.registration?.filing_frequency;
    if (!freq) return { blocked: 'The registration has no periodicity recorded', code: 'PERIODICITY_MISSING' };
  }
  if (['monthly', 'quarterly', 'half_yearly', 'annual', 'installments'].includes(freq)) {
    const reg = scope.registration;
    const ps = DE.periodsOf(freq, fy, { months_in_quarter: rule.months_in_quarter, installments: rule.installments });
    // a registration that starts or ends inside the year only has the periods it was active in
    return { periods: ps.filter(p => !reg || ((!reg.active_from || reg.active_from <= p.end) && (!reg.active_to || reg.active_to >= p.start))) };
  }
  if (freq === 'event') {
    const types = rule.scope.event_types || [];
    return {
      periods: (events || []).filter(e => e.entity_id === scope.entity_id && types.includes(e.type) && e.status !== 'cancelled' && U.isDate(e.event_date) && U.fyOf(e.event_date) === fy
        && (!e.registration_id || !scope.registration || e.registration_id === scope.registration.id))
        .map(e => ({ key: `E:${e.id}`, kind: 'event', fy, label: `${CAT.EVENT_TYPES[e.type] || e.type} ${e.event_date}${e.reference ? ` · ${e.reference}` : ''}`, start: e.event_date, end: e.event_date, event: e })),
    };
  }
  if (freq === 'renewal') {
    const expiry = scope.registration?.active_to || scope.person?.dsc_expiry;
    if (!U.isDate(expiry) || U.fyOf(expiry) !== fy) return { periods: [] };
    return { periods: [{ key: `R:${scope.scope_id}:${expiry}`, kind: 'renewal', fy, label: `Expires ${expiry}`, start: expiry, end: expiry, expiry }] };
  }
  return { periods: [] };
}

/** Best owner / backup / checker row for a task (most specific wins). Rows: { entity_id|'*', category|'*', registration_id? } */
function pickTeam(team, t) {
  let best = null, bestScore = -1;
  for (const row of team?.rows || []) {
    if (row.registration_id && row.registration_id !== t.registration_id) continue;
    if (row.entity_id && row.entity_id !== '*' && row.entity_id !== t.entity_id) continue;
    if (row.category && row.category !== '*' && row.category !== t.category) continue;
    const score = (row.registration_id ? 8 : 0) + (row.entity_id && row.entity_id !== '*' ? 4 : 0) + (row.category && row.category !== '*' ? 2 : 0);
    if (score > bestScore) { best = row; bestScore = score; }
  }
  return best;
}

function evidenceRule(rule) { return U.clone(rule.evidence || CAT.NATURE_EVIDENCE[rule.nature] || { review: [], close: [], payment: [] }); }

/**
 * Generate tasks for one financial year.
 * input: { org, rulesDoc, applic, events, team, tasksDocs: { [fy]: { tasks } }, fy, entityIds?, ruleIds?, live, actor, nameOf }
 * Returns { created, existing, blocked, not_applicable } (created tasks are pushed into tasksDocs[fy].tasks).
 */
function generate(input) {
  const { org, rulesDoc, applic, events, team, tasksDocs, fy, entityIds, ruleIds, live, actor, nameOf = () => '' } = input;
  const { start, end } = U.fyBounds(fy);
  const out = { created: [], existing: 0, blocked: [], not_applicable: 0 };
  const doc = tasksDocs[fy] || (tasksDocs[fy] = { tasks: [] });
  const byIdentity = new Map(doc.tasks.map(t => [t.identity, t]));
  const rules = rulesDoc.rules.filter(r => r.active !== false && r.frequency !== 'transaction' && (!ruleIds || ruleIds.includes(r.id)));
  // linked (internal) rules last, so the obligations they point at exist first
  rules.sort((a, b) => (a.versions.some(v => v.due?.type === 'linked') ? 1 : 0) - (b.versions.some(v => v.due?.type === 'linked') ? 1 : 0));
  for (const rule of rules) {
    for (const scope of AP.scopesFor(rule, org, { entityIds, start, end })) {
      if (live && scope.entity.data_status !== 'approved') { out.blocked.push(blk(rule, scope, null, 'ENTITY_NOT_APPROVED', 'Entity master data is not approved yet')); continue; }
      if (live && scope.registration && scope.registration.data_status !== 'approved') { out.blocked.push(blk(rule, scope, null, 'REGISTRATION_NOT_APPROVED', 'Registration is not approved yet')); continue; }
      const pf = periodsFor(rule, scope, fy, events.events);
      if (pf.blocked) { out.blocked.push(blk(rule, scope, null, pf.code, pf.blocked)); continue; }
      for (const period of pf.periods) {
        const id = identity(scope.scope_type, scope.scope_id, rule.id, period.key);
        if (byIdentity.has(id)) { out.existing++; continue; }
        const decisionId = AP.decisionScopeType(rule) === 'entity' ? scope.entity_id : scope.scope_id;
        const dec = AP.decisionOn(applic.records, rule.id, AP.decisionScopeType(rule), decisionId, period.start);
        if (!dec) { out.blocked.push(blk(rule, scope, period, 'APPLIC_NOT_REVIEWED', 'Applicability not decided yet')); continue; }
        if (dec.status === 'needs_review') { out.blocked.push(blk(rule, scope, period, 'APPLIC_NEEDS_REVIEW', `Applicability needs review: ${dec.reason}`)); continue; }
        if (dec.status === 'not_applicable') { out.not_applicable++; continue; }
        const vf = RU.versionFor(rule, period.start, { live });
        if (!vf.version) { out.blocked.push(blk(rule, scope, period, 'RULE_UNVERIFIED', vf.blocked)); continue; }
        const t = buildTask({ org, rule, version: vf.version, unverified: vf.unverified, scope, period, events: events.events, tasks: doc.tasks, rulesDoc, live, actor, team, nameOf, decision: dec });
        doc.tasks.push(t);
        byIdentity.set(t.identity, t);
        out.created.push(t);
      }
    }
  }
  return out;
}

function blk(rule, scope, period, code, reason) {
  return { rule_id: rule.id, rule_name: rule.name, category: rule.category, entity_id: scope.entity_id, scope_type: scope.scope_type, scope_id: scope.scope_id, scope_label: scope.label, period_key: period?.key || null, period_label: period?.label || null, code, reason };
}

/** Due date of a rule version for a scope / period (follows "linked" rules one step) */
function dueOf(version, { rule, scope, period, events, tasks, rulesDoc, live }, depth = 0) {
  const ctx = {
    period, registration: scope.registration, event: period.event, events: (events || []).filter(e => e.entity_id === scope.entity_id),
    expiry: period.expiry,
    linkedDue: ruleId => {
      if (depth > 1) return null;
      const t = tasks.find(x => x.rule_id === ruleId && x.scope_id === scope.scope_id && x.period_key === period.key && x.filing_version === 1);
      if (t) return t.revised_due || t.original_due;
      const r = rulesDoc.rules.find(x => x.id === ruleId);
      const vf = r ? RU.versionFor(r, period.start, { live }) : null;
      return vf?.version ? dueOf(vf.version, { rule: r, scope, period, events, tasks, rulesDoc, live }, depth + 1).date : null;
    },
  };
  return DE.computeDue(version.due, ctx);
}

function buildTask({ org, rule, version, unverified, scope, period, events, tasks, rulesDoc, live, actor, team, nameOf, decision }) {
  // an event can name the registration it concerns (a cancelled GSTIN, a notice on one GSTIN)
  const evReg = !scope.registration && period.event?.registration_id ? org.registrations.find(r => r.id === period.event.registration_id) : null;
  if (evReg) scope = { ...scope, registration: evReg };
  const due = dueOf(version, { rule, scope, period, events, tasks, rulesDoc, live });
  const now = U.nowIso();
  const t = {
    id: taskId(period.fy), identity: identity(scope.scope_type, scope.scope_id, rule.id, period.key), rule_id: rule.id, rule_version: version.version, rule_name: rule.name,
    form: version.form || '', category: rule.category, nature: rule.nature, internal: rule.nature === 'internal',
    entity_id: scope.entity_id, entity_ids: scope.entity_ids || [scope.entity_id], scope_type: scope.scope_type, scope_id: scope.scope_id, scope_label: scope.label,
    registration_id: scope.registration?.id || null, establishment_id: scope.establishment?.id || null, person_id: scope.person?.id || null, event_id: period.event?.id || null,
    state: scope.registration?.state || scope.establishment?.state || '',
    fy: period.fy, period_key: period.key, period_label: period.label, period_start: period.start, period_end: period.end,
    original_due: due.date || null, original_due_at: due.at || null, due_basis: due.basis || '', due_pending: due.date ? '' : (due.pending || due.error || 'No due date'), due_error: due.error || '',
    missing_rule: !!due.missing_rule, revised_due: null, revised_due_at: null, revised_by: null, fee_waivers: [], internal_target: null,
    status: 'not_started', priority: rule.priority || 'medium', applicability_id: decision.id,
    owner_id: '', owner_name: '', backup_owner_id: '', backup_owner_name: '', checker_id: '', checker_name: '',
    workflow: {}, filing: null, exception: null, evidence_rule: evidenceRule(rule), filing_ack: rule.filing?.ack || 'REFERENCE', payment_ref: rule.filing?.payment_ref || null,
    filing_version: 1, revision_of: null, revised_by_task: null, locked: false,
    sample: !live, rule_unverified: !!unverified, created_at: now, created_by: actor.name, updated_at: now, updated_by: actor.name, rev: 1,
    history: [{ at: now, by: actor.name, action: 'created', note: `Generated from ${rule.id} v${version.version}${unverified ? ' (UNVERIFIED rule — demo only)' : ''}; applicability ${decision.id} by ${decision.reviewer}` }],
  };
  const tm = pickTeam(team, t);
  if (tm) {
    Object.assign(t, { owner_id: tm.owner_id || '', backup_owner_id: tm.backup_owner_id || '', checker_id: tm.checker_id || '' });
    t.owner_name = nameOf(t.owner_id); t.backup_owner_name = nameOf(t.backup_owner_id); t.checker_name = nameOf(t.checker_id);
  }
  applyExtensions(t, rulesDoc, actor, { silent: true });
  setInternalTarget(t, version);
  return t;
}

function setInternalTarget(t, version) {
  if (t.internal_target_override) { t.internal_target = t.internal_target_override; return; }
  const eff = t.revised_due || t.original_due;
  if (t.internal) t.internal_target = eff;
  else if (eff && Number.isInteger(Number(version?.internal_offset_days)) && version.internal_offset_days !== null) t.internal_target = U.addDays(eff, Number(version.internal_offset_days));
  else t.internal_target = null;
}

function hist(t, actor, action, note, extra) {
  t.history.push({ at: U.nowIso(), by: actor?.name || 'system', by_id: actor?.id || '', action, note: note || '', ...(extra || {}) });
}

/** Re-reads approved extensions for a task. Returns true when its revised due date changed. */
function applyExtensions(t, rulesDoc, actor, { silent } = {}) {
  const { deadline, waivers } = RU.extensionsFor(rulesDoc, t);
  const before = t.revised_due;
  t.revised_due = deadline ? deadline.new_due_date : null;
  t.revised_by = deadline ? deadline.id : null;
  t.fee_waivers = waivers.map(w => ({ id: w.id, note: w.waiver_note, notification_no: w.notification_no }));
  const changed = before !== t.revised_due;
  if (changed && !silent) hist(t, actor, 'revised_due', deadline ? `Deadline extended to ${t.revised_due} (${deadline.notification_no || deadline.id})` : `Extension no longer applies — due date back to ${t.original_due || 'none'}`, { from: before, to: t.revised_due });
  return changed;
}

/** Context to recompute a stored task's due date */
function scopeOfTask(t, org) {
  const entity = org.entities.find(e => e.id === t.entity_id);
  return {
    scope_type: t.scope_type, scope_id: t.scope_id, entity_id: t.entity_id, entity,
    registration: t.registration_id ? org.registrations.find(r => r.id === t.registration_id) : null,
    establishment: t.establishment_id ? org.establishments.find(b => b.id === t.establishment_id) : null,
    person: t.person_id ? org.people.find(p => p.id === t.person_id) : null,
  };
}
function periodOfTask(t, events) {
  const p = DE.periodFromKey(t.period_key);
  if (p) return p;
  if (t.period_key.startsWith('E:')) { const ev = events.find(e => e.id === t.event_id); return { key: t.period_key, kind: 'event', fy: t.fy, start: ev?.event_date || t.period_start, end: ev?.event_date || t.period_end, event: ev }; }
  if (t.period_key.startsWith('R:')) return { key: t.period_key, kind: 'renewal', fy: t.fy, start: t.period_start, end: t.period_end, expiry: t.period_end };
  return null;
}

/**
 * Recompute original_due from a rule version (the task's own, or a newly approved one). Filed / completed tasks keep their
 * dates. Returns { changed, from, to } — mutates the task only when apply is true.
 */
function recompute(t, { org, rulesDoc, events, tasks, version, live, actor, apply, reason }) {
  if (FROZEN.includes(t.status) || t.locked) return { changed: false, kept: 'filed' };
  if (t.due_source === 'manual' && !version) return { changed: false, kept: 'manual' };
  const rule = rulesDoc.rules.find(r => r.id === t.rule_id);
  const v = version || rule?.versions.find(x => x.version === t.rule_version);
  if (!rule || !v) return { changed: false };
  const period = periodOfTask(t, events);
  if (!period) return { changed: false };
  const due = dueOf(v, { rule, scope: scopeOfTask(t, org), period, events, tasks, rulesDoc, live });
  const to = due.date || null;
  const changed = to !== t.original_due || (due.at || null) !== (t.original_due_at || null) || v.version !== t.rule_version;
  if (changed && apply) {
    const from = t.original_due;
    Object.assign(t, { original_due: to, original_due_at: due.at || null, due_basis: due.basis || '', due_pending: to ? '' : (due.pending || due.error || 'No due date'), due_error: due.error || '', missing_rule: !!due.missing_rule, rule_version: v.version, form: v.form || t.form, rule_unverified: v.status !== 'approved' });
    setInternalTarget(t, v);
    t.rev++; t.updated_at = U.nowIso(); t.updated_by = actor?.name || 'system';
    hist(t, actor, 'due_recomputed', reason || 'Due date recomputed', { from, to });
  }
  return { changed, from: t.original_due, to, basis: due.basis || due.pending || due.error || '' };
}

/**
 * What approving a version would do to existing tasks (no change is made). scope: { entity_ids?, registration_ids?, period_from?, period_to? }.
 * Returns { rows, counts, hash } — the hash is what the approver quotes.
 */
function previewVersion({ rule, version, tasksAll, org, rulesDoc, events, live, scope }) {
  const rows = [];
  for (const t of tasksAll) {
    if (t.rule_id !== rule.id) continue;
    if ((version.effective_from && t.period_start < version.effective_from) || (version.effective_to && t.period_start > version.effective_to)) continue;
    if (scope?.entity_ids?.length && !scope.entity_ids.includes(t.entity_id)) continue;
    if (scope?.registration_ids?.length && !scope.registration_ids.includes(t.registration_id)) continue;
    if (scope?.period_from && t.period_end < scope.period_from) continue;
    if (scope?.period_to && t.period_start > scope.period_to) continue;
    const r = recompute(t, { org, rulesDoc, events, tasks: tasksAll, version, live, apply: false });
    rows.push({ task_id: t.id, entity_id: t.entity_id, scope_label: t.scope_label, period_key: t.period_key, period_label: t.period_label, status: t.status,
      from_version: t.rule_version, to_version: version.version, before: t.original_due, after: r.kept ? t.original_due : r.to, effect: r.kept ? `kept (${r.kept})` : r.changed ? (t.original_due === r.to ? 'version only' : 'due date changes') : 'no change', basis: r.basis || '' });
  }
  rows.sort((a, b) => (a.period_key + a.task_id).localeCompare(b.period_key + b.task_id));
  const counts = rows.reduce((c, r) => { c[r.effect] = (c[r.effect] || 0) + 1; return c; }, {});
  const hash = U.sha256(U.stable({ rule: rule.id, version: version.version, due: version.due, applicability: version.applicability, eff: [version.effective_from, version.effective_to], scope: scope || null, rows: rows.map(r => [r.task_id, r.before, r.after, r.effect]) })).slice(0, 24);
  return { rows, counts, hash, applicability_note: 'Recorded applicability decisions are not changed by a rule version; review suggestions in Coverage after approval.' };
}

// ── Derived flags ─────────────────────────────────────────────────────────────
/** Mandatory document types for a task in its current state */
function requiredDocs(t) {
  const er = t.evidence_rule || { review: [], close: [], payment: [] };
  const amounts = t.filing?.payment?.amounts || {};
  const paid = Object.values(amounts).some(v => Number(v) > 0);
  const needPayment = t.nature === 'payment' || ((t.nature === 'return_payment') && !t.filing?.nil_return && paid);
  return U.uniq([...(er.close || []), ...(needPayment ? (er.payment || []) : [])]);
}

/**
 * A task with its derived flags. docs: document records linked to the task. today: 'YYYY-MM-DD' (Asia/Kolkata).
 */
function derive(t, { today, nowMs, docs = [], soonDays = 7 }) {
  const effective_due = t.revised_due || t.original_due || null;
  const effective_due_at = t.revised_due ? (t.revised_due_at || null) : (t.original_due_at || null);
  const filed = !!t.filing?.filed_at;
  const filedOn = t.filing?.filed_on || null;
  const done = t.status === 'completed';
  let overdue = false, days_overdue = 0;
  if (effective_due && !filed && !done) {
    overdue = effective_due_at ? nowMs > Date.parse(effective_due_at) : today > effective_due;
    if (overdue) days_overdue = Math.max(0, U.daysBetween(effective_due, today));
  }
  const days_to_due = effective_due ? U.daysBetween(today, effective_due) : null;
  const due_soon = !!effective_due && !filed && !done && !overdue && days_to_due >= 0 && days_to_due <= soonDays;
  const filed_late = filed && !!effective_due && !!filedOn && filedOn > effective_due;
  const usable = docs.filter(d => d.status === 'active' && d.current?.scan_status !== 'infected');
  const present = U.uniq(usable.map(d => d.doc_type));
  const required = requiredDocs(t);
  const missing = required.filter(k => !present.includes(k));
  const exceptionOk = t.exception?.status === 'approved';
  const evidence_missing = missing.length > 0 && !exceptionOk && (filed || done || t.status === 'filed_awaiting_verification');
  const flags = [];
  if (overdue) flags.push('overdue');
  if (due_soon) flags.push('due_soon');
  if (!effective_due) flags.push('no_due_date');
  if (filed_late) flags.push('filed_late');
  if (evidence_missing) flags.push('evidence_missing');
  if (t.rule_unverified) flags.push('rule_unverified');
  if (t.missing_rule) flags.push('missing_rule');
  // "not scanned" is shown on the document itself; document_flags = something a person must look at (mismatch, duplicate …)
  if (usable.some(d => (d.current?.flags || []).some(f => f.code !== 'not_scanned'))) flags.push('document_flags');
  if (t.sample) flags.push('sample');
  return {
    ...t, status_label: STATUS[t.status] || t.status, effective_due, effective_due_at, filed, filed_late, on_time: filed && !!effective_due && !!filedOn && filedOn <= effective_due,
    overdue, days_overdue, due_soon, days_to_due, no_due_date: !effective_due,
    evidence: { required, present, missing, exception: t.exception?.status || null, sample: usable.some(d => d.sample), unscanned: usable.filter(d => d.current?.scan?.status !== 'clean').length }, evidence_missing, doc_count: usable.length, flags,
  };
}

// ── Events ────────────────────────────────────────────────────────────────────
function cleanEvent(input, org) {
  const errors = [];
  const e = {
    entity_id: String(input.entity_id || ''), registration_id: input.registration_id || null, type: String(input.type || ''), title: String(input.title || '').trim().slice(0, 300),
    event_date: input.event_date || null, event_at: input.event_at || null, fy: input.fy || null, response_due: input.response_due || null,
    reference: String(input.reference || '').trim().slice(0, 200), authority: String(input.authority || '').trim().slice(0, 200), notes: String(input.notes || '').slice(0, 4000),
    status: ['open', 'closed', 'cancelled'].includes(input.status) ? input.status : 'open',
  };
  if (!org.entities.some(x => x.id === e.entity_id)) errors.push('Choose the entity');
  if (e.registration_id && !org.registrations.some(r => r.id === e.registration_id && r.entity_id === e.entity_id)) errors.push('The registration is not one of this entity\'s registrations');
  if (!CAT.EVENT_TYPES[e.type]) errors.push('Choose the event type');
  if (!U.isDate(e.event_date)) errors.push('Event date is required (YYYY-MM-DD)');
  if (e.event_at) {
    const ms = Date.parse(e.event_at);
    if (Number.isNaN(ms) || !/[+-]\d{2}:\d{2}$|Z$/.test(e.event_at)) errors.push('Event time must include its time zone, e.g. 2026-07-14T18:30:00+05:30');
    else if (U.isDate(e.event_date) && new Date(ms + U.IST_MS).toISOString().slice(0, 10) !== e.event_date) errors.push('Event time is on a different date (Indian time) than the event date');
  }
  if (e.response_due && !U.isDate(e.response_due)) errors.push('Response due must be a date');
  if (e.type === 'AGM' && !U.validFy(e.fy || '')) errors.push('For an AGM, record the financial year whose accounts it adopts (e.g. 2025-26)');
  if (e.fy && !U.validFy(e.fy)) errors.push('Financial year must look like 2025-26');
  return { value: e, errors };
}

module.exports = {
  STATUS, FROZEN, taskKey, identity, taskId, fyOfTaskId, periodsFor, pickTeam, generate, buildTask, dueOf, applyExtensions, setInternalTarget, recompute, previewVersion,
  requiredDocs, derive, cleanEvent, hist, scopeOfTask, periodOfTask,
};
