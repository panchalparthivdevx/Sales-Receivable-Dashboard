/**
 * Compliance Dashboard — API routes, mounted at /api/compliance (see server/index.js).
 *
 * Every route needs the app's normal login (JWT) and then a compliance permission flag.
 * Routes stay thin: the logic lives in ./lib (one file per layer):
 *   period.js  dueDateRules.js  statusEngine.js  tasks.js  taskGenerator.js  masters.js
 *   reports.js importExport.js  zohoSync.js      documents.js access.js     store.js
 */

'use strict';

const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');

const { authMiddleware } = require('../auth');
const store    = require('./lib/store');
const Settings = require('./lib/settings');
const P   = require('./lib/period');
const R   = require('./lib/dueDateRules');
const SE  = require('./lib/statusEngine');
const C   = require('./lib/columns');
const M   = require('./lib/masters');
const T   = require('./lib/tasks');
const G   = require('./lib/taskGenerator');
const RP  = require('./lib/reports');
const IE  = require('./lib/importExport');
const ZS  = require('./lib/zohoSync');
const D   = require('./lib/documents');
const A   = require('./lib/audit');
const AC  = require('./lib/access');
const { migrate, LATEST_VERSION } = require('./schema/migrations');

const router = express.Router();

// ── Zoho client (injectable for tests) ────────────────────────────────────────
let zohoGetFn = null;
let zohoSync = null;
function zoho() {
  if (!zohoSync) zohoSync = ZS.createZohoSync({ zohoGet: zohoGetFn || require('../zoho').zohoGet });
  return zohoSync;
}
router.setZohoGet = fn => { zohoGetFn = fn; zohoSync = null; };

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getSettings() { return Settings.merge(await store.read('settings', {})); }

/** Current data, migrated to the latest schema (migration runs once, with a backup first) */
async function readState() {
  const raw = await store.read('data', null);
  if (raw && raw.schema_version >= LATEST_VERSION) return migrate(raw).state;
  return store.transaction(async tx => {
    const cur = await tx.get('data', null);
    if (cur && cur.schema_version >= LATEST_VERSION) return cur;
    const settings = await getSettings();
    if (cur) await store.backup('before-migration', { dir: settings.backup_dir, keep: settings.backup_keep });
    const { state, applied } = migrate(cur);
    tx.set('data', state);
    await A.append(tx, A.entry(null, 'migrate', 'schema', String(state.schema_version), `Schema migrated (${applied.join(', ')})`), settings.audit_max_entries);
    return state;
  });
}

const nowISO = () => new Date().toISOString();
const today = () => P.localISODate();

function bad(res, status, error, extra = {}) { return res.status(status).json({ error, ...extra }); }
function wrap(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

/** Parse + validate the period selection from a query/body. Sends 400 when invalid. */
function selectionFrom(src, res) {
  const v = P.validateSelection({ fy: src.fy, half: src.half, quarter: src.quarter, month: src.month });
  if (!v.ok) { bad(res, 400, v.errors.join(' '), { errors: v.errors }); return null; }
  return v;
}

/** A company filter value the user may use ('' = all of the user's companies) */
function companyFilter(req, value, state) {
  if (!value || P.isAll(value)) return '';
  const co = M.resolveCompany(state, value);
  if (!co) return null;
  if (!AC.canSeeCompany(req.cuser, co.id)) return null;
  return co.id;
}

const visibleCompanies = (req, state) => state.companies.filter(c => AC.canSeeCompany(req.cuser, c.id));

function people(state) {
  const set = new Set();
  for (const a of state.applicability) { if (a.responsible) set.add(a.responsible); if (a.reviewer) set.add(a.reviewer); }
  for (const t of state.tasks) { if (t.responsible) set.add(t.responsible); if (t.reviewer) set.add(t.reviewer); }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function docView(d) {
  return {
    id: d.id, task_id: d.task_id, kind: d.kind, doc_type: d.doc_type,
    name: d.kind === 'link' ? (d.title || d.url) : d.original_name,
    url: d.kind === 'link' ? d.url : undefined,
    size: d.size || 0, folder: d.folder || '',
    company_id: d.company_id, fy: d.fy, module: d.module, month: d.month, quarter: P.quarterOf(d.month), compliance_id: d.compliance_id,
    uploaded_by: d.uploaded_by, uploaded_at: d.uploaded_at, replaced_at: d.replaced_at || null, version: d.version || 1,
  };
}

const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv', '.txt': 'text/plain', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.zip': 'application/zip' };

function sendXlsx(res, buffer, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
}

/** multer in memory with the size limit from settings */
function uploadSingle(field, maxMb) {
  return multer({ storage: multer.memoryStorage(), limits: { fileSize: Math.ceil(maxMb * 1024 * 1024) + 1024, files: 1 } }).single(field);
}
function runUpload(req, res, field, maxMb) {
  return new Promise((resolve, reject) => uploadSingle(field, maxMb)(req, res, e => (e ? reject(e) : resolve())));
}

// ── Auth for everything below ─────────────────────────────────────────────────
router.use(authMiddleware, AC.attach());

// First request after start-up: make sure the data store exists and is on the latest schema
let schemaReady = false;
router.use(wrap(async (req, res, next) => {
  if (!schemaReady) { await readState(); schemaReady = true; }
  next();
}));
router.resetSchemaCheck = () => { schemaReady = false; };

// ═════════════════════════════════════════════════════════════════════════════
// Meta
// ═════════════════════════════════════════════════════════════════════════════
router.get('/meta', wrap(async (req, res) => {
  const [state, settings] = await Promise.all([readState(), getSettings()]);
  const cur = P.currentPeriod();
  const { roles, zoho: zohoCfg, ...rest } = settings;
  const safeSettings = { ...rest, roles, zoho: { entities: (zohoCfg?.entities || []).map(e => ({ key: e.key, label: e.label, modules: e.modules })) } };
  if (!req.cuser.flags.edit_master && !req.cuser.flags.admin) { delete safeSettings.storage_root; delete safeSettings.backup_dir; }
  res.json({
    me: req.cuser,
    today: today(),
    current: { ...cur, fy_default: settings.fy_list.includes(cur.fy) ? cur.fy : settings.fy_list[settings.fy_list.length - 1] },
    period: P.periodMeta(),
    statuses: { user: SE.USER_STATUSES, display: SE.DISPLAY_STATUSES },
    columns: { sheets: C.SHEETS, sheet_order: C.SHEET_ORDER, task_view: C.TASK_VIEW, summary: C.SUMMARY_VIEW, audit: C.AUDIT_VIEW, error_report: C.ERROR_REPORT },
    settings: safeSettings,
    companies: visibleCompanies(req, state),
    compliances: state.compliances,
    people: people(state),
  });
}));

// ═════════════════════════════════════════════════════════════════════════════
// Dashboard (KPIs + reports + tasks for ONE selected period)
// ═════════════════════════════════════════════════════════════════════════════
router.get('/dashboard', wrap(async (req, res) => {
  const sel = selectionFrom(req.query, res);
  if (!sel) return;
  const [state, settings] = await Promise.all([readState(), getSettings()]);
  const company_id = companyFilter(req, req.query.company, state);
  if (company_id === null) return bad(res, 400, `Company "${req.query.company}" not found or not allowed.`);
  if (req.query.module && !P.isAll(req.query.module) && !M.normModule(settings, req.query.module)) return bad(res, 400, `Module "${req.query.module}" is not valid.`);
  const tasks = RP.selectTasks(state, sel, { company_id, module: req.query.module }, req.cuser);
  const L = RP.lookups(state);
  const t = today();
  const rows = tasks.map(x => RP.viewRow(x, L, t, settings.due_soon_days));
  res.json({ selection: { ...sel.selection, company: company_id || 'All', module: req.query.module && !P.isAll(req.query.module) ? M.normModule(settings, req.query.module) : 'All' },
    months: sel.months, today: t, due_soon_days: settings.due_soon_days, rows, ...RP.dashboard(rows, settings) });
}));

// Global search — inside the selection, or across all periods when scope=all (an intentional widening)
router.get('/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return bad(res, 400, 'Type at least 2 characters.');
  const [state, settings] = await Promise.all([readState(), getSettings()]);
  let tasks;
  if (req.query.scope === 'all') tasks = state.tasks.filter(x => AC.canSeeCompany(req.cuser, x.company_id));
  else {
    const sel = selectionFrom(req.query, res);
    if (!sel) return;
    const company_id = companyFilter(req, req.query.company, state);
    if (company_id === null) return bad(res, 400, 'Company not allowed.');
    tasks = RP.selectTasks(state, sel, { company_id, module: req.query.module }, req.cuser);
  }
  const L = RP.lookups(state);
  const t = today();
  const rows = tasks.map(x => RP.viewRow(x, L, t, settings.due_soon_days)).filter(r => RP.matchesSearch(r, q));
  res.json({ q, scope: req.query.scope === 'all' ? 'all' : 'selection', total: rows.length, rows: rows.slice(0, 1000) });
}));

// ═════════════════════════════════════════════════════════════════════════════
// Tasks
// ═════════════════════════════════════════════════════════════════════════════
router.get('/tasks/:id', wrap(async (req, res) => {
  const [state, settings, audit] = await Promise.all([readState(), getSettings(), store.read('audit', [])]);
  const task = state.tasks.find(x => x.task_id === req.params.id);
  if (!task || !AC.canSeeCompany(req.cuser, task.company_id)) return bad(res, 404, 'Task not found.');
  const docs = state.documents.filter(d => d.task_id === task.task_id);
  const docIds = new Set(docs.map(d => d.id));
  const trail = audit.filter(e => (e.entity === 'task' && e.entity_id === task.task_id) || (e.entity === 'document' && (e.task_id === task.task_id || docIds.has(e.entity_id))))
    .slice(-300).reverse();
  const compliance = state.compliances.find(c => c.id === task.compliance_id);
  res.json({ task: RP.viewRow(task, RP.lookups(state), today(), settings.due_soon_days), compliance, documents: docs.map(docView), audit: trail });
}));

router.put('/tasks/:id', AC.need('edit_tasks'), wrap(async (req, res) => {
  const body = req.body || {};
  const allowed = ['status', 'completion_date', 'remarks', 'responsible', 'reviewer'];
  const masterOnly = ['due_date', 'applicable'];
  const input = {};
  for (const k of allowed) if (k in body) input[k] = body[k] ?? '';
  for (const k of masterOnly) if (k in body) {
    if (!req.cuser.flags.edit_master) return bad(res, 403, `Changing ${k.replace('_', ' ')} needs the "edit master" permission.`);
    input[k] = body[k] ?? '';
  }
  const settings = await getSettings();
  const out = await store.transaction(async tx => {
    const state = await tx.get('data');
    const task = state.tasks.find(x => x.task_id === req.params.id);
    if (!task || !AC.canSeeCompany(req.cuser, task.company_id)) return { status: 404, error: 'Task not found.' };
    const r = T.updateTask(state, req.params.id, input, { settings, user: req.cuser, now: nowISO(), today: today() });
    if (!r.ok) return { status: 400, error: r.errors.map(e => e.error).join(' '), errors: r.errors };
    if (r.action === 'update') {
      tx.set('data', state);
      await A.append(tx, A.entry(req.cuser, 'update', 'task', r.record.task_id, 'Task updated', r.changes), settings.audit_max_entries);
    }
    return { ok: true, action: r.action };
  });
  if (out.error) return bad(res, out.status, out.error, { errors: out.errors });
  res.json(out);
}));

// Manual entry
router.post('/tasks', AC.need('edit_master'), wrap(async (req, res) => {
  const settings = await getSettings();
  const b = req.body || {};
  const input = {};
  for (const k of ['company', 'fy', 'month', 'quarter', 'half', 'module', 'compliance_id', 'applicable', 'due_date', 'responsible', 'reviewer', 'remarks', 'status', 'completion_date']) {
    if (b[k] !== undefined && b[k] !== null && b[k] !== '') input[k] = b[k];
  }
  const out = await store.transaction(async tx => {
    const state = await tx.get('data');
    const co = M.resolveCompany(state, input.company);
    if (co && !AC.canSeeCompany(req.cuser, co.id)) return { status: 403, error: 'You cannot add tasks for this company.' };
    const r = T.createTask(state, input, { settings, user: req.cuser, now: nowISO(), today: today(), source: 'manual' });
    if (!r.ok) return { status: 400, error: r.errors.map(e => e.error).join(' '), errors: r.errors };
    tx.set('data', state);
    await A.append(tx, A.entry(req.cuser, 'create', 'task', r.record.task_id, 'Task added manually', r.changes), settings.audit_max_entries);
    return { ok: true, task_id: r.record.task_id };
  });
  if (out.error) return bad(res, out.status, out.error, { errors: out.errors });
  res.json(out);
}));

router.delete('/tasks/:id', AC.need('edit_master'), wrap(async (req, res) => {
  const settings = await getSettings();
  const out = await store.transaction(async tx => {
    const state = await tx.get('data');
    const task = state.tasks.find(x => x.task_id === req.params.id);
    if (!task || !AC.canSeeCompany(req.cuser, task.company_id)) return { status: 404, error: 'Task not found.' };
    const r = T.deleteTask(state, req.params.id);
    if (!r.ok) return { status: 400, error: r.error };
    tx.set('data', state);
    await A.append(tx, A.entry(req.cuser, 'delete', 'task', req.params.id, `Task deleted (${task.status}, due ${task.due_date})`), settings.audit_max_entries);
    return { ok: true };
  });
  if (out.error) return bad(res, out.status, out.error);
  res.json(out);
}));

// Generate tasks: rules × companies × periods. confirm=false → preview only.
router.post('/tasks/generate', AC.need('edit_master'), wrap(async (req, res) => {
  const b = req.body || {};
  const sel = selectionFrom(b, res);
  if (!sel) return;
  const settings = await getSettings();
  if (!settings.fy_list.includes(sel.selection.fy)) return bad(res, 400, `FY ${sel.selection.fy} is not in the FY list.`);
  const params = {
    fy: sel.selection.fy, months: sel.months,
    company_ids: (b.company_ids || []).filter(Boolean),
    modules: (b.modules || []).filter(Boolean),
  };
  const run = async (state, apply) => {
    if (req.cuser.companies.length) params.company_ids = (params.company_ids.length ? params.company_ids : state.companies.map(c => c.id)).filter(id => AC.canSeeCompany(req.cuser, id));
    return G.generate(state, params, { settings, user: req.cuser, now: nowISO(), today: today() }, { apply });
  };
  if (!b.confirm) {
    const g = await run(await readState(), false);
    return res.json({ preview: true, create: g.create.length, skipped: g.skipped.length, errors: g.errors, sample: g.create.slice(0, 50).map(t => ({ task_id: t.task_id, due_date: t.due_date, applicable: t.applicable })) });
  }
  const out = await store.transaction(async tx => {
    const state = await tx.get('data');
    const g = await run(state, true);
    if (g.create.length) {
      tx.set('data', state);
      await A.append(tx, A.entry(req.cuser, 'generate', 'task', `${params.fy}`, `Generated ${g.create.length} task(s) for FY ${params.fy} (${sel.selection.month !== 'All' ? sel.selection.month : sel.selection.quarter !== 'All' ? sel.selection.quarter : sel.selection.half !== 'All' ? sel.selection.half : 'full year'}); ${g.skipped.length} already existed`), settings.audit_max_entries);
    }
    return { ok: true, created: g.create.length, skipped: g.skipped.length, errors: g.errors };
  });
  res.json(out);
}));

// ═════════════════════════════════════════════════════════════════════════════
// Masters
// ═════════════════════════════════════════════════════════════════════════════
router.get('/master', wrap(async (req, res) => {
  const [state, settings] = await Promise.all([readState(), getSettings()]);
  const cos = visibleCompanies(req, state);
  const coIds = new Set(cos.map(c => c.id));
  const taskCount = {};
  for (const t of state.tasks) {
    taskCount[`co:${t.company_id}`] = (taskCount[`co:${t.company_id}`] || 0) + 1;
    taskCount[`cm:${t.compliance_id}`] = (taskCount[`cm:${t.compliance_id}`] || 0) + 1;
  }
  const applicability = [];
  for (const co of cos) for (const cm of state.compliances) {
    const a = M.findApplicability(state, co.id, cm.id);
    applicability.push({ company_id: co.id, company_short: co.short_code, company_name: co.name, compliance_id: cm.id, compliance_name: cm.name, module: cm.module,
      applicable: a ? a.applicable : settings.applicability_default, explicit: !!a, responsible: a?.responsible || '', reviewer: a?.reviewer || '', remarks: a?.remarks || '',
      updated_at: a?.updated_at || null, updated_by: a?.updated_by || null });
  }
  res.json({
    companies: cos.map(c => ({ ...c, task_count: taskCount[`co:${c.id}`] || 0 })),
    compliances: state.compliances.map(c => ({ ...c, task_count: taskCount[`cm:${c.id}`] || 0 })),
    applicability: applicability.filter(a => coIds.has(a.company_id)),
    people: people(state),
  });
}));

/** Shared handler for master saves */
function masterSave(kind) {
  return wrap(async (req, res) => {
    const settings = await getSettings();
    const body = { ...(req.body || {}) };
    const out = await store.transaction(async tx => {
      const state = await tx.get('data');
      const ctx = { settings, user: req.cuser, now: nowISO(), today: today() };
      let r, entity, entityId;
      if (kind === 'company') {
        if (req.params.id) body.id = req.params.id;
        if (req.params.id && !AC.canSeeCompany(req.cuser, req.params.id)) return { status: 403, error: 'Not allowed for this company.' };
        if (!req.params.id && req.cuser.companies.length) return { status: 403, error: 'Users limited to some companies cannot add companies.' };
        r = M.saveCompany(state, body, { ...ctx, mode: req.params.id ? 'update' : 'create' });
        entity = 'company'; entityId = r.record?.id;
      } else if (kind === 'compliance') {
        if (req.params.id) body.id = req.params.id;
        r = M.saveCompliance(state, body, { ...ctx, mode: req.params.id ? 'update' : 'create' });
        entity = 'compliance'; entityId = r.record?.id;
      } else {
        const co = M.resolveCompany(state, body.company_id || body.company);
        if (co && !AC.canSeeCompany(req.cuser, co.id)) return { status: 403, error: 'Not allowed for this company.' };
        r = M.saveApplicability(state, body, ctx);
        entity = 'applicability'; entityId = r.ok ? `${r.company.short_code}|${r.compliance.id}` : null;
      }
      if (!r.ok) return { status: 400, error: r.errors.map(e => e.error).join(' '), errors: r.errors };
      if (r.action !== 'nochange') {
        tx.set('data', state);
        await A.append(tx, A.entry(req.cuser, r.action, entity, entityId, `${entity[0].toUpperCase() + entity.slice(1)} ${r.action === 'create' ? 'added' : 'updated'}${(r.effects || []).length ? ' — ' + r.effects.join(' ') : ''}`, r.changes), settings.audit_max_entries);
      }
      return { ok: true, action: r.action, effects: r.effects || [], record: r.record };
    });
    if (out.error) return bad(res, out.status, out.error, { errors: out.errors });
    res.json(out);
  });
}
router.post('/master/companies', AC.need('edit_master'), masterSave('company'));
router.put('/master/companies/:id', AC.need('edit_master'), masterSave('company'));
router.post('/master/compliances', AC.need('edit_master'), masterSave('compliance'));
router.put('/master/compliances/:id', AC.need('edit_master'), masterSave('compliance'));
router.put('/master/applicability', AC.need('edit_master'), masterSave('applicability'));

function masterDelete(kind) {
  return wrap(async (req, res) => {
    const settings = await getSettings();
    const out = await store.transaction(async tx => {
      const state = await tx.get('data');
      if (kind === 'company' && !AC.canSeeCompany(req.cuser, req.params.id)) return { status: 403, error: 'Not allowed.' };
      const r = kind === 'company' ? M.deleteCompany(state, req.params.id) : M.deleteCompliance(state, req.params.id);
      if (!r.ok) return { status: 400, error: r.error };
      tx.set('data', state);
      await A.append(tx, A.entry(req.cuser, 'delete', kind, req.params.id, `${kind === 'company' ? 'Company ' + r.record.name : 'Compliance ' + r.record.name} deleted`), settings.audit_max_entries);
      return { ok: true };
    });
    if (out.error) return bad(res, out.status, out.error);
    res.json(out);
  });
}
router.delete('/master/companies/:id', AC.need('edit_master'), masterDelete('company'));
router.delete('/master/compliances/:id', AC.need('edit_master'), masterDelete('compliance'));

// Show the due dates a rule produces for a whole FY (helps verify a rule before saving)
router.post('/master/rule-preview', wrap(async (req, res) => {
  const { due_rule, frequency, fy } = req.body || {};
  const freq = P.normFrequency(frequency);
  if (!freq) return bad(res, 400, 'Choose a frequency.');
  const v = R.validateRule(due_rule, freq);
  if (!v.ok) return bad(res, 400, v.error);
  const year = P.normFY(fy) || P.currentPeriod().fy;
  res.json({ fy: year, dates: P.periodKeysOf(freq).map(pk => ({ period: pk, label: P.periodLabel(year, pk), due_date: R.dueDateFor(due_rule, year, pk).date })) });
}));

// ═════════════════════════════════════════════════════════════════════════════
// Excel template / export / import
// ═════════════════════════════════════════════════════════════════════════════
router.get('/master/template', wrap(async (req, res) => {
  const [state, settings] = await Promise.all([readState(), getSettings()]);
  sendXlsx(res, IE.buildWorkbook(state, settings, { withData: false }), 'Compliance_Import_Template.xlsx');
}));

router.get('/master/export', AC.need('edit_master'), wrap(async (req, res) => {
  const [state, settings] = await Promise.all([readState(), getSettings()]);
  if (req.cuser.companies.length) return bad(res, 403, 'Users limited to some companies cannot export all master data.');
  const fy = req.query.fy && !P.isAll(req.query.fy) ? P.normFY(req.query.fy) : null;
  sendXlsx(res, IE.buildWorkbook(state, settings, { withData: true, fy }), `Compliance_Master_Data${fy ? '_FY' + fy : ''}_${today()}.xlsx`);
}));

const previews = new Map();     // token → { parsed, file, user_id, at, result }
function prunePreviews() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of previews) if (v.at < cutoff) previews.delete(k);
}

router.post('/import/preview', AC.need('import'), wrap(async (req, res) => {
  try { await runUpload(req, res, 'file', 10); }
  catch (e) { return bad(res, 400, e.code === 'LIMIT_FILE_SIZE' ? 'The Excel file is larger than 10 MB.' : e.message); }
  if (!req.file) return bad(res, 400, 'Choose an Excel file.');
  if (!/\.(xlsx|xls)$/i.test(req.file.originalname)) return bad(res, 400, 'Only .xlsx or .xls files can be imported.');
  if (req.cuser.companies.length) return bad(res, 403, 'Users limited to some companies cannot import.');
  const [state, settings] = await Promise.all([readState(), getSettings()]);
  const parsed = IE.parseWorkbook(req.file.buffer);
  const copy = JSON.parse(JSON.stringify(state));                  // preview never touches real data
  const result = IE.run(copy, parsed, { settings, user: req.cuser, now: nowISO(), today: today() });
  prunePreviews();
  const token = crypto.randomBytes(16).toString('hex');
  previews.set(token, { parsed, file: req.file.originalname, user_id: req.cuser.id, at: Date.now(), result });
  res.json({ token, file: req.file.originalname, sheets: parsed.found, counts: result.counts, actions: result.actions.slice(0, 500), action_total: result.actions.length,
    errors: result.errors, skipped: result.skipped, warnings: result.warnings });
}));

router.post('/import/confirm', AC.need('import'), wrap(async (req, res) => {
  const p = previews.get(req.body?.token);
  if (!p || p.user_id !== req.cuser.id) return bad(res, 400, 'This preview has expired. Please preview the file again.');
  const settings = await getSettings();
  const out = await store.transaction(async tx => {
    const backupFile = await store.backup('before-import', { dir: settings.backup_dir, keep: settings.backup_keep });
    const state = await tx.get('data');
    const result = IE.run(state, p.parsed, { settings, user: req.cuser, now: nowISO(), today: today() });
    if (result.actions.length) {
      tx.set('data', state);
      const entries = result.audit.map(a => A.entry(req.cuser, a.action, a.entity, a.id, a.summary, a.changes));
      entries.push(A.entry(req.cuser, 'import', 'import', p.file, `Excel import "${p.file}": ${result.actions.length} change(s), ${result.errors.length} error row(s), ${result.skipped.length} skipped. Backup: ${path.basename(backupFile)}`));
      await A.append(tx, entries, settings.audit_max_entries);
    }
    return { ok: true, applied: result.actions.length, counts: result.counts, errors: result.errors, skipped: result.skipped, backup: path.basename(backupFile) };
  });
  p.result = { errors: out.errors, skipped: out.skipped };
  res.json(out);
}));

router.get('/import/:token/errors', AC.need('import'), wrap(async (req, res) => {
  const p = previews.get(req.params.token);
  if (!p || p.user_id !== req.cuser.id) return bad(res, 404, 'This preview has expired.');
  const rows = [...p.result.errors, ...p.result.skipped, ...(p.result.warnings || [])];
  sendXlsx(res, IE.buildErrorReport(rows), `Import_Error_Report_${today()}.xlsx`);
}));

// ═════════════════════════════════════════════════════════════════════════════
// Settings (admin)
// ═════════════════════════════════════════════════════════════════════════════
router.get('/settings', AC.need('admin'), wrap(async (req, res) => {
  const overrides = await store.read('settings', {});
  const effective = Settings.merge(overrides);
  res.json({ effective, overrides, defaults: Settings.loadDefaults(), storage_root_resolved: D.rootOf(effective) });
}));

router.put('/settings', AC.need('admin'), wrap(async (req, res) => {
  const patch = req.body || {};
  const editable = ['fy_list', 'modules', 'folder_modules', 'default_folder_module', 'document_types', 'storage_root', 'due_soon_days', 'upload',
    'allow_duplicate_across_tasks', 'applicability_default', 'default_role', 'roles', 'upcoming_windows'];
  const clean = {};
  for (const k of editable) if (k in patch) clean[k] = patch[k];
  if ('fy_list' in clean) clean.fy_list = [...new Set(clean.fy_list.map(f => P.normFY(f) || f))].sort();
  if ('due_soon_days' in clean) clean.due_soon_days = Number(clean.due_soon_days);
  const errs = Settings.validatePatch(clean);
  const out = await store.transaction(async tx => {
    const overrides = { ...(await tx.get('settings', {})) };
    const before = Settings.merge(overrides);
    const after = Settings.merge({ ...overrides, ...clean });
    if (!after.roles[after.default_role]) errs.push({ field: 'default_role', error: `Default role "${after.default_role}" does not exist.`, fix: 'Pick a defined role.' });
    const state = await tx.get('data');
    // A module still used by compliances cannot be removed
    if ('modules' in clean) {
      const keys = new Set(after.modules.map(m => m.key));
      const used = [...new Set(state.compliances.map(c => c.module))].filter(m => !keys.has(m));
      if (used.length) errs.push({ field: 'modules', error: `Module(s) ${used.join(', ')} are used by compliances and cannot be removed.`, fix: 'Move or deactivate those compliances first.' });
    }
    if ('fy_list' in clean) {
      const used = [...new Set(state.tasks.map(t => t.fy))].filter(f => !after.fy_list.includes(f));
      if (used.length) errs.push({ field: 'fy_list', error: `FY ${used.join(', ')} has tasks and cannot be removed.`, fix: 'Keep it in the list.' });
    }
    if (errs.length) return { status: 400, error: errs.map(e => e.error).join(' '), errors: errs };
    tx.set('settings', { ...overrides, ...clean });
    const changes = Object.keys(clean).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(k => ({ field: k, from: before[k], to: after[k] }));
    if (changes.length) await A.append(tx, A.entry(req.cuser, 'update', 'settings', 'settings', 'Settings changed', changes), after.audit_max_entries);
    return { ok: true, effective: after };
  });
  if (out.error) return bad(res, out.status, out.error, { errors: out.errors });
  res.json(out);
}));

router.post('/settings/reset', AC.need('admin'), wrap(async (req, res) => {
  const keys = Array.isArray(req.body?.keys) ? req.body.keys : null;
  const out = await store.transaction(async tx => {
    const overrides = { ...(await tx.get('settings', {})) };
    const removed = keys ? keys.filter(k => k in overrides) : Object.keys(overrides);
    for (const k of removed) delete overrides[k];
    tx.set('settings', overrides);
    if (removed.length) await A.append(tx, A.entry(req.cuser, 'reset', 'settings', 'settings', `Settings reset to defaults: ${removed.join(', ')}`));
    return { ok: true, reset: removed };
  });
  res.json(out);
}));

// ═════════════════════════════════════════════════════════════════════════════
// Users and roles (admin)
// ═════════════════════════════════════════════════════════════════════════════
function appAdminOnly(req, res, next) {
  if (req.cuser.app_role === 'admin') return next();
  res.status(403).json({ error: 'Only an app Administrator can create users, disable users or reset passwords.' });
}

router.get('/users', AC.need('admin'), wrap(async (req, res) => {
  const { loadUsers } = require('../auth');
  const [users, state, settings] = await Promise.all([loadUsers(), readState(), getSettings()]);
  res.json({
    roles: settings.roles, default_role: settings.default_role,
    users: users.map(u => {
      const a = state.user_roles.find(r => r.user_id === u.id);
      return { id: u.id, username: u.username, name: u.name, app_role: u.role, active: u.active !== false,
        compliance_enabled: u.role === 'admin' || u.permissions?.compliance?.enabled !== false,
        role: u.role === 'admin' ? 'admin' : (a?.role || settings.default_role), assigned: !!a || u.role === 'admin', companies: a?.companies || [] };
    }),
  });
}));

router.put('/users/:id/role', AC.need('admin'), wrap(async (req, res) => {
  const { role, companies } = req.body || {};
  const settings = await getSettings();
  if (!settings.roles[role]) return bad(res, 400, `Role "${role}" does not exist.`);
  const { loadUsers } = require('../auth');
  const u = (await loadUsers()).find(x => x.id === req.params.id);
  if (!u) return bad(res, 404, 'User not found.');
  if (u.role === 'admin') return bad(res, 400, 'App Administrators are always compliance admins.');
  const out = await store.transaction(async tx => {
    const state = await tx.get('data');
    const ids = new Set(state.companies.map(c => c.id));
    const cos = (Array.isArray(companies) ? companies : []).filter(c => ids.has(c));
    const before = state.user_roles.find(r => r.user_id === u.id);
    const next = { user_id: u.id, username: u.username, role, companies: cos, updated_at: nowISO(), updated_by: req.cuser.name };
    state.user_roles = [...state.user_roles.filter(r => r.user_id !== u.id), next];
    tx.set('data', state);
    await A.append(tx, A.entry(req.cuser, 'update', 'role', u.username, `Compliance role for ${u.name || u.username}`,
      [{ field: 'role', from: before?.role || `(default) ${settings.default_role}`, to: role }, { field: 'companies', from: (before?.companies || []).join(', ') || 'All', to: cos.join(', ') || 'All' }]), settings.audit_max_entries);
    return { ok: true };
  });
  res.json(out);
}));

router.post('/users', AC.need('admin'), appAdminOnly, wrap(async (req, res) => {
  const { username, name, password, role, companies } = req.body || {};
  if (!username || !/^[A-Za-z0-9._@-]{3,40}$/.test(String(username).trim())) return bad(res, 400, 'Username must be 3–40 letters, digits or . _ @ -');
  if (!password || String(password).length < 8) return bad(res, 400, 'Password must be at least 8 characters.');
  const settings = await getSettings();
  if (role && !settings.roles[role]) return bad(res, 400, `Role "${role}" does not exist.`);
  const { loadUsers, saveUsers, allPerms } = require('../auth');
  const users = await loadUsers();
  if (users.find(u => u.username.toLowerCase() === String(username).trim().toLowerCase())) return bad(res, 409, 'Username already exists.');
  // New logins made here can open only the Compliance Dashboard; widen it in User Settings if needed.
  const perms = allPerms();
  for (const k of Object.keys(perms)) perms[k].enabled = k === 'compliance';
  const user = { id: Date.now().toString(), username: String(username).trim(), name: String(name || username).trim(), password: bcrypt.hashSync(String(password), 10), role: 'user', active: true, permissions: perms };
  users.push(user);
  await saveUsers(users);
  await store.transaction(async tx => {
    const state = await tx.get('data');
    if (role) {
      const ids = new Set(state.companies.map(c => c.id));
      state.user_roles.push({ user_id: user.id, username: user.username, role, companies: (companies || []).filter(c => ids.has(c)), updated_at: nowISO(), updated_by: req.cuser.name });
      tx.set('data', state);
    }
    await A.append(tx, A.entry(req.cuser, 'create', 'user', user.username, `Login created for ${user.name} (compliance role: ${role || settings.default_role})`), settings.audit_max_entries);
  });
  res.status(201).json({ ok: true, id: user.id });
}));

router.put('/users/:id', AC.need('admin'), appAdminOnly, wrap(async (req, res) => {
  const { name, active, password } = req.body || {};
  const { loadUsers, saveUsers } = require('../auth');
  const users = await loadUsers();
  const u = users.find(x => x.id === req.params.id);
  if (!u) return bad(res, 404, 'User not found.');
  const changes = [];
  if (name !== undefined && String(name).trim() && name !== u.name) { changes.push({ field: 'name', from: u.name, to: String(name).trim() }); u.name = String(name).trim(); }
  if (active !== undefined && !!active !== (u.active !== false)) {
    if (!active && u.id === req.cuser.id) return bad(res, 400, 'You cannot disable your own login.');
    if (!active && u.role === 'admin' && users.filter(x => x.role === 'admin' && x.active !== false).length === 1) return bad(res, 400, 'Cannot disable the last active admin.');
    changes.push({ field: 'active', from: u.active !== false, to: !!active }); u.active = !!active;
  }
  if (password !== undefined) {
    if (String(password).length < 8) return bad(res, 400, 'Password must be at least 8 characters.');
    u.password = bcrypt.hashSync(String(password), 10);
    changes.push({ field: 'password', from: '', to: '(reset)' });
  }
  if (!changes.length) return res.json({ ok: true, action: 'nochange' });
  await saveUsers(users);
  const settings = await getSettings();
  await store.transaction(async tx => A.append(tx, A.entry(req.cuser, 'update', 'user', u.username, `Login updated for ${u.name || u.username}`, changes), settings.audit_max_entries));
  res.json({ ok: true });
}));

// ═════════════════════════════════════════════════════════════════════════════
// Audit trail (admin)
// ═════════════════════════════════════════════════════════════════════════════
router.get('/audit', AC.need('admin'), wrap(async (req, res) => {
  const all = await store.read('audit', []);
  const { entity, user, q, from, to } = req.query;
  const limit = Math.min(Number(req.query.limit) || 500, 5000);
  const s = String(q || '').toLowerCase();
  const rows = [];
  for (let i = all.length - 1; i >= 0 && rows.length < limit; i--) {
    const e = all[i];
    if (entity && e.entity !== entity) continue;
    if (user && e.user !== user) continue;
    if (from && e.at.slice(0, 10) < from) continue;
    if (to && e.at.slice(0, 10) > to) continue;
    if (s && !`${e.entity_id} ${e.summary} ${e.user} ${e.action} ${JSON.stringify(e.changes)}`.toLowerCase().includes(s)) continue;
    rows.push(e);
  }
  res.json({ total: all.length, rows, users: [...new Set(all.map(e => e.user))].sort(), entities: [...new Set(all.map(e => e.entity))].sort() });
}));

// ═════════════════════════════════════════════════════════════════════════════
// Folder setup
// ═════════════════════════════════════════════════════════════════════════════
router.get('/folders/status', AC.need('edit_master'), wrap(async (req, res) => {
  const [state, settings] = await Promise.all([readState(), getSettings()]);
  const fy = P.normFY(req.query.fy);
  if (!fy) return bad(res, 400, 'Choose a Financial Year.');
  const cos = (req.query.company_id && req.query.company_id !== 'ALL') ? state.companies.filter(c => c.id === req.query.company_id) : visibleCompanies(req, state);
  res.json({ root: D.rootOf(settings), fy, companies: cos.filter(c => AC.canSeeCompany(req.cuser, c.id)).map(c => ({ company_id: c.id, company_name: c.name, modules: D.folderStatus({ settings, company: c, fy }) })) });
}));

router.post('/folders/create', AC.need('edit_master'), wrap(async (req, res) => {
  const { company_id, fy: fyIn, modules } = req.body || {};
  const settings = await getSettings();
  const fy = P.normFY(fyIn);
  if (!fy || !settings.fy_list.includes(fy)) return bad(res, 400, 'Choose a Financial Year from the FY list.');
  const mods = (modules || []).filter(m => settings.folder_modules.includes(m));
  if (!mods.length) return bad(res, 400, 'Tick at least one module.');
  const out = await store.transaction(async tx => {
    const state = await tx.get('data');
    const cos = company_id === 'ALL' ? state.companies.filter(c => c.status !== 'Inactive' && AC.canSeeCompany(req.cuser, c.id)) : state.companies.filter(c => c.id === company_id && AC.canSeeCompany(req.cuser, c.id));
    if (!cos.length) return { status: 400, error: 'Choose a company.' };
    const results = [];
    let anyCreated = false;
    for (const co of cos) {
      const r = D.createFolderStructure({ settings, company: co, fy, modules: mods });
      results.push({ company_id: co.id, company_name: co.name, root: r.root, modules: r.results });
      for (const reg of r.registry) {
        const exists = state.folders.find(f => f.company_id === reg.company_id && f.fy === reg.fy && f.module === reg.module && f.month === reg.month);
        if (!exists) { state.folders.push({ ...reg, created_at: nowISO(), created_by: req.cuser.name }); anyCreated = true; }
      }
      if (r.results.some(m => m.created)) anyCreated = true;
    }
    if (anyCreated) {
      tx.set('data', state);
      await A.append(tx, A.entry(req.cuser, 'create', 'folder', `${company_id}|${fy}`, `Folder structure for FY ${fy}: ${results.map(r => `${r.company_name} [${r.modules.map(m => `${m.module}: ${m.status}`).join(', ')}]`).join('; ')}`), settings.audit_max_entries);
    }
    return { ok: true, fy, results };
  });
  if (out.error) return bad(res, out.status, out.error);
  res.json(out);
}));

// ═════════════════════════════════════════════════════════════════════════════
// Documents — confidential: served only here, after login + permission checks
// ═════════════════════════════════════════════════════════════════════════════
async function loadTaskForDocs(req, state) {
  const task = state.tasks.find(x => x.task_id === req.params.id);
  if (!task || !AC.canSeeCompany(req.cuser, task.company_id)) return null;
  return task;
}

router.post('/tasks/:id/documents', AC.need('edit_tasks'), wrap(async (req, res) => {
  const settings = await getSettings();
  try { await runUpload(req, res, 'file', Number(settings.upload?.max_size_mb) || 15); }
  catch (e) { return bad(res, 400, e.code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${settings.upload.max_size_mb} MB.` : e.message); }
  if (!req.file) return bad(res, 400, 'Choose a file.');
  const docType = String(req.body?.doc_type || '').trim();
  if (!settings.document_types.includes(docType)) return bad(res, 400, `Choose a document type (${settings.document_types.join(', ')}).`);
  const problem = D.checkFile(req.file.buffer, req.file.originalname, settings);
  if (problem) return bad(res, 400, problem);
  const hash = D.sha256(req.file.buffer);
  const out = await store.transaction(async tx => {
    const state = await tx.get('data');
    const task = await loadTaskForDocs(req, state);
    if (!task) return { status: 404, error: 'Task not found.' };
    const dup = D.findDuplicate(state, hash, task.task_id, settings);
    if (dup) return { status: 409, error: `This exact file is already uploaded as "${dup.original_name}" on task ${dup.task_id}.` };
    const company = state.companies.find(c => c.id === task.company_id);
    const compliance = state.compliances.find(c => c.id === task.compliance_id);
    const w = D.writeRoutedFile(req.file.buffer, req.file.originalname, { settings, company, task, compliance }, docType);
    const doc = {
      id: D.newDocId(), task_id: task.task_id, kind: 'file', doc_type: docType,
      company_id: task.company_id, compliance_id: task.compliance_id, fy: task.fy, module: compliance.module, month: task.month,
      original_name: path.basename(String(req.file.originalname).replace(/\\/g, '/')).slice(0, 200), stored_name: w.fileName, stored_path: w.rel, folder: w.folder,
      size: req.file.size, mime: MIME[path.extname(w.fileName).toLowerCase()] || 'application/octet-stream', sha256: hash,
      uploaded_by: req.cuser.name, uploaded_by_id: req.cuser.id, uploaded_at: nowISO(), version: 1,
    };
    state.documents.push(doc);
    tx.set('data', state);
    await A.append(tx, A.entry(req.cuser, 'upload', 'document', doc.id, `${docType} "${doc.original_name}" uploaded to ${task.task_id} → ${w.folder}`, [], { task_id: task.task_id }), settings.audit_max_entries);
    return { ok: true, document: docView(doc) };
  });
  if (out.error) return bad(res, out.status, out.error);
  res.json(out);
}));

router.post('/tasks/:id/links', AC.need('edit_tasks'), wrap(async (req, res) => {
  const settings = await getSettings();
  const { url, title, doc_type } = req.body || {};
  let u;
  try { u = new URL(String(url || '').trim()); } catch (_) { return bad(res, 400, 'Enter a full link starting with https://'); }
  if (!['https:', 'http:'].includes(u.protocol)) return bad(res, 400, 'Only http(s) links are allowed.');
  if (!settings.document_types.includes(doc_type)) return bad(res, 400, 'Choose a document type.');
  const out = await store.transaction(async tx => {
    const state = await tx.get('data');
    const task = await loadTaskForDocs(req, state);
    if (!task) return { status: 404, error: 'Task not found.' };
    if (state.documents.some(d => d.task_id === task.task_id && d.kind === 'link' && d.url === u.href)) return { status: 409, error: 'This link is already on the task.' };
    const compliance = state.compliances.find(c => c.id === task.compliance_id);
    const doc = { id: D.newDocId(), task_id: task.task_id, kind: 'link', doc_type, url: u.href, title: String(title || '').trim().slice(0, 200) || u.hostname,
      company_id: task.company_id, compliance_id: task.compliance_id, fy: task.fy, module: compliance.module, month: task.month,
      uploaded_by: req.cuser.name, uploaded_by_id: req.cuser.id, uploaded_at: nowISO(), version: 1 };
    state.documents.push(doc);
    tx.set('data', state);
    await A.append(tx, A.entry(req.cuser, 'link', 'document', doc.id, `${doc_type} link "${doc.title}" added to ${task.task_id}`, [], { task_id: task.task_id }), settings.audit_max_entries);
    return { ok: true, document: docView(doc) };
  });
  if (out.error) return bad(res, out.status, out.error);
  res.json(out);
}));

router.get('/documents/:id/download', wrap(async (req, res) => {
  const [state, settings] = await Promise.all([readState(), getSettings()]);
  const doc = state.documents.find(d => d.id === req.params.id);
  if (!doc || !AC.canSeeCompany(req.cuser, doc.company_id)) return bad(res, 404, 'Document not found.');
  if (doc.kind !== 'file') return bad(res, 400, 'This document is a link.');
  let abs;
  try { abs = D.absPathOf(settings, doc); } catch (e) { return bad(res, 400, e.message); }
  if (!fs.existsSync(abs)) return bad(res, 404, 'The file is missing from the storage folder. It may have been moved, or the storage root changed.');
  const inline = req.query.inline === '1';
  await store.transaction(async tx => A.append(tx, A.entry(req.cuser, inline ? 'view' : 'download', 'document', doc.id, `${doc.doc_type} "${doc.original_name}" ${inline ? 'viewed' : 'downloaded'}`, [], { task_id: doc.task_id }), settings.audit_max_entries));
  res.setHeader('Content-Type', doc.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
}));

router.put('/documents/:id/replace', AC.need('manage_documents'), wrap(async (req, res) => {
  const settings = await getSettings();
  try { await runUpload(req, res, 'file', Number(settings.upload?.max_size_mb) || 15); }
  catch (e) { return bad(res, 400, e.code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${settings.upload.max_size_mb} MB.` : e.message); }
  if (!req.file) return bad(res, 400, 'Choose a file.');
  const problem = D.checkFile(req.file.buffer, req.file.originalname, settings);
  if (problem) return bad(res, 400, problem);
  const hash = D.sha256(req.file.buffer);
  const out = await store.transaction(async tx => {
    const state = await tx.get('data');
    const doc = state.documents.find(d => d.id === req.params.id);
    if (!doc || !AC.canSeeCompany(req.cuser, doc.company_id)) return { status: 404, error: 'Document not found.' };
    if (doc.kind !== 'file') return { status: 400, error: 'Links cannot be replaced — delete and add again.' };
    const dup = state.documents.find(d => d.id !== doc.id && d.kind === 'file' && d.sha256 === hash && (d.task_id === doc.task_id || !settings.allow_duplicate_across_tasks));
    if (dup || doc.sha256 === hash) return { status: 409, error: `This exact file is already uploaded${dup ? ` as "${dup.original_name}" on task ${dup.task_id}` : ' (same as the current file)'}.` };
    const task = state.tasks.find(t => t.task_id === doc.task_id);
    const company = state.companies.find(c => c.id === doc.company_id);
    const compliance = state.compliances.find(c => c.id === doc.compliance_id);
    const archived = D.archiveFile(settings, doc, 'replaced');
    const w = D.writeRoutedFile(req.file.buffer, req.file.originalname, { settings, company, task, compliance }, doc.doc_type);
    const before = { name: doc.original_name, sha256: doc.sha256 };
    Object.assign(doc, { original_name: path.basename(String(req.file.originalname).replace(/\\/g, '/')).slice(0, 200), stored_name: w.fileName, stored_path: w.rel, folder: w.folder,
      size: req.file.size, mime: MIME[path.extname(w.fileName).toLowerCase()] || 'application/octet-stream', sha256: hash,
      replaced_at: nowISO(), replaced_by: req.cuser.name, version: (doc.version || 1) + 1 });
    tx.set('data', state);
    await A.append(tx, A.entry(req.cuser, 'replace', 'document', doc.id, `${doc.doc_type} replaced on ${doc.task_id}${archived ? ` (old file kept in ${archived})` : ''}`,
      [{ field: 'file', from: before.name, to: doc.original_name }, { field: 'sha256', from: before.sha256.slice(0, 12), to: hash.slice(0, 12) }], { task_id: doc.task_id }), settings.audit_max_entries);
    return { ok: true, document: docView(doc) };
  });
  if (out.error) return bad(res, out.status, out.error);
  res.json(out);
}));

router.delete('/documents/:id', AC.need('manage_documents'), wrap(async (req, res) => {
  const settings = await getSettings();
  const out = await store.transaction(async tx => {
    const state = await tx.get('data');
    const doc = state.documents.find(d => d.id === req.params.id);
    if (!doc || !AC.canSeeCompany(req.cuser, doc.company_id)) return { status: 404, error: 'Document not found.' };
    const archived = doc.kind === 'file' ? D.archiveFile(settings, doc, 'deleted') : null;
    state.documents = state.documents.filter(d => d.id !== doc.id);
    tx.set('data', state);
    await A.append(tx, A.entry(req.cuser, 'delete', 'document', doc.id, `${doc.doc_type} "${doc.original_name || doc.title}" deleted from ${doc.task_id}${archived ? ` (file kept in ${archived})` : ''}`, [], { task_id: doc.task_id }), settings.audit_max_entries);
    return { ok: true };
  });
  if (out.error) return bad(res, out.status, out.error);
  res.json(out);
}));

// ═════════════════════════════════════════════════════════════════════════════
// Zoho period sync — reads never call Zoho; only POST /zoho/sync does (explicit click)
// ═════════════════════════════════════════════════════════════════════════════
async function zohoContext(req, res, src) {
  const sel = selectionFrom(src, res);
  if (!sel) return null;
  const [state, settings, cache] = await Promise.all([readState(), getSettings(), store.read('zoho', { periods: {} })]);
  const company_id = companyFilter(req, src.company, state);
  if (company_id === null) { bad(res, 400, 'Company not found or not allowed.'); return null; }
  const periods = ZS.periodsFor(state, sel, { company_id, access: req.cuser });
  return { sel, state, settings, cache, periods };
}

router.get('/zoho/status', wrap(async (req, res) => {
  const z = await zohoContext(req, res, req.query);
  if (!z) return;
  res.json(ZS.statusOf(z.cache, z.periods));
}));

router.get('/zoho/data', wrap(async (req, res) => {
  const z = await zohoContext(req, res, req.query);
  if (!z) return;
  res.json({ status: ZS.statusOf(z.cache, z.periods), ...ZS.dataOf(z.cache, z.periods, z.settings, req.query.module) });
}));

let syncRunning = false;
router.post('/zoho/sync', AC.need('edit_tasks'), wrap(async (req, res) => {
  const z = await zohoContext(req, res, req.body || {});
  if (!z) return;
  if (syncRunning) return bad(res, 409, 'A Zoho sync is already running. Please wait for it to finish.');
  const todo = z.periods.filter(p => p.company.zoho_org_id);
  if (!todo.length) return bad(res, 400, 'None of the selected companies is linked to Zoho Books (add a Zoho Org ID in the Company Master).');
  const maxPeriods = 36;
  if (todo.length > maxPeriods) return bad(res, 400, `That is ${todo.length} periods. Sync at most ${maxPeriods} at a time — choose a half year, quarter or one company.`);
  syncRunning = true;
  try {
    const results = await zoho().syncPeriods(todo, z.cache, {
      settings: z.settings, user: req.cuser, onlyMissing: !!req.body?.only_missing,
      save: (key, rec) => store.transaction(async tx => {
        const cache = await tx.get('zoho', { periods: {} });
        const prev = cache.periods[key];
        // A failed sync never wipes good stored data
        cache.periods[key] = !rec.ok && prev?.ok ? { ...prev, last_error: rec.errors.join('; '), last_error_at: rec.synced_at } : rec;
        tx.set('zoho', cache);
        await A.append(tx, A.entry(req.cuser, 'sync', 'zoho', key, `Zoho sync ${rec.ok ? (rec.partial ? 'partly done' : 'done') : 'failed'} for ${key} (${rec.api_calls} API call(s))${rec.errors.length ? ': ' + rec.errors.join('; ') : ''}`), z.settings.audit_max_entries);
      }),
    });
    const cache = await store.read('zoho', { periods: {} });
    res.json({ ok: true, results, status: ZS.statusOf(cache, z.periods), api_calls: results.reduce((s, r) => s + (r.api_calls || 0), 0) });
  } finally { syncRunning = false; }
}));

// ── Errors → JSON ─────────────────────────────────────────────────────────────
router.use((err, req, res, _next) => {
  console.error('[compliance]', err);
  res.status(500).json({ error: err.message || 'Server error' });
});

module.exports = router;
