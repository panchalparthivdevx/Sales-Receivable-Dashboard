/**
 * Obligation rules, their versions, and deadline extensions / fee waivers.
 *
 * Version lifecycle:  draft → verified → approved   (or withdrawn; an approved version is replaced, never edited)
 *   verify   a person records the official source: law, provision, form, authority, source URL, notification number and
 *            date (or "standing provision"), the date the source was retrieved, and a note. Editing a verified
 *            version sends it back to draft.
 *   approve  a DIFFERENT person approves, quoting the impact preview they looked at (its hash). Only approved versions
 *            schedule live tasks; demo scheduling may use drafts and marks those tasks "rule unverified".
 *   Overlaps: the newly approved version wins — an older approved version that starts earlier ends the day before; one
 *            that lies entirely inside the new window becomes "superseded". History is kept on the rule.
 *
 * Extensions: 'deadline_extension' (moves the statutory date for named periods and scope) and 'fee_waiver' (waives a late
 * fee; it does NOT move the date and does not make a late filing on time). Each needs its own source and a second
 * person's approval. Archived / withdrawn / superseded extensions never affect a deadline.
 */

'use strict';

const U = require('./util');
const DE = require('./dueEngine');
const CAT = require('./catalogue');

const VERSION_EDITABLE = ['law', 'provision', 'form', 'authority', 'source_url', 'notification_no', 'notification_date', 'retrieved_at',
  'effective_from', 'effective_to', 'applicability', 'due', 'internal_offset_days', 'notes'];
const OFFICIAL_DOMAINS = /(^|\.)(gov\.in|nic\.in|sebi\.gov\.in|rbi\.org\.in|bseindia\.com|nseindia\.com|incometax\.gov\.in|incometaxindia\.gov\.in|cbic\.gov\.in|gst\.gov\.in|mca\.gov\.in|epfindia\.gov\.in|esic\.gov\.in|esic\.nic\.in|dgft\.gov\.in|egazette\.gov\.in)$/i;

const EMPTY = () => ({ catalogue_version: 0, rules: [], extensions: [] });

/** Adds catalogue rules that are missing. Never overwrites a rule that is already there (it may have been edited). */
function seed(doc, { now = U.nowIso() } = {}) {
  const have = new Set(doc.rules.map(r => r.id));
  const added = [];
  for (const r of CAT.RULES) {
    if (have.has(r.id)) continue;
    doc.rules.push({ ...U.clone(r), active: true, history: [{ at: now, by: 'catalogue', action: 'seeded', note: `Catalogue v${CAT.CATALOGUE_VERSION}: every version is an unverified draft` }] });
    added.push(r.id);
  }
  doc.catalogue_version = Math.max(doc.catalogue_version || 0, CAT.CATALOGUE_VERSION);
  return added;
}

/**
 * Brings a space's rules up to the current catalogue: adds new rules, and replaces a rule with its new catalogue definition
 * ONLY if nobody has touched it (every version still an unverified catalogue draft, no history but the catalogue's).
 * A rule someone edited, verified or approved is never overwritten — it is listed so a person can compare.
 */
function upgrade(doc, { now = U.nowIso() } = {}) {
  const out = { added: [], updated: [], kept_edited: [] };
  if ((doc.catalogue_version || 0) >= CAT.CATALOGUE_VERSION) return out;
  const definition = r => { const { history, active, seed, ...rest } = r; return U.stable(rest); };
  for (const cr of CAT.RULES) {
    const cur = doc.rules.find(r => r.id === cr.id);
    if (!cur) { doc.rules.push({ ...U.clone(cr), active: true, history: [{ at: now, by: 'catalogue', action: 'seeded', note: `Catalogue v${CAT.CATALOGUE_VERSION}: every version is an unverified draft` }] }); out.added.push(cr.id); continue; }
    const untouched = (cur.history || []).every(h => h.by === 'catalogue') && cur.versions.every(v => v.status === 'draft' && !v.verified_by && !v.created_by);
    if (definition(cur) === definition(cr)) continue;
    if (!untouched) { out.kept_edited.push(cr.id); continue; }
    const { active, history } = cur;
    Object.keys(cur).forEach(k => delete cur[k]);
    Object.assign(cur, U.clone(cr), { active, history: [...(history || []), { at: now, by: 'catalogue', action: 'updated', note: `Updated to catalogue v${CAT.CATALOGUE_VERSION} (it had not been edited)` }] });
    out.updated.push(cr.id);
  }
  doc.catalogue_version = CAT.CATALOGUE_VERSION;
  return out;
}

function findRule(doc, id) {
  const r = doc.rules.find(x => x.id === id);
  if (!r) throw U.httpError(404, `Rule ${id} not found`);
  return r;
}
function findVersion(rule, v) {
  const x = rule.versions.find(y => y.version === Number(v));
  if (!x) throw U.httpError(404, `${rule.id} has no version ${v}`);
  return x;
}

const covers = (v, date) => (!v.effective_from || v.effective_from <= date) && (!v.effective_to || v.effective_to >= date);

/**
 * The version that applies on a date. live: only approved versions schedule; otherwise the approved one is preferred and a
 * draft / verified one is used (marked unverified).
 */
function versionFor(rule, date, { live }) {
  const cands = rule.versions.filter(v => !['withdrawn', 'superseded'].includes(v.status) && covers(v, date)).sort((a, b) => b.version - a.version);
  const approved = cands.find(v => v.status === 'approved');
  if (approved) return { version: approved, unverified: false };
  if (!cands.length) return { version: null, blocked: `No version of ${rule.id} covers ${date}` };
  if (live) return { version: null, blocked: `Version ${cands[0].version} of ${rule.id} is ${cands[0].status === 'verified' ? 'verified but not yet approved' : 'an unverified draft'} — blocked from live scheduling`, pending_version: cands[0] };
  return { version: cands[0], unverified: true };
}

/** Is the rule able to schedule live anywhere in a window? (for coverage) */
function liveState(rule, start, end) {
  const approved = rule.versions.filter(v => v.status === 'approved' && (!v.effective_from || v.effective_from <= end) && (!v.effective_to || v.effective_to >= start));
  return approved.length ? 'approved' : rule.versions.some(v => v.status === 'verified') ? 'verified' : 'unverified';
}

function checkApplicability(x, path = 'applicability') {
  if (x === null) return [];
  if (!x || typeof x !== 'object') return [`${path} must be an object`];
  if (Array.isArray(x.all)) return x.all.flatMap((c, i) => checkApplicability(c, `${path}.all[${i}]`));
  if (Array.isArray(x.any)) return x.any.flatMap((c, i) => checkApplicability(c, `${path}.any[${i}]`));
  if (x.not) return checkApplicability(x.not, `${path}.not`);
  if (typeof x.fact === 'string' && /^(entity|registration|establishment|person)\.[a-z_.]+$/.test(x.fact) && ['eq', 'ne', 'in', 'nin', 'gt', 'gte', 'lt', 'lte'].some(k => k in x)) return [];
  return [`${path}: each test needs a fact (entity.…, registration.…, establishment.…) and one of eq, ne, in, nin, gt, gte, lt, lte`];
}

function log(rule, actor, action, version, note) {
  rule.history = [...(rule.history || []), { at: U.nowIso(), by: actor.name, by_id: actor.id, action, version, note: note || '' }];
}

function newDraft(doc, ruleId, { from_version, effective_from, note } = {}, actor) {
  const rule = findRule(doc, ruleId);
  const base = from_version ? findVersion(rule, from_version) : [...rule.versions].sort((a, b) => b.version - a.version)[0];
  if (effective_from && !U.isDate(effective_from)) throw U.httpError(400, 'Effective from must be a date');
  const v = {
    ...U.clone(base), version: Math.max(...rule.versions.map(x => x.version)) + 1, status: 'draft',
    verified_by: '', verified_by_id: '', verified_at: '', verification_note: '', approved_by: '', approved_by_id: '', approved_at: '',
    source_url: '', notification_no: '', notification_date: '', retrieved_at: '',
    effective_from: effective_from || base.effective_from, effective_to: null, prefilled: '', created_by: actor.name, created_at: U.nowIso(),
    approval: undefined,
  };
  rule.versions.push(v);
  log(rule, actor, 'draft_created', v.version, note || `Copied from version ${base.version}`);
  return v;
}

function editDraft(doc, ruleId, version, patch, actor) {
  const rule = findRule(doc, ruleId);
  const v = findVersion(rule, version);
  if (!['draft', 'verified'].includes(v.status)) throw U.httpError(400, `Version ${v.version} is ${v.status} and cannot be edited — create a new draft version instead`);
  const before = U.clone(v);
  for (const k of Object.keys(patch || {})) {
    if (!VERSION_EDITABLE.includes(k)) throw U.httpError(400, `"${k}" cannot be edited`);
  }
  const next = { ...v, ...U.clone(patch) };
  const problems = [...DE.checkExpr(next.due ?? null), ...checkApplicability(next.applicability ?? null)];
  if (next.effective_from && !U.isDate(next.effective_from)) problems.push('effective_from must be a date');
  if (next.effective_to && !U.isDate(next.effective_to)) problems.push('effective_to must be a date');
  if (next.effective_from && next.effective_to && next.effective_to < next.effective_from) problems.push('effective_to is before effective_from');
  if (next.internal_offset_days !== null && next.internal_offset_days !== undefined && !Number.isInteger(Number(next.internal_offset_days))) problems.push('internal_offset_days must be a whole number');
  if (problems.length) throw U.httpError(400, problems.join('; '), { errors: problems });
  Object.assign(v, next);
  if (before.status === 'verified') { v.status = 'draft'; v.verified_by = ''; v.verified_by_id = ''; v.verified_at = ''; }
  log(rule, actor, 'draft_edited', v.version, before.status === 'verified' ? 'Edited after verification — back to draft' : '');
  return { version: v, before };
}

function verify(doc, ruleId, version, input, actor) {
  const rule = findRule(doc, ruleId);
  const v = findVersion(rule, version);
  if (v.status !== 'draft') throw U.httpError(400, `Only a draft can be verified (version ${v.version} is ${v.status})`);
  const f = { ...v, ...U.clone(input || {}) };
  const errors = [];
  const need = (k, label) => { if (!String(f[k] || '').trim()) errors.push(`${label} is required`); };
  need('law', 'Law'); need('authority', 'Authority');
  if (!f.standing_provision) { need('notification_no', 'Notification / circular number (or tick "standing provision")'); need('notification_date', 'Notification date'); }
  need('source_url', 'Official source URL'); need('retrieved_at', 'Date the source was retrieved'); need('verification_note', 'Verification note (what you checked)');
  if (f.source_url && !/^https:\/\//i.test(f.source_url)) errors.push('Source URL must start with https://');
  if (f.retrieved_at && !U.isDate(String(f.retrieved_at).slice(0, 10))) errors.push('Retrieved date must be a date');
  if (f.notification_date && !U.isDate(f.notification_date)) errors.push('Notification date must be a date');
  if (!f.effective_from || !U.isDate(f.effective_from)) errors.push('Effective from date is required');
  errors.push(...DE.checkExpr(f.due ?? null), ...checkApplicability(f.applicability ?? null));
  if (errors.length) throw U.httpError(400, errors.join('; '), { errors });
  const warnings = [];
  try { if (!OFFICIAL_DOMAINS.test(new URL(f.source_url).hostname)) warnings.push(`${new URL(f.source_url).hostname} is not on the list of official domains — check it is an authoritative source`); } catch (_) { throw U.httpError(400, 'Source URL is not a valid address'); }
  if (f.due === null) warnings.push('No due-date rule: tasks from this version will have no due date until one is entered');
  for (const k of ['law', 'provision', 'form', 'authority', 'source_url', 'notification_no', 'notification_date', 'effective_from', 'effective_to', 'due', 'applicability', 'internal_offset_days']) if (k in (input || {})) v[k] = U.clone(input[k]);
  Object.assign(v, {
    status: 'verified', standing_provision: !!f.standing_provision, retrieved_at: String(f.retrieved_at).slice(0, 10), verification_note: String(f.verification_note).slice(0, 2000),
    verified_by: actor.name, verified_by_id: actor.id, verified_at: U.nowIso(), prefilled: '', verify_warnings: warnings,
  });
  log(rule, actor, 'verified', v.version, v.verification_note);
  return { version: v, warnings };
}

/** Approve a verified version. The caller has checked preview_hash against a freshly computed impact preview. */
function approve(doc, ruleId, version, { note, scope } = {}, actor) {
  const rule = findRule(doc, ruleId);
  const v = findVersion(rule, version);
  if (v.status !== 'verified') throw U.httpError(400, `Only a verified version can be approved (version ${v.version} is ${v.status})`);
  if (v.verified_by_id && v.verified_by_id === actor.id) throw U.httpError(403, 'The person who verified a rule version cannot also approve it — a second person must approve');
  const changed = [];
  for (const o of rule.versions) {
    if (o === v || o.status !== 'approved') continue;
    const oFrom = o.effective_from || '0000-01-01';
    const vFrom = v.effective_from || '0000-01-01';
    const inside = oFrom >= vFrom && (!v.effective_to || (o.effective_to && o.effective_to <= v.effective_to));
    if (inside) { o.status = 'superseded'; o.superseded_by = v.version; changed.push(`v${o.version} superseded`); }
    else if (oFrom < vFrom && (!o.effective_to || o.effective_to >= vFrom)) { o.effective_to = U.addDays(vFrom, -1); changed.push(`v${o.version} now ends ${o.effective_to}`); }
  }
  Object.assign(v, { status: 'approved', approved_by: actor.name, approved_by_id: actor.id, approved_at: U.nowIso(), approval: { note: String(note || '').slice(0, 2000), scope: scope || null } });
  log(rule, actor, 'approved', v.version, [note, ...changed].filter(Boolean).join('; '));
  return { version: v, changed };
}

function withdraw(doc, ruleId, version, reason, actor) {
  const rule = findRule(doc, ruleId);
  const v = findVersion(rule, version);
  if (!['draft', 'verified'].includes(v.status)) throw U.httpError(400, 'An approved version is replaced by approving a new version, not withdrawn');
  if (!String(reason || '').trim()) throw U.httpError(400, 'A reason is required');
  v.status = 'withdrawn';
  log(rule, actor, 'withdrawn', v.version, reason);
  return v;
}

// ── Extensions and fee waivers ────────────────────────────────────────────────
function cleanExtension(input, doc) {
  const errors = [];
  const e = {
    rule_id: String(input.rule_id || ''), kind: input.kind, period_keys: (Array.isArray(input.period_keys) ? input.period_keys : String(input.period_keys || '').split(',')).map(s => s.trim()).filter(Boolean),
    scope: { states: [].concat(input.scope?.states || []).filter(Boolean), entity_ids: [].concat(input.scope?.entity_ids || []).filter(Boolean), registration_ids: [].concat(input.scope?.registration_ids || []).filter(Boolean) },
    new_due_date: input.new_due_date || null, waiver_note: String(input.waiver_note || '').slice(0, 2000),
    issuer: String(input.issuer || '').slice(0, 200), notification_no: String(input.notification_no || '').slice(0, 200), notification_date: input.notification_date || null,
    source_url: String(input.source_url || '').slice(0, 500), retrieved_at: input.retrieved_at || null, notes: String(input.notes || '').slice(0, 2000),
  };
  if (!doc.rules.some(r => r.id === e.rule_id)) errors.push(`Rule ${e.rule_id} not found`);
  if (!['deadline_extension', 'fee_waiver'].includes(e.kind)) errors.push('Kind must be deadline_extension or fee_waiver');
  if (!e.period_keys.length) errors.push('Name the period(s) it covers, e.g. M:2026-05');
  for (const k of e.period_keys) if (!DE.periodFromKey(k)) errors.push(`"${k}" is not a period key (M:2026-05, Q:2026-27:Q1, Y:2026-27 …)`);
  if (e.kind === 'deadline_extension' && !U.isDate(e.new_due_date)) errors.push('A deadline extension needs the new due date');
  if (e.kind === 'fee_waiver' && e.new_due_date) errors.push('A fee waiver does not change the due date. If the deadline was also extended, record a separate deadline extension.');
  if (e.kind === 'fee_waiver' && !e.waiver_note) errors.push('Describe what the waiver covers (which fee, for filings made when)');
  if (e.source_url && !/^https:\/\//i.test(e.source_url)) errors.push('Source URL must start with https://');
  return { value: e, errors };
}

function createExtension(doc, input, actor) {
  const { value, errors } = cleanExtension(input, doc);
  if (errors.length) throw U.httpError(400, errors.join('; '), { errors });
  const x = { id: U.uid('X-'), ...value, status: 'draft', created_by: actor.name, created_by_id: actor.id, created_at: U.nowIso(), history: [{ at: U.nowIso(), by: actor.name, action: 'created' }] };
  doc.extensions.push(x);
  return x;
}

function setExtensionStatus(doc, id, action, { reason } = {}, actor) {
  const x = doc.extensions.find(e => e.id === id);
  if (!x) throw U.httpError(404, `Extension ${id} not found`);
  const before = U.clone(x);
  if (action === 'approve') {
    if (x.status !== 'draft') throw U.httpError(400, `Only a draft can be approved (this one is ${x.status})`);
    if (x.created_by_id === actor.id) throw U.httpError(403, 'The person who recorded an extension cannot also approve it');
    const missing = ['notification_no', 'source_url', 'retrieved_at', 'issuer'].filter(k => !x[k]);
    if (missing.length) throw U.httpError(400, `Before approval record: ${missing.join(', ').replace(/_/g, ' ')}`);
    // a newer approved extension for exactly the same rule, kind, periods and scope supersedes the older one
    for (const o of doc.extensions) {
      if (o !== x && o.status === 'approved' && o.rule_id === x.rule_id && o.kind === x.kind && U.stable(o.period_keys.slice().sort()) === U.stable(x.period_keys.slice().sort()) && U.stable(o.scope) === U.stable(x.scope)) {
        o.status = 'superseded'; o.history.push({ at: U.nowIso(), by: actor.name, action: 'superseded', note: `by ${x.id}` });
      }
    }
    Object.assign(x, { status: 'approved', approved_by: actor.name, approved_by_id: actor.id, approved_at: U.nowIso() });
  } else if (['archive', 'withdraw'].includes(action)) {
    if (!String(reason || '').trim()) throw U.httpError(400, 'A reason is required');
    if (!['draft', 'approved'].includes(x.status)) throw U.httpError(400, `This extension is already ${x.status}`);
    x.status = action === 'archive' ? 'archived' : 'withdrawn';
  } else throw U.httpError(400, `Unknown action ${action}`);
  x.history.push({ at: U.nowIso(), by: actor.name, action, note: reason || '' });
  return { extension: x, before };
}

const inScope = (x, task) => (!x.scope.entity_ids.length || x.scope.entity_ids.includes(task.entity_id))
  && (!x.scope.registration_ids.length || x.scope.registration_ids.includes(task.registration_id))
  && (!x.scope.states.length || x.scope.states.includes(task.state));

/** Approved extensions / waivers that apply to a task: { deadline: extension | null, waivers: [] } */
function extensionsFor(doc, task) {
  const hits = (doc.extensions || []).filter(x => x.status === 'approved' && x.rule_id === task.rule_id && x.period_keys.includes(task.period_key) && inScope(x, task));
  const deadline = hits.filter(x => x.kind === 'deadline_extension').sort((a, b) => (b.approved_at || '').localeCompare(a.approved_at || ''))[0] || null;
  return { deadline, waivers: hits.filter(x => x.kind === 'fee_waiver') };
}

module.exports = { EMPTY, seed, upgrade, findRule, findVersion, versionFor, liveState, checkApplicability, newDraft, editDraft, verify, approve, withdraw, createExtension, setExtensionStatus, extensionsFor, OFFICIAL_DOMAINS };
