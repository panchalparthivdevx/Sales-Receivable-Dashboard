/**
 * Applicability: does an obligation apply to a scope (entity / registration / establishment / person) for a period?
 *
 *   • A rule's applicability expression gives a SUGGESTION on recorded facts, with three-valued logic: a fact that is
 *     not recorded makes the answer "needs review" (unknown), never "not applicable".
 *   • Only a DECISION recorded by a person counts: status applicable / not_applicable / needs_review, with reason,
 *     evidence, reviewer and effective dates. A new decision closes the previous one (history kept).
 *   • Event-based rules are decided per entity (the events then create the tasks).
 *
 * Expression format (data, never code):
 *   { all: [ … ] }  { any: [ … ] }  { not: … }  { fact: 'registration.frequency', eq | ne | in | nin | gt | gte | lt | lte: value }
 *   facts: entity.type, entity.kind, entity.listed, entity.flags.<flag>, entity.fy.<fact>, entity.prev_fy.<fact>,
 *          registration.<field or flag> (registration.frequency = its filing frequency), establishment.<field or flag>
 */

'use strict';

const U = require('./util');
const CAT = require('./catalogue');
const ORG = require('./org');

const STATUSES = { applicable: 'Applicable', not_applicable: 'Not applicable', needs_review: 'Needs review' };
const unknown = v => v === undefined || v === null || v === '';

const prevFy = fy => { const s = U.fyStartYear(fy) - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

/** Reads one fact for a context { entity, registration, establishment, person, fy } */
function getFact(path, ctx) {
  const [head, ...rest] = String(path).split('.');
  const key = rest.join('.');
  if (head === 'entity') {
    const e = ctx.entity;
    if (!e) return undefined;
    if (key === 'kind') return CAT.entityKind(e.type);
    if (rest[0] === 'flags') return e.flags?.[rest[1]];
    if (rest[0] === 'fy') return e.fy_facts?.[ctx.fy]?.[rest[1]];
    if (rest[0] === 'prev_fy') return e.fy_facts?.[prevFy(ctx.fy)]?.[rest[1]];
    return e[key];
  }
  if (head === 'registration') {
    const r = ctx.registration;
    if (!r) return undefined;
    if (key === 'frequency') return r.filing_frequency;
    return r[key] !== undefined && typeof r[key] !== 'object' ? r[key] : r.flags?.[key];
  }
  if (head === 'establishment') {
    const b = ctx.establishment;
    if (!b) return undefined;
    if (key === 'headcount') return b.headcount;
    return b[key] !== undefined && typeof b[key] !== 'object' ? b[key] : b.flags?.[key];
  }
  if (head === 'person') return ctx.person?.[key];
  return undefined;
}

const OPS = {
  eq: (a, b) => a === b, ne: (a, b) => a !== b,
  in: (a, b) => Array.isArray(b) && b.includes(a), nin: (a, b) => Array.isArray(b) && !b.includes(a),
  gt: (a, b) => Number(a) > Number(b), gte: (a, b) => Number(a) >= Number(b), lt: (a, b) => Number(a) < Number(b), lte: (a, b) => Number(a) <= Number(b),
};

/** → { value: true | false | null, missing: [fact paths], trace: [text] } */
function evaluate(expr, ctx) {
  const missing = new Set();
  const trace = [];
  function ev(x) {
    if (!x || typeof x !== 'object') return null;
    if (Array.isArray(x.all)) {
      let anyUnknown = false;
      for (const c of x.all) { const r = ev(c); if (r === false) return false; if (r === null) anyUnknown = true; }
      return anyUnknown ? null : true;
    }
    if (Array.isArray(x.any)) {
      let anyUnknown = false;
      for (const c of x.any) { const r = ev(c); if (r === true) return true; if (r === null) anyUnknown = true; }
      return anyUnknown ? null : false;
    }
    if (x.not) { const r = ev(x.not); return r === null ? null : !r; }
    if (x.fact) {
      const op = Object.keys(OPS).find(k => k in x);
      if (!op) return null;
      const v = getFact(x.fact, ctx);
      if (unknown(v)) { missing.add(x.fact); trace.push(`${x.fact} is not recorded`); return null; }
      const r = OPS[op](v, x[op]);
      trace.push(`${x.fact} = ${JSON.stringify(v)} → ${op} ${JSON.stringify(x[op])} is ${r ? 'true' : 'false'}`);
      return r;
    }
    return null;
  }
  const value = expr === null || expr === undefined ? null : ev(expr);
  if (expr === null || expr === undefined) trace.push('This obligation has no automatic test — a person must decide');
  return { value, missing: [...missing], trace };
}

/** The scope kind applicability is decided at (event rules are decided per entity) */
const decisionScopeType = rule => (rule.scope.type === 'event' ? 'entity' : rule.scope.type);

/**
 * Every scope a rule can apply to within some entities, for a date window. Returns
 * [{ scope_type, scope_id, entity_id, entity_ids, registration, establishment, person, entity, label }]
 */
function scopesFor(rule, org, { entityIds, start, end }) {
  const ents = org.entities.filter(e => (!entityIds || entityIds.includes(e.id)) && e.status !== 'inactive');
  const out = [];
  const t = decisionScopeType(rule);
  if (t === 'entity') {
    const kinds = rule.scope.entity_kinds || ['company', 'llp', 'other'];
    for (const e of ents) if (kinds.includes(CAT.entityKind(e.type))) out.push({ scope_type: 'entity', scope_id: e.id, entity_id: e.id, entity: e });
  } else if (t === 'registration') {
    for (const r of org.registrations) {
      if (!rule.scope.reg_types.includes(r.type)) continue;
      const e = ents.find(x => x.id === r.entity_id);
      if (!e || !ORG.activeIn(r, start, end)) continue;
      out.push({ scope_type: 'registration', scope_id: r.id, entity_id: e.id, entity: e, registration: r });
    }
  } else if (t === 'establishment') {
    for (const b of org.establishments) {
      const e = ents.find(x => x.id === b.entity_id);
      if (!e || !ORG.activeIn(b, start, end)) continue;
      out.push({ scope_type: 'establishment', scope_id: b.id, entity_id: e.id, entity: e, establishment: b });
    }
  } else if (t === 'person') {
    // one scope per PERSON, even when the person is a director of several group entities
    for (const p of org.people) {
      if (p.status === 'inactive') continue;
      if (rule.scope.with === 'din' && !p.din) continue;
      if (rule.scope.with === 'dsc_expiry' && !p.dsc_expiry) continue;
      const ids = U.uniq(p.roles.filter(r => (!r.to || r.to >= start) && (!r.from || r.from <= end)).map(r => r.entity_id)).filter(id => ents.some(e => e.id === id));
      if (!ids.length) continue;
      out.push({ scope_type: 'person', scope_id: p.id, entity_id: ids[0], entity_ids: ids, entity: ents.find(e => e.id === ids[0]), person: p });
    }
  }
  for (const s of out) s.label = ORG.scopeLabel(org, s.scope_type, s.scope_id);
  return out;
}

/** The decision in force on a date, or null */
function decisionOn(records, ruleId, scopeType, scopeId, date) {
  let best = null;
  for (const r of records) {
    if (r.rule_id !== ruleId || r.scope_type !== scopeType || r.scope_id !== scopeId || r.superseded) continue;
    if (r.effective_from && r.effective_from > date) continue;
    if (r.effective_to && r.effective_to < date) continue;
    if (!best || (r.effective_from || '') > (best.effective_from || '') || ((r.effective_from || '') === (best.effective_from || '') && r.recorded_at > best.recorded_at)) best = r;
  }
  return best;
}

/** Suggestion for one scope (no decision is recorded by this) */
function suggest(version, scope, fy) {
  const r = evaluate(version?.applicability, { ...scope, fy });
  const status = r.value === true ? 'applicable' : r.value === false ? 'not_applicable' : 'needs_review';
  return { status, missing: r.missing, trace: r.trace };
}

/**
 * Record a decision. input: { rule_id, scope_type, scope_id, status, reason, evidence, effective_from, effective_to }.
 * The previous open decision for the same scope is closed the day before (history is never overwritten).
 */
function record(applic, rules, org, input, actor) {
  const rule = rules.rules.find(r => r.id === input.rule_id);
  if (!rule) throw U.httpError(404, `Rule ${input.rule_id} not found`);
  if (!STATUSES[input.status]) throw U.httpError(400, `Status must be one of: ${Object.keys(STATUSES).join(', ')}`);
  const reason = String(input.reason || '').trim().slice(0, 2000);
  if (!reason) throw U.httpError(400, 'A reason is required for every applicability decision');
  if (input.status === 'not_applicable' && reason.length < 5) throw U.httpError(400, '"Not applicable" needs a real reason');
  const from = input.effective_from || null;
  if (from && !U.isDate(from)) throw U.httpError(400, 'Effective from must be a date');
  if (input.effective_to && !U.isDate(input.effective_to)) throw U.httpError(400, 'Effective to must be a date');
  if (from && input.effective_to && input.effective_to < from) throw U.httpError(400, 'Effective to is before effective from');
  const st = decisionScopeType(rule);
  if (input.scope_type !== st) throw U.httpError(400, `${rule.id} is decided per ${st}`);
  const listName = { entity: 'entities', registration: 'registrations', establishment: 'establishments', person: 'people' }[st];
  const target = org[listName].find(x => x.id === input.scope_id);
  if (!target) throw U.httpError(404, `${st} ${input.scope_id} not found`);
  const now = U.nowIso();
  const rec = {
    id: U.uid('A-'), rule_id: rule.id, scope_type: st, scope_id: input.scope_id, entity_id: target.entity_id || target.roles?.[0]?.entity_id || target.id,
    status: input.status, reason, evidence: String(input.evidence || '').trim().slice(0, 2000), basis: input.basis || 'manual',
    effective_from: from, effective_to: input.effective_to || null, reviewer: actor.name, reviewer_id: actor.id, recorded_at: now,
  };
  // close the decision that was open at the new one's start
  const prev = decisionOn(applic.records, rule.id, st, input.scope_id, from || '0000-00-00');
  const closed = [];
  for (const r of applic.records) {
    if (r.rule_id !== rule.id || r.scope_type !== st || r.scope_id !== input.scope_id || r.superseded) continue;
    if ((r.effective_from || '') === (from || '')) { r.superseded = { by: rec.id, at: now }; closed.push(r.id); continue; }
    if ((r.effective_from || '') < (from || '') && (!r.effective_to || r.effective_to >= from)) { r.effective_to = U.addDays(from, -1); closed.push(r.id); }
  }
  applic.records.push(rec);
  return { record: rec, previous: prev, closed };
}

module.exports = { STATUSES, getFact, evaluate, decisionScopeType, scopesFor, decisionOn, suggest, record, prevFy };
