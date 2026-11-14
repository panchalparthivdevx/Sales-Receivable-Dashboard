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
router.init = (deps = {}) => { if (deps.loadUsers) usersOf = deps.loadUsers; if (deps.readLegacy) legacyRead = deps.readLegacy; };

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
  const inputs = await inputsNow();
  res.json({ dictionary: RA.dictionary(), results: periods.map(p => RA.compute(c.ctx, b, p, inputs)), mode: c.mode });
}));
router.get('/ratios/dictionary', wrap(async (req, res) => res.json(RA.dictionary())));

router.get('/cfo', wrap(async (req, res) => {
  const c = await ctxFor(req); if (!c) return noData(res);
  const b = basisOf(req);
  let p = req.query.period;
  if (!P.fromId(p)) p = M.periodsFor(c.ctx.ix, b, 'PL').filter(x => x.type === 'Q' && x.availability === 'reported').sort(P.cmp).pop()?.id;
  const r = await reconFor(c);
  const inputs = await inputsNow();
  res.json({ ...V.cfo(c.ctx, b, p, inputs, { dataQuality: { summary: r.summary, decisions: r.decisions.length } }), coverage: IN.coverage(inputs), mode: c.mode });
}));

// ── management inputs ────────────────────────────────────────────────────────
router.get('/inputs', wrap(async (req, res) => {
  const s = await inputsNow();
  res.json({ ...s, types: Object.fromEntries(Object.entries(IN.TYPES).map(([k, t]) => [k, { label: t.label, unit: t.unit, help: t.help, fields: t.fields.map(([key, label, kind, req2]) => ({ key, label, type: kind.t, required: !!req2 })) }])), coverage: IN.coverage(s), requiredBy: IN.REQUIRED_BY });
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
    const inputs = await inputsNow();
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

router.use((err, req, res, next) => { console.error('[fin-reporting]', err); if (res.headersSent) return next(err); bad(res, err.status || 500, err.message || 'Error'); });

module.exports = router;
