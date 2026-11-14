/**
 * Financial Reporting — API routes, mounted at /api/fin-reporting (see server/index.js). Used by the Financial Statements
 * page: imported statements, notes, comparisons, ratios, CFO overview, management inputs and Data Validation.
 *
 * Rights (User Settings → Financial Statements):
 *   view        module ticked (as the sidebar)            every report and export
 *   fs_import   "Import workbooks"                         upload / import workbooks, commit a version, roll back
 *   fs_adjust   "Adjustments & source decisions"           record or reverse a statement-level adjustment, resolve a source conflict
 *   fs_inputs   "Management inputs"                        budgets, seats, schedules, covenants, share data, thresholds
 * Admins have every right. Nothing here writes to Zoho Books. Imported figures are never changed: adjustments and decisions
 * are stored separately with reason, evidence, user and date. Logic lives in ./lib — see README.md.
 */

'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadUsers } = require('../auth');
const store = require('./lib/store');
const X = require('./lib/extract');
const B = require('./lib/build');
const M = require('./lib/model');
const RC = require('./lib/recon');
const C = require('./lib/compare');
const RA = require('./lib/ratios');
const IN = require('./lib/inputs');
const V = require('./lib/views');
const EX = require('./lib/exporter');
const P = require('./lib/periods');
const L = require('./lib/lines');

const router = express.Router();
const IS_VERCEL = !!process.env.VERCEL;
const DEFAULT_FOLDER = path.join(__dirname, '..', '..', 'Financials & Presentations', 'Financials');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

let usersOf = loadUsers;
let legacyRead = async () => null;
router.init = (deps = {}) => { if (deps.loadUsers) usersOf = deps.loadUsers; if (deps.readLegacy) legacyRead = deps.readLegacy; if (deps.ops) require('./lib/sources').setOps(deps.ops); };

// ── rights ───────────────────────────────────────────────────────────────────
async function rights(req) {
  const users = await usersOf();
  const u = users.find(x => x.id === req.user?.id);
  if (!u || u.active === false) return { view: false };
  const admin = u.role === 'admin';
  const p = u.permissions?.fin_stmt;
  // same rule as the sidebar: a user whose permissions predate this module keeps seeing it
  const view = admin || p == null || p.enabled === true;
  const sec = k => admin || (view && p?.sections?.[k] === true);
  return { user: u, admin, view, import: sec('fs_import'), adjust: sec('fs_adjust'), inputs: sec('fs_inputs') };
}
const WHY = { import: 'This needs the "Import workbooks" right (User Settings → Financial Statements).', adjust: 'This needs the "Adjustments & source decisions" right.', inputs: 'This needs the "Management inputs" right.' };
router.use(wrap(async (req, res, next) => {
  req.fsr = await rights(req);
  if (!req.fsr.view) return bad(res, 403, 'You do not have access to Financial Statements.');
  next();
}));
const need = k => (req, res, next) => (req.fsr[k] ? next() : bad(res, 403, WHY[k]));
const who = req => req.fsr.user?.name || req.fsr.user?.username || 'unknown';

// ── active version, cached in memory per process ─────────────────────────────
let cur = null;   // { id, version, ix }
async function active() {
  const idx = await store.read('index', { activeId: null, versions: [] });
  if (!idx.activeId) return null;
  if (cur?.id === idx.activeId) return cur;
  const version = await store.read(`version_${idx.activeId}`, null);
  if (!version) return null;
  cur = { id: idx.activeId, version, ix: M.index(version), recon: new Map() };
  return cur;
}
async function ctxFor(req) {
  const a = await active();
  if (!a) return null;
  const mode = req.query.mode === 'latest' ? 'latest' : 'original';
  const dec = await store.read('decisions', { items: {} });
  const adj = await store.read('adjustments', { items: [] });
  const decisions = Object.fromEntries(Object.entries(dec.items).map(([k, d]) => [k, d.factKey]));
  return { a, ctx: M.makeCtx(a.version, { ix: a.ix, mode, decisions, adjustments: adj.items, withAdj: req.query.adj === '1' }), mode };
}
const noData = res => bad(res, 404, 'No financial statements have been imported yet. Use Data Validation & Reconciliation → Import workbooks.', { code: 'NO_IMPORT' });
const basisOf = req => (req.query.basis === 'CO' ? 'CO' : 'SA');
const inputsNow = () => store.read('inputs', IN.emptyStore());

// ── import: stage → commit → (rollback) ──────────────────────────────────────
function summariseExtraction(x) {
  return { name: x.file.name, sha256: x.file.sha256, size: x.file.size, basis: x.basis, reportingDate: x.reportingDate,
    statements: x.statements.map(s => ({ sheet: s.sheet, type: s.type, hidden: s.hidden, periods: s.periods.map(p => `${p.period} (${p.role})`), rows: s.rows.length })),
    notes: x.notes.length, issues: [...x.issues, ...x.statements.flatMap(s => s.issues)].reduce((m, i) => { m[i.sev] = (m[i.sev] || 0) + 1; return m; }, {}) };
}
async function stage(buf, meta, user) {
  const x = X.extractWorkbook(buf, meta);
  const blocking = x.issues.filter(i => i.sev === 'error' && i.code === 'BASIS_CONFLICT');
  if (!x.statements.length) throw Object.assign(new Error(`"${meta.name}" contains no recognisable financial statement (no results, balance sheet, cash flow or statement of profit and loss title).`), { status: 400 });
  if (blocking.length) throw Object.assign(new Error(blocking[0].msg), { status: 400 });
  await store.write(`staged_${x.file.sha256.slice(0, 24)}`, x);
  await store.update('staging', { files: [] }, s => {
    s.files = s.files.filter(f => f.sha256 !== x.file.sha256 && !(f.name === x.file.name && f.basis === x.basis && f.reportingDate === x.reportingDate));
    s.files.push({ ...summariseExtraction(x), stagedAt: new Date().toISOString(), stagedBy: user });
  });
  return summariseExtraction(x);
}

router.get('/status', wrap(async (req, res) => {
  const idx = await store.read('index', { activeId: null, versions: [] });
  const staging = await store.read('staging', { files: [] });
  const a = await active();
  res.json({
    rights: { import: req.fsr.import, adjust: req.fsr.adjust, inputs: req.fsr.inputs, admin: req.fsr.admin },
    active: a ? { id: a.id, builtAt: a.version.builtAt, builtBy: a.version.builtBy, files: a.version.files, counts: a.version.counts, statements: a.version.statements.map(s => ({ f: s.f, sheet: s.sheet, type: s.type, basis: s.basis, hidden: s.hidden, periods: s.periods, unit: s.unit, unitInferred: s.unitInferred, title: s.title.slice(0, 160) })) } : null,
    versions: idx.versions, staging: staging.files, folderImport: !IS_VERCEL, folder: IS_VERCEL ? null : DEFAULT_FOLDER,
  });
}));

router.post('/import/upload', need('import'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return bad(res, 400, 'No file was received.');
  if (!/\.xlsx?$/i.test(req.file.originalname)) return bad(res, 400, 'Only Excel workbooks (.xlsx) can be imported.');
  try { res.json({ staged: await stage(req.file.buffer, { name: req.file.originalname }, who(req)) }); }
  catch (e) { bad(res, e.status || 500, e.message); }
}));

router.post('/import/folder', need('import'), wrap(async (req, res) => {
  if (IS_VERCEL) return bad(res, 400, 'Online, upload the workbooks one at a time (the server has no access to the office PC folder).');
  const dir = DEFAULT_FOLDER;
  if (!fs.existsSync(dir)) return bad(res, 404, `Folder not found: ${dir}`);
  const files = fs.readdirSync(dir).filter(f => /\.xlsx$/i.test(f) && !f.startsWith('~$'));
  const out = [], errors = [];
  for (const f of files) {
    try { const full = path.join(dir, f); out.push(await stage(fs.readFileSync(full), { name: f, mtime: fs.statSync(full).mtime.toISOString() }, who(req))); }
    catch (e) { errors.push(`${f}: ${e.message}`); }
  }
  res.json({ staged: out, errors, folder: dir });
}));

router.delete('/import/staging/:sha', need('import'), wrap(async (req, res) => {
  await store.update('staging', { files: [] }, s => { s.files = s.files.filter(f => f.sha256 !== req.params.sha); });
  await store.remove(`staged_${String(req.params.sha).replace(/[^a-f0-9]/g, '').slice(0, 24)}`);
  res.json({ ok: true });
}));

router.post('/import/commit', need('import'), wrap(async (req, res) => {
  const staging = await store.read('staging', { files: [] });
  if (!staging.files.length) return bad(res, 400, 'Nothing is staged. Import the workbooks first.');
  const idx = await store.read('index', { activeId: null, versions: [] });
  const shas = staging.files.map(f => f.sha256).sort();
  const same = idx.versions.find(v => v.status !== 'discarded' && JSON.stringify([...(v.files || []).map(f => f.sha256)].sort()) === JSON.stringify(shas));
  if (same && same.id === idx.activeId) return res.json({ unchanged: true, id: same.id, message: 'These exact workbooks are already the active import — nothing was duplicated.' });
  if (same) {   // the same files as an older version: re-activate it instead of storing a copy
    await store.update('index', { activeId: null, versions: [] }, i => { i.activeId = same.id; i.versions.forEach(v => { v.status = v.id === same.id ? 'active' : v.status === 'active' ? 'superseded' : v.status; }); });
    await store.audit({ action: 'reactivate', id: same.id, by: who(req) });
    cur = null;
    return res.json({ reactivated: true, id: same.id });
  }
  const xs = [];
  for (const f of staging.files) { const x = await store.read(`staged_${f.sha256.slice(0, 24)}`, null); if (x) xs.push(x); }
  const version = B.build(xs, { user: who(req) });
  const id = `v${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${crypto.randomBytes(2).toString('hex')}`;
  version.id = id;
  const legacy = await legacyRead().catch(() => null);
  const recon = RC.reconcile(version, { legacy, thresholds: (await inputsNow()).settings?.thresholds });
  version.reconSummary = recon.summary;
  await store.write(`version_${id}`, version);
  await store.update('index', { activeId: null, versions: [] }, i => {
    i.versions.forEach(v => { if (v.status === 'active') v.status = 'superseded'; });
    i.versions.unshift({ id, builtAt: version.builtAt, builtBy: version.builtBy, status: 'active', files: version.files.map(f => ({ name: f.name, sha256: f.sha256, basis: f.basis, reportingDate: f.reportingDate })), counts: version.counts, recon: recon.summary, decisions: recon.decisions.length });
    i.activeId = id;
    // keep the 8 most recent versions; older ones are deleted
    for (const old of i.versions.slice(8)) store.remove(`version_${old.id}`).catch(() => {});
    i.versions = i.versions.slice(0, 8);
  });
  await store.audit({ action: 'import', id, by: who(req), files: version.files.map(f => f.name), counts: version.counts, recon: recon.summary });
  cur = null;
  res.json({ id, counts: version.counts, recon: recon.summary, decisions: recon.decisions.length });
}));

router.post('/import/rollback', need('import'), wrap(async (req, res) => {
  const { versionId } = req.body || {};
  const idx = await store.read('index', { activeId: null, versions: [] });
  const v = idx.versions.find(x => x.id === versionId);
  if (!v) return bad(res, 404, 'That version is not available.');
  if (!(await store.read(`version_${versionId}`, null))) return bad(res, 404, 'That version\'s data is no longer stored.');
  await store.update('index', { activeId: null, versions: [] }, i => { i.activeId = versionId; i.versions.forEach(x => { x.status = x.id === versionId ? 'active' : x.status === 'active' ? 'rolled back' : x.status; }); });
  await store.audit({ action: 'rollback', to: versionId, from: idx.activeId, by: who(req), reason: (req.body.reason || '').slice(0, 500) });
  cur = null;
  res.json({ ok: true, activeId: versionId });
}));

// ── statements, notes ────────────────────────────────────────────────────────
router.get('/periods', wrap(async (req, res) => {
  const c = await ctxFor(req); if (!c) return noData(res);
  const b = basisOf(req);
  const out = {};
  for (const st of ['PL', 'BS', 'CF', 'RT']) out[st] = { available: M.periodsFor(c.ctx.ix, b, st), defaults: M.defaultColumns(c.a.version, b, st === 'RT' ? 'PL' : st) };
  res.json(out);
}));

router.get('/statement', wrap(async (req, res) => {
  const c = await ctxFor(req); if (!c) return noData(res);
  const b = basisOf(req);
  const stmt = ['PL', 'BS', 'CF', 'RT'].includes(req.query.stmt) ? req.query.stmt : 'PL';
  const periods = String(req.query.periods || '').split(',').filter(p => P.fromId(p));
  const cols = periods.length ? periods : M.defaultColumns(c.a.version, b, stmt === 'RT' ? 'PL' : stmt);
  const view = M.statementView(c.ctx, b, stmt, cols);
  view.files = c.a.version.files.map(f => ({ f: f.f, name: f.name, reportingDate: f.reportingDate }));
  view.mode = c.mode; view.versionId = c.a.id;
  if (stmt === 'RT') view.ratioDefs = Object.fromEntries(Object.entries(c.a.version.ratioDefs || {}).filter(([k]) => k.startsWith(`${b}|`)).map(([k, d]) => [k.split('|')[1], d.definition]));
  res.json(view);
}));

router.get('/notes', wrap(async (req, res) => {
  const c = await ctxFor(req); if (!c) return noData(res);
  const b = basisOf(req);
  let periods = String(req.query.periods || '').split(',').filter(p => P.fromId(p));
  if (!periods.length) periods = [...new Set([...M.defaultColumns(c.a.version, b, 'BS'), ...M.defaultColumns(c.a.version, b, 'CF')])];
  const view = V.notesView(c.ctx, b, periods);
  view.files = c.a.version.files.map(f => ({ f: f.f, name: f.name }));
  res.json(view);
}));

// ── reconciliation, decisions, adjustments ───────────────────────────────────
async function reconFor(c) {
  const inputs = await inputsNow();
  const key = `${c.mode}|${JSON.stringify(c.ctx.decisions)}|${JSON.stringify(inputs.settings?.thresholds || {})}`;
  if (c.a.recon.has(key)) return c.a.recon.get(key);
  const legacy = await legacyRead().catch(() => null);
  const r = RC.reconcile(c.a.version, { ctx: c.ctx, legacy, thresholds: inputs.settings?.thresholds, mode: c.mode });
  c.a.recon.clear(); c.a.recon.set(key, r);
  return r;
}
router.get('/recon', wrap(async (req, res) => {
  const c = await ctxFor(req); if (!c) return noData(res);
  const r = await reconFor(c);
  const dec = await store.read('decisions', { items: {} });
  res.json({ ...r, recorded: dec.items, files: c.a.version.files.map(f => ({ f: f.f, name: f.name })), versionId: c.a.id });
}));

router.post('/decisions', need('adjust'), wrap(async (req, res) => {
  const { key, factKey, reason, mode } = req.body || {};
  if (!key || !factKey || !String(reason || '').trim()) return bad(res, 400, 'A decision needs the figure, the chosen source and a reason.');
  const a = await active(); if (!a) return noData(res);
  const cands = a.ix.by.get(key) || [];
  if (!cands.some(fc => M.factKey(fc) === factKey)) return bad(res, 400, 'The chosen source figure is not one of the competing figures.');
  const m = mode === 'latest' ? 'latest' : 'original';
  await store.update('decisions', { items: {} }, d => { d.items[`${key}|${m}`] = { factKey, reason: String(reason).slice(0, 1000), by: who(req), at: new Date().toISOString(), versionId: a.id }; });
  await store.audit({ action: 'decision', key, mode: m, factKey, reason, by: who(req) });
  a.recon.clear();
  res.json({ ok: true });
}));
router.delete('/decisions/:key', need('adjust'), wrap(async (req, res) => {
  await store.update('decisions', { items: {} }, d => { delete d.items[req.params.key]; });
  await store.audit({ action: 'decision-removed', key: req.params.key, by: who(req) });
  if (cur) cur.recon.clear();
  res.json({ ok: true });
}));

router.get('/adjustments', wrap(async (req, res) => res.json(await store.read('adjustments', { items: [] }))));
router.post('/adjustments', need('adjust'), wrap(async (req, res) => {
  const { basis, line, period, amount, reason, evidence } = req.body || {};
  if (!L.BY_ID[line] || !P.fromId(period) || !Number.isFinite(Number(amount)) || !String(reason || '').trim() || !String(evidence || '').trim())
    return bad(res, 400, 'An adjustment needs a statement line, a period, an amount (₹ lakh), a reason and the supporting evidence.');
  const item = { id: crypto.randomBytes(6).toString('hex'), b: basis === 'CO' ? 'CO' : 'SA', l: line, p: period, amount: Number(amount), reason: String(reason).slice(0, 1000), evidence: String(evidence).slice(0, 1000), by: who(req), at: new Date().toISOString(), status: 'active' };
  await store.update('adjustments', { items: [] }, a => { a.items.push(item); });
  await store.audit({ action: 'adjustment', item, by: who(req) });
  res.json({ ok: true, item });
}));
router.post('/adjustments/:id/reverse', need('adjust'), wrap(async (req, res) => {
  await store.update('adjustments', { items: [] }, a => { const it = a.items.find(x => x.id === req.params.id); if (it) { it.status = 'reversed'; it.reversedBy = who(req); it.reversedAt = new Date().toISOString(); it.reversalReason = String(req.body?.reason || '').slice(0, 500); } });
  await store.audit({ action: 'adjustment-reversed', id: req.params.id, by: who(req) });
  res.json({ ok: true });
}));
router.get('/audit', wrap(async (req, res) => res.json((await store.read('audit', { entries: [] })).entries.slice(-300).reverse())));

// ── comparisons, ratios, CFO ─────────────────────────────────────────────────
router.get('/compare', wrap(async (req, res) => {
  const c = await ctxFor(req); if (!c) return noData(res);
  const b = basisOf(req);
  if (!P.fromId(req.query.cur) || !P.fromId(req.query.cmp)) return bad(res, 400, 'Choose a current and a comparator period.');
  res.json({ ...C.compare(c.ctx, b, req.query.cur, req.query.cmp), mode: c.mode });
}));
router.get('/compare/presets', wrap(async (req, res) => {
  const c = await ctxFor(req); if (!c) return noData(res);
  res.json(C.presets(c.ctx, basisOf(req)));
}));
router.get('/compare/three-year', wrap(async (req, res) => {
  const c = await ctxFor(req); if (!c) return noData(res);
  res.json(C.threeYear(c.ctx, basisOf(req), { quarter: +req.query.quarter || 1, half: +req.query.half || 1 }));
}));

router.get('/ratios', wrap(async (req, res) => {
  const c = await ctxFor(req); if (!c) return noData(res);
  const b = basisOf(req);
  const periods = String(req.query.periods || req.query.period || '').split(',').filter(p => P.fromId(p));
  if (!periods.length) return bad(res, 400, 'Choose at least one period.');
  const inputs = await ratioInputs();
  res.json({ dictionary: RA.dictionary(), results: periods.map(p => RA.compute(c.ctx, b, p, inputs)), mode: c.mode });
}));
router.get('/ratios/dictionary', wrap(async (req, res) => res.json(RA.dictionary())));

router.get('/cfo', wrap(async (req, res) => {
  const c = await ctxFor(req); if (!c) return noData(res);
  const b = basisOf(req);
  let p = req.query.period;
  if (!P.fromId(p)) p = M.periodsFor(c.ctx.ix, b, 'PL').filter(x => x.type === 'Q' && x.availability === 'reported').sort(P.cmp).pop()?.id;
  const r = await reconFor(c);
  const inputs = await ratioInputs();
  res.json({ ...V.cfo(c.ctx, b, p, inputs, { dataQuality: { summary: r.summary, decisions: r.decisions.length } }), coverage: IN.coverage(await inputsNow(), await planningCounts()), mode: c.mode });
}));

// ── management inputs ────────────────────────────────────────────────────────
router.get('/inputs', wrap(async (req, res) => {
  const s = await inputsNow();
  res.json({ ...s, types: Object.fromEntries(Object.entries(IN.TYPES).map(([k, t]) => [k, { label: t.label, unit: t.unit, help: t.help, fields: t.fields.map(([key, label, kind, req2]) => ({ key, label, type: kind.t, required: !!req2 })), moved: IN.MOVED[k] || null }])), coverage: IN.coverage(s, await planningCounts()), requiredBy: IN.REQUIRED_BY });
}));
router.post('/inputs/record', need('inputs'), wrap(async (req, res) => {
  const { type } = req.body || {};
  if (!IN.TYPES[type]) return bad(res, 400, 'Unknown input type.');
  const rec = IN.normalise(type, req.body, who(req));
  const errs = IN.validate(type, rec);
  if (errs.length) return bad(res, 400, errs.join('; '));
  await store.update('inputs', IN.emptyStore(), s => { s.records = s.records.filter(r => r.id !== rec.id); s.records.push(rec); });
  await store.audit({ action: 'input', type, id: rec.id, by: who(req) });
  res.json({ ok: true, record: rec });
}));
router.delete('/inputs/record/:id', need('inputs'), wrap(async (req, res) => {
  await store.update('inputs', IN.emptyStore(), s => { s.records = s.records.filter(r => r.id !== req.params.id); });
  await store.audit({ action: 'input-deleted', id: req.params.id, by: who(req) });
  res.json({ ok: true });
}));
router.put('/inputs/settings', need('inputs'), wrap(async (req, res) => {
  const { thresholds, alerts, gstOnReceivables } = req.body || {};
  const numOrNull = v => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  await store.update('inputs', IN.emptyStore(), s => {
    s.settings = s.settings || {};
    if (thresholds) s.settings.thresholds = Object.fromEntries(Object.entries(thresholds).map(([k, v]) => [k, numOrNull(v)]).filter(([, v]) => v != null));
    if (alerts) s.settings.alerts = Object.fromEntries(Object.entries(alerts).map(([k, v]) => [k, { min: numOrNull(v?.min), max: numOrNull(v?.max) }]).filter(([, v]) => v.min != null || v.max != null));
    if (gstOnReceivables !== undefined) s.settings.gstOnReceivables = numOrNull(gstOnReceivables);
    s.settings.updatedBy = who(req); s.settings.updatedAt = new Date().toISOString();
  });
  await store.audit({ action: 'settings', by: who(req), thresholds, alerts, gstOnReceivables });
  if (cur) cur.recon.clear();
  res.json({ ok: true });
}));
router.get('/inputs/template/:type', wrap(async (req, res) => {
  if (!IN.TYPES[req.params.type]) return bad(res, 404, 'Unknown input type.');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}_template.xlsx"`);
  res.send(IN.template(req.params.type));
}));
router.post('/inputs/upload/:type', need('inputs'), upload.single('file'), wrap(async (req, res) => {
  const type = req.params.type;
  if (!IN.TYPES[type]) return bad(res, 404, 'Unknown input type.');
  if (!req.file) return bad(res, 400, 'No file was received.');
  const { records, errors } = IN.parseUpload(type, req.file.buffer, who(req));
  if (errors.length && req.query.partial !== '1') return bad(res, 400, `Nothing was saved — fix these rows and upload again: ${errors.slice(0, 15).join(' | ')}${errors.length > 15 ? ` (+${errors.length - 15} more)` : ''}`, { errors });
  await store.update('inputs', IN.emptyStore(), s => { s.records.push(...records); });
  await store.audit({ action: 'input-upload', type, rows: records.length, by: who(req), file: req.file.originalname });
  res.json({ ok: true, saved: records.length, errors });
}));

// ── exports (Excel; the page builds the PDF from the same data) ───────────────
router.get('/export', wrap(async (req, res) => {
  const c = await ctxFor(req); if (!c) return noData(res);
  const b = basisOf(req);
  const what = req.query.what;
  const fmtUnit = u => ({ lakh: '₹ lakh', inr: '₹', times: 'times', fraction: '%', days: 'days', nos: 'nos' })[u] || u || '';
  const meta = extra => EX.contextMeta({ basis: b, mode: c.mode, version: { id: c.a.id, builtAt: c.a.version.builtAt, builtBy: c.a.version.builtBy, files: c.a.version.files }, ...extra });
  const file = (n, buf) => { res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="${n}.xlsx"`); res.send(buf); };
  const srcRef = cl => (cl?.src ? `${c.a.version.files[cl.src.f]?.name} › ${cl.src.sh}!${cl.src.c}` : cl?.derived ? `derived: ${cl.derived.formula}` : '');
  if (what === 'statement') {
    const stmt = ['PL', 'BS', 'CF', 'RT'].includes(req.query.stmt) ? req.query.stmt : 'PL';
    const periods = String(req.query.periods || '').split(',').filter(p => P.fromId(p));
    const cols = periods.length ? periods : M.defaultColumns(c.a.version, b, stmt);
    const v = M.statementView(c.ctx, b, stmt, cols);
    const name = { PL: 'Statement of profit and loss', BS: 'Balance sheet', CF: 'Cash flow statement', RT: 'Ratios disclosed in results' }[stmt];
    return file(`${name.replace(/ /g, '_')}_${b}`, EX.workbook([{ name, title: `${name} (${b === 'CO' ? 'consolidated' : 'standalone'})`, meta: meta({ periods: v.periods.map(p => p.label).join('; ') }),
      columns: [{ label: 'Particulars', get: r => `${'  '.repeat(r.indent || 0)}${r.label}`, width: 60 }, { label: 'Unit', get: r => fmtUnit(r.unit) }, ...cols.flatMap(p => [{ label: P.fromId(p).label, get: r => r.cells[p]?.v ?? (r.cells[p]?.st === 'error' ? r.cells[p]?.src?.err : r.cells[p]?.st === 'missing' ? 'Not available' : '') , width: 22 }, { label: `Source — ${P.fromId(p).short}`, get: r => srcRef(r.cells[p]), width: 50 }])],
      rows: v.rows }]));
  }
  if (what === 'recon') {
    const r = await reconFor(c);
    return file('Data_validation_and_reconciliation', EX.workbook([{ name: 'Reconciliation', title: 'Data validation & reconciliation', meta: meta({ periods: 'all imported', filters: req.query.filters || '—' }),
      columns: [{ label: 'Reporting basis', get: x => (x.b === 'CO' ? 'Consolidated' : 'Standalone') }, { label: 'Period', get: x => P.fromId(x.p)?.label || x.p }, { label: 'Statement', key: 'stmt' }, { label: 'Check', key: 'check' }, { label: 'Particulars', key: 'particulars', width: 70 },
        { label: 'Source figure', key: 'source' }, { label: 'Module figure', key: 'module' }, { label: 'Difference', key: 'diff' }, { label: 'Source reference', key: 'ref', width: 70 }, { label: 'Status', key: 'status' }, { label: 'Explanation', key: 'expl', width: 90 }], rows: r.rows },
    { name: 'Decision requests', title: 'Material differences between sources — decisions required', meta: meta({}), columns: [{ label: 'Figure', get: d => `${d.label} — ${P.fromId(d.p)?.label} (${d.b})` , width: 60 }, ...[0, 1, 2].map(i => ({ label: `Option ${i + 1}`, get: d => (d.options[i] ? `${d.options[i].v} — ${d.options[i].ref}` : ''), width: 70 }))], rows: r.decisions }]));
  }
  if (what === 'ratios') {
    const periods = String(req.query.periods || '').split(',').filter(p => P.fromId(p));
    const inputs = await ratioInputs();
    const results = periods.map(p => RA.compute(c.ctx, b, p, inputs));
    const dict = RA.dictionary();
    return file(`Ratios_${b}`, EX.workbook([{ name: 'Ratios', title: 'Ratio analytics', meta: meta({ periods: periods.map(p => P.fromId(p).label).join('; ') }),
      columns: [{ label: 'Category', key: 'cat' }, { label: 'Metric', key: 'name', width: 44 }, { label: 'Unit', get: d => fmtUnit(d.unit) }, ...results.flatMap(rr => [{ label: rr.period.short, get: d => rr.values[d.id]?.v ?? '' }, { label: `${rr.period.short} status`, get: d => `${rr.values[d.id]?.status || ''}${rr.values[d.id]?.note ? ` — ${rr.values[d.id].note}` : ''}`, width: 50 }])], rows: dict },
    { name: 'Formula dictionary', title: 'Formula dictionary', meta: meta({}), columns: [{ label: 'Metric', key: 'name', width: 40 }, { label: 'Definition', key: 'definition', width: 80 }, { label: 'Formula', key: 'formula', width: 60 }, { label: 'Inputs', get: d => d.inputs.join(', '), width: 50 }, { label: 'Source', key: 'source' }, { label: 'Period basis', key: 'basis' }, { label: 'Annualisation', key: 'annual' }, { label: 'Status', key: 'status' }], rows: dict }]));
  }
  if (what === 'compare') {
    const cmp = C.compare(c.ctx, b, req.query.cur, req.query.cmp);
    return file(`Comparison_${req.query.cur}_vs_${req.query.cmp}_${b}`, EX.workbook([{ name: 'Comparison', title: `${cmp.current.label} vs ${cmp.comparator.label}`, meta: meta({ periods: `${cmp.current.label} vs ${cmp.comparator.label}` }),
      columns: [{ label: 'Particulars', key: 'label', width: 50 }, { label: 'Current', key: 'cur' }, { label: 'Comparator', key: 'cmp' }, { label: 'Absolute change', key: 'abs' }, { label: 'Change %', get: r => (r.pct != null ? r.pct : r.pctNote || '') }, { label: 'Common-size % (current)', key: 'csCur' }, { label: 'Common-size % (comparator)', key: 'csCmp' }, { label: 'Margin movement (pp)', key: 'pp' }, { label: 'Margin movement (bps)', key: 'bps' }, { label: 'Interpretation', key: 'interpretation', width: 80 }], rows: cmp.rows }]));
  }
  bad(res, 400, 'Unknown export.');
}));

// ══ Planning: budget, client end dates, rent end dates, branch master, debt schedule, forecasts ═════════════════
// Amounts are kept in rupees; budget and forecast views are returned in ₹ lakh like the statements.
const SRC = require('./lib/sources');
const BU = require('./lib/budget');
const DB = require('./lib/debt');
const BR = require('./lib/branches');
const FC = require('./lib/forecast');
const L_ = v => (v == null ? v : v / 1e5);
const docBudget = () => store.read('budget', { versions: [], manual: [], overrides: {} });
const docOf = (k, def) => store.read(k, def);
/**
 * Management inputs plus what the planning documents supply to the ratios (₹ lakh): the debt schedule (scheduled
 * principal), covenant tests (lender-defined DSCR), and the branch master (seats and super built-up area from the
 * branch's revenue start date, for branches without their own capacity rows). Entries on the Management Inputs tab win.
 */
/** How much of each input the planning sections hold (for the coverage lists) */
async function planningCounts() {
  const [b, debt, br] = await Promise.all([docBudget(), docOf('debt', DB.empty()), docOf('branches', { items: [] })]);
  const forecast = b.versions.length ? 1 : 0;   // the forecast is computed from Zoho and the budget
  return { budget: b.versions.length, branch_opening: (br.items || []).filter(x => x.revenueStart || x.expenseStart).length, collection_forecast: forecast, payment_forecast: forecast, debt_schedule: debt.schedule.length, covenant: debt.covenants.length };
}
async function ratioInputs() {
  const [inputs, debt, br] = await Promise.all([inputsNow(), docOf('debt', DB.empty()), docOf('branches', { items: [] })]);
  let recs = [...(inputs.records || [])];
  if (debt.schedule.length) {
    const fac = new Map(debt.facilities.map(x => [x.id, x]));
    recs = recs.filter(r => r.type !== 'debt_schedule').concat(debt.schedule.filter(r => fac.has(r.facilityId)).map(r => ({ type: 'debt_schedule', basis: fac.get(r.facilityId).basis || 'SA', periodEnd: r.dueDate,
      values: { lender: fac.get(r.facilityId).lender, facility: fac.get(r.facilityId).facilityName, principal: L_(r.principal), interest: L_(r.interest) }, source: 'Debt & covenants' })));
  }
  for (const c of debt.covenants) {
    const label = c.facilityId === 'ALL' ? 'All facilities' : debt.facilities.find(x => x.id === c.facilityId)?.facilityName || c.facilityLabel || '';
    const tests = debt.tests.filter(t => t.covenantId === c.id);
    for (const t of tests.length ? tests : [null]) recs.push({ type: 'covenant', basis: c.basis, values: { facility: label, metric: c.metric, definition: c.definition, operator: c.operator, threshold: c.threshold, periodEnd: t?.periodEnd || null, testedValue: t ? t.value : null }, source: 'Debt & covenants' });
  }
  const own = new Set(recs.filter(r => r.type === 'branch_capacity').map(r => SRC.normName(r.branch)));
  for (const b of br.items || []) {
    const from = b.revenueStart || b.expenseStart;
    if (!from || !b.seats || own.has(SRC.normName(b.name)) || /closed/i.test(b.status || '')) continue;
    recs.push({ type: 'branch_capacity', branch: b.name, effectiveDate: from, values: { capacitySeats: b.seats, areaSqft: b.superBuiltUp || null }, source: 'Branch master' });
  }
  return { ...inputs, records: recs };
}
const xlsxOut = (res, name, buf) => { res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', `attachment; filename="${name}"`); res.send(buf); };

async function planningDocs(versionId) {
  const [b, contracts, rent, debt] = await Promise.all([docBudget(), docOf('client_contracts', { items: [] }), docOf('rent_overrides', { items: [] }), docOf('debt', DB.empty())]);
  const debtM = DB.monthly(debt);
  return { contracts: contracts.items, rentOverrides: rent.items, manual: b.manual, overrides: b.overrides[versionId] || {}, debtInterest: Object.keys(debtM.interest).length ? debtM.interest : null };
}
async function gridFor(versionId, { live } = {}) {
  const b = await docBudget();
  const v = b.versions.find(x => x.id === versionId) || (versionId ? null : b.versions[0]);
  if (!v) return null;
  if (v.frozen && !live) return { ...v.frozen.grid, version: { id: v.id, name: v.name, frozen: true, frozenAt: v.frozen.at, frozenBy: v.frozen.by } };
  return BU.compute(v, await planningDocs(v.id));
}
const toLakhGrid = g => ({ ...g, rows: g.rows.map(r => ({ ...r, values: Object.fromEntries(Object.entries(r.values).map(([m, x]) => [m, L_(x)])), total: L_(r.total),
  meta: { ...r.meta, runRate: L_(r.meta?.runRate), hist: r.meta?.hist?.map(L_), monthly: L_(r.meta?.monthly), lastModule: r.meta?.lastModule ? { ...r.meta.lastModule, amount: L_(r.meta.lastModule.amount) } : undefined },
  overridden: r.overridden ? Object.fromEntries(Object.entries(r.overridden).map(([m, o]) => [m, { ...o, was: L_(o.was) }])) : undefined })),
  totals: Object.fromEntries(Object.entries(g.totals).map(([m, t]) => [m, Object.fromEntries(Object.entries(t).map(([k, x]) => [k, L_(x)]))])), unit: 'lakh' });

// ── budget versions ──────────────────────────────────────────────────────────
router.get('/budget/versions', wrap(async (req, res) => {
  const b = await docBudget();
  res.json({ versions: b.versions.map(v => ({ id: v.id, name: v.name, settings: v.settings, createdBy: v.createdBy, createdAt: v.createdAt, frozen: v.frozen ? { at: v.frozen.at, by: v.frozen.by } : null })), defaults: BU.DEFAULT_SETTINGS(), methods: BU.METHODS });
}));
router.post('/budget/versions', need('inputs'), wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return bad(res, 400, 'Give the budget version a name.');
  const v = { id: `b${Date.now().toString(36)}`, name, settings: { ...BU.DEFAULT_SETTINGS(), ...(req.body.settings || {}) }, createdBy: who(req), createdAt: new Date().toISOString(), frozen: null };
  await store.update('budget', { versions: [], manual: [], overrides: {} }, b => {
    const from = req.body.copyFrom && b.versions.find(x => x.id === req.body.copyFrom);
    if (from) { v.settings = { ...from.settings, ...(req.body.settings || {}) }; b.overrides[v.id] = { ...(b.overrides[from.id] || {}) }; b.manual.push(...b.manual.filter(l => l.versionId === from.id).map(l => ({ ...l, id: DB.id(), versionId: v.id }))); }
    b.versions.unshift(v);
  });
  await store.audit({ action: 'budget-version', id: v.id, name, by: who(req) });
  res.json({ ok: true, version: v });
}));
router.put('/budget/versions/:id', need('inputs'), wrap(async (req, res) => {
  let err = null;
  await store.update('budget', { versions: [], manual: [], overrides: {} }, b => {
    const v = b.versions.find(x => x.id === req.params.id);
    if (!v) { err = 'Version not found.'; return; }
    if (v.frozen) { err = 'This version is frozen — unfreeze it first.'; return; }
    if (req.body.name) v.name = String(req.body.name).trim();
    if (req.body.settings) v.settings = { ...v.settings, ...req.body.settings };
  });
  if (err) return bad(res, 400, err);
  res.json({ ok: true });
}));
router.delete('/budget/versions/:id', need('inputs'), wrap(async (req, res) => {
  await store.update('budget', { versions: [], manual: [], overrides: {} }, b => { b.versions = b.versions.filter(x => x.id !== req.params.id); delete b.overrides[req.params.id]; b.manual = b.manual.filter(l => l.versionId !== req.params.id); });
  await store.audit({ action: 'budget-version-deleted', id: req.params.id, by: who(req) });
  res.json({ ok: true });
}));
router.post('/budget/versions/:id/freeze', need('inputs'), wrap(async (req, res) => {
  const b = await docBudget();
  const v = b.versions.find(x => x.id === req.params.id);
  if (!v) return bad(res, 404, 'Version not found.');
  const grid = req.body?.unfreeze ? null : await BU.compute(v, await planningDocs(v.id));
  await store.update('budget', { versions: [], manual: [], overrides: {} }, d => { const x = d.versions.find(y => y.id === v.id); x.frozen = grid ? { at: new Date().toISOString(), by: who(req), grid } : null; });
  await store.audit({ action: grid ? 'budget-frozen' : 'budget-unfrozen', id: v.id, by: who(req) });
  res.json({ ok: true });
}));
router.get('/budget/compute', wrap(async (req, res) => {
  const g = await gridFor(req.query.version, { live: req.query.live === '1' });
  if (!g) return bad(res, 404, 'Create a budget version first.', { code: 'NO_BUDGET' });
  // Zoho billing (the budget's revenue basis) against published revenue for the latest reported periods
  const revenueCheck = [];
  const c = await ctxFor(req);
  if (c) {
    // the invoice caches hold the whole current financial year; earlier periods would be incomplete
    const lm = SRC.lastCompleteMonth();
    const fyStart = `${+lm.slice(5) >= 4 ? lm.slice(0, 4) : +lm.slice(0, 4) - 1}-04-01`;
    const inv = await SRC.invoices();
    const pers = M.periodsFor(c.ctx.ix, 'SA', 'PL').filter(p => p.availability === 'reported' && ['Q', 'H'].includes(p.type) && p.start >= fyStart).sort(P.cmp);
    for (const p of pers) {
      const billing = inv.invoices.filter(i => i.date >= p.start && i.date <= p.end).reduce((s, i) => s + i.sub, 0);
      revenueCheck.push({ period: p.label, short: p.short, billing: L_(billing), published: M.num(M.cell(c.ctx, 'SA', 'pl.rev', p.id)) });
    }
  }
  res.json({ ...toLakhGrid(g), revenueCheck });
}));
router.post('/budget/override', need('inputs'), wrap(async (req, res) => {
  const { versionId, rowId, month, value, note } = req.body || {};
  if (!versionId || !rowId || !/^\d{4}-\d{2}$/.test(month || '')) return bad(res, 400, 'Version, row and month are required.');
  const b = await docBudget();
  if (b.versions.find(x => x.id === versionId)?.frozen) return bad(res, 400, 'This version is frozen — unfreeze it first.');
  await store.update('budget', { versions: [], manual: [], overrides: {} }, d => {
    d.overrides[versionId] = d.overrides[versionId] || {};
    const k = `${rowId}|${month}`;
    if (value === null || value === '') delete d.overrides[versionId][k];
    else d.overrides[versionId][k] = { v: Number(value), by: who(req), at: new Date().toISOString(), note: String(note || '').slice(0, 300) };
  });
  res.json({ ok: true });
}));
router.post('/budget/manual', need('inputs'), wrap(async (req, res) => {
  const l = req.body || {};
  if (!String(l.label || '').trim() || !Number.isFinite(Number(l.monthly)) || !/^\d{4}-\d{2}$/.test(l.from || '')) return bad(res, 400, 'A manual line needs a description, a start month and a monthly amount (₹).');
  const item = { id: l.id || DB.id(), versionId: l.versionId || null, section: ['revenue', 'other_income'].includes(l.section) ? l.section : 'expense', head: l.head || null, label: String(l.label).trim(), branch: l.branch || '', from: l.from, to: /^\d{4}-\d{2}$/.test(l.to || '') ? l.to : null,
    monthly: Number(l.monthly), growthPct: Number(l.growthPct) || 0, note: String(l.note || '').slice(0, 300), by: who(req), at: new Date().toISOString() };
  await store.update('budget', { versions: [], manual: [], overrides: {} }, d => { d.manual = d.manual.filter(x => x.id !== item.id); d.manual.push(item); });
  res.json({ ok: true, item });
}));
router.delete('/budget/manual/:id', need('inputs'), wrap(async (req, res) => {
  await store.update('budget', { versions: [], manual: [], overrides: {} }, d => { d.manual = d.manual.filter(x => x.id !== req.params.id); });
  res.json({ ok: true });
}));
router.get('/budget/export', wrap(async (req, res) => {
  const g = await gridFor(req.query.version, { live: req.query.live === '1' });
  if (!g) return bad(res, 404, 'No budget version.');
  const lg = toLakhGrid(g);
  const sec = { revenue: 'Revenue', other_income: 'Other income', rent: 'Rent', expense: 'Expenses' };
  const rows = [...lg.rows.map(r => ({ ...r, sectionName: sec[r.section] })), ...['revenue', 'otherIncome', 'rent', 'expenses', 'ebitda'].map(k => ({ sectionName: 'Total', label: { revenue: 'Total revenue', otherIncome: 'Total other income', rent: 'Total rent', expenses: 'Total other expenses', ebitda: 'EBITDA (budget)' }[k], values: Object.fromEntries(lg.months.map(m => [m, lg.totals[m][k]])), total: lg.months.reduce((s, m) => s + lg.totals[m][k], 0) }))];
  xlsxOut(res, `Budget_${g.version.name.replace(/[^\w]+/g, '_')}.xlsx`, EX.workbook([{ name: 'Budget', title: `Budget — ${g.version.name}${g.version.frozen ? ' (frozen)' : ''}`, meta: EX.contextMeta({ basis: 'SA', mode: 'original', periods: `${lg.months[0]} to ${lg.months[lg.months.length - 1]}`, unit: '₹ lakh', filters: `revenue basis: ${lg.settings.revenueBasis}; base month ${lg.settings.baseMonth}; clients without end date: ${lg.settings.noEndDate}` }),
    columns: [{ label: 'Section', key: 'sectionName' }, { label: 'Line', key: 'label', width: 50 }, { label: 'Branch', key: 'branch' }, { label: 'End date', get: r => r.meta?.endDate || '' }, { label: 'Basis / method', get: r => r.meta?.basis || r.meta?.method || (r.meta?.manual ? 'manual' : '') }, ...lg.months.map(m => ({ label: m, get: r => r.values[m] })), { label: 'Total', key: 'total' }], rows }]));
}));
router.get('/budget/vs-actual', wrap(async (req, res) => {
  const c = await ctxFor(req); if (!c) return noData(res);
  const per = P.fromId(req.query.period);
  if (!per || per.type === 'BS') return bad(res, 400, 'Choose a flow period.');
  const g = await gridFor(req.query.version);
  if (!g) return bad(res, 404, 'No budget version.', { code: 'NO_BUDGET' });
  const bl = BU.byStatementLine(g, per.start, per.end);
  const b = basisOf(req);
  // the budget is on the books' (management) basis: rent is an expense. The published P&L follows Ind AS 116 (leases in
  // depreciation and interest), so budget rent is compared with the lease payments in the cash flow, and budget EBITDA
  // (after rent) with lease-adjusted EBITDA (reported EBITDA less lease payments)
  const g1 = x => M.num(M.cell(c.ctx, b, x, per.id));
  const lease = () => { const i = g1('cf.int_lease'), p = g1('cf.lease_principal'); return i == null || p == null ? null : -(i + p); };
  const actual = id => {
    if (id === 'm.lease') return lease();
    if (id === 'm.ebitda') { const v = ['pl.pbt', 'pl.exp_fin', 'pl.exp_dep'].map(g1); const l = lease(); return v.some(x => x == null) || l == null ? null : v[0] + v[1] + v[2] - l; }
    return g1(id);
  };
  const LABEL = { 'm.lease': 'Rent / lease payments (actual: cash flow lease interest + principal)', 'm.ebitda': 'EBITDA after rent (actual: lease-adjusted EBITDA)', 'pl.exp_fin': 'Finance costs (actual includes interest on lease liabilities)' };
  const lines = ['pl.rev', 'pl.oth_inc', 'pl.tot_inc', 'm.lease', 'pl.exp_ops', 'pl.exp_emp', 'pl.exp_fin', 'pl.exp_oth', 'm.ebitda'];
  res.json({ version: g.version, period: per, covered: bl.covered, missingMonths: bl.missingMonths,
    note: 'Budget revenue is Zoho billing before GST; published revenue also includes revenue booked by journals / Ind AS adjustments. Depreciation is not budgeted.',
    rows: lines.map(id => ({ id, label: LABEL[id] || L.BY_ID[id]?.label, budget: L_(bl.values[id] ?? 0), actual: actual(id) })) });
}));

// ── budget inputs: history fetch, client end dates, rent end dates ───────────
router.get('/budget/history', wrap(async (req, res) => {
  const base = req.query.base || SRC.lastCompleteMonth();
  const pl = await SRC.plHeadMonthly(SRC.addMonths(base, -11), base).catch(e => ({ coverage: {}, error: e.message }));
  const fys = Object.keys(pl.coverage || {});
  const ops = SRC.ops();
  res.json({ base, coverage: pl.coverage, error: pl.error || null, prefetch: Object.fromEntries(fys.map(fy => [fy, ops.plPrefetchStatus ? ops.plPrefetchStatus(fy) : null])) });
}));
router.post('/budget/history/fetch', need('inputs'), wrap(async (req, res) => {
  const fy = String(req.body?.fy || '').trim();
  if (!/^\d{4}-\d{2}$/.test(fy)) return bad(res, 400, 'Financial year like 2025-26.');
  const ops = SRC.ops();
  if (!ops.plPrefetch) return bad(res, 503, 'Restart the server to enable the history fetch.');
  const r = await ops.plPrefetch(fy);
  await store.audit({ action: 'budget-history-fetch', fy, by: who(req) });
  res.json(r);
}));

async function clientList() {
  const inv = await SRC.invoices();
  const base = SRC.lastCompleteMonth();
  const since = SRC.addMonths(base, -11);
  const by = new Map();
  for (const i of inv.invoices) {
    const m = SRC.monthOf(i.date);
    if (m < since || m > base) continue;
    const c = by.get(i.customerId) || { customerId: i.customerId, client: i.customer, branch: i.branch, last: 0, lastDate: '' };
    if (m === base) c.last += i.sub;
    if (i.date >= c.lastDate) { c.lastDate = i.date; c.branch = i.branch || c.branch; }
    by.set(i.customerId, c);
  }
  // end dates already extracted from client agreements (agreements module)
  const ag = SRC.ops().agreements ? await SRC.ops().agreements().catch(() => ({})) : {};
  const agBy = new Map();
  for (const brs of Object.values(ag || {})) for (const [br, cls] of Object.entries(brs || {})) for (const [ck, a] of Object.entries(cls || {})) agBy.set(SRC.normName(a.invoicing_legal_name || ck), { ...a, branch: br });
  return [...by.values()].map(c => {
    const a = agBy.get(SRC.normName(c.client));
    const inc = a?.annual_increment ? parseFloat(String(a.annual_increment).replace(/[^\d.]/g, '')) : null;
    return { ...c, currentMonthly: c.last, agreement: a ? { start: a.start_date || null, end: a.end_date || null, lockIn: a.lock_in_date || null, increment: Number.isFinite(inc) ? inc : null, monthlyFee: a.monthly_fee || null, file: a._extracted_from || null } : null };
  }).sort((x, y) => y.currentMonthly - x.currentMonthly);
}
const CLIENT_FIELDS = [['customerId', 'Zoho customer id'], ['client', 'Client'], ['branch', 'Branch'], ['currentMonthly', 'Current monthly billing (₹, before GST — for reference)'], ['startDate', 'Agreement start date'], ['endDate', 'Agreement end date *'], ['monthlyRevenue', 'Monthly revenue to use (₹, optional — blank = current billing)'], ['escalationPct', 'Escalation %'], ['escalationDate', 'First escalation date'], ['source', 'Source *']];
router.get('/budget/clients', wrap(async (req, res) => {
  const [doc, list] = await Promise.all([docOf('client_contracts', { items: [] }), clientList()]);
  res.json({ items: doc.items, zoho: list.map(c => ({ ...c, currentMonthly: c.currentMonthly })), base: SRC.lastCompleteMonth() });
}));
router.post('/budget/clients', need('inputs'), wrap(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
  const errs = [];
  const clean = items.map((x, i) => {
    const o = { id: x.id || DB.id(), customerId: x.customerId || null, client: String(x.client || '').trim(), branch: x.branch || '', startDate: SRC.excelDate(x.startDate) || null, endDate: SRC.excelDate(x.endDate) || null,
      monthlyRevenue: x.monthlyRevenue === '' || x.monthlyRevenue == null ? null : SRC.num(x.monthlyRevenue), escalationPct: x.escalationPct === '' || x.escalationPct == null ? null : SRC.num(x.escalationPct), escalationDate: SRC.excelDate(x.escalationDate) || null, source: String(x.source || '').trim(), by: who(req), at: new Date().toISOString() };
    if (!o.client) errs.push(`Row ${i + 1}: client is required`);
    if (!o.endDate && o.monthlyRevenue == null) errs.push(`Row ${i + 1} (${o.client}): give the end date (or a monthly amount)`);
    if (!o.source) errs.push(`Row ${i + 1} (${o.client}): source is required`);
    return o;
  });
  if (errs.length) return bad(res, 400, errs.slice(0, 12).join('; '));
  await store.update('client_contracts', { items: [] }, d => { for (const o of clean) { d.items = d.items.filter(x => !(x.id === o.id || (o.customerId && x.customerId === o.customerId) || (!o.customerId && SRC.normName(x.client) === SRC.normName(o.client)))); d.items.push(o); } });
  await store.audit({ action: 'client-end-dates', rows: clean.length, by: who(req) });
  res.json({ ok: true, saved: clean.length });
}));
router.delete('/budget/clients/:id', need('inputs'), wrap(async (req, res) => { await store.update('client_contracts', { items: [] }, d => { d.items = d.items.filter(x => x.id !== req.params.id); }); res.json({ ok: true }); }));
router.get('/budget/clients/template', wrap(async (req, res) => {
  const [doc, list] = await Promise.all([docOf('client_contracts', { items: [] }), clientList()]);
  const XLSX = require('xlsx');
  const rows = list.map(c => { const k = doc.items.find(x => x.customerId === c.customerId); return [c.customerId, c.client, c.branch, Math.round(c.currentMonthly), k?.startDate || c.agreement?.start || null, k?.endDate || c.agreement?.end || null, k?.monthlyRevenue ?? null, k?.escalationPct ?? c.agreement?.increment ?? null, k?.escalationDate || null, k?.source || (c.agreement?.end ? `Agreement extract: ${c.agreement.file || ''}` : null)]; });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([CLIENT_FIELDS.map(f => f[1]), ...rows]);
  ws['!cols'] = CLIENT_FIELDS.map((f, i) => ({ wch: i === 1 ? 44 : Math.max(14, Math.min(40, f[1].length)) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Clients');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Client end dates — fill "Agreement end date" for every client (revenue is projected until that date).'], [`Prefilled with every client billed in the last 12 months (Zoho), their billing in ${SRC.lastCompleteMonth()} before GST, and the end date / increment already read from the client agreements where available.`], ['Keep the Zoho customer id column — it links the row to the client in Zoho. Dates as YYYY-MM-DD or DD/MM/YYYY. Escalation % as 5 or 0.05.']]), 'Instructions');
  xlsxOut(res, 'Client_end_dates.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));
router.post('/budget/clients/upload', need('inputs'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return bad(res, 400, 'No file was received.');
  const XLSX = require('xlsx');
  const wb = XLSX.read(req.file.buffer, { cellDates: true });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets.Clients || wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const head = (aoa[0] || []).map(h => String(h || '').trim().toLowerCase());
  const col = l => head.indexOf(l.toLowerCase());
  const items = aoa.slice(1).filter(r => r && r.some(x => x != null && x !== '')).map(r => Object.fromEntries(CLIENT_FIELDS.map(([k, l]) => [k, col(l) >= 0 ? r[col(l)] : null])))
    .filter(x => x.endDate || (x.monthlyRevenue != null && x.monthlyRevenue !== ''));
  if (!items.length) return bad(res, 400, 'No rows with an end date (or monthly amount) were found.');
  for (const x of items) { if (x.customerId != null) x.customerId = String(x.customerId); if (!x.source) x.source = `Upload ${req.file.originalname}`; }
  req.body = { items };
  const errs = [];
  items.forEach((x, i) => { if (!x.client) errs.push(`Row ${i + 2}: client missing`); });
  if (errs.length) return bad(res, 400, errs.join('; '));
  await store.update('client_contracts', { items: [] }, d => { for (const x of items) { const o = { id: DB.id(), customerId: x.customerId || null, client: String(x.client).trim(), branch: x.branch || '', startDate: SRC.excelDate(x.startDate), endDate: SRC.excelDate(x.endDate), monthlyRevenue: x.monthlyRevenue === '' || x.monthlyRevenue == null ? null : SRC.num(x.monthlyRevenue), escalationPct: x.escalationPct == null || x.escalationPct === '' ? null : SRC.num(x.escalationPct), escalationDate: SRC.excelDate(x.escalationDate), source: String(x.source), by: who(req), at: new Date().toISOString() };
    d.items = d.items.filter(y => !((o.customerId && y.customerId === o.customerId) || (!o.customerId && SRC.normName(y.client) === SRC.normName(o.client)))); d.items.push(o); } });
  await store.audit({ action: 'client-end-dates-upload', rows: items.length, by: who(req), file: req.file.originalname });
  res.json({ ok: true, saved: items.length });
}));

router.get('/budget/rent', wrap(async (req, res) => {
  const [rent, ov] = await Promise.all([SRC.rentWorkbook().catch(e => ({ file: null, lines: [], error: e.message })), docOf('rent_overrides', { items: [] })]);
  const groups = new Map();
  for (const l of rent.lines) { const k = `${l.branch}|${l.vendor}|${l.office}`; const g = groups.get(k) || { key: k, branch: l.branch, vendor: l.vendor, office: l.office, agrStart: l.agrStart, agrEnd: l.agrEnd, lines: 0, last: null }; g.lines++; if (l.agrEnd && (!g.agrEnd || l.agrEnd > g.agrEnd)) g.agrEnd = l.agrEnd; if (l.agrStart && (!g.agrStart || l.agrStart < g.agrStart)) g.agrStart = l.agrStart; if (!g.last || (l.modStart || '') > (g.last.modStart || '')) g.last = l; groups.set(k, g); }
  res.json({ file: rent.file, error: rent.error || null, agreements: [...groups.values()].map(g => ({ ...g, last: g.last ? { modStart: g.last.modStart, modEnd: g.last.modEnd, amount: g.last.amount, incOn: g.last.incOn, incPct: g.last.incPct, terms: g.last.terms } : null, override: ov.items.find(o => o.key === g.key) || null })).sort((a, b) => a.branch.localeCompare(b.branch)), overrides: ov.items });
}));
router.post('/budget/rent/override', need('inputs'), wrap(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
  const clean = items.map(x => ({ key: String(x.key || '').trim(), endDate: SRC.excelDate(x.endDate) || null, monthlyRent: x.monthlyRent === '' || x.monthlyRent == null ? null : SRC.num(x.monthlyRent), source: String(x.source || '').trim(), note: String(x.note || '').slice(0, 300), by: who(req), at: new Date().toISOString() }));
  const errs = clean.map((o, i) => (!o.key ? `Row ${i + 1}: branch / landlord missing` : !o.endDate && o.monthlyRent == null ? `Row ${i + 1}: give an end date or a monthly rent` : !o.source ? `Row ${i + 1}: source is required` : null)).filter(Boolean);
  if (errs.length) return bad(res, 400, errs.slice(0, 12).join('; '));
  await store.update('rent_overrides', { items: [] }, d => { for (const o of clean) { d.items = d.items.filter(x => x.key !== o.key); d.items.push(o); } });
  await store.audit({ action: 'rent-end-dates', rows: clean.length, by: who(req) });
  res.json({ ok: true, saved: clean.length });
}));
router.delete('/budget/rent/override', need('inputs'), wrap(async (req, res) => { await store.update('rent_overrides', { items: [] }, d => { d.items = d.items.filter(x => x.key !== req.query.key); }); res.json({ ok: true }); }));
router.get('/budget/rent/template', wrap(async (req, res) => {
  const XLSX = require('xlsx');
  const [rent, ov] = await Promise.all([SRC.rentWorkbook().catch(() => ({ lines: [] })), docOf('rent_overrides', { items: [] })]);
  const groups = new Map();
  for (const l of rent.lines) { const k = `${l.branch}|${l.vendor}|${l.office}`; const g = groups.get(k) || { key: k, branch: l.branch, vendor: l.vendor, office: l.office, agrEnd: null, last: null }; if (l.agrEnd && (!g.agrEnd || l.agrEnd > g.agrEnd)) g.agrEnd = l.agrEnd; if (!g.last || (l.modStart || '') > (g.last.modStart || '')) g.last = l; groups.set(k, g); }
  const head = ['Key (do not change)', 'Branch', 'Landlord', 'Office no.', 'Agreement end (Rent module)', 'Current agreed rent (₹/month)', 'Agreement end date to use *', 'Monthly rent to use (₹, optional)', 'Source *', 'Note'];
  const rows = [...groups.values()].map(g => { const o = ov.items.find(x => x.key === g.key); return [g.key, g.branch, g.vendor, g.office, g.agrEnd, g.last?.amount || null, o?.endDate || null, o?.monthlyRent ?? null, o?.source || null, o?.note || null]; });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([head, ...rows]); ws['!cols'] = head.map((h, i) => ({ wch: i === 0 ? 50 : Math.max(14, h.length) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Rent agreements');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Rent agreement end dates — rent is budgeted until the end date you give (blank = the end date in the Rent Recurring Module).'], ['A branch-wide row can use the key "<Branch>|*". Dates as YYYY-MM-DD or DD/MM/YYYY.']]), 'Instructions');
  xlsxOut(res, 'Rent_agreement_end_dates.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}));
router.post('/budget/rent/upload', need('inputs'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return bad(res, 400, 'No file was received.');
  const XLSX = require('xlsx');
  const wb = XLSX.read(req.file.buffer, { cellDates: true });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets['Rent agreements'] || wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const items = aoa.slice(1).filter(r => r && r[0] && (r[6] || r[7] != null)).map(r => ({ key: String(r[0]).trim(), endDate: SRC.excelDate(r[6]), monthlyRent: r[7] == null || r[7] === '' ? null : SRC.num(r[7]), source: r[8] ? String(r[8]) : `Upload ${req.file.originalname}`, note: r[9] ? String(r[9]) : '', by: who(req), at: new Date().toISOString() }));
  if (!items.length) return bad(res, 400, 'No rows with an end date or monthly rent were found.');
  await store.update('rent_overrides', { items: [] }, d => { for (const o of items) { d.items = d.items.filter(x => x.key !== o.key); d.items.push(o); } });
  await store.audit({ action: 'rent-end-dates-upload', rows: items.length, by: who(req), file: req.file.originalname });
  res.json({ ok: true, saved: items.length });
}));

// ── branch master ────────────────────────────────────────────────────────────
router.get('/branches', wrap(async (req, res) => {
  const doc = await docOf('branches', { items: [] });
  res.json({ items: doc.items.map(b => ({ ...b, missing: BR.validate(b) })), suggestions: await BR.suggestions(doc.items).catch(() => []), fields: BR.FIELDS.map(([key, label, type, required]) => ({ key, label, type, required })), models: BR.MODELS, zones: BR.ZONES });
}));
router.post('/branches', need('inputs'), wrap(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
  const draft = !!req.body?.draft;
  const rows = items.map(x => BR.normalise(x, who(req)));
  const errs = draft ? [] : rows.flatMap(b => BR.validate(b).map(e => `${b.name || '—'}: ${e}`));
  if (errs.length) return bad(res, 400, errs.slice(0, 12).join('; '));
  await store.update('branches', { items: [] }, d => { for (const b of rows) { const old = d.items.find(x => x.id === b.id || SRC.normName(x.name) === SRC.normName(b.name)); if (old) b.id = old.id; d.items = d.items.filter(x => x.id !== b.id); d.items.push(b); } d.items.sort((a, c) => String(a.name).localeCompare(String(c.name))); });
  await store.audit({ action: 'branch-master', rows: rows.length, draft, by: who(req) });
  res.json({ ok: true, saved: rows.length });
}));
router.delete('/branches/:id', need('inputs'), wrap(async (req, res) => { await store.update('branches', { items: [] }, d => { d.items = d.items.filter(x => x.id !== req.params.id); }); res.json({ ok: true }); }));
router.get('/branches/template', wrap(async (req, res) => {
  const doc = await docOf('branches', { items: [] });
  const sug = await BR.suggestions(doc.items).catch(() => []);
  xlsxOut(res, 'Branch_master.xlsx', BR.template([...doc.items, ...sug]));
}));
router.post('/branches/upload', need('inputs'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return bad(res, 400, 'No file was received.');
  const { rows, errors } = BR.parseUpload(req.file.buffer, who(req));
  if (errors.length && req.query.partial !== '1') return bad(res, 400, `Nothing was saved — fix these rows: ${errors.slice(0, 12).join(' | ')}`, { errors });
  await store.update('branches', { items: [] }, d => { for (const b of rows) { const old = d.items.find(x => SRC.normName(x.name) === SRC.normName(b.name)); if (old) b.id = old.id; d.items = d.items.filter(x => x.id !== b.id); d.items.push(b); } d.items.sort((a, c) => String(a.name).localeCompare(String(c.name))); });
  await store.audit({ action: 'branch-master-upload', rows: rows.length, by: who(req), file: req.file.originalname });
  res.json({ ok: true, saved: rows.length, errors });
}));

// ── debt schedule and covenants ──────────────────────────────────────────────
router.get('/debt', wrap(async (req, res) => {
  const d = await docOf('debt', DB.empty());
  const today = SRC.todayIso();
  const facilities = d.facilities.map(f => { const rows = d.schedule.filter(r => r.facilityId === f.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate)); const next = rows.find(r => r.dueDate >= today);
    return { ...f, scheduleRows: rows.length, scheduledPrincipal: rows.reduce((s, r) => s + (Number(r.principal) || 0), 0), next12Principal: rows.filter(r => r.dueDate >= today && r.dueDate <= `${+today.slice(0, 4) + 1}${today.slice(4)}`).reduce((s, r) => s + (Number(r.principal) || 0), 0), nextDue: next || null }; });
  res.json({ ...d, facilities, covenants: d.covenants.map(c => ({ ...c, ...DB.status(c, d.tests) })), fields: { facility: DB.FAC_FIELDS, schedule: DB.SCH_FIELDS, covenant: DB.COV_FIELDS, test: DB.TEST_FIELDS } });
}));
router.post('/debt/facility', need('inputs'), wrap(async (req, res) => {
  const f = req.body || {};
  const errs = DB.FAC_FIELDS.filter(([k, , , rq]) => rq && (f[k] == null || f[k] === '')).map(([, l]) => `${l} is required`);
  if (errs.length) return bad(res, 400, errs.join('; '));
  const item = { ...Object.fromEntries(DB.FAC_FIELDS.map(([k, , t]) => [k, f[k] === '' ? null : t === 'number' ? SRC.num(f[k]) : t === 'date' ? SRC.excelDate(f[k]) : f[k]])), id: f.id || DB.id(), basis: f.basis === 'CO' || /cons/i.test(f.basis || '') ? 'CO' : 'SA', by: who(req), at: new Date().toISOString() };
  let generated = 0;
  await store.update('debt', DB.empty(), d => {
    d.facilities = d.facilities.filter(x => x.id !== item.id); d.facilities.push(item);
    if (req.body.generate !== false && !/custom/i.test(item.repaymentType || '') && !d.schedule.some(r => r.facilityId === item.id && r.source !== 'generated')) {
      const g = DB.generate(item);
      d.schedule = d.schedule.filter(r => r.facilityId !== item.id).concat(g.rows.map(r => ({ facilityId: item.id, ...r, source: 'generated' })));
      generated = g.rows.length;
    }
  });
  await store.audit({ action: 'debt-facility', id: item.id, by: who(req) });
  res.json({ ok: true, item, generated });
}));
router.delete('/debt/facility/:id', need('inputs'), wrap(async (req, res) => { await store.update('debt', DB.empty(), d => { d.facilities = d.facilities.filter(x => x.id !== req.params.id); d.schedule = d.schedule.filter(r => r.facilityId !== req.params.id); d.covenants = d.covenants.filter(c => c.facilityId !== req.params.id); }); res.json({ ok: true }); }));
router.post('/debt/facility/:id/generate', need('inputs'), wrap(async (req, res) => {
  const d = await docOf('debt', DB.empty());
  const f = d.facilities.find(x => x.id === req.params.id);
  if (!f) return bad(res, 404, 'Facility not found.');
  const g = DB.generate(f);
  if (g.error) return bad(res, 400, g.error);
  await store.update('debt', DB.empty(), x => { x.schedule = x.schedule.filter(r => r.facilityId !== f.id).concat(g.rows.map(r => ({ facilityId: f.id, ...r, source: 'generated' }))); });
  res.json({ ok: true, rows: g.rows.length, emi: g.emi });
}));
router.put('/debt/schedule/:facilityId', need('inputs'), wrap(async (req, res) => {
  const rows = (req.body?.rows || []).map(r => ({ facilityId: req.params.facilityId, dueDate: SRC.excelDate(r.dueDate), principal: SRC.num(r.principal) || 0, interest: SRC.num(r.interest) || 0, note: r.note || '', source: 'manual' })).filter(r => r.dueDate);
  await store.update('debt', DB.empty(), d => { d.schedule = d.schedule.filter(r => r.facilityId !== req.params.facilityId).concat(rows); });
  res.json({ ok: true, rows: rows.length });
}));
router.post('/debt/covenant', need('inputs'), wrap(async (req, res) => {
  const c = req.body || {};
  if (!c.facilityId || !c.metric || !c.definition || !['>=', '<='].includes(String(c.operator).trim()) || !Number.isFinite(Number(c.threshold)) || !c.source) return bad(res, 400, 'A covenant needs the facility (or ALL), metric, definition, test (>= or <=), threshold and source.');
  const item = { id: c.id || DB.id(), facilityId: c.facilityId, metric: c.metric, definition: c.definition, operator: String(c.operator).trim(), threshold: Number(c.threshold), frequency: c.frequency || '', basis: c.basis === 'CO' ? 'CO' : 'SA', firstTest: SRC.excelDate(c.firstTest), source: c.source, by: who(req), at: new Date().toISOString() };
  await store.update('debt', DB.empty(), d => { d.covenants = d.covenants.filter(x => x.id !== item.id); d.covenants.push(item); });
  res.json({ ok: true, item });
}));
router.delete('/debt/covenant/:id', need('inputs'), wrap(async (req, res) => { await store.update('debt', DB.empty(), d => { d.covenants = d.covenants.filter(x => x.id !== req.params.id); d.tests = d.tests.filter(t => t.covenantId !== req.params.id); }); res.json({ ok: true }); }));
router.post('/debt/test', need('inputs'), wrap(async (req, res) => {
  const t = req.body || {};
  if (!t.covenantId || !SRC.excelDate(t.periodEnd) || !Number.isFinite(Number(t.value))) return bad(res, 400, 'A covenant test needs the covenant, the period end and the tested value.');
  const item = { id: t.id || DB.id(), covenantId: t.covenantId, periodEnd: SRC.excelDate(t.periodEnd), value: Number(t.value), note: t.note || '', by: who(req), at: new Date().toISOString() };
  await store.update('debt', DB.empty(), d => { d.tests = d.tests.filter(x => x.id !== item.id && !(x.covenantId === item.covenantId && x.periodEnd === item.periodEnd)); d.tests.push(item); });
  res.json({ ok: true });
}));
router.get('/debt/template', wrap(async (req, res) => xlsxOut(res, 'Debt_schedule_and_covenants.xlsx', DB.template())));
router.post('/debt/upload', need('inputs'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return bad(res, 400, 'No file was received.');
  const { doc, errors } = DB.parseUpload(req.file.buffer, who(req));
  if (errors.length && req.query.partial !== '1') return bad(res, 400, `Nothing was saved — fix these: ${errors.slice(0, 12).join(' | ')}`, { errors });
  await store.update('debt', DB.empty(), d => {
    if (req.query.mode === 'replace') return doc;
    const names = new Set(doc.facilities.map(f => String(f.facilityName).toLowerCase()));
    const dropped = d.facilities.filter(f => names.has(String(f.facilityName).toLowerCase())).map(f => f.id);
    d.facilities = d.facilities.filter(f => !dropped.includes(f.id)).concat(doc.facilities);
    d.schedule = d.schedule.filter(r => !dropped.includes(r.facilityId)).concat(doc.schedule);
    d.covenants = d.covenants.filter(c => !dropped.includes(c.facilityId)).concat(doc.covenants);
    d.tests = d.tests.concat(doc.tests);
    return d;
  });
  await store.audit({ action: 'debt-upload', facilities: doc.facilities.length, by: who(req), file: req.file.originalname });
  res.json({ ok: true, facilities: doc.facilities.length, scheduleRows: doc.schedule.length, covenants: doc.covenants.length, errors });
}));
router.post('/debt/import-loans', need('inputs'), wrap(async (req, res) => {
  const ops = SRC.ops();
  if (!ops.loanData) return bad(res, 503, 'Restart the server to enable the Loan module import.');
  const facs = DB.fromLoanModule(await ops.loanData(), who(req));
  const d = await docOf('debt', DB.empty());
  const have = new Set(d.facilities.map(f => String(f.facilityName).toLowerCase()));
  const add = facs.filter(f => !have.has(String(f.facilityName).toLowerCase()));
  await store.update('debt', DB.empty(), x => { x.facilities.push(...add); });
  await store.audit({ action: 'debt-import-loans', added: add.length, by: who(req) });
  res.json({ ok: true, added: add.length, skipped: facs.length - add.length });
}));

// ── collection and payment forecasts ─────────────────────────────────────────
router.get('/forecast', wrap(async (req, res) => {
  const fdoc = await docOf('forecast', { settings: {}, manual: [] });
  const b = await docBudget();
  const vid = req.query.version || fdoc.settings.versionId || b.versions[0]?.id || null;
  const grid = vid ? await gridFor(vid) : null;
  const debt = await docOf('debt', DB.empty());
  let opening = fdoc.settings.opening?.amount != null ? { ...fdoc.settings.opening, source: 'entered' } : null;
  if (!opening) {
    const a = await active();
    if (a) {
      const ctx = M.makeCtx(a.version, { ix: a.ix });
      const bsP = M.periodsFor(a.ix, 'SA', 'BS').filter(p => p.availability === 'reported').sort(P.cmp).pop();
      const cash = bsP ? M.num(M.cell(ctx, 'SA', 'bs.cash', bsP.id)) : null;
      if (cash != null) opening = { amount: cash * 1e5, asAt: bsP.end, source: `cash and cash equivalents in the standalone balance sheet as at ${bsP.end} — movements since then are not included; enter today's bank balance` };
    }
  }
  const f = await FC.build({ grid, debtDoc: debt, settings: { ...fdoc.settings, months: +req.query.months || fdoc.settings.months || 12 }, manual: fdoc.manual, opening });
  const lk = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, L_(v)]));
  res.json({ ...f, table: f.table.map(r => ({ ...r, ins: lk(r.ins), outs: lk(r.outs), totalIn: L_(r.totalIn), totalOut: L_(r.totalOut), net: L_(r.net), opening: L_(r.opening), closing: L_(r.closing) })),
    flows: f.flows.slice(0, 3000).map(x => ({ ...x, amount: L_(x.amount), gross: L_(x.gross) })), clients: f.clients.map(c => ({ ...c, open: L_(c.open) })), opening: f.opening ? { ...f.opening, amount: L_(f.opening.amount) } : null, manual: fdoc.manual.map(x => ({ ...x, amountLakh: L_(x.amount) })),
    heads: grid ? grid.rows.filter(r => r.section === 'expense' && !r.meta?.manual).map(r => ({ id: r.head, label: r.label, method: r.meta?.method })) : [],
    notes: { ...f.notes, overdueExcludedIn: L_(f.notes.overdueExcludedIn), overdueExcludedOut: L_(f.notes.overdueExcludedOut), rentAlreadyBilled: L_(f.notes.rentAlreadyBilled), billsThisMonth: L_(f.notes.billsThisMonth) }, overdue: { in: f.overdue.in.map(x => ({ ...x, amount: L_(x.amount) })), out: f.overdue.out.map(x => ({ ...x, amount: L_(x.amount) })) }, versions: b.versions.map(v => ({ id: v.id, name: v.name })), unit: 'lakh' });
}));
router.put('/forecast/settings', need('inputs'), wrap(async (req, res) => {
  const s = req.body || {};
  await store.update('forecast', { settings: {}, manual: [] }, d => {
    if (s.versionId !== undefined) d.settings.versionId = s.versionId || null;
    if (s.months) d.settings.months = Math.max(3, Math.min(36, +s.months));
    if (s.opening !== undefined) d.settings.opening = s.opening && s.opening.amount !== '' && s.opening.amount != null ? { amount: Number(s.opening.amount), asAt: SRC.excelDate(s.opening.asAt) || SRC.todayIso(), by: who(req) } : null;
    if (s.headLags) d.settings.headLags = Object.fromEntries(Object.entries(s.headLags).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, Number(v)]));
    if (s.netFactors) d.settings.netFactors = Object.fromEntries(Object.entries(s.netFactors).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, Number(v)]));
    if (s.includeOpen !== undefined) d.settings.includeOpen = !!s.includeOpen;
    if (['aged', 'exclude', 'current'].includes(s.overdueCollections)) d.settings.overdueCollections = s.overdueCollections;
    if (s.overdueDays != null && s.overdueDays !== '') d.settings.overdueDays = Math.max(0, Math.min(365, Number(s.overdueDays) || 0));
    if (['exclude', 'current'].includes(s.overduePayments)) d.settings.overduePayments = s.overduePayments;
  });
  res.json({ ok: true });
}));
router.post('/forecast/manual', need('inputs'), wrap(async (req, res) => {
  const x = req.body || {};
  if (!/^\d{4}-\d{2}$/.test(x.month || '') || !Number.isFinite(Number(x.amount)) || !String(x.label || '').trim()) return bad(res, 400, 'Month, amount (₹) and description are required.');
  const item = { id: x.id || DB.id(), dir: x.dir === 'in' ? 'in' : 'out', month: x.month, amount: Number(x.amount), label: String(x.label).trim(), note: String(x.note || ''), by: who(req), at: new Date().toISOString() };
  await store.update('forecast', { settings: {}, manual: [] }, d => { d.manual = d.manual.filter(y => y.id !== item.id); d.manual.push(item); });
  res.json({ ok: true, item });
}));
router.delete('/forecast/manual/:id', need('inputs'), wrap(async (req, res) => { await store.update('forecast', { settings: {}, manual: [] }, d => { d.manual = d.manual.filter(y => y.id !== req.params.id); }); res.json({ ok: true }); }));

router.use((err, req, res, next) => { console.error('[fin-reporting]', err); if (res.headersSent) return next(err); bad(res, err.status || 500, err.message || 'Error'); });

module.exports = router;
