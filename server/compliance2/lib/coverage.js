/**
 * Coverage-gap report and missing-rule queue for one financial year.
 *
 * One row per (obligation × scope) that can apply to the selected entities, with:
 *   decision     the recorded applicability decision (or none), and the automatic suggestion with its missing facts
 *   rule_state   approved / verified / unverified — only approved rules schedule live tasks
 *   due_state    scheduled / no due-date rule / state rule missing / periodicity missing / event- or expiry-driven
 *   tasks        how many tasks exist for it in the year
 *   gaps         what stops it being covered (codes below)
 * Unknown applicability is a gap, never "not applicable"; a "not applicable" decision with a reason is covered.
 * Registration checks: entities without a GSTIN / TAN, or with employees but no PF / ESIC / PT registration, are listed.
 */

'use strict';

const U = require('./util');
const AP = require('./applicability');
const RU = require('./rules');
const CAT = require('./catalogue');

const GAPS = {
  APPLIC_NOT_REVIEWED: 'Applicability not decided',
  APPLIC_NEEDS_REVIEW: 'Applicability needs review',
  RULE_UNVERIFIED: 'Rule not verified and approved (blocked from live scheduling)',
  NO_DUE_RULE: 'No due-date rule',
  STATE_RULE_MISSING: 'No rule for this state (missing-rule queue)',
  PERIODICITY_MISSING: 'Registration periodicity not recorded',
  NOT_GENERATED: 'Applicable and approved, but no tasks generated for the year',
  MASTER_NOT_APPROVED: 'Entity / registration master data not approved',
};

function dueState(version, scope) {
  const due = version?.due;
  if (!due) return { code: 'NO_DUE_RULE', text: 'No due-date rule' };
  if (due.type === 'manual') return { code: 'MANUAL', text: 'Entered on each task' };
  if (due.type === 'by_state') {
    const st = scope.registration?.state || scope.establishment?.state;
    if (!st || !due.states?.[st]) return { code: 'STATE_RULE_MISSING', text: `No rule for ${st || 'an unknown state'}`, state: st || '' };
    return { code: 'SCHEDULED', text: `${st}: ${due.states[st].type}` };
  }
  if (['event_offset', 'event_field'].includes(due.type)) return { code: 'EVENT', text: 'Dated from an event when it is recorded' };
  if (due.type === 'expiry') return { code: 'EXPIRY', text: 'Dated from the recorded expiry date' };
  return { code: 'SCHEDULED', text: 'Scheduled' };
}

function report({ org, rulesDoc, applic, tasksAll, fy, entityIds, live }) {
  const { start, end } = U.fyBounds(fy);
  const taskCount = new Map();
  for (const t of tasksAll) if (t.fy === fy && t.filing_version === 1) { const k = `${t.rule_id}|${t.scope_type}|${t.scope_id}`; taskCount.set(k, (taskCount.get(k) || 0) + 1); }
  const rows = [];
  for (const rule of rulesDoc.rules.filter(r => r.active !== false)) {
    const vf = RU.versionFor(rule, start, { live: false });
    const version = vf.version;
    const liveState = RU.liveState(rule, start, end);
    for (const scope of AP.scopesFor(rule, org, { entityIds, start, end })) {
      const dType = AP.decisionScopeType(rule);
      const dId = dType === 'entity' ? scope.entity_id : scope.scope_id;
      const decision = AP.decisionOn(applic.records, rule.id, dType, dId, start) || AP.decisionOn(applic.records, rule.id, dType, dId, end);
      const sug = AP.suggest(version, scope, fy);
      const ds = dueState(version, scope);
      const n = taskCount.get(`${rule.id}|${scope.scope_type}|${scope.scope_id}`) || 0;
      const gaps = [];
      const status = decision?.status || null;
      if (!decision) gaps.push('APPLIC_NOT_REVIEWED');
      else if (status === 'needs_review') gaps.push('APPLIC_NEEDS_REVIEW');
      const relevant = status !== 'not_applicable';
      if (relevant) {
        if (live && liveState !== 'approved') gaps.push('RULE_UNVERIFIED');
        if (ds.code === 'NO_DUE_RULE' && rule.frequency !== 'transaction') gaps.push('NO_DUE_RULE');
        if (ds.code === 'STATE_RULE_MISSING') gaps.push('STATE_RULE_MISSING');
        if (rule.frequency === 'per_registration' && !scope.registration?.filing_frequency) gaps.push('PERIODICITY_MISSING');
        if (live && (scope.entity.data_status !== 'approved' || (scope.registration && scope.registration.data_status !== 'approved'))) gaps.push('MASTER_NOT_APPROVED');
        if (status === 'applicable' && (!live || liveState === 'approved') && !n && !['event', 'renewal', 'transaction'].includes(rule.frequency) && !gaps.includes('PERIODICITY_MISSING')) gaps.push('NOT_GENERATED');
      }
      rows.push({
        rule_id: rule.id, rule_name: rule.name, category: rule.category, frequency: rule.frequency, nature: rule.nature, reference: rule.reference,
        entity_id: scope.entity_id, scope_type: scope.scope_type, scope_id: scope.scope_id, scope_label: scope.label, state: scope.registration?.state || scope.establishment?.state || '',
        decision: decision ? { id: decision.id, status: decision.status, reason: decision.reason, reviewer: decision.reviewer, effective_from: decision.effective_from, effective_to: decision.effective_to } : null,
        suggestion: sug, rule_state: liveState, version: version?.version || null, version_status: version?.status || null, due_state: ds, tasks: n, gaps,
      });
    }
  }
  // registration coverage
  const regChecks = [];
  for (const e of org.entities.filter(x => (!entityIds || entityIds.includes(x.id)) && x.status !== 'inactive')) {
    const regs = org.registrations.filter(r => r.entity_id === e.id && r.status !== 'inactive');
    const has = t => regs.some(r => r.type === t);
    const add = (code, text) => regChecks.push({ entity_id: e.id, entity: e.legal_name, code, text });
    if (!regs.some(r => r.type.startsWith('GST_'))) add('NO_GSTIN', 'No GST registration recorded — record it, or record why none is needed');
    if (!has('TAN')) add('NO_TAN', 'No TAN recorded');
    if (e.flags?.has_employees !== false) {
      if (e.flags?.has_employees === undefined) add('EMPLOYEES_UNKNOWN', 'Whether the entity has employees is not recorded (PF / ESIC / PT applicability)');
      if (!has('PF')) add('NO_PF', 'No PF establishment code recorded');
      if (!has('ESIC')) add('NO_ESIC', 'No ESIC employer code recorded');
      for (const st of U.uniq(org.establishments.filter(b => b.entity_id === e.id && b.status !== 'inactive').map(b => b.state))) {
        if (!regs.some(r => r.type === 'PT_PTRC' && r.state === st)) add('NO_PT_STATE', `Establishment in ${st} but no PT employer registration for ${st} — confirm whether Professional Tax applies in ${st}`);
      }
    }
    const gstStates = U.uniq(regs.filter(r => r.type === 'GST_REGULAR').map(r => r.state));
    for (const st of gstStates) {
      const n = regs.filter(r => r.type === 'GST_REGULAR' && r.state === st).length;
      if (n > 1) regChecks.push({ entity_id: e.id, entity: e.legal_name, code: 'MULTI_GSTIN_STATE', text: `${n} GST registrations in ${st} — each is tracked separately (check they are distinct verticals / registrations)`, info: true });
    }
  }
  // missing-rule queue: obligations that apply (or may apply) but cannot be dated
  const mq = new Map();
  for (const r of rows) {
    if (!(r.gaps.includes('STATE_RULE_MISSING') || r.gaps.includes('NO_DUE_RULE') || r.gaps.includes('PERIODICITY_MISSING'))) continue;
    if (r.decision?.status === 'not_applicable') continue;
    const k = `${r.rule_id}|${r.gaps.includes('STATE_RULE_MISSING') ? r.state : '*'}`;
    const cur = mq.get(k) || { rule_id: r.rule_id, rule_name: r.rule_name, category: r.category, state: r.gaps.includes('STATE_RULE_MISSING') ? r.state : '', reason: r.gaps.filter(g => ['STATE_RULE_MISSING', 'NO_DUE_RULE', 'PERIODICITY_MISSING'].includes(g)).map(g => GAPS[g]).join('; '), scopes: [] };
    cur.scopes.push({ entity_id: r.entity_id, scope_label: r.scope_label, decision: r.decision?.status || 'not decided' });
    mq.set(k, cur);
  }
  const summary = {
    rows: rows.length, covered: rows.filter(r => !r.gaps.length).length,
    by_gap: Object.fromEntries(Object.keys(GAPS).map(g => [g, rows.filter(r => r.gaps.includes(g)).length])),
    by_decision: { applicable: rows.filter(r => r.decision?.status === 'applicable').length, not_applicable: rows.filter(r => r.decision?.status === 'not_applicable').length, needs_review: rows.filter(r => r.decision?.status === 'needs_review').length, not_decided: rows.filter(r => !r.decision).length },
    registration_checks: regChecks.filter(x => !x.info).length,
  };
  return { fy, live, rows, registration_checks: regChecks, missing_rules: [...mq.values()], summary, gap_labels: GAPS, categories: CAT.CATEGORIES };
}

module.exports = { report, GAPS, dueState };
