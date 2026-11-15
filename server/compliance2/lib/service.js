/**
 * Data access shared by the routes: the documents of a space, task lookup, filters.
 *
 * A space is 'live' (real master data, approved rules only) or 'demo' (illustrative data, may use unverified rules).
 * They never share a document (store.js) or a stored file (blobs.js).
 */

'use strict';

const store = require('./store');
const U = require('./util');
const ORG = require('./org');
const RU = require('./rules');
const T = require('./tasks');
const DE = require('./dueEngine');
const AC = require('./access');

const SPACES = ['live', 'demo'];
const WORKSPACE = ['payments', 'tds', 'recon', 'imports', 'taxaudit', 'updates', 'files'];
const keys = sp => ({ org: `${sp}_org`, rules: `${sp}_rules`, applic: `${sp}_applic`, events: `${sp}_events`, docs: `${sp}_docs`, team: `${sp}_team`, meta: `${sp}_meta`,
  ...Object.fromEntries(WORKSPACE.map(n => [n, `${sp}_${n}`])) });
const DEF = { org: ORG.EMPTY, rules: RU.EMPTY, applic: () => ({ records: [] }), events: () => ({ events: [] }), docs: () => ({ documents: [] }), team: () => ({ rows: [] }), meta: () => ({}),
  payments: () => ({ payments: [] }), tds: () => ({ sections: [], challans: [], allocations: [] }), recon: () => ({ records: [] }), imports: () => ({ batches: [] }),
  taxaudit: () => ({ lots: [], payments: [], settings: {} }), updates: () => ({ updates: [], sources: [], runs: [], actions: [], user_state: {}, settings: { enabled: false, time: '09:00', extra_domains: [] } }), files: () => ({ files: [] }) };
const SETTINGS_DEF = () => ({ access: {}, soon_days: 7, retention_years: 8, max_upload_mb: 25, link_ttl_seconds: 120 });

const get = (src, key, def) => (src.get ? src.get(key, def) : src.read(key, def));

/** Several documents of a space: load(store or tx, 'live', ['org', 'rules']) → { org, rules } */
async function load(src, sp, names) {
  const k = keys(sp);
  const out = {};
  for (const n of names) out[n] = await get(src, k[n], DEF[n]());
  return out;
}
const set = (tx, sp, name, value) => tx.set(keys(sp)[name], value);

async function settings(src = store) { return { ...SETTINGS_DEF(), ...(await get(src, 'settings', {})) }; }

/** Financial years that have a task document */
async function taskFys(sp) { return (await store.list(`${sp}_tasks_`)).map(k => k.slice(`${sp}_tasks_`.length)).filter(U.validFy).sort(); }

/** All tasks of a space: { fy → doc } (inside a transaction, the documents are the transaction's copies) */
async function taskDocs(src, sp, fys) {
  const list = fys || await taskFys(sp);
  const out = {};
  for (const fy of list) out[fy] = await get(src, T.taskKey(sp, fy), { tasks: [] });
  return out;
}
const flat = docs => Object.values(docs).flatMap(d => d.tasks);

/** One task by id (its FY is part of the id) → { task, doc, fy } */
async function findTask(src, sp, id) {
  const fy = T.fyOfTaskId(id);
  if (!fy) throw U.httpError(404, 'Task not found');
  const doc = await get(src, T.taskKey(sp, fy), { tasks: [] });
  const task = doc.tasks.find(t => t.id === id);
  if (!task) throw U.httpError(404, 'Task not found');
  return { task, doc, fy };
}

/** "Today" for a space: the real date in Asia/Kolkata, or the demo's fixed snapshot date */
function todayFor(sp, meta) { return sp === 'demo' && meta?.snapshot_date ? meta.snapshot_date : U.todayIST(); }

// ── Filters ───────────────────────────────────────────────────────────────────
const list = v => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v.map(String) : String(v).split(',').map(s => s.trim()).filter(Boolean));

function parseFilters(q = {}) {
  return {
    entity_ids: list(q.entity_ids), registration_ids: list(q.registration_ids), states: list(q.states), fys: list(q.fy || q.fys), months: list(q.months), quarters: list(q.quarters),
    categories: list(q.categories), owners: list(q.owners), checkers: list(q.checkers), priorities: list(q.priorities), statuses: list(q.statuses), flags: list(q.flags),
    rule_ids: list(q.rule_ids), natures: list(q.natures), search: String(q.search || '').trim().toLowerCase().slice(0, 100),
    due_from: U.isDate(q.due_from) ? q.due_from : null, due_to: U.isDate(q.due_to) ? q.due_to : null,
    internal: q.internal === 'exclude' ? 'exclude' : q.internal === 'only' ? 'only' : 'include', revisions: q.revisions === 'include' ? 'include' : 'exclude',
  };
}

/** Month 'YYYY-MM' overlaps a task's period */
const overlapsMonth = (t, ym) => t.period_start.slice(0, 7) <= ym && t.period_end.slice(0, 7) >= ym;

/** Filters derived tasks (flags are only on derived tasks) */
function filter(tasks, f, actor) {
  return tasks.filter(t => {
    if (actor && !AC.canSeeTask(actor, t)) return false;
    if (f.revisions === 'exclude' && t.filing_version > 1 && t.status === 'completed') return false;
    if (f.internal === 'exclude' && t.internal) return false;
    if (f.internal === 'only' && !t.internal) return false;
    if (f.entity_ids.length && !(t.entity_ids || [t.entity_id]).some(id => f.entity_ids.includes(id))) return false;
    if (f.registration_ids.length && !f.registration_ids.includes(t.registration_id)) return false;
    if (f.states.length && !f.states.includes(t.state)) return false;
    if (f.fys.length && !f.fys.includes(t.fy)) return false;
    if (f.months.length && !f.months.some(m => overlapsMonth(t, m))) return false;
    if (f.quarters.length) {
      const q = DE.QUARTER_OF_MONTH(+t.period_end.slice(5, 7));
      if (!f.quarters.includes(q)) return false;
    }
    if (f.categories.length && !f.categories.includes(t.category)) return false;
    if (f.owners.length && !f.owners.includes(t.owner_id || '__none__')) return false;
    if (f.checkers.length && !f.checkers.includes(t.checker_id || '__none__')) return false;
    if (f.priorities.length && !f.priorities.includes(t.priority)) return false;
    if (f.statuses.length && !f.statuses.includes(t.status)) return false;
    if (f.rule_ids.length && !f.rule_ids.includes(t.rule_id)) return false;
    if (f.natures.length && !f.natures.includes(t.nature)) return false;
    if (f.flags.length && !f.flags.every(fl => (fl === 'review' ? ['ready_for_review', 'filed_awaiting_verification'].includes(t.status) : fl === 'open' ? t.status !== 'completed' : t.flags.includes(fl)))) return false;
    if (f.due_from && (!t.effective_due || t.effective_due < f.due_from)) return false;
    if (f.due_to && (!t.effective_due || t.effective_due > f.due_to)) return false;
    if (f.search) {
      const hay = `${t.id} ${t.rule_id} ${t.rule_name} ${t.form} ${t.scope_label} ${t.period_label} ${t.owner_name} ${t.checker_name} ${t.filing?.ack_no || ''} ${t.filing?.payment?.reference || ''}`.toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    return true;
  });
}

/** Documents by task id (all records, active or not — derive() decides what counts) */
function docsByTask(docsDoc) {
  const m = new Map();
  for (const d of docsDoc.documents) for (const id of d.task_ids) (m.get(id) || m.set(id, []).get(id)).push(d);
  return m;
}

/** Visible entity list for an actor */
const visibleEntities = (org, actor) => org.entities.filter(e => AC.canSeeEntity(actor, e.id));

/** The org document narrowed to what an actor may see */
function scopedOrg(org, actor) {
  const ids = new Set(visibleEntities(org, actor).map(e => e.id));
  return {
    groups: org.groups, entities: org.entities.filter(e => ids.has(e.id)), registrations: org.registrations.filter(r => ids.has(r.entity_id)),
    establishments: org.establishments.filter(b => ids.has(b.entity_id)),
    people: org.people.filter(p => p.roles.some(r => ids.has(r.entity_id))).map(p => ({ ...p, din: p.din ? `••••${p.din.slice(-4)}` : '', din_recorded: !!p.din })),
  };
}

module.exports = { SPACES, WORKSPACE, keys, DEF, load, set, settings, taskFys, taskDocs, flat, findTask, todayFor, parseFilters, filter, docsByTask, visibleEntities, scopedOrg, get };
