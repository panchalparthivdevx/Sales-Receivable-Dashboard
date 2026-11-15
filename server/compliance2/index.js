/**
 * Compliance Dashboard Vr.2.0 — API routes, mounted at /api/compliance2 (see server/index.js).
 *
 * Every route needs the app's login (JWT), except GET /dl/<token> (a signed, short-lived, per-user download link that is
 * checked against the user's current access when used). Rights: lib/access.js. Space: ?space=live|demo (default live) or
 * the X-C2-Space header; demo personas: X-C2-Persona (demo space only).
 *
 * The module never files anything on a government portal, never sends email or messages, and never writes to Zoho.
 * Logic lives in ./lib — see README.md, DATA_DICTIONARY.md and API.md in this folder.
 */

'use strict';

const express = require('express');
const multer  = require('multer');

const { loadUsers } = require('../auth');
const store = require('./lib/store');
const U = require('./lib/util');
const S = require('./lib/service');
const ORG = require('./lib/org');
const RU = require('./lib/rules');
const AP = require('./lib/applicability');
const T = require('./lib/tasks');
const W = require('./lib/workflow');
const DOC = require('./lib/documents');
const BL = require('./lib/blobs');
const SC = require('./lib/scanner');
const AU = require('./lib/audit');
const AC = require('./lib/access');
const COV = require('./lib/coverage');
const MET = require('./lib/metrics');
const EXP = require('./lib/exporter');
const IMP = require('./lib/importer');
const DEMO = require('./lib/demo');
const CAT = require('./lib/catalogue');
const DE = require('./lib/dueEngine');
const FO = require('./lib/folders');
const PV = require('./lib/provision');
const GR = require('./lib/graph');
const GS = require('./lib/graphSim');
const MS = require('./lib/msauth');
const DEMO2 = require('./lib/demo2');
const TDS = require('./lib/tds');
const UP = require('./lib/updates');
const { background } = require('../background');

const router = express.Router();
const IS_VERCEL = !!process.env.VERCEL;
let usersOf = loadUsers;
// tests inject a simulated OneDrive (deps.graph) and a stand-in for the Microsoft sign-in (deps.msauth)
let graphOverride = null, msauthOverride = null, fetchOverride = null;
router.init = (deps = {}) => {
  if (deps.loadUsers) usersOf = deps.loadUsers;
  if (deps.fetcher) fetchOverride = deps.fetcher;
  if (deps.graph !== undefined) { graphOverride = deps.graph; liveGraph = null; }
  if (deps.msauth) msauthOverride = deps.msauth;
  return router;
};

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const MAX_MB = () => (IS_VERCEL ? 4 : 25);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 26 * 1024 * 1024, files: 1 } });

// ── Space set-up ──────────────────────────────────────────────────────────────
const ready = new Map();
function spaceOf(req) {
  const sp = String(req.query.space || req.get('x-c2-space') || 'live');
  if (!S.SPACES.includes(sp)) throw U.httpError(400, 'space must be live or demo');
  return sp;
}
async function ensure(sp) {
  if (ready.get(sp)) return;
  const meta = await store.read(S.keys(sp).meta, null);
  if (!meta?.initialised_at) { if (sp === 'demo') await resetDemo(DEMO.SEED_ACTOR, { onlyIfEmpty: true }); else await initLive(); }
  await upgradeCatalogue(sp);
  await seedWorkspace(sp);
  ready.set(sp, true);
}
/** Workspace stores: the TDS section master and the update sources start from the official seed lists (all unverified /
 *  monitor off); a demo space made before the workspace tabs existed gets its illustrative workspace records. */
async function seedWorkspace(sp) {
  const k = S.keys(sp);
  if (sp === 'demo' && !(await store.read(k.updates, null))) {
    const { org, meta } = await S.load(store, 'demo', ['org', 'meta']);
    const w = await DEMO2.build({ org, snapshot: meta.snapshot_date || DEMO.fixedSnapshot() });
    await store.transaction(async tx => {
      if (await tx.get(k.updates, null)) return;
      for (const n of S.WORKSPACE) tx.set(k[n], w[n]);
      await AU.append(tx, 'demo', { actor: DEMO.SEED_ACTOR, action: 'demo_workspace_seeded', summary: 'Illustrative payments, TDS challans, reconciliation inputs, a payroll import, tax-audit lots and curated update entries added to the demo' });
    });
    return;
  }
  if (sp !== 'live') return;
  const tds = await store.read(k.tds, null), up = await store.read(k.updates, null);
  if (tds?.sections?.length && up?.sources?.length) return;
  await store.transaction(async tx => {
    const t = await tx.get(k.tds, S.DEF.tds()), u = await tx.get(k.updates, S.DEF.updates());
    const a = TDS.seed(t), b = UP.seedSources(u);
    if (!a && !b) return;
    tx.set(k.tds, t); tx.set(k.updates, u);
    await AU.append(tx, 'live', { action: 'workspace_seeded', summary: `${a} TDS section reference(s) added as "requires verification"; ${b} official update source(s) listed (monitor off until an administrator turns it on)` });
  });
}
/** A newer catalogue adds its new rules and updates rules nobody has touched; edited rules are kept (and listed) */
async function upgradeCatalogue(sp) {
  const cur = await store.read(S.keys(sp).rules, null);
  if (!cur || (cur.catalogue_version || 0) >= CAT.CATALOGUE_VERSION) return;
  await store.transaction(async tx => {
    const rules = await tx.get(S.keys(sp).rules, RU.EMPTY());
    const r = RU.upgrade(rules);
    S.set(tx, sp, 'rules', rules);
    await AU.append(tx, sp, { action: 'catalogue_upgraded', object_type: 'rules', object_id: `catalogue-v${CAT.CATALOGUE_VERSION}`,
      summary: `Catalogue v${CAT.CATALOGUE_VERSION}: ${r.added.length} rule(s) added (${r.added.join(', ') || '—'}), ${r.updated.length} unedited rule(s) updated${r.kept_edited.length ? `; edited rules kept as they are: ${r.kept_edited.join(', ')}` : ''}` });
  });
}
async function initLive() {
  await store.transaction(async tx => {
    const meta = await tx.get('live_meta', {});
    if (meta.initialised_at) return;
    const rules = await tx.get('live_rules', RU.EMPTY());
    const added = RU.seed(rules);
    tx.set('live_rules', rules);
    tx.set('live_meta', { initialised_at: U.nowIso(), catalogue_version: rules.catalogue_version });
    await AU.append(tx, 'live', { action: 'space_initialised', summary: `Live space created: ${added.length} catalogue rules added as UNVERIFIED drafts (blocked from live scheduling until verified and approved). No entities, no tasks.` });
  });
}
async function resetDemo(actor, { onlyIfEmpty } = {}) {
  const built = await DEMO.build();
  const work = await DEMO2.build({ org: built.org, snapshot: built.meta.snapshot_date });
  const old = (await store.list('demo_tasks_')).map(k => k.slice('demo_tasks_'.length));
  await store.transaction(async tx => {
    if (onlyIfEmpty && (await tx.get('demo_meta', {})).initialised_at) return;
    for (const n of ['org', 'rules', 'applic', 'events', 'team', 'docs', 'meta']) S.set(tx, 'demo', n, built[n]);
    for (const n of S.WORKSPACE) S.set(tx, 'demo', n, work[n]);
    for (const fy of U.uniq([...old, ...Object.keys(built.tasksDocs)])) tx.set(T.taskKey('demo', fy), built.tasksDocs[fy] || { tasks: [] });
    tx.set('demo_folders', PV.EMPTY());                    // the simulated OneDrive starts empty again
    tx.set('demo_graphsim', null);
    demoSim = null;
    await AU.append(tx, 'demo', { actor, action: 'demo_reset', summary: `Demo space rebuilt with ILLUSTRATIVE data (snapshot ${built.meta.snapshot_date}): ${Object.values(built.tasksDocs).reduce((a, d) => a + d.tasks.length, 0)} sample tasks` });
  });
}

// ── Identity and rights ───────────────────────────────────────────────────────
const WHY = {
  prepare: 'This needs the "Prepare (maker)" right.', review: 'This needs the "Review (checker)" right.', file: 'This needs the "File" right.',
  verify: 'This needs the "Verify & close" right.', approve: 'This needs the "Approve" right.', rules: 'This needs the "Rules & applicability" right.',
  master: 'This needs the "Master data" right.', admin: 'This needs the "Administer" right.',
};
function gate(right) {
  return wrap(async (req, res, next) => {
    const sp = spaceOf(req);
    await ensure(sp);
    const users = await usersOf();
    const settings = await S.settings();
    const actor = AC.resolve(users, req.user, { settings, space: sp, persona: sp === 'demo' ? String(req.get('x-c2-persona') || '') : '' });
    if (actor.error) return bad(res, actor.error, actor.message);
    const need = [].concat(right || []);
    if (need.length && !need.some(r => actor.rights[r])) return bad(res, 403, need.map(r => WHY[r]).join(' Or: '));
    req.c2 = { sp, actor, users, settings, live: sp === 'live' };
    next();
  });
}
const nameOf = (users, sp) => id => {
  if (!id) return '';
  if (sp === 'demo' && /^demo:/.test(id)) return `${id.slice(5).replace(/^./, c => c.toUpperCase())} (demo)`;
  const u = users.find(x => x.id === id);
  return u ? (u.name || u.username) : id;
};
function mustSeeEntity(req, entityId) { if (!AC.canSeeEntity(req.c2.actor, entityId)) throw U.httpError(404, 'Not found'); }
function mustBeUnscoped(req) { if (req.c2.actor.entities !== null) throw U.httpError(403, 'You are limited to some entities, so you cannot make group-wide changes. Ask an administrator.'); }
const audit = (tx, req, e) => AU.append(tx, req.c2.sp, { actor: req.c2.actor, ...e });

// ── Derived tasks for a request ───────────────────────────────────────────────
function clockFor(sp, meta) {
  const today = S.todayFor(sp, meta);
  return { today, nowMs: sp === 'demo' && meta?.snapshot_date ? Date.parse(`${meta.snapshot_date}T12:00:00+05:30`) : U.clock.now() };
}
async function derivedTasks(req, f) {
  const { sp, actor, settings } = req.c2;
  const { docs, meta } = await S.load(store, sp, ['docs', 'meta']);
  const fys = f?.fys?.length ? f.fys : undefined;
  const tdocs = await S.taskDocs(store, sp, fys);
  const dbt = S.docsByTask(docs);
  const { today, nowMs } = clockFor(sp, meta);
  const all = S.flat(tdocs).filter(t => AC.canSeeTask(actor, t)).map(t => T.derive(t, { today, nowMs, docs: dbt.get(t.id) || [], soonDays: settings.soon_days }));
  return { all, today, meta, docs, dbt };
}
const slim = t => { const { history, evidence_rule, ...rest } = t; return rest; };

// ── Meta ──────────────────────────────────────────────────────────────────────
router.get('/meta', gate(), wrap(async (req, res) => {
  const { sp, actor, settings } = req.c2;
  const meta = await store.read(S.keys(sp).meta, {});
  const fys = await S.taskFys(sp);
  res.json({
    space: sp, live: sp === 'live', today_ist: U.todayIST(), today: S.todayFor(sp, meta), demo: sp === 'demo' ? { snapshot_date: meta.snapshot_date, initialised_at: meta.initialised_at, illustrative: true } : null,
    actor: { id: actor.id, name: actor.name, rights: actor.rights, auditor: actor.auditor, admin: actor.admin, persona: actor.persona, scoped: actor.entities !== null },
    fys, storage: { ...BL.status(), scanner: SC.engine(), max_upload_mb: MAX_MB(), vercel: IS_VERCEL },
    settings: { soon_days: settings.soon_days, retention_years: settings.retention_years },
    constants: {
      categories: CAT.CATEGORIES, reg_types: CAT.REG_TYPES, entity_types: CAT.ENTITY_TYPES, event_types: CAT.EVENT_TYPES, doc_types: CAT.DOC_TYPES, ack_types: CAT.ACK_TYPES,
      statuses: T.STATUS, transitions: Object.fromEntries(Object.entries(W.TRANSITIONS).map(([k, v]) => [k, v.label])), gaps: COV.GAPS, personas: Object.fromEntries(Object.entries(AC.PERSONAS).map(([k, v]) => [k, v.label])),
      rights: AC.SECTIONS, states: require('./lib/validate').STATES, frequencies: DE.FREQUENCIES, expr_types: DE.EXPR_TYPES, applicability: AP.STATUSES, entity_flags: ORG.ENTITY_FLAGS, reg_flags: ORG.REG_FLAGS, est_flags: ORG.EST_FLAGS, fy_facts: ORG.FY_FACTS,
    },
  });
}));

router.get('/users', gate(), wrap(async (req, res) => {
  const out = req.c2.users.filter(u => u.active !== false && (u.role === 'admin' || u.permissions?.compliance_v2?.enabled === true)).map(u => ({
    id: u.id, name: u.name || u.username, admin: u.role === 'admin',
    rights: AC.rightsOf(u), roles: AC.rolesOf(u), auditor: u.role !== 'admin' && !!u.permissions?.compliance_v2?.sections?.c2_auditor,
  }));
  if (req.c2.sp === 'demo') for (const p of ['initiator', 'approver']) out.push({ id: `demo:${p}`, name: `${p[0].toUpperCase()}${p.slice(1)} (demo)`, demo: true, rights: [] });
  res.json({ users: out });
}));

// ── Masters ───────────────────────────────────────────────────────────────────
router.get('/org', gate(), wrap(async (req, res) => {
  const { org } = await S.load(store, req.c2.sp, ['org']);
  res.json(S.scopedOrg(org, req.c2.actor));
}));

router.post('/org/:kind', gate('master'), wrap(async (req, res) => {
  if (!ORG.KINDS[req.params.kind]) return bad(res, 404, 'Unknown master');
  if (req.params.kind === 'entity') mustBeUnscoped(req);
  else if (req.body.entity_id) mustSeeEntity(req, req.body.entity_id);
  const out = await store.transaction(async tx => {
    const { org } = await S.load(tx, req.c2.sp, ['org']);
    const r = ORG.upsert(org, req.params.kind, req.body || {}, { actor: req.c2.actor, illustrative: req.c2.sp === 'demo' });
    S.set(tx, req.c2.sp, 'org', org);
    await audit(tx, req, { action: `${req.params.kind}_created`, object_type: req.params.kind, object_id: r.record.id, entity_id: r.record.entity_id || r.record.id, after: r.record, summary: `${req.params.kind} created` });
    return r;
  });
  autoFolders(req, out.record.entity_id || (req.params.kind === 'entity' ? out.record.id : null));
  res.json(out);
}));

router.put('/org/:kind/:id', gate('master'), wrap(async (req, res) => {
  const kind = req.params.kind;
  if (!ORG.KINDS[kind]) return bad(res, 404, 'Unknown master');
  const out = await store.transaction(async tx => {
    const { org } = await S.load(tx, req.c2.sp, ['org']);
    const cur = org[ORG.KINDS[kind].list].find(x => x.id === req.params.id);
    if (!cur) throw U.httpError(404, 'Not found');
    const ent = cur.entity_id || (kind === 'person' ? cur.roles?.[0]?.entity_id : cur.id);
    mustSeeEntity(req, ent);
    const r = ORG.upsert(org, kind, req.body || {}, { actor: req.c2.actor, id: req.params.id, expectedRev: req.body?.rev });
    S.set(tx, req.c2.sp, 'org', org);
    await audit(tx, req, { action: `${kind}_updated`, object_type: kind, object_id: r.record.id, entity_id: ent, before: r.before, after: r.record, reason: req.body?.reason || '', summary: `${kind} updated` });
    return { ...r, entity_for_folders: ['entity', 'registration', 'establishment'].includes(kind) ? ent : null };
  });
  autoFolders(req, out.entity_for_folders);
  res.json(out);
}));

router.post('/org/:kind/:id/approve', gate('approve'), wrap(async (req, res) => {
  const kind = req.params.kind;
  if (!['entity', 'registration'].includes(kind)) return bad(res, 400, 'Only entities and registrations are approved');
  const out = await store.transaction(async tx => {
    const { org } = await S.load(tx, req.c2.sp, ['org']);
    const rec = org[ORG.KINDS[kind].list].find(x => x.id === req.params.id);
    if (!rec) throw U.httpError(404, 'Not found');
    mustSeeEntity(req, rec.entity_id || rec.id);
    const r = ORG.approve(org, kind, req.params.id, req.c2.actor);
    S.set(tx, req.c2.sp, 'org', org);
    await audit(tx, req, { action: `${kind}_approved`, object_type: kind, object_id: rec.id, entity_id: rec.entity_id || rec.id, before: r.before, after: r.record, summary: `${kind} master data approved` });
    return r;
  });
  autoFolders(req, out.record.entity_id || out.record.id);
  res.json(out);
}));

// ── Rules, versions, extensions ───────────────────────────────────────────────
router.get('/rules', gate(), wrap(async (req, res) => {
  const { rules } = await S.load(store, req.c2.sp, ['rules']);
  res.json({ ...rules, rules: rules.rules.map(r => ({ ...r, versions: r.versions.map(v => ({ ...v, due_text: DE.describe(v.due), due_problems: DE.checkExpr(v.due ?? null) })) })) });
}));

router.post('/rules/:id/versions', gate('rules'), wrap(async (req, res) => {
  mustBeUnscoped(req);
  const v = await store.transaction(async tx => {
    const { rules } = await S.load(tx, req.c2.sp, ['rules']);
    const x = RU.newDraft(rules, req.params.id, req.body || {}, req.c2.actor);
    S.set(tx, req.c2.sp, 'rules', rules);
    await audit(tx, req, { action: 'rule_draft_created', object_type: 'rule', object_id: `${req.params.id}@v${x.version}`, after: x, summary: `New draft version ${x.version} of ${req.params.id}` });
    return x;
  });
  res.json({ version: v });
}));

router.put('/rules/:id/versions/:v', gate('rules'), wrap(async (req, res) => {
  mustBeUnscoped(req);
  const out = await store.transaction(async tx => {
    const { rules } = await S.load(tx, req.c2.sp, ['rules']);
    const r = RU.editDraft(rules, req.params.id, req.params.v, req.body?.patch || {}, req.c2.actor);
    S.set(tx, req.c2.sp, 'rules', rules);
    await audit(tx, req, { action: 'rule_draft_edited', object_type: 'rule', object_id: `${req.params.id}@v${req.params.v}`, before: r.before, after: r.version, summary: 'Rule draft edited' });
    return r.version;
  });
  res.json({ version: out });
}));

router.post('/rules/:id/versions/:v/verify', gate('rules'), wrap(async (req, res) => {
  mustBeUnscoped(req);
  const out = await store.transaction(async tx => {
    const { rules } = await S.load(tx, req.c2.sp, ['rules']);
    const before = U.clone(RU.findVersion(RU.findRule(rules, req.params.id), req.params.v));
    const r = RU.verify(rules, req.params.id, req.params.v, req.body || {}, req.c2.actor);
    S.set(tx, req.c2.sp, 'rules', rules);
    await audit(tx, req, { action: 'rule_verified', object_type: 'rule', object_id: `${req.params.id}@v${req.params.v}`, before, after: r.version, summary: `Verified against ${r.version.source_url}`, reason: r.version.verification_note });
    return r;
  });
  res.json(out);
}));

function previewScope(src) {
  const l = v => (v ? String(v).split(',').filter(Boolean) : []);
  return { entity_ids: l(src.entity_ids), registration_ids: l(src.registration_ids), period_from: U.isDate(src.period_from) ? src.period_from : null, period_to: U.isDate(src.period_to) ? src.period_to : null };
}
async function computePreview(src, sp, ruleId, v, scope) {
  const { org, rules, events } = await S.load(src, sp, ['org', 'rules', 'events']);
  const tdocs = await S.taskDocs(src, sp);
  const rule = RU.findRule(rules, ruleId);
  const version = RU.findVersion(rule, v);
  return { p: T.previewVersion({ rule, version, tasksAll: S.flat(tdocs), org, rulesDoc: rules, events: events.events, live: sp === 'live', scope }), org, rules, events, tdocs, rule, version };
}

router.get('/rules/:id/versions/:v/preview', gate(['approve', 'rules']), wrap(async (req, res) => {
  mustBeUnscoped(req);
  const { p, version } = await computePreview(store, req.c2.sp, req.params.id, req.params.v, previewScope(req.query));
  res.json({ ...p, version: { version: version.version, status: version.status, due_text: DE.describe(version.due), effective_from: version.effective_from, effective_to: version.effective_to } });
}));

router.post('/rules/:id/versions/:v/approve', gate('approve'), wrap(async (req, res) => {
  mustBeUnscoped(req);
  const scope = previewScope(req.body?.scope || {});
  const out = await store.transaction(async tx => {
    const { p, org, rules, events, tdocs, version } = await computePreview(tx, req.c2.sp, req.params.id, req.params.v, scope);
    if (!req.body?.preview_hash || req.body.preview_hash !== p.hash) throw U.httpError(409, 'The impact of this version changed since it was previewed (or no preview was quoted). Open the preview again and approve what it shows.', { preview: p });
    const before = U.clone(version);
    const r = RU.approve(rules, req.params.id, req.params.v, { note: req.body?.note, scope }, req.c2.actor);
    const all = S.flat(tdocs);
    let changed = 0;
    const touched = new Set();
    for (const row of p.rows.filter(x => x.effect === 'due date changes' || x.effect === 'version only')) {
      const t = all.find(x => x.id === row.task_id);
      const c = T.recompute(t, { org, rulesDoc: rules, events: events.events, tasks: all, version: r.version, live: req.c2.live, actor: req.c2.actor, apply: true, reason: `Rule ${req.params.id} version ${r.version.version} approved by ${req.c2.actor.name}` });
      if (c.changed) { changed++; touched.add(t.fy); }
    }
    S.set(tx, req.c2.sp, 'rules', rules);
    for (const fy of touched) tx.set(T.taskKey(req.c2.sp, fy), tdocs[fy]);
    await audit(tx, req, { action: 'rule_approved', object_type: 'rule', object_id: `${req.params.id}@v${req.params.v}`, before, after: r.version, reason: req.body?.note || '',
      summary: `Approved with impact preview ${p.hash}: ${changed} open task(s) updated, ${(p.counts['kept (filed)'] || 0)} filed task(s) kept. ${r.changed.join('; ')}` });
    return { version: r.version, tasks_updated: changed, preview: p.counts };
  });
  res.json(out);
}));

router.post('/rules/:id/versions/:v/withdraw', gate('rules'), wrap(async (req, res) => {
  mustBeUnscoped(req);
  const v = await store.transaction(async tx => {
    const { rules } = await S.load(tx, req.c2.sp, ['rules']);
    const x = RU.withdraw(rules, req.params.id, req.params.v, req.body?.reason, req.c2.actor);
    S.set(tx, req.c2.sp, 'rules', rules);
    await audit(tx, req, { action: 'rule_withdrawn', object_type: 'rule', object_id: `${req.params.id}@v${req.params.v}`, reason: req.body?.reason, summary: 'Rule version withdrawn' });
    return x;
  });
  res.json({ version: v });
}));

async function reapplyExtensions(tx, req, ruleId) {
  const { rules } = await S.load(tx, req.c2.sp, ['rules']);
  const tdocs = await S.taskDocs(tx, req.c2.sp);
  let n = 0;
  for (const [fy, doc] of Object.entries(tdocs)) {
    let dirty = false;
    for (const t of doc.tasks.filter(x => x.rule_id === ruleId)) {
      const before = U.stable(t.fee_waivers);
      if (T.applyExtensions(t, rules, req.c2.actor)) {
        T.setInternalTarget(t, RU.findRule(rules, t.rule_id).versions.find(v => v.version === t.rule_version));
        t.rev++; t.updated_at = U.nowIso(); t.updated_by = req.c2.actor.name; n++; dirty = true;
      } else if (U.stable(t.fee_waivers) !== before) { T.hist(t, req.c2.actor, 'fee_waiver', 'Fee waiver records changed (the due date is not affected)'); t.rev++; dirty = true; }
    }
    if (dirty) tx.set(T.taskKey(req.c2.sp, fy), doc);
  }
  return n;
}

router.post('/extensions', gate('rules'), wrap(async (req, res) => {
  mustBeUnscoped(req);
  const x = await store.transaction(async tx => {
    const { rules } = await S.load(tx, req.c2.sp, ['rules']);
    const e = RU.createExtension(rules, req.body || {}, req.c2.actor);
    S.set(tx, req.c2.sp, 'rules', rules);
    await audit(tx, req, { action: 'extension_created', object_type: 'extension', object_id: e.id, after: e, summary: `${e.kind} for ${e.rule_id} ${e.period_keys.join(', ')} (draft)` });
    return e;
  });
  res.json({ extension: x });
}));

router.post('/extensions/:id/:action', gate('approve'), wrap(async (req, res) => {
  mustBeUnscoped(req);
  if (!['approve', 'archive', 'withdraw'].includes(req.params.action)) return bad(res, 404, 'Unknown action');
  const out = await store.transaction(async tx => {
    const { rules } = await S.load(tx, req.c2.sp, ['rules']);
    const r = RU.setExtensionStatus(rules, req.params.id, req.params.action, req.body || {}, req.c2.actor);
    S.set(tx, req.c2.sp, 'rules', rules);
    const n = await reapplyExtensions(tx, req, r.extension.rule_id);
    await audit(tx, req, { action: `extension_${req.params.action}`, object_type: 'extension', object_id: r.extension.id, before: r.before, after: r.extension, reason: req.body?.reason || '', summary: `${r.extension.kind} ${req.params.action}d — ${n} task due date(s) changed` });
    return { extension: r.extension, tasks_changed: n };
  });
  res.json(out);
}));

// ── Applicability and coverage ────────────────────────────────────────────────
function entityScope(req, wanted) {
  const a = req.c2.actor.entities;
  if (a === null) return wanted?.length ? wanted : undefined;
  return wanted?.length ? wanted.filter(id => a.includes(id)) : a;
}
async function coverage(req) {
  const fy = U.validFy(req.query.fy) ? req.query.fy : U.fyOf(S.todayFor(req.c2.sp, await store.read(S.keys(req.c2.sp).meta, {})));
  const { org, rules, applic } = await S.load(store, req.c2.sp, ['org', 'rules', 'applic']);
  const tdocs = await S.taskDocs(store, req.c2.sp, [fy]);
  return COV.report({ org, rulesDoc: rules, applic, tasksAll: S.flat(tdocs), fy, entityIds: entityScope(req, S.parseFilters(req.query).entity_ids), live: req.c2.live });
}
router.get('/coverage', gate(), wrap(async (req, res) => res.json(await coverage(req))));

router.post('/applicability', gate('rules'), wrap(async (req, res) => {
  const out = await store.transaction(async tx => {
    const { org, rules, applic } = await S.load(tx, req.c2.sp, ['org', 'rules', 'applic']);
    const r = AP.record(applic, rules, org, req.body || {}, req.c2.actor);
    mustSeeEntity(req, r.record.entity_id);
    S.set(tx, req.c2.sp, 'applic', applic);
    await audit(tx, req, { action: 'applicability_decided', object_type: 'applicability', object_id: r.record.id, entity_id: r.record.entity_id, before: r.previous, after: r.record, reason: r.record.reason, summary: `${r.record.rule_id}: ${AP.STATUSES[r.record.status]}` });
    return r;
  });
  res.json(out);
}));

/** Accept the automatic suggestion for several scopes (only where the facts decide it — never for "needs review") */
router.post('/applicability/accept', gate('rules'), wrap(async (req, res) => {
  const fy = req.body?.fy;
  if (!U.validFy(fy)) return bad(res, 400, 'fy is required');
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 2000) : [];
  const out = await store.transaction(async tx => {
    const { org, rules, applic } = await S.load(tx, req.c2.sp, ['org', 'rules', 'applic']);
    const { start, end } = U.fyBounds(fy);
    const done = [], skipped = [];
    for (const it of items) {
      const rule = rules.rules.find(r => r.id === it.rule_id);
      if (!rule) { skipped.push({ ...it, why: 'rule not found' }); continue; }
      const scope = AP.scopesFor(rule, org, { start, end, entityIds: entityScope(req) }).find(s => (AP.decisionScopeType(rule) === 'entity' ? s.entity_id : s.scope_id) === it.scope_id);
      if (!scope) { skipped.push({ ...it, why: 'scope not found or not visible' }); continue; }
      const sug = AP.suggest(RU.versionFor(rule, start, { live: false }).version, scope, fy);
      if (sug.status === 'needs_review') { skipped.push({ ...it, why: `needs a person's decision (${sug.missing.join(', ') || 'no automatic test'})` }); continue; }
      const r = AP.record(applic, rules, org, { rule_id: rule.id, scope_type: AP.decisionScopeType(rule), scope_id: it.scope_id, status: sug.status, effective_from: start, basis: 'suggestion_accepted',
        reason: `Accepted the rule test result for FY ${fy}: ${sug.trace.join('; ') || 'applies to every scope of this kind'}` }, req.c2.actor);
      done.push(r.record);
    }
    S.set(tx, req.c2.sp, 'applic', applic);
    await audit(tx, req, { action: 'applicability_accepted', object_type: 'applicability', object_id: `bulk:${fy}`, summary: `${done.length} suggestion(s) accepted for FY ${fy}, ${skipped.length} skipped` });
    return { accepted: done.length, skipped };
  });
  res.json(out);
}));

// ── Events ────────────────────────────────────────────────────────────────────
router.get('/events', gate(), wrap(async (req, res) => {
  const { events } = await S.load(store, req.c2.sp, ['events']);
  res.json({ events: events.events.filter(e => AC.canSeeEntity(req.c2.actor, e.entity_id)) });
}));

async function saveEvent(req, res, id) {
  const out = await store.transaction(async tx => {
    const { org, rules, applic, events, team } = await S.load(tx, req.c2.sp, ['org', 'rules', 'applic', 'events', 'team']);
    const { value, errors } = T.cleanEvent(req.body || {}, org);
    if (errors.length) throw U.httpError(400, errors.join('; '), { errors });
    mustSeeEntity(req, value.entity_id);
    let ev = id ? events.events.find(e => e.id === id) : null;
    if (id && !ev) throw U.httpError(404, 'Event not found');
    const before = ev ? U.clone(ev) : null;
    if (ev) {
      if (req.body?.rev !== undefined && Number(req.body.rev) !== ev.rev) throw U.httpError(409, 'This event was changed since you opened it. Reload and try again.');
      mustSeeEntity(req, ev.entity_id);
      Object.assign(ev, value, { updated_at: U.nowIso(), updated_by: req.c2.actor.name, rev: (ev.rev || 1) + 1 });
      ev.history.push({ at: U.nowIso(), by: req.c2.actor.name, action: 'updated', note: req.body?.reason || '' });
    } else {
      ev = { id: U.uid('V-'), ...value, illustrative: req.c2.sp === 'demo', created_at: U.nowIso(), created_by: req.c2.actor.name, rev: 1, history: [{ at: U.nowIso(), by: req.c2.actor.name, action: 'created' }] };
      events.events.push(ev);
    }
    // tasks this event creates, and dates that depend on it (AGM → AOC-4 / MGT-7; notice → reply date)
    const fy = U.fyOf(ev.event_date);
    const tdocs = await S.taskDocs(tx, req.c2.sp, U.uniq([fy, ev.fy].filter(Boolean)));
    const ruleIds = rules.rules.filter(r => r.frequency === 'event' && (r.scope.event_types || []).includes(ev.type)).map(r => r.id);
    const g = ruleIds.length ? T.generate({ org, rulesDoc: rules, applic, events, team, tasksDocs: tdocs, fy, entityIds: [ev.entity_id], ruleIds, live: req.c2.live, actor: req.c2.actor, nameOf: nameOf(req.c2.users, req.c2.sp) }) : { created: [], blocked: [] };
    const all = S.flat(tdocs);
    let recomputed = 0;
    for (const t of all) {
      if (g.created.includes(t)) continue;
      const depends = t.event_id === ev.id || (t.entity_id === ev.entity_id && t.fy === ev.fy && RU.findRule(rules, t.rule_id).versions.some(v => v.due?.type === 'event_offset' && v.due.event_type === ev.type));
      if (!depends) continue;
      if (T.recompute(t, { org, rulesDoc: rules, events: events.events, tasks: all, live: req.c2.live, actor: req.c2.actor, apply: true, reason: `${CAT.EVENT_TYPES[ev.type]} ${before ? 'changed' : 'recorded'} (${ev.event_date})` }).changed) recomputed++;
    }
    S.set(tx, req.c2.sp, 'events', events);
    for (const [k, d] of Object.entries(tdocs)) tx.set(T.taskKey(req.c2.sp, k), d);
    await audit(tx, req, { action: before ? 'event_updated' : 'event_created', object_type: 'event', object_id: ev.id, entity_id: ev.entity_id, before, after: ev,
      summary: `${CAT.EVENT_TYPES[ev.type]} ${ev.event_date}: ${g.created.length} task(s) created, ${recomputed} due date(s) recomputed${g.blocked.length ? `, ${g.blocked.length} blocked` : ''}` });
    return { event: ev, created: g.created.map(slim), blocked: g.blocked, recomputed };
  });
  res.json(out);
}
router.post('/events', gate('master'), wrap((req, res) => saveEvent(req, res, null)));
router.put('/events/:id', gate('master'), wrap((req, res) => saveEvent(req, res, req.params.id)));

// ── Tasks ─────────────────────────────────────────────────────────────────────
router.post('/tasks/generate', gate('master'), wrap(async (req, res) => {
  const fy = req.body?.fy;
  if (!U.validFy(fy)) return bad(res, 400, 'Choose a financial year (e.g. 2026-27)');
  const entityIds = entityScope(req, [].concat(req.body?.entity_ids || []));
  const ruleIds = req.body?.rule_ids?.length ? [].concat(req.body.rule_ids) : undefined;
  const run = async src => {
    const { org, rules, applic, events, team } = await S.load(src, req.c2.sp, ['org', 'rules', 'applic', 'events', 'team']);
    const tdocs = await S.taskDocs(src, req.c2.sp, [fy]);
    const g = T.generate({ org, rulesDoc: rules, applic, events, team, tasksDocs: tdocs, fy, entityIds, ruleIds, live: req.c2.live, actor: req.c2.actor, nameOf: nameOf(req.c2.users, req.c2.sp) });
    return { g, tdocs };
  };
  const summary = g => ({ fy, created: g.created.length, existing: g.existing, not_applicable: g.not_applicable, blocked: g.blocked.length,
    blocked_by_code: g.blocked.reduce((c, b) => { c[b.code] = (c[b.code] || 0) + 1; return c; }, {}), blocked_rows: g.blocked.slice(0, 500), created_rows: g.created.slice(0, 300).map(slim) });
  if (!req.body?.commit) { const { g } = await run(store); return res.json({ preview: true, ...summary(g) }); }
  const out = await store.transaction(async tx => {
    const { g, tdocs } = await run(tx);
    if (g.created.length) tx.set(T.taskKey(req.c2.sp, fy), tdocs[fy]);
    await audit(tx, req, { action: 'tasks_generated', object_type: 'tasks', object_id: `${req.c2.sp}:${fy}`, summary: `FY ${fy}: ${g.created.length} created, ${g.existing} already existed, ${g.blocked.length} blocked, ${g.not_applicable} not applicable` });
    return summary(g);
  });
  res.json({ preview: false, ...out });
}));

router.get('/tasks', gate(), wrap(async (req, res) => {
  const f = S.parseFilters(req.query);
  const { all, today } = await derivedTasks(req, f);
  const list = S.filter(all, f, req.c2.actor).sort((a, b) => String(a.effective_due || '9999').localeCompare(String(b.effective_due || '9999')) || a.rule_id.localeCompare(b.rule_id));
  res.json({ today, total: list.length, tasks: list.map(slim) });
}));

router.get('/overview', gate(), wrap(async (req, res) => {
  const f = S.parseFilters(req.query);
  const { all, today, meta } = await derivedTasks(req, f);
  const { org } = await S.load(store, req.c2.sp, ['org']);
  const list = S.filter(all, f, req.c2.actor);
  const ents = S.visibleEntities(org, req.c2.actor).filter(e => !f.entity_ids.length || f.entity_ids.includes(e.id));
  const regs = org.registrations.filter(r => ents.some(e => e.id === r.entity_id) && (!f.registration_ids.length || f.registration_ids.includes(r.id)) && (!f.states.length || f.states.includes(r.state)));
  const ov = MET.overview(list, { entities: ents, registrations: regs, sample: req.c2.sp === 'demo', asOf: today, soonDays: req.c2.settings.soon_days });
  const byId = new Map(list.map(t => [t.id, t]));
  res.json({ ...ov, queue_tasks: ov.queue.map(id => slim(byId.get(id))), snapshot: req.c2.sp === 'demo' ? meta.snapshot_date : null });
}));

router.get('/workload', gate(), wrap(async (req, res) => {
  const f = S.parseFilters(req.query);
  const { all } = await derivedTasks(req, f);
  const list = S.filter(all, f, req.c2.actor).filter(t => t.status !== 'completed');
  const people = new Map();
  const row = (id, name) => { if (!people.has(id)) people.set(id, { id, name: name || (id ? id : 'Unassigned'), owner: 0, owner_overdue: 0, owner_due_soon: 0, checker: 0, review_waiting: 0, backup: 0 }); return people.get(id); };
  for (const t of list) {
    const o = row(t.owner_id || '', t.owner_name); o.owner++; if (t.overdue) o.owner_overdue++; if (t.due_soon) o.owner_due_soon++;
    if (t.checker_id) { const c = row(t.checker_id, t.checker_name); c.checker++; if (t.status === 'ready_for_review') c.review_waiting++; }
    if (t.backup_owner_id) row(t.backup_owner_id, t.backup_owner_name).backup++;
  }
  res.json({ rows: [...people.values()].sort((a, b) => b.owner_overdue - a.owner_overdue || b.owner - a.owner), open_tasks: list.length });
}));

async function taskView(req, id) {
  const { sp, actor, settings } = req.c2;
  const { docs, meta, rules, events } = await S.load(store, sp, ['docs', 'meta', 'rules', 'events']);
  const { task } = await S.findTask(store, sp, id);
  if (!AC.canSeeTask(actor, task)) throw U.httpError(404, 'Task not found');
  const tdocs = docs.documents.filter(d => d.task_ids.includes(task.id));
  const { today, nowMs } = clockFor(sp, meta);
  const t = T.derive(task, { today, nowMs, docs: tdocs, soonDays: settings.soon_days });
  const rule = rules.rules.find(r => r.id === task.rule_id);
  const version = rule?.versions.find(v => v.version === task.rule_version);
  return {
    task: t, documents: tdocs, actions: AC.canWrite(actor) ? W.available(task, actor) : [], event: task.event_id ? events.events.find(e => e.id === task.event_id) : null,
    rule: rule ? { id: rule.id, name: rule.name, category: rule.category, nature: rule.nature, reference: rule.reference, filing: rule.filing, version: version ? { ...version, due_text: DE.describe(version.due) } : null } : null,
    audit: await AU.query(store, sp, { object_id: task.id, limit: 200 }), extensions: (rules.extensions || []).filter(x => x.rule_id === task.rule_id && x.period_keys.includes(task.period_key)),
  };
}
router.get('/tasks/:id', gate(), wrap(async (req, res) => res.json(await taskView(req, req.params.id))));

router.post('/tasks/:id/action', gate(), wrap(async (req, res) => {
  if (!AC.canWrite(req.c2.actor)) return bad(res, 403, 'Read-only (auditor) access');
  const action = String(req.body?.action || '');
  const out = await store.transaction(async tx => {
    const { docs } = await S.load(tx, req.c2.sp, ['docs']);
    const { task, doc, fy } = await S.findTask(tx, req.c2.sp, req.params.id);
    if (!AC.canSeeTask(req.c2.actor, task)) throw U.httpError(404, 'Task not found');
    const before = U.clone(task);
    if (action === 'verify_close' && task.rule_id === 'TDS-DEP') {         // V3: the section-wise allocation and the paid challan come first
      const chk = TDS.closeCheck(await tx.get(S.keys(req.c2.sp).tds, S.DEF.tds()), task);
      if (!chk.ok) throw U.httpError(400, chk.reason);
    }
    const r = W.act(task, action, req.body || {}, { actor: req.c2.actor, docs: docs.documents.filter(d => d.task_ids.includes(task.id)), nowMs: U.clock.now() });
    if (r.revision) doc.tasks.push(r.revision);
    tx.set(T.taskKey(req.c2.sp, fy), doc);
    await audit(tx, req, { action: `task_${action}`, object_type: 'task', object_id: task.id, entity_id: task.entity_id, before, after: task, reason: req.body?.note || '', summary: `${task.rule_name} ${task.period_label}: ${W.TRANSITIONS[action]?.label || action}` });
    if (r.revision) await audit(tx, req, { action: 'task_revision_created', object_type: 'task', object_id: r.revision.id, entity_id: task.entity_id, after: r.revision, reason: req.body?.note || '', summary: `Version ${r.revision.filing_version} of ${task.id}` });
    return { warnings: r.warnings, revision_id: r.revision?.id || null };
  });
  res.json({ ...out, ...(await taskView(req, out.revision_id || req.params.id)) });
}));

router.patch('/tasks/:id', gate(['master', 'prepare']), wrap(async (req, res) => {
  await store.transaction(async tx => {
    const { task, doc, fy } = await S.findTask(tx, req.c2.sp, req.params.id);
    if (!AC.canSeeTask(req.c2.actor, task)) throw U.httpError(404, 'Task not found');
    const before = U.clone(task);
    const r = W.edit(task, req.body || {}, { actor: req.c2.actor, nameOf: nameOf(req.c2.users, req.c2.sp) });
    if (!r.changes.length) return;
    tx.set(T.taskKey(req.c2.sp, fy), doc);
    await audit(tx, req, { action: 'task_edited', object_type: 'task', object_id: task.id, entity_id: task.entity_id, before, after: task, reason: req.body?.reason || '', summary: r.changes.map(c => c.field).join(', ') });
  });
  res.json(await taskView(req, req.params.id));
}));

// ── Documents ─────────────────────────────────────────────────────────────────
router.post('/tasks/:id/documents', gate(['prepare', 'file']), upload.single('file'), wrap(async (req, res) => {
  const { sp, actor, settings } = req.c2;
  const pre = await S.findTask(store, sp, req.params.id);
  if (!AC.canSeeTask(actor, pre.task)) return bad(res, 404, 'Task not found');
  if (pre.task.locked) return bad(res, 400, 'This task is closed and locked — re-open it (new version) to add documents');
  const prepared = await DOC.prepare(sp, req.file, { maxMb: Math.min(MAX_MB(), settings.max_upload_mb || 25) });
  const out = await store.transaction(async tx => {
    const { docs, org } = await S.load(tx, sp, ['docs', 'org']);
    const { task } = await S.findTask(tx, sp, req.params.id);
    const entity = org.entities.find(e => e.id === task.entity_id);
    const registration = task.registration_id ? org.registrations.find(r => r.id === task.registration_id) : null;
    const r = DOC.add(docs, { prepared, task, entity, registration, doc_type: String(req.body?.doc_type || ''), replace_doc_id: req.body?.replace_doc_id || null, actor, retentionYears: settings.retention_years, sample: sp === 'demo' });
    S.set(tx, sp, 'docs', docs);
    await audit(tx, req, { action: r.linked_existing ? 'document_linked' : req.body?.replace_doc_id ? 'document_new_version' : 'document_uploaded', object_type: 'document', object_id: r.doc.id, entity_id: task.entity_id,
      summary: `${CAT.DOC_TYPES[r.doc.doc_type]} "${prepared.original_name}" (sha256 ${prepared.sha.slice(0, 12)}…, scan ${prepared.scan.status}) for task ${task.id}` });
    await audit(tx, req, { action: 'task_document', object_type: 'task', object_id: task.id, entity_id: task.entity_id, summary: `Document ${r.doc.id} ${r.linked_existing ? 'linked' : 'added'} (does not change the task status)` });
    return { document: r.doc, linked_existing: r.linked_existing, flags: r.doc.current.flags };
  });
  if (!out.linked_existing) autoCopy(req.c2.sp, out.document.id, out.document.current.v);
  res.json(out);
}));

router.post('/tasks/:id/documents/link', gate(['prepare', 'file']), wrap(async (req, res) => {
  const out = await store.transaction(async tx => {
    const { docs } = await S.load(tx, req.c2.sp, ['docs']);
    const { task } = await S.findTask(tx, req.c2.sp, req.params.id);
    if (!AC.canSeeTask(req.c2.actor, task)) throw U.httpError(404, 'Task not found');
    const d = DOC.link(docs, String(req.body?.doc_id || ''), task, req.c2.actor);
    S.set(tx, req.c2.sp, 'docs', docs);
    await audit(tx, req, { action: 'document_linked', object_type: 'document', object_id: d.id, entity_id: task.entity_id, summary: `Linked to task ${task.id}` });
    return { document: d };
  });
  res.json(out);
}));

router.get('/documents', gate(), wrap(async (req, res) => {
  const { sp, actor } = req.c2;
  const f = S.parseFilters(req.query);
  const { docs } = await S.load(store, sp, ['docs']);
  const tdocs = await S.taskDocs(store, sp);
  const tasks = new Map(S.flat(tdocs).map(t => [t.id, t]));
  const type = String(req.query.doc_type || '');
  const flag = String(req.query.flag || '');
  const list = docs.documents.filter(d => AC.canSeeEntity(actor, d.entity_id) && (!f.entity_ids.length || f.entity_ids.includes(d.entity_id)) && (!type || d.doc_type === type)
    && (req.query.status === 'all' || d.status === (req.query.status || 'active'))
    && (!flag || (flag === 'unscanned' ? d.current.scan?.status !== 'clean' : flag === 'hold' ? !!d.legal_hold : (d.current.flags || []).some(x => x.code === flag)))
    && (!f.search || `${d.id} ${d.current.original_name} ${d.current.sha256}`.toLowerCase().includes(f.search)))
    .map(d => ({ ...d, tasks: d.task_ids.map(id => tasks.get(id)).filter(Boolean).filter(t => AC.canSeeTask(actor, t)).map(t => ({ id: t.id, rule_name: t.rule_name, period_label: t.period_label, scope_label: t.scope_label, status: t.status, category: t.category })) }));
  res.json({ documents: list.slice(0, 2000), total: list.length });
}));

async function loadDoc(src, req, id) {
  const { docs } = await S.load(src, req.c2.sp, ['docs']);
  const d = docs.documents.find(x => x.id === id);
  if (!d || !AC.canSeeEntity(req.c2.actor, d.entity_id)) throw U.httpError(404, 'Document not found');
  return { d, docs };
}

router.post('/documents/:id/link-url', gate(), wrap(async (req, res) => {
  const { d } = await loadDoc(store, req, req.params.id);
  const v = req.body?.version ? Number(req.body.version) : d.current.v;
  if (!d.versions.some(x => x.v === v)) return bad(res, 404, 'Version not found');
  const ttl = Math.min(600, Math.max(30, Number(req.c2.settings.link_ttl_seconds) || 120));
  const token = DOC.signLink({ space: req.c2.sp, doc_id: d.id, v, user_id: req.c2.actor.user_id }, ttl * 1000);
  await store.transaction(tx => audit(tx, req, { action: 'document_link_issued', object_type: 'document', object_id: d.id, entity_id: d.entity_id, summary: `Download link for version ${v} (valid ${ttl} s)` }));
  res.json({ url: `/api/compliance2/dl/${token}`, expires_in: ttl });
}));

/** The signed link itself (no login header: the signature, the expiry and the user's current access decide) */
router.get('/dl/:token', wrap(async (req, res) => {
  const p = DOC.readLink(req.params.token);
  if (!p) return bad(res, 403, 'This download link is invalid or has expired. Open the document again from the dashboard.');
  const users = await usersOf();
  const settings = await S.settings();
  const actor = AC.resolve(users, { id: p.u }, { settings, space: p.s });
  if (actor.error) return bad(res, 403, 'Your access has changed — open the document again from the dashboard.');
  if (String(p.d).startsWith('F:')) return sendWorkspaceFile(res, p, actor);
  const { docs } = await S.load(store, p.s, ['docs']);
  const d = docs.documents.find(x => x.id === p.d);
  if (!d || !AC.canSeeEntity(actor, d.entity_id)) return bad(res, 404, 'Document not found');
  const v = d.versions.find(x => x.v === p.v);
  if (!v) return bad(res, 404, 'Version not found');
  if (v.scan?.status === 'infected') return bad(res, 403, 'This file failed the malware scan');
  const buf = await BL.read(p.s, v.sha256);
  if (!buf) return bad(res, 404, 'The stored file is missing — restore it from the backup');
  await store.transaction(tx => AU.append(tx, p.s, { actor, action: 'document_downloaded', object_type: 'document', object_id: d.id, entity_id: d.entity_id, summary: `Version ${v.v} downloaded` }));
  res.setHeader('Content-Type', v.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${EXP.safeName(v.original_name).replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.end(buf);
}));

/** Evidence file of a workspace record (TDS challan, payment, reconciliation, payroll import, tax-audit payment) */
async function sendWorkspaceFile(res, p, actor) {
  const { files } = await S.load(store, p.s, ['files']);
  const f = files.files.find(x => x.id === String(p.d).slice(2));
  if (!f || !AC.canSeeEntity(actor, f.entity_id)) return bad(res, 404, 'File not found');
  if (f.scan?.status === 'infected') return bad(res, 403, 'This file failed the malware scan');
  const buf = await BL.read(p.s, f.sha256);
  if (!buf) return bad(res, 404, 'The stored file is missing — restore it from the backup');
  await store.transaction(tx => AU.append(tx, p.s, { actor, action: 'evidence_downloaded', object_type: 'file', object_id: f.id, entity_id: f.entity_id, summary: `"${f.original_name}" downloaded` }));
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${EXP.safeName(f.original_name).replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  return res.end(buf);
}

function docAction(right, fn, action) {
  router.post(`/documents/:id/${action}`, gate(right), wrap(async (req, res) => {
    const out = await store.transaction(async tx => {
      const { d, docs } = await loadDoc(tx, req, req.params.id);
      const before = U.clone(d);
      const tdocs = await S.taskDocs(tx, req.c2.sp);
      const locked = S.flat(tdocs).some(t => d.task_ids.includes(t.id) && t.locked);
      fn(d, req, locked);
      S.set(tx, req.c2.sp, 'docs', docs);
      await audit(tx, req, { action: `document_${action}`, object_type: 'document', object_id: d.id, entity_id: d.entity_id, before: { status: before.status, current: before.current.v, legal_hold: before.legal_hold }, after: { status: d.status, current: d.current.v, legal_hold: d.legal_hold }, reason: req.body?.reason || '', summary: `Document ${action}` });
      return d;
    });
    res.json({ document: out });
  }));
}
docAction(['prepare', 'file'], (d, req, locked) => { if (locked) throw U.httpError(400, 'It is evidence of a closed task — re-open the task first'); DOC.restore(d, req.body?.version, req.c2.actor); }, 'restore');
docAction(['prepare', 'file'], (d, req, locked) => DOC.withdraw(d, req.body?.reason, req.c2.actor, locked), 'withdraw');
docAction('approve', (d, req) => DOC.hold(d, !!req.body?.on, req.body?.reason, req.c2.actor), 'hold');

// ── Team, settings, access, audit ─────────────────────────────────────────────
router.get('/team', gate(), wrap(async (req, res) => res.json(await store.read(S.keys(req.c2.sp).team, { rows: [] }))));
router.put('/team', gate('master'), wrap(async (req, res) => {
  mustBeUnscoped(req);
  const rows = (Array.isArray(req.body?.rows) ? req.body.rows : []).map(r => ({
    id: r.id || U.uid('TM-'), entity_id: r.entity_id || '*', category: r.category || '*', registration_id: r.registration_id || '', owner_id: r.owner_id || '', backup_owner_id: r.backup_owner_id || '', checker_id: r.checker_id || '', note: String(r.note || '').slice(0, 300),
  }));
  for (const r of rows) {
    if (r.category !== '*' && !CAT.CATEGORIES.includes(r.category)) return bad(res, 400, `Unknown category ${r.category}`);
    if (r.owner_id && r.checker_id && r.owner_id === r.checker_id) return bad(res, 400, 'The owner (maker) and the checker of a mapping must be different people');
  }
  const out = await store.transaction(async tx => {
    const before = await tx.get(S.keys(req.c2.sp).team, { rows: [] });
    const doc = { rows, updated_at: U.nowIso(), updated_by: req.c2.actor.name };
    S.set(tx, req.c2.sp, 'team', doc);
    await audit(tx, req, { action: 'team_mapping_saved', object_type: 'team', object_id: 'team', before, after: doc, summary: `${rows.length} mapping row(s). Applies to tasks generated from now on — existing tasks keep their people.` });
    return doc;
  });
  res.json(out);
}));

router.get('/settings', gate('admin'), wrap(async (req, res) => res.json(await S.settings())));
router.put('/settings', gate('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  const out = await store.transaction(async tx => {
    const cur = await S.settings(tx);
    const next = { ...cur };
    if (b.soon_days !== undefined) { const n = Number(b.soon_days); if (!(n >= 1 && n <= 60)) throw U.httpError(400, 'Due-soon days must be 1–60'); next.soon_days = n; }
    if (b.retention_years !== undefined) { const n = Number(b.retention_years); if (!(n >= 1 && n <= 30)) throw U.httpError(400, 'Retention years must be 1–30'); next.retention_years = n; }
    if (b.max_upload_mb !== undefined) { const n = Number(b.max_upload_mb); if (!(n >= 1 && n <= 25)) throw U.httpError(400, 'Upload limit must be 1–25 MB'); next.max_upload_mb = n; }
    if (b.link_ttl_seconds !== undefined) { const n = Number(b.link_ttl_seconds); if (!(n >= 30 && n <= 600)) throw U.httpError(400, 'Link lifetime must be 30–600 seconds'); next.link_ttl_seconds = n; }
    tx.set('settings', next);
    await AU.append(tx, 'live', { actor: req.c2.actor, action: 'settings_saved', object_type: 'settings', object_id: 'settings', before: cur, after: next, summary: 'Module settings changed' });
    return next;
  });
  res.json(out);
}));
router.put('/settings/access', gate('admin'), wrap(async (req, res) => {
  const { user_id, entities, period_from, period_to } = req.body || {};
  if (!req.c2.users.some(u => u.id === user_id)) return bad(res, 404, 'User not found');
  if (period_from && !U.isDate(period_from)) return bad(res, 400, 'period_from must be a date');
  if (period_to && !U.isDate(period_to)) return bad(res, 400, 'period_to must be a date');
  const out = await store.transaction(async tx => {
    const cur = await S.settings(tx);
    const before = cur.access[user_id] || null;
    const next = { ...cur, access: { ...cur.access } };
    const ents = (Array.isArray(entities) ? entities : []).map(String);
    if (!ents.length && !period_from && !period_to) delete next.access[user_id]; else next.access[user_id] = { entities: ents, period_from: period_from || null, period_to: period_to || null };
    tx.set('settings', next);
    await AU.append(tx, 'live', { actor: req.c2.actor, action: 'access_scope_saved', object_type: 'access', object_id: user_id, before, after: next.access[user_id] || null, summary: `Access scope of ${user_id}` });
    return next.access;
  });
  res.json({ access: out });
}));

router.get('/audit', gate(), wrap(async (req, res) => {
  const a = req.c2.actor;
  const list = await AU.query(store, req.c2.sp, { object_id: req.query.object_id || undefined, entity_ids: a.entities === null ? undefined : a.entities, from: U.isDate(req.query.from) ? req.query.from : undefined, to: U.isDate(req.query.to) ? req.query.to : undefined, limit: Math.min(2000, Number(req.query.limit) || 300) });
  res.json({ entries: list });
}));
router.get('/audit/verify', gate(), wrap(async (req, res) => res.json(await AU.verify(store, req.c2.sp))));

// ── Exports ───────────────────────────────────────────────────────────────────
const REGISTER_COLUMNS = [
  ['Task ID', t => t.id, 22], ['Entity', t => t.entity_label, 30], ['Scope (GSTIN / TAN / entity / person)', t => t.scope_label, 34], ['State', t => t.state, 6], ['Category', t => t.category, 16],
  ['Obligation', t => t.rule_name, 36], ['Rule', t => `${t.rule_id} v${t.rule_version}${t.rule_unverified ? ' (UNVERIFIED)' : ''}`, 18], ['Form', t => t.form, 14], ['FY', t => t.fy, 8], ['Period', t => t.period_label, 20],
  ['Original statutory due', t => t.original_due || '', 12], ['Revised statutory due', t => t.revised_due || '', 12], ['Effective due', t => t.effective_due || '', 12], ['Due basis / why no date', t => t.due_basis || t.due_pending, 40], ['Internal target', t => t.internal_target || '', 12],
  ['Status', t => t.status_label, 22], ['Flags', t => t.flags.join(', '), 30], ['Owner', t => t.owner_name, 18], ['Checker', t => t.checker_name, 18], ['Prepared by', t => t.workflow?.prepared_by || '', 18], ['Checked by', t => t.workflow?.checked_by || '', 18],
  ['Filed by', t => t.workflow?.filed_by || '', 18], ['Filed at (IST)', t => (t.filing?.filed_at ? U.istText(t.filing.filed_at) : ''), 17], ['Acknowledgement', t => t.filing?.ack_no || '', 20], ['Nil', t => (t.filing?.nil_return ? 'Yes' : ''), 5],
  ['Payment date', t => t.filing?.payment?.date || '', 12], ['Payment reference', t => t.filing?.payment?.reference || '', 20], ['BSR', t => t.filing?.payment?.bsr_code || '', 9], ['Challan serial', t => t.filing?.payment?.challan_serial || '', 9],
  ['Tax', t => t.filing?.payment?.amounts?.tax ?? '', 12], ['Interest', t => t.filing?.payment?.amounts?.interest ?? '', 10], ['Late fee', t => t.filing?.payment?.amounts?.late_fee ?? '', 10], ['Penalty', t => t.filing?.payment?.amounts?.penalty ?? '', 10],
  ['Verified by', t => t.workflow?.verified_by || '', 18], ['Evidence required', t => t.evidence.required.join(', '), 30], ['Evidence missing', t => t.evidence.missing.join(', '), 30], ['Exception', t => t.exception?.status || '', 10],
  ['Remarks', t => t.remarks || '', 30], ['Filing version', t => t.filing_version, 6], ['Sample (demo)', t => (t.sample ? 'SAMPLE' : ''), 8],
].map(([label, get, width]) => ({ label, get, width }));

async function exportSet(req) {
  const f = S.parseFilters(req.query);
  const { all, today, docs } = await derivedTasks(req, f);
  const { org } = await S.load(store, req.c2.sp, ['org']);
  const ents = new Map(org.entities.map(e => [e.id, e]));
  const list = S.filter(all, f, req.c2.actor).map(t => ({ ...t, entity_label: ents.get(t.entity_id)?.legal_name || t.entity_id, entity_code: ents.get(t.entity_id)?.short_code || '' }));
  const context = { Dataset: req.c2.sp === 'demo' ? 'DEMO — illustrative sample data, not real filings' : 'Live', 'Generated at (IST)': U.istText(U.clock.now()), 'Generated by': req.c2.actor.name,
    'As of date': today, Filters: Object.entries(req.query).filter(([k]) => k !== 'space').map(([k, v]) => `${k}=${v}`).join('; ') || 'none', Rows: list.length };
  return { list, context, docs, org };
}
async function logExport(req, what, n) { await store.transaction(tx => audit(tx, req, { action: 'export', object_type: 'export', object_id: what, summary: `${what}: ${n} row(s)` })); }

router.get('/export/register.:fmt', gate(), wrap(async (req, res) => {
  const { list, context } = await exportSet(req);
  const stamp = U.todayIST();
  await logExport(req, `register.${req.params.fmt}`, list.length);
  if (req.params.fmt === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="compliance_register_${req.c2.sp}_${stamp}.xlsx"`);
    return res.end(EXP.xlsx([{ name: 'Register', columns: REGISTER_COLUMNS, rows: list }], context));
  }
  if (req.params.fmt !== 'csv') return bad(res, 404, 'csv or xlsx');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="compliance_register_${req.c2.sp}_${stamp}.csv"`);
  res.end(EXP.csv(REGISTER_COLUMNS, list, context));
}));

router.get('/export/calendar.ics', gate(), wrap(async (req, res) => {
  const { list } = await exportSet(req);
  await logExport(req, 'calendar.ics', list.length);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="compliance_calendar_${req.c2.sp}.ics"`);
  res.end(EXP.ics(list, { name: req.c2.sp === 'demo' ? 'Compliance (DEMO — illustrative)' : 'Compliance calendar' }));
}));

router.get('/export/exceptions.csv', gate(), wrap(async (req, res) => {
  const { list, context } = await exportSet(req);
  const rows = [];
  const add = (t, issue, detail) => rows.push({ t, issue, detail });
  for (const t of list) {
    if (t.overdue) add(t, 'Overdue', `${t.days_overdue} day(s) past ${t.effective_due}`);
    if (t.filed_late) add(t, 'Filed late', `Filed ${t.filing.filed_on}, due ${t.effective_due}`);
    if (t.evidence_missing) add(t, 'Mandatory evidence missing', t.evidence.missing.join(', '));
    if (t.exception) add(t, `Evidence exception ${t.exception.status}`, `${t.exception.reason} (asked by ${t.exception.requested_by}${t.exception.decided_by ? `, decided by ${t.exception.decided_by}` : ''})`);
    if (t.no_due_date) add(t, 'No due date', t.due_pending);
    if (t.rule_unverified) add(t, 'Rule not verified', `${t.rule_id} v${t.rule_version}`);
    if (t.flags.includes('document_flags')) add(t, 'Document check flag', 'See the task\'s documents');
  }
  const cols = [['Task ID', r => r.t.id], ['Entity', r => r.t.entity_label], ['Scope', r => r.t.scope_label], ['Obligation', r => r.t.rule_name], ['Period', r => r.t.period_label], ['Status', r => r.t.status_label], ['Issue', r => r.issue], ['Detail', r => r.detail], ['Owner', r => r.t.owner_name]].map(([label, get]) => ({ label, get }));
  await logExport(req, 'exceptions.csv', rows.length);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="compliance_exceptions_${req.c2.sp}.csv"`);
  res.end(EXP.csv(cols, rows, context));
}));

router.get('/export/coverage.csv', gate(), wrap(async (req, res) => {
  const c = await coverage(req);
  const cols = [['Rule', r => r.rule_id], ['Obligation', r => r.rule_name], ['Category', r => r.category], ['Scope', r => r.scope_label], ['State', r => r.state], ['Decision', r => (r.decision ? AP.STATUSES[r.decision.status] : 'Not decided')],
    ['Decision reason', r => r.decision?.reason || ''], ['Reviewer', r => r.decision?.reviewer || ''], ['Suggestion', r => AP.STATUSES[r.suggestion.status]], ['Missing facts', r => r.suggestion.missing.join(', ')], ['Rule state', r => r.rule_state],
    ['Due-date rule', r => r.due_state.text], ['Tasks in FY', r => r.tasks], ['Gaps', r => r.gaps.map(g => COV.GAPS[g]).join('; ')]].map(([label, get]) => ({ label, get }));
  await logExport(req, 'coverage.csv', c.rows.length);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="coverage_${req.c2.sp}_${c.fy}.csv"`);
  res.end(EXP.csv(cols, c.rows, { Dataset: req.c2.sp === 'demo' ? 'DEMO — illustrative' : 'Live', FY: c.fy, 'Generated at (IST)': U.istText(U.clock.now()), Rows: c.rows.length }));
}));

/** Audit pack: register + evidence manifest + the evidence files themselves + the audit entries of those tasks */
router.get('/export/audit.zip', gate(), wrap(async (req, res) => {
  const { list, context, docs, org } = await exportSet(req);
  if (list.length > 5000) return bad(res, 400, `${list.length} tasks — narrow the filters (at most 5,000 per audit pack)`);
  const ids = new Set(list.map(t => t.id));
  const ents = new Map(org.entities.map(e => [e.id, e]));
  const files = [];
  const manifest = [];
  let bytes = 0;
  for (const d of docs.documents.filter(x => x.task_ids.some(id => ids.has(id)) && AC.canSeeEntity(req.c2.actor, x.entity_id))) {
    for (const v of d.versions) {
      const buf = await BL.read(req.c2.sp, v.sha256);
      const e = ents.get(d.entity_id);
      const t = list.find(x => d.task_ids.includes(x.id));
      const path = `evidence/${EXP.safeName(e?.short_code || d.entity_id)}/FY ${t?.fy || ''}/${EXP.safeName(t?.category || '')}/${d.id}_v${v.v}_${EXP.safeName(v.original_name)}`;
      bytes += buf?.length || 0;
      if (bytes > 150 * 1024 * 1024) return bad(res, 400, 'The evidence is larger than 150 MB — narrow the filters');
      if (buf) files.push({ name: path, data: buf });
      manifest.push({ d, v, path: buf ? path : '(missing from storage)', tasks: d.task_ids.filter(id => ids.has(id)).join(' ') });
    }
  }
  const mcols = [['Document', r => r.d.id], ['Version', r => r.v.v], ['Current', r => (r.d.current.v === r.v.v ? 'yes' : '')], ['Status', r => r.d.status], ['Type', r => CAT.DOC_TYPES[r.d.doc_type]], ['Tasks', r => r.tasks],
    ['File in pack', r => r.path], ['Original name', r => r.v.original_name], ['SHA-256', r => r.v.sha256], ['Bytes', r => r.v.size], ['Malware scan', r => `${r.v.scan?.status || ''} ${r.v.scan?.engine || ''}`],
    ['Uploaded by', r => r.v.uploaded_by], ['Uploaded at', r => r.v.at], ['Check flags', r => (r.v.flags || []).map(f => f.text).join(' | ')], ['Legal hold', r => r.d.legal_hold?.reason || ''], ['Sample', r => (r.d.sample ? 'SAMPLE' : '')]].map(([label, get]) => ({ label, get }));
  const auditLines = [];
  for (const e of await AU.query(store, req.c2.sp, { limit: 100000, entity_ids: req.c2.actor.entities === null ? undefined : req.c2.actor.entities })) if (ids.has(e.object_id) || manifest.some(m => m.d.id === e.object_id)) auditLines.push(JSON.stringify(e));
  const readme = [`Compliance audit pack — ${context.Dataset}`, '', ...Object.entries(context).map(([k, v]) => `${k}: ${v}`), '',
    'register.csv          the tasks in the filter, with dates, people, filing and payment details and flags',
    'evidence_manifest.csv every document version, its SHA-256 and where it is in this pack',
    'audit.jsonl           the audit entries of these tasks and documents (hash-chained; verify in the dashboard)',
    'evidence/             the files, by entity / FY / category', '',
    'Check a file: its SHA-256 must equal the manifest value. Sample (demo) files are illustrative, not real documents.'].join('\r\n');
  files.unshift({ name: 'README.txt', data: readme }, { name: 'register.csv', data: EXP.csv(REGISTER_COLUMNS, list, context) }, { name: 'evidence_manifest.csv', data: EXP.csv(mcols, manifest, context) }, { name: 'audit.jsonl', data: auditLines.join('\n') });
  await logExport(req, 'audit.zip', manifest.length);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="compliance_audit_pack_${req.c2.sp}_${U.todayIST()}.zip"`);
  res.end(EXP.zip(files));
}));

// ── Import ────────────────────────────────────────────────────────────────────
router.get('/import/template.xlsx', gate(), wrap(async (req, res) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="compliance_v2_master_template.xlsx"');
  res.end(IMP.template());
}));

async function importRun(req, sheets, commit, label) {
  if (commit) {
    return store.transaction(async tx => {
      const { org } = await S.load(tx, req.c2.sp, ['org']);
      const r = IMP.apply(org, sheets, req.c2.actor);
      if (r.errors) throw U.httpError(400, `${r.errors} row(s) have errors — nothing was imported`, { results: r.results, counts: r.counts });
      if (req.c2.sp === 'demo') for (const k of ['entities', 'registrations', 'establishments', 'people']) for (const x of r.org[k]) if (x.data_status === 'draft') x.data_status = 'illustrative';
      S.set(tx, req.c2.sp, 'org', r.org);
      await audit(tx, req, { action: 'master_import', object_type: 'import', object_id: label, summary: `${label}: ${JSON.stringify(r.counts)}` });
      return { committed: true, results: r.results, counts: r.counts, unknown_columns: r.unknown_columns };
    });
  }
  const { org } = await S.load(store, req.c2.sp, ['org']);
  const r = IMP.apply(org, sheets, req.c2.actor);
  return { committed: false, results: r.results, counts: r.counts, errors: r.errors, unknown_columns: r.unknown_columns };
}

router.post('/import/:step', gate('master'), upload.single('file'), wrap(async (req, res) => {
  mustBeUnscoped(req);
  if (!['preview', 'commit'].includes(req.params.step)) return bad(res, 404, 'Unknown step');
  if (!req.file?.buffer?.length) return bad(res, 400, 'Choose the filled-in template (.xlsx) or a CSV');
  const sheets = IMP.parse(req.file.buffer, req.file.originalname);
  if (!Object.keys(sheets).length) return bad(res, 400, 'No sheet named Entities, FY_Facts, Registrations, Establishments or People was found');
  res.json(await importRun(req, sheets, req.params.step === 'commit', `file ${req.file.originalname}`));
}));

router.post('/import-v1/:step', gate('master'), wrap(async (req, res) => {
  mustBeUnscoped(req);
  if (req.c2.sp !== 'live') return bad(res, 400, 'Compliance v1 companies are carried over into the live space only');
  const v1 = await require('../compliance/lib/store').read('data', null);
  const rows = IMP.fromV1(v1);
  if (!rows.length) return bad(res, 404, 'Compliance v1 has no companies');
  res.json(await importRun(req, { Entities: { rows, unknown: [] } }, req.params.step === 'commit', 'Compliance v1 companies'));
}));

// ── Demo ──────────────────────────────────────────────────────────────────────
router.post('/demo/reset', gate('admin'), wrap(async (req, res) => {
  if (req.c2.sp !== 'demo') return bad(res, 400, 'Only the demo space can be reset');
  await resetDemo(req.c2.actor);
  res.json({ ok: true });
}));

// ── Document folders (OneDrive) ───────────────────────────────────────────────
// Live: the connected Microsoft account's OneDrive (lib/graph.js). Demo: a SIMULATED OneDrive (lib/graphSim.js) — nothing is
// sent to Microsoft. Folder plan: lib/folders.js; engine: lib/provision.js.
let msaInstance = null, liveGraph = null, demoSim = null, folderTimer = null;
const MSA = () => msauthOverride || msaInstance || (msaInstance = MS.create());
const foldersKey = sp => `${sp}_folders`;
const busyFolders = new Set();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const onedriveDoc = () => store.read('onedrive', null);
async function saveOnedrive(patch) {
  await store.transaction(async tx => { const cur = await tx.get('onedrive', {}); tx.set('onedrive', { ...cur, ...patch }); });
  if (patch.status && patch.status !== 'connected') liveGraph = null;
}

/** The OneDrive to work with: the simulated one in the demo; in live, the connected account's (or null when not connected) */
async function graphFor(sp) {
  if (sp === 'demo') { if (!demoSim) demoSim = GS.create(await store.read('demo_graphsim', null)); return demoSim; }
  if (graphOverride) return graphOverride;
  const od = await onedriveDoc();
  if (!od?.sealed || od.status !== 'connected') return null;
  if (!liveGraph) liveGraph = GR.create({ getToken: MSA().tokenGetter({ read: onedriveDoc, save: saveOnedrive }) });
  return liveGraph;
}

async function loadFolders(src, sp) {
  const mapping = await S.get(src, foldersKey(sp), PV.EMPTY());
  if (sp === 'demo' && !mapping.base) mapping.base = { drive_id: 'sim-drive', item_id: 'sim-base', path: 'New folder (SIMULATED)', web_url: '' };
  return mapping;
}
const folderFys = (mapping, meta, sp) => (mapping.settings?.fys?.length ? mapping.settings.fys : [U.fyOf(S.todayFor(sp, meta))]);

/** Plan → create what is missing → save. One run per space at a time. */
async function runFolders(sp, { entityIds, fys, force, actor, scanFirst } = {}) {
  if (busyFolders.has(sp)) return { busy: true, message: 'A folder run is already going — try again in a moment' };
  busyFolders.add(sp);
  try {
    const graph = await graphFor(sp);
    if (!graph) throw U.httpError(400, 'OneDrive is not connected — connect it in Document Folders first');
    const { org, meta } = await S.load(store, sp, ['org', 'meta']);
    const mapping = await loadFolders(store, sp);
    const logFrom = mapping.log.length;
    let scanRes = null;
    if (scanFirst && mapping.root?.item_id) scanRes = await PV.scan({ graph, mapping, org });
    const planned = FO.plan(org, { fys: fys?.length ? fys : folderFys(mapping, meta, sp), entityIds, trigger: mapping.settings.trigger, live: sp === 'live' });
    const res = await PV.apply({ graph, mapping, planned, force, maxMs: IS_VERCEL ? 240000 : 900000 });
    await store.transaction(async tx => {
      const stored = await loadFolders(tx, sp);
      PV.merge(stored, mapping, { logFrom });
      tx.set(foldersKey(sp), stored);
      if (sp === 'demo') tx.set('demo_graphsim', graph.state());
      await AU.append(tx, sp, { actor, action: 'folders_provisioned', object_type: 'folders', object_id: sp,
        summary: `${sp === 'demo' ? 'SIMULATED — ' : ''}${res.created} created, ${res.reused} reused, ${res.known} already there, ${res.renamed} renamed, ${res.failed} failed, ${res.blocked} waiting for a parent, ${res.pending} pending configuration${scanRes?.linked?.length ? `, ${scanRes.linked.length} company folder(s) found and linked` : ''}${res.stopped ? ` — stopped: ${res.stopped}` : ''}` });
    });
    if (res.stopped === 'revoked' && sp === 'live') await saveOnedrive({ status: 'revoked', revoked_at: U.nowIso(), last_error: res.error });
    return { ...res, scan: scanRes, simulated: sp === 'demo' };
  } finally { busyFolders.delete(sp); }
}

/** After an entity / registration is saved or approved (live, once OneDrive is connected): create its folders in the background */
function autoFolders(req, entityId) {
  if (!entityId || req.c2.sp !== 'live') return;
  background((async () => {
    const mapping = await loadFolders(store, 'live');
    if (!mapping.base?.item_id || !(await graphFor('live'))) return;
    await runFolders('live', { entityIds: [entityId], actor: req.c2.actor });
  })().catch(e => console.error('[compliance2] folders:', e.message)));
}

/** Copy one document version into its folder (live: when switched on; demo: simulated) */
async function copyDoc(sp, docId, v, { force } = {}) {
  const mapping = await loadFolders(store, sp);
  if (sp === 'live' && !mapping.settings.copy_documents && !force) return { skipped: 'Copying documents to OneDrive is switched off' };
  const graph = await graphFor(sp);
  if (!graph || !mapping.root?.item_id) return { skipped: 'The OneDrive folders are not set up yet' };
  const { docs, org, events } = await S.load(store, sp, ['docs', 'org', 'events']);
  const doc = docs.documents.find(d => d.id === docId);
  const version = doc?.versions.find(x => x.v === v);
  if (!doc || !version) return { skipped: 'Document not found' };
  const { task } = await S.findTask(store, sp, doc.task_ids[0]);
  const entity = org.entities.find(e => e.id === task.entity_id);
  const registration = task.registration_id ? org.registrations.find(r => r.id === task.registration_id) : null;
  const event = task.event_id ? events.events.find(e => e.id === task.event_id) : null;
  const route = FO.route({ task, doc, version, entity, registration, event });
  const logFrom = mapping.log.length;
  let remote;
  if (route.unrouted) remote = { status: 'unrouted', reason: route.unrouted, at: U.nowIso() };
  else {
    try {
      const up = await PV.uploadDocument({ graph, mapping, route, entity, buffer: await BL.read(sp, version.sha256) });
      remote = { status: sp === 'demo' ? 'simulated' : 'uploaded', ...up, at: U.nowIso() };
    } catch (e) {
      remote = { status: 'failed', error: e.message, at: U.nowIso(), attempts: (version.remote?.attempts || 0) + 1 };
      if (e.revoked && sp === 'live') await saveOnedrive({ status: 'revoked', revoked_at: U.nowIso(), last_error: e.message });
    }
  }
  await store.transaction(async tx => {
    const d2 = await S.get(tx, S.keys(sp).docs, { documents: [] });
    const dd = d2.documents.find(d => d.id === docId);
    const vv = dd?.versions.find(x => x.v === v);
    if (vv) { vv.remote = remote; if (dd.current.v === v) dd.current.remote = remote; }
    tx.set(S.keys(sp).docs, d2);
    const stored = await loadFolders(tx, sp);
    PV.merge(stored, mapping, { logFrom });
    tx.set(foldersKey(sp), stored);
    if (sp === 'demo') tx.set('demo_graphsim', graph.state());
  });
  return remote;
}
function autoCopy(sp, docId, v) { background(copyDoc(sp, docId, v).catch(e => console.error('[compliance2] OneDrive copy:', e.message))); }

/** Office PC: every 15 minutes, look for company folders added in OneDrive and finish / retry the set-up */
function startFolderTimer() {
  if (IS_VERCEL || folderTimer) return;
  folderTimer = setInterval(() => {
    (async () => {
      const mapping = await loadFolders(store, 'live');
      if (!mapping.base?.item_id || !mapping.root?.item_id || !(await graphFor('live'))) return;
      await runFolders('live', { scanFirst: true, actor: { id: 'scheduler', name: 'Folder scheduler' } });
    })().catch(e => console.error('[compliance2] folder scheduler:', e.message));
  }, 15 * 60000);
  if (folderTimer.unref) folderTimer.unref();
}

router.get('/folders', gate(), wrap(async (req, res) => {
  const { sp, actor } = req.c2;
  startFolderTimer();
  const { org, meta } = await S.load(store, sp, ['org', 'meta']);
  const mapping = await loadFolders(store, sp);
  const fys = folderFys(mapping, meta, sp);
  const visible = S.visibleEntities(org, actor).map(e => e.id);
  const all = FO.plan(org, { fys, entityIds: visible, trigger: mapping.settings.trigger, live: sp === 'live' });
  const pv = PV.preview(mapping, all);
  const entityId = visible.includes(String(req.query.entity_id)) ? String(req.query.entity_id) : visible[0] || '';
  const fy = fys.includes(req.query.fy) ? req.query.fy : fys[fys.length - 1];
  const tree = all.nodes.filter(n => n.key === 'ROOT' || (n.entity_id === entityId && (n.kind === 'company' || n.key.includes(`|FY:${fy}`)))).map(n => {
    const m = n.key === 'ROOT' ? mapping.root : mapping.nodes[n.key];
    return { key: n.key, parent: n.parent, name: m?.name || n.name, kind: n.kind, status: m?.item_id ? (m.status || 'mapped') : m?.status === 'failed' ? 'failed' : 'planned', web_url: m?.web_url || '', error: m?.error || '' };
  });
  const od = sp === 'live' ? await onedriveDoc() : null;
  res.json({
    simulated: sp === 'demo',
    connection: sp === 'demo' ? { status: 'simulated' } : { app: MSA().status(), status: od?.status || 'not_connected', account: od?.account || null, connected_at: od?.connected_at || null, connected_by: od?.connected_by || '', revoked_at: od?.revoked_at || null, last_error: od?.last_error || '' },
    base: mapping.base, root: mapping.root, settings: { ...mapping.settings, fys },
    counts: { total: pv.total, mapped: pv.mapped, to_create: pv.to_create, failed: pv.failed, pending: pv.pending.length },
    entity_id: entityId, fy, tree, pending: all.pending, found: mapping.found.filter(f => f.status === 'open'), log: mapping.log.slice(-200).reverse(), last_run: mapping.last_run, last_scan: mapping.last_scan,
  });
}));

router.post('/folders/preview', gate(), wrap(async (req, res) => {
  const { sp } = req.c2;
  const { org, meta } = await S.load(store, sp, ['org', 'meta']);
  const mapping = await loadFolders(store, sp);
  const fys = (req.body?.fys || []).filter(U.validFy);
  res.json(PV.preview(mapping, FO.plan(org, { fys: fys.length ? fys : folderFys(mapping, meta, sp), entityIds: entityScope(req, req.body?.entity_ids || []), trigger: mapping.settings.trigger, live: sp === 'live' })));
}));

router.post('/folders/provision', gate('master'), wrap(async (req, res) => {
  const fys = (req.body?.fys || []).filter(U.validFy);
  res.json(await runFolders(req.c2.sp, { entityIds: entityScope(req, req.body?.entity_ids || []), fys, force: !!req.body?.force, actor: req.c2.actor }));
}));

router.post('/folders/scan', gate('master'), wrap(async (req, res) => {
  mustBeUnscoped(req);
  res.json(await runFolders(req.c2.sp, { scanFirst: true, actor: req.c2.actor }));
}));

router.post('/folders/found/:itemId/:action', gate('master'), wrap(async (req, res) => {
  mustBeUnscoped(req);
  const { sp } = req.c2;
  if (!['link', 'ignore'].includes(req.params.action)) return bad(res, 404, 'Unknown action');
  const linkedTo = await store.transaction(async tx => {
    const mapping = await loadFolders(tx, sp);
    const f = mapping.found.find(x => x.item_id === req.params.itemId && x.status === 'open');
    if (!f) throw U.httpError(404, 'That folder is not waiting for a decision');
    let entity = null;
    if (req.params.action === 'link') {
      const { org } = await S.load(tx, sp, ['org']);
      entity = org.entities.find(e => e.id === req.body?.entity_id);
      if (!entity) throw U.httpError(400, 'Choose the entity this folder belongs to');
      PV.link(mapping, f, entity);
    } else {
      f.status = 'ignored';
      mapping.log.push({ at: U.nowIso(), kind: 'ignored', key: '', name: f.name, detail: `Marked "not a company folder" by ${req.c2.actor.name}` });
    }
    tx.set(foldersKey(sp), mapping);
    await audit(tx, req, { action: `folder_found_${req.params.action}`, object_type: 'folder', object_id: f.item_id, entity_id: entity?.id || '', summary: `"${f.name}" ${entity ? `linked to ${entity.legal_name}` : 'ignored (not a company folder)'}` });
    return entity?.id || null;
  });
  // a linked company folder gets the standard structure straight away
  const run = linkedTo ? await runFolders(sp, { entityIds: [linkedTo], actor: req.c2.actor }) : null;
  res.json({ ok: true, run });
}));

router.put('/folders/settings', gate('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  const fys = [...new Set((Array.isArray(b.fys) ? b.fys : []).filter(U.validFy))].sort();
  if (fys.length > 6) return bad(res, 400, 'At most 6 financial years');
  if (b.trigger && !['saved', 'approved'].includes(b.trigger)) return bad(res, 400, 'trigger must be saved or approved');
  const out = await store.transaction(async tx => {
    const mapping = await loadFolders(tx, req.c2.sp);
    const before = { ...mapping.settings };
    mapping.settings = { ...mapping.settings, ...(fys.length ? { fys } : {}), ...(b.trigger ? { trigger: b.trigger } : {}), ...(b.copy_documents !== undefined ? { copy_documents: !!b.copy_documents } : {}) };
    tx.set(foldersKey(req.c2.sp), mapping);
    await audit(tx, req, { action: 'folder_settings_saved', object_type: 'folders', object_id: 'settings', before, after: mapping.settings, summary: 'Document folder settings saved' });
    return mapping.settings;
  });
  if (req.c2.sp === 'live') background((async () => { const m = await loadFolders(store, 'live'); if (m.base?.item_id && await graphFor('live')) await runFolders('live', { actor: req.c2.actor }); })().catch(e => console.error('[compliance2] folders:', e.message)));
  res.json({ settings: out });
}));

/** The folders a new company would get (nothing is created) */
router.get('/folders/preview-company', gate(), wrap(async (req, res) => {
  const name = String(req.query.name || '').trim().slice(0, 200);
  if (!name) return bad(res, 400, 'Type the company\'s legal name');
  const fy = U.validFy(req.query.fy) ? req.query.fy : U.fyOf(U.todayIST());
  const fake = { id: 'preview', legal_name: name, short_code: 'NEW', type: 'PRIVATE', status: 'active', data_status: 'approved', flags: {} };
  const p = FO.plan({ entities: [fake], registrations: [], establishments: [], people: [] }, { fys: [fy], live: true });
  const depth = key => key.split('|').length;
  res.json({ name: FO.safeName(name), total: p.nodes.length, top: p.nodes.filter(n => n.key !== 'ROOT' && depth(n.key) <= 3).map(n => ({ key: n.key, parent: n.parent, name: n.name })), note: 'GST, TDS, PF, ESIC and PT folders appear once the company\'s registrations are recorded.' });
}));

function redirectUri(req) {
  const base = process.env.C2_PUBLIC_URL || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
  return `${base.replace(/\/+$/, '')}/api/compliance2/onedrive/callback`;
}

router.post('/onedrive/connect-url', gate('admin'), wrap(async (req, res) => {
  if (req.c2.sp !== 'live') return bad(res, 400, 'The demo uses a simulated OneDrive — there is nothing to connect');
  const st = MSA().status();
  if (!st.configured) return bad(res, 400, `The Microsoft 365 app registration is not set up on the server yet. Missing: ${st.missing.join(', ')}.`, { missing: st.missing });
  const r = redirectUri(req);
  res.json({ url: MSA().authorizeUrl({ redirectUri: r, state: MSA().signState({ u: req.c2.actor.user_id, r }) }), redirect_uri: r });
}));

/** Microsoft sends the browser back here after the sign-in (no dashboard login header: the signed state decides) */
router.get('/onedrive/callback', wrap(async (req, res) => {
  const page = (status, title, text) => res.status(status).type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui,sans-serif;padding:40px;max-width:680px;color:#1A1D2E"><h2>${esc(title)}</h2><p>${esc(text)}</p><p><a href="/">Back to the dashboard</a></p></body></html>`);
  if (req.query.error) return page(400, 'OneDrive was not connected', String(req.query.error_description || req.query.error).slice(0, 400));
  const st = MSA().readState(req.query.state);
  if (!st) return page(400, 'The sign-in link has expired', 'Start again from Compliance Dashboard Vr.2.0 → Document Folders → Connect OneDrive.');
  const actor = AC.resolve(await usersOf(), { id: st.u }, { settings: await S.settings(), space: 'live' });
  if (actor.error || !actor.rights.admin) return page(403, 'Not allowed', 'Only an administrator of the module can connect OneDrive.');
  try {
    const t = await MSA().exchangeCode({ code: String(req.query.code || ''), redirectUri: st.r });
    if (!t.refresh_token) return page(400, 'OneDrive was not connected', 'Microsoft did not grant offline access (the offline_access permission is missing from the app registration).');
    const me = await GR.create({ getToken: async () => t.access_token }).me();
    await store.transaction(async tx => {
      tx.set('onedrive', { status: 'connected', sealed: MSA().seal(t.refresh_token), account: { name: me.displayName || '', upn: me.userPrincipalName || me.mail || '', id: me.id }, connected_by: actor.name, connected_at: U.nowIso(), scopes: MS.SCOPES });
      await AU.append(tx, 'live', { actor, action: 'onedrive_connected', object_type: 'onedrive', object_id: me.id, summary: `OneDrive connected as ${me.userPrincipalName || me.displayName}` });
    });
    liveGraph = null;
    return page(200, 'OneDrive connected', `Connected as ${me.userPrincipalName || me.displayName}. Go back to the dashboard → Compliance Dashboard Vr.2.0 → Document Folders and choose the folder to use.`);
  } catch (e) {
    return page(400, 'OneDrive was not connected', e.message);
  }
}));

router.post('/onedrive/base', gate('admin'), wrap(async (req, res) => {
  if (req.c2.sp !== 'live') return bad(res, 400, 'The demo uses a simulated OneDrive');
  const graph = await graphFor('live');
  if (!graph) return bad(res, 400, 'Connect OneDrive first');
  const me = await graph.me();
  const r = await graph.resolveBase(String(req.body?.url || ''), me);
  const out = await store.transaction(async tx => {
    const mapping = await loadFolders(tx, 'live');
    if (mapping.root?.item_id && mapping.base?.item_id && mapping.base.item_id !== r.item.id) throw U.httpError(409, `The folders were already set up under "${mapping.base.path}". Changing the folder would start a new tree — ask for a reset first.`);
    const before = mapping.base;
    mapping.base = { drive_id: r.item.parentReference?.driveId, item_id: r.item.id, web_url: r.item.webUrl || '', path: r.path, url_given: String(req.body.url).slice(0, 600), set_by: req.c2.actor.name, set_at: U.nowIso() };
    tx.set(foldersKey('live'), mapping);
    await audit(tx, req, { action: 'onedrive_folder_chosen', object_type: 'folders', object_id: r.item.id, before, after: mapping.base, summary: `OneDrive folder: ${r.path}` });
    return mapping.base;
  });
  res.json({ base: out });
}));

router.post('/onedrive/disconnect', gate('admin'), wrap(async (req, res) => {
  await saveOnedrive({ status: 'disconnected', sealed: null, disconnected_at: U.nowIso(), disconnected_by: req.c2.actor.name });
  await store.transaction(tx => audit(tx, req, { action: 'onedrive_disconnected', object_type: 'onedrive', object_id: 'onedrive', summary: 'OneDrive disconnected (the folders and the mapping stay)' }));
  res.json({ ok: true });
}));

router.post('/documents/:id/onedrive', gate(['prepare', 'file']), wrap(async (req, res) => {
  const { d } = await loadDoc(store, req, req.params.id);
  res.json({ remote: await copyDoc(req.c2.sp, d.id, Number(req.body?.version) || d.current.v, { force: true }) });
}));

// ── Workspace: payments, TDS section-wise, reconciliations, payroll imports, tax audit, updates, reports ──
require('./workspace').mount(router, { gate, wrap, audit, upload, store, MAX_MB, derivedTasks, slim, isVercel: IS_VERCEL, get fetcher() { return fetchOverride; } });

// ── Errors ────────────────────────────────────────────────────────────────────
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.code === 'LIMIT_FILE_SIZE') return bad(res, 413, `The file is larger than ${MAX_MB()} MB`);
  const status = err.status || 500;
  if (status >= 500 && !err.status) console.error('[compliance2]', err.stack || err.message);   // unexpected errors only
  res.status(status).json({ error: status >= 500 && !err.status ? `Server error: ${err.message}` : err.message, ...(err.errors ? { errors: err.errors } : {}), ...(err.warnings ? { warnings: err.warnings } : {}),
    ...(err.missing ? { missing: err.missing } : {}), ...(err.results ? { results: err.results, counts: err.counts } : {}), ...(err.preview ? { preview: err.preview } : {}), ...(err.current_rev ? { current_rev: err.current_rev } : {}) });
});

module.exports = router;
