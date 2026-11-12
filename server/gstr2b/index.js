/**
 * GSTR-2B Reco — API routes, mounted at /api/gstr2b (see server/index.js).
 *
 * Every route needs the app's login (JWT). Rights (User Settings → GSTR-2B Reco):
 *   view          module ticked                       dashboards, workbench, exports, imports list
 *   g2b_prepare   "Prepare"                           Zoho sync, upload statements, run reconciliation, notes, assign
 *   g2b_review    "Review"                            link / unlink, approve suggestions, exclude documents
 *   g2b_approve   "Approve / lock"  (Phase 2)         approvals, ITC claim decisions, period locks
 *   g2b_config    "Configure"                         companies, GSTINs, branches, tolerances, schedule, access
 * Admins have every right. A user may be limited to some companies and GSTINs (Settings → Access).
 *
 * This module only READS from Zoho Books (lib/zohoRead.js has no write method) and never files, sends or posts anything.
 * Logic lives in ./lib — see README.md and DESIGN.md.
 */

'use strict';

const express = require('express');
const multer  = require('multer');

const { loadUsers } = require('../auth');
const { background } = require('../background');
const store = require('./lib/store');
const files = require('./lib/files');
const CFG = require('./lib/config');
const N = require('./lib/normalize');
const M = require('./lib/match');
const D = require('./lib/dash');
const ST = require('./lib/statements');
const RV = require('./lib/review');
const AUD = require('./lib/audit');
const ZR = require('./lib/zohoRead');
const BS = require('./lib/booksSync');
const books = require('./lib/booksStore');
const RC = require('./lib/recon');
const EX = require('./lib/exporter');
const RULES = require('./lib/rules');
const DEMO = require('./lib/demo');
const { uid } = require('./lib/util');

const router = express.Router();
const IS_VERCEL = !!process.env.VERCEL;

// ── Wiring ────────────────────────────────────────────────────────────────────
let ctx = null;
let usersOf = loadUsers;
const cfgNow = async () => CFG.merge(await store.read('config', null));
router.init = (deps = {}) => {
  if (deps.loadUsers) usersOf = deps.loadUsers;
  const zr = deps.zr || ZR.create({ zoho: deps.zoho });
  const recon = RC.create({ cfgNow, audit: AUD, log: deps.log || console });
  const sync = BS.create({ zr, cfgNow, readSynced: deps.readSynced || (async () => null), audit: AUD, log: deps.log || console, useLease: IS_VERCEL });
  ctx = { zr, recon, sync };
  return ctx;
};
const need = () => ctx || router.init();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const byName = req => req.g2b?.user?.name || req.g2b?.user?.username || 'unknown';

// ── Rights and scope ──────────────────────────────────────────────────────────
async function rights(req) {
  const users = await usersOf();
  const u = users.find(x => x.id === req.user?.id);
  if (!u || u.active === false) return { view: false };
  const admin = u.role === 'admin';
  const p = u.permissions?.gstr2b;
  const view = admin || p?.enabled === true;
  const sec = k => admin || (view && p?.sections?.[k] === true);
  return { user: u, admin, view, prepare: sec('g2b_prepare'), review: sec('g2b_review'), approve: sec('g2b_approve'), config: sec('g2b_config') };
}
const WHY = { prepare: 'This needs the "Prepare" right (sync, upload statements, run reconciliation).', review: 'This needs the "Review" right (link, approve, exclude).', approve: 'This needs the "Approve / lock" right.',
  config: 'This needs the "Configure" right (companies, GSTINs, settings).', admin: 'Only an administrator can do this.' };
function gate(right) {
  return wrap(async (req, res, next) => {
    const r = await rights(req);
    req.g2b = r;
    if (!r.view) return bad(res, 403, 'You do not have access to GSTR-2B Reco');
    if (right && !r[right]) return bad(res, 403, WHY[right] || 'Not permitted');
    req.cfg = await cfgNow();
    req.acc = CFG.accessOf(req.cfg, r.user);
    next();
  });
}

/** Registrations the user may see, narrowed by ?company= and ?gstin= */
function scopeRegs(req, q = req.query) {
  const want = q.gstin ? String(q.gstin).split(',').map(N.normGstin).filter(Boolean) : null;
  const out = [];
  for (const co of req.cfg.companies) {
    if (q.company && q.company !== 'all' && co.id !== q.company) continue;
    if (!CFG.canSeeCompany(req.acc, co.id)) continue;
    for (const reg of co.registrations) {
      if (!CFG.canSeeGstin(req.acc, co, reg.gstin)) continue;
      if (want && !want.includes(reg.gstin)) continue;
      out.push({ co, reg });
    }
  }
  return out;
}
const companyOf = (req, id) => {
  const co = req.cfg.companies.find(c => c.id === id);
  if (!co || !CFG.canSeeCompany(req.acc, co.id)) { const e = new Error('Company not found'); e.status = 404; throw e; }
  return co;
};
const regOf = (req, co, gstin) => {
  const reg = co.registrations.find(r => r.gstin === N.normGstin(gstin));
  if (!reg || !CFG.canSeeGstin(req.acc, co, reg.gstin)) { const e = new Error('GSTIN not found'); e.status = 404; throw e; }
  return reg;
};

async function loadScope(req, q = req.query) {
  const regs = scopeRegs(req, q);
  const rows = [], docs = [], reviews = {};
  for (const { co, reg } of regs) {
    const d = await need().recon.load(co.id, reg.gstin);
    if (!d) continue;
    docs.push({ co, reg, d });
    if (!reviews[co.id]) reviews[co.id] = await RV.load(co.id);
    for (const r of d.rows) rows.push({ ...r, company: co.id });
  }
  return { regs, rows, docs, reviews };
}
const metaOf = (reviews, r) => (reviews[r.company] && reviews[r.company].meta[r.books_ids[0] || r.portal_ids[0]]) || {};
const reviewForFilter = reviews => ({ meta: Object.assign({}, ...Object.values(reviews).map(x => x.meta)) });
const rowKey = r => `${r.company}|${r.recipient_gstin}|${r.id}`;

function listView(r, reviews) {
  const m = metaOf(reviews, r), notes = ((reviews[r.company] || {}).notes || {})[r.books_ids[0] || r.portal_ids[0]] || [];
  return {
    key: rowKey(r), id: r.id, company: r.company, gstin: r.recipient_gstin, status: r.status, rule: r.rule, identity: r.identity || null, decision: r.decision, flags: r.flags,
    supplier_gstin: r.supplier_gstin, supplier: r.supplier_name, doc_type: r.doc_type, b: r.b, p: r.p, diffs: r.diffs, within: r.within, periods: r.periods, exclusion: r.exclusion || null,
    related: r.related || null, owner: m.owner || '', workflow: m.workflow || '', next_action: m.next_action || '', due: m.due || '', notes: notes.length,
    summary: (r.explain && r.explain[0]) || '', candidates: (r.candidates || []).length,
  };
}
const STATUS_ORDER = { mismatched: 0, suggested: 1, portal_only: 2, books_only: 3, tolerance: 4, exact: 5, excluded: 6 };
function sortRows(rows, sort, dir) {
  const k = sort || 'status', sign = dir === 'desc' ? -1 : 1;
  const name = r => String(r.supplier_name || r.supplier || '').toLowerCase();
  const val = {
    status: r => [STATUS_ORDER[r.status], name(r), (r.b[0] || r.p[0] || {}).date || ''],
    supplier: r => [name(r), (r.b[0] || r.p[0] || {}).date || ''],
    date: r => [(r.b[0] || r.p[0] || {}).date || ''],
    gst: r => [-Math.abs(D.gst(D.sumSide(r.b.length ? r.b : r.p, 1)))],
  }[k] || (() => [0]);
  return rows.sort((a, b) => { const x = val(a), y = val(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return (x[i] < y[i] ? -1 : 1) * sign; return 0; });
}

const scopeText = (req, regs) => {
  const cos = [...new Set(regs.map(x => x.co.name))];
  return `${cos.join(', ') || '—'} · GSTIN: ${regs.map(x => x.reg.gstin).join(', ') || '—'}`;
};

// ── Meta ──────────────────────────────────────────────────────────────────────
router.get('/meta', gate(), wrap(async (req, res) => {
  const r = req.g2b, cfg = req.cfg;
  const companies = cfg.companies.filter(c => CFG.canSeeCompany(req.acc, c.id)).map(c => ({
    id: c.id, name: c.name, short: c.short, org_id: c.org_id, active: c.active, demo: !!c.demo, invoice_date_field: c.invoice_date_field, credit_date_field: c.credit_date_field, credit_number_field: c.credit_number_field,
    registrations: c.registrations.filter(g => CFG.canSeeGstin(req.acc, c, g.gstin)),
  }));
  const sched = await store.read('sched', {});
  res.json({
    rights: { prepare: r.prepare, review: r.review, approve: r.approve, config: r.config, admin: r.admin },
    me: { id: r.user.id, username: r.user.username, name: r.user.name },
    companies, settings: cfg.settings, schedule: { ...cfg.schedule, last: sched }, sync: cfg.sync, period_bases: CFG.PERIOD_BASES,
    statuses: M.STATUS, flags: EX.FLAG_TEXT, workflow: RV.WORKFLOW, definitions: D.DEFINITIONS, rules: RULES.RULES, coverage_matrix: RC.COVERAGE_MATRIX,
    integrations: { zoho: need().zr.identity(), zoho_dedicated: need().zr.dedicated(), read_only: true, vercel: IS_VERCEL, scheduler: !IS_VERCEL, max_upload_mb: IS_VERCEL ? 4 : 40 },
    phases: { implemented: ['Zoho read-only sync', 'GSTR-2B JSON / Excel import with versions', 'Matching engine and review', 'Dashboards, vendor summary, bridge', 'Excel export', 'Audit trail'],
      planned: ['Phase 2: ITC register, approvals, vendor message drafts, period locks, evidence attachments', 'Phase 3: authorised GSTN / IMS connectivity, advanced analytics'] },
    admin_users: r.admin ? (await usersOf()).filter(u => u.active !== false).map(u => ({ id: u.id, name: u.name || u.username, role: u.role })) : undefined,
    access: r.admin ? cfg.access : undefined,
  });
}));

// ── Configuration ─────────────────────────────────────────────────────────────
async function saveConfig(patch, by, action, detail, company = '') {
  const next = await store.withLock('config', async () => { const c = CFG.merge(await store.read('config', null)); const n = { ...c, ...patch }; await store.write('config', n); return n; });
  await AUD.log({ by, action, company, detail });
  return next;
}

router.post('/onboard/zoho-orgs', gate('config'), wrap(async (req, res) => {
  try {
    const orgs = await need().zr.listOrganizations();
    res.json({ credentials: need().zr.identity(), organizations: orgs.map(o => ({ ...o, configured: req.cfg.companies.some(c => c.org_id === o.id) })) });
  } catch (e) { bad(res, 502, need().zr.errText(e)); }
}));

/** Branches of an organisation grouped by recipient GSTIN, each with the checks a person should look at */
router.post('/onboard/branches', gate('config'), wrap(async (req, res) => {
  const org = String(req.body?.org_id || '').trim();
  if (!/^\d{6,20}$/.test(org)) return bad(res, 400, 'Enter the Zoho organisation id (digits only)');
  let list;
  try { list = await need().zr.listBranches(org); } catch (e) { return bad(res, 502, need().zr.errText(e)); }
  const groups = new Map(), unmapped = [];
  for (const b of list) {
    const info = N.gstinInfo(b.gstin);
    if (!info.present) { unmapped.push({ id: b.id, name: b.name, active: b.active, state: b.state }); continue; }
    (groups.get(info.gstin) || groups.set(info.gstin, []).get(info.gstin)).push(b);
  }
  const pans = new Set([...groups.keys()].map(g => N.panOf(g)).filter(Boolean));
  const registrations = [...groups.entries()].map(([gstin, bs]) => {
    const info = N.gstinInfo(gstin), checks = [];
    checks.push(info.format_ok ? (info.checksum_ok ? { ok: true, text: 'GSTIN format and check digit are correct' } : { ok: false, text: 'GSTIN check digit is wrong — there is a typing error in Zoho' }) : { ok: false, text: 'Not a valid GSTIN format' });
    const stateMismatch = bs.filter(b => b.state_code && info.state && b.state_code !== info.state);
    checks.push(stateMismatch.length ? { ok: false, text: `${stateMismatch.length} branch address(es) are in a different state than this GSTIN (${info.state}): ${stateMismatch.map(b => b.name).join(', ')}` } : { ok: true, text: `All branch addresses are in ${info.state || 'the GSTIN state'}` });
    if (pans.size > 1) checks.push({ ok: false, text: `This organisation's GSTINs belong to ${pans.size} different PANs — check that all of them are yours` });
    return { gstin, label: `${bs[0].state || info.state || ''}${bs.length > 1 ? ` (${bs.length} branches)` : ''}`.trim(), state: info.state, pan: info.pan, valid: info.valid, branch_ids: bs.map(b => b.id), branches: bs.map(b => ({ id: b.id, name: b.name, active: b.active })), checks };
  }).sort((a, b) => b.branches.length - a.branches.length);
  res.json({ org_id: org, branches: list.length, registrations, unmapped, pans: [...pans] });
}));

router.post('/onboard/check', gate('config'), wrap(async (req, res) => {
  const co = companyOf(req, String(req.body?.company || ''));
  if (co.demo) return bad(res, 400, 'The demo company has no Zoho organisation');
  res.json(await need().zr.checkAccess(co.org_id));
}));

router.put('/config/companies', gate('config'), wrap(async (req, res) => {
  // The list is replaced as a whole, so a user who can see only some companies must not be able to save it
  if (req.acc.companies || req.acc.gstins) return bad(res, 403, 'Company setup can only be changed by a user who is not limited to particular companies or GSTINs.');
  const sent = Array.isArray(req.body?.companies) ? req.body.companies : [];
  const keepDemo = req.cfg.companies.filter(c => c.demo && !sent.some(x => x.id === c.id));         // the demo company is managed under Demo data only
  const v = CFG.validateCompanies([...sent, ...keepDemo], req.cfg.companies);
  if (v.error) return bad(res, 400, v.error);
  const warnings = [];
  // Verify every registration against the organisation's own branch list (read-only call), so a GSTIN is never saved on trust
  for (const co of v.companies.filter(c => !c.demo && c.registrations.length)) {
    let live = null;
    try { live = await need().zr.listBranches(co.org_id); } catch (e) { warnings.push(`${co.name}: Zoho could not be reached to verify the GSTINs (${need().zr.errText(e)}). They are saved as UNVERIFIED.`); }
    for (const reg of co.registrations) {
      if (!live) { reg.verified = null; continue; }
      const hit = live.filter(b => N.normGstin(b.gstin) === reg.gstin);
      if (!hit.length) { reg.verified = null; warnings.push(`${co.name}: GSTIN ${reg.gstin} is not on any branch in Zoho — documents will not be assigned to it until a branch carries it.`); }
      else { reg.verified = { at: new Date().toISOString(), by: byName(req), source: 'Zoho branches', branches: hit.length, branch_names: hit.map(b => b.name).slice(0, 20) }; if (!reg.branch_ids.length) reg.branch_ids = hit.map(b => b.id); }
    }
  }
  const next = await saveConfig({ companies: v.companies }, byName(req), 'config.companies', v.companies.map(c => `${c.name}: ${c.registrations.map(r => r.gstin).join(', ') || '—'}`).join('; '));
  res.json({ companies: next.companies, warnings });
}));

const configure = (field, validate, label) => router.put(`/config/${field}`, gate('config'), wrap(async (req, res) => {
  const cfg = req.cfg;
  const v = validate(req.body || {}, cfg[label || field]);
  if (v.error) return bad(res, 400, v.error);
  const key = Object.keys(v).find(k => k !== 'error');
  const next = await saveConfig({ [key]: v[key] }, byName(req), `config.${field}`, JSON.stringify(req.body).slice(0, 400));
  res.json({ [key]: next[key] });
}));
configure('settings', CFG.validateSettings);
configure('schedule', CFG.validateSchedule);
configure('sync', CFG.validateSyncLimits);

router.put('/config/access', gate('config'), wrap(async (req, res) => {
  if (!req.g2b.admin) return bad(res, 403, WHY.admin);
  const v = CFG.validateAccess(req.body?.access, await usersOf());
  if (v.error) return bad(res, 400, v.error);
  const next = await saveConfig({ access: v.access }, byName(req), 'config.access', `${Object.keys(v.access).length} user restriction(s)`);
  res.json({ access: next.access });
}));

// ── Zoho sync ─────────────────────────────────────────────────────────────────
router.get('/sync/status', gate(), wrap(async (req, res) => {
  const co = companyOf(req, String(req.query.company || ''));
  if (co.demo) return res.json({ company: co.id, demo: true, running: false, stats: { total: 0 } });
  const st = await need().sync.status(co.id);
  const sched = await store.read('sched', {});
  res.json({ ...st, scheduled: { enabled: req.cfg.schedule.enabled && !IS_VERCEL, times: req.cfg.schedule.times, last: sched } });
}));

async function reconAfter(company, by) {
  try { await need().recon.run({ company, by, mode: 'dirty' }); } catch (e) { if (!/No active GSTIN/.test(e.message)) console.error(`[gstr2b] reconciliation after sync failed (${company}): ${e.message}`); }
}

router.post('/sync/run', gate('prepare'), wrap(async (req, res) => {
  const co = companyOf(req, String(req.body?.company || ''));
  if (co.demo) return bad(res, 400, 'The demo company has no Zoho organisation to sync');
  const mode = ['period', 'incremental', 'recheck'].includes(req.body?.mode) ? req.body.mode : 'incremental';
  if (need().sync.isRunning(co.id)) return res.json({ busy: true, message: `A sync of ${co.name} is already running` });
  // Online a request may run 5 minutes, so a step is at most 3 minutes of Zoho calls and leaves time to save (and, in the last step, to reconcile)
  const run = need().sync.run({ company: co.id, mode, from: req.body?.from, to: req.body?.to, by: byName(req), maxMs: IS_VERCEL ? Math.min(req.cfg.sync.slice_seconds, 180) * 1000 : 50 * 60 * 1000 })
    .then(async r => { if (!r.busy && !(IS_VERCEL && r.status === 'partial')) await reconAfter(co.id, byName(req)); return r; })       // online a partial step is followed by another: reconcile once, at the end
    .catch(e => console.error(`[gstr2b] sync ${co.id}: ${e.message}`));
  if (IS_VERCEL) {                                                                // one slice per request on Vercel
    const r = await background(run);
    if (r && r.busy) return res.json({ busy: true, message: r.message });         // another instance holds the sync lease
    return res.json({ started: true, summary: r || null });
  }
  res.json({ started: true });
}));

router.post('/sync/cancel', gate('prepare'), wrap(async (req, res) => {
  const co = companyOf(req, String(req.body?.company || ''));
  res.json({ cancelled: need().sync.cancel(co.id) });
}));

router.post('/sync/refresh', gate('prepare'), wrap(async (req, res) => {
  const co = companyOf(req, String(req.body?.company || ''));
  const doc = await need().sync.refreshOne(co.id, String(req.body?.doc_id || ''), byName(req));
  if (doc.recipient_gstin) await need().recon.run({ company: co.id, gstin: doc.recipient_gstin, by: byName(req), mode: 'dirty' }).catch(() => {});
  res.json({ refreshed: true, deleted: !!doc.deleted });
}));

// ── Statement import ──────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: (IS_VERCEL ? 4 : 40) * 1024 * 1024, files: 1 } });
router.post('/import/preview', gate('prepare'), (req, res, next) => upload.single('file')(req, res, err => (err ? bad(res, 400, err.code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${IS_VERCEL ? 4 : 40} MB${IS_VERCEL ? ' (the online dashboard accepts up to 4 MB — upload large files from the office PC)' : ''}` : err.message) : next())),
  wrap(async (req, res) => {
    if (!req.file) return bad(res, 400, 'Choose a GSTR-2B file (JSON or Excel)');
    const regs = scopeRegs(req, { company: 'all' });
    const allowed = { ...req.cfg, companies: req.cfg.companies.map(c => ({ ...c, registrations: c.registrations.filter(r => regs.some(x => x.reg.gstin === r.gstin)) })) };
    try {
      const pv = await ST.preview({ buffer: req.file.buffer, fileName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), cfg: allowed, by: byName(req), gstin: req.body?.gstin, period: req.body?.period });
      res.json(pv);
    } catch (e) { bad(res, 400, e.message); }
  }));

router.post('/import/commit', gate('prepare'), wrap(async (req, res) => {
  const regs = scopeRegs(req, { company: 'all' });
  const allowed = { ...req.cfg, companies: req.cfg.companies.map(c => ({ ...c, registrations: c.registrations.filter(r => regs.some(x => x.reg.gstin === r.gstin)) })) };
  let st;
  try { st = await ST.commit({ previewId: String(req.body?.preview_id || ''), cfg: allowed, by: byName(req), gstin: req.body?.gstin, period: req.body?.period, ack: !!req.body?.ack }); }
  catch (e) { return bad(res, e.status || 400, e.message, { needs_ack: !!e.needs_ack, blockers: e.blockers }); }
  await AUD.log({ by: byName(req), action: 'import.statement', company: st.company, gstin: st.gstin, ref: st.id, detail: `${st.period} v${st.version}${st.is_current ? ' (current)' : ' (history)'} — ${st.docs} documents, ${st.error_count} row problem(s)${st.acknowledged ? ', acknowledged' : ''}; sha256 ${st.sha256}` });
  let recon = null;
  try { recon = (await need().recon.run({ company: st.company, gstin: st.gstin, by: byName(req), mode: 'dirty' })).results[0]; } catch (e) { recon = { error: e.message }; }
  res.json({ statement: st, reconciliation: recon && !recon.error ? { version: recon.version, summary: recon.summary.counts, changes: recon.changes } : recon });
}));

router.get('/imports', gate(), wrap(async (req, res) => {
  const regs = scopeRegs(req);
  const ok = new Set(regs.map(x => x.reg.gstin));
  const list = (await ST.list()).filter(s => ok.has(s.gstin));
  res.json({ statements: list.map(s => ({ ...s, company_name: (req.cfg.companies.find(c => c.id === s.company) || {}).name || '' })) });
}));
router.get('/imports/diff', gate(), wrap(async (req, res) => {
  const a = await ST.find(String(req.query.a || '')), b = await ST.find(String(req.query.b || ''));
  if (!a || !b) return bad(res, 404, 'Statement not found');
  for (const s of [a, b]) regOf(req, companyOf(req, s.company), s.gstin);
  try { res.json(await ST.diff(a.id, b.id)); } catch (e) { bad(res, 400, e.message); }
}));
router.get('/imports/:id', gate(), wrap(async (req, res) => {
  const s = await ST.get(req.params.id, { withDocs: false });
  if (!s) return bad(res, 404, 'Statement not found');
  regOf(req, companyOf(req, s.company), s.gstin);
  const body = await store.read(`stmt_${s.id}`, { errors: [] });
  res.json({ statement: s, errors: (body.errors || []).slice(0, 500), error_count: (body.errors || []).length, versions: (await ST.list()).filter(x => x.gstin === s.gstin && x.period === s.period).sort((a, b) => a.version - b.version) });
}));
router.get('/imports/:id/file', gate(), wrap(async (req, res) => {
  const s = await ST.get(req.params.id);
  if (!s) return bad(res, 404, 'Statement not found');
  regOf(req, companyOf(req, s.company), s.gstin);
  const buf = await files.read(s.sha256);
  if (!buf) return bad(res, 404, 'The original file is not available on this server');
  res.setHeader('Content-Type', s.format === 'json' ? 'application/json' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${String(s.file_name).replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(buf);
}));

// ── Reconciliation ────────────────────────────────────────────────────────────
router.post('/recon/run', gate('prepare'), wrap(async (req, res) => {
  const co = companyOf(req, String(req.body?.company || ''));
  const gstin = req.body?.gstin ? regOf(req, co, req.body.gstin).gstin : null;
  try { res.json(await need().recon.run({ company: co.id, gstin, by: byName(req), mode: req.body?.mode === 'all' ? 'all' : 'dirty' })); }
  catch (e) { bad(res, 400, e.message); }
}));

const FILTER_KEYS = ['company', 'gstin', 'branch', 'vendor', 'project', 'fy', 'month', 'quarter', 'half', 'from', 'to', 'basis', 'doc_type', 'status', 'flag', 'owner', 'workflow', 'queue', 'q'];
const filtersOf = q => Object.fromEntries(FILTER_KEYS.filter(k => q[k] !== undefined && q[k] !== '').map(k => [k, q[k]]));
const soon = req => req.cfg.settings.closing_soon_days;
const regLookup = req => g => { for (const co of req.cfg.companies) { const r = co.registrations.find(x => x.gstin === g); if (r) return r; } return null; };

router.get('/recon/summary', gate(), wrap(async (req, res) => {
  const { regs, rows, docs, reviews } = await loadScope(req);
  const f = filtersOf(req.query);
  const sel = D.filterRows(rows, f, reviewForFilter(reviews));
  const summary = D.summarize(sel, { regOf: regLookup(req), soonDays: soon(req), reviewDoc: reviewForFilter(reviews) });
  const last = docs.map(x => ({ company: x.co.id, gstin: x.reg.gstin, version: x.d.version, ran_at: x.d.ran_at, changes: x.d.changes, stale_links: x.d.stale_links, inputs: x.d.inputs })).sort((a, b) => String(b.ran_at).localeCompare(String(a.ran_at)));
  res.json({ filters: f, registrations: regs.map(x => ({ company: x.co.id, gstin: x.reg.gstin, reconciled: docs.some(d => d.reg.gstin === x.reg.gstin) })), summary, runs: last, bridge_ties: D.bridge(sel).ties });
}));

router.get('/recon/rows', gate(), wrap(async (req, res) => {
  const { rows, reviews } = await loadScope(req);
  const sel = sortRows(D.filterRows(rows, filtersOf(req.query), reviewForFilter(reviews)), req.query.sort, req.query.dir);
  const per = Math.min(500, Math.max(10, parseInt(req.query.per || '100', 10))), page = Math.max(1, parseInt(req.query.page || '1', 10));
  res.json({ total: sel.length, page, per, rows: sel.slice((page - 1) * per, page * per).map(r => listView(r, reviews)) });
}));

router.get('/recon/row', gate(), wrap(async (req, res) => {
  const [company, gstin, ...rest] = String(req.query.key || '').split('|');
  const id = rest.join('|');
  const co = companyOf(req, company), reg = regOf(req, co, gstin);
  const d = await need().recon.load(co.id, reg.gstin);
  const row = d && d.rows.find(r => r.id === id);
  if (!row) return bad(res, 404, 'This row no longer exists — the reconciliation was re-run. Refresh the list.');
  const views = new Map();
  for (const r of d.rows) { r.b.forEach(v => views.set(v.id, { side: 'books', ...v })); r.p.forEach(v => views.set(v.id, { side: 'portal', ...v })); }
  const cands = (row.candidates || []).map(c => ({ ...c, books: views.get(c.books_id) || null, portal: views.get(c.portal_id) || null }));
  const rv = await RV.detailFor(co.id, row);
  const deadline = row.status === 'books_only' && row.b[0] ? RULES.claimDeadline(row.b[0].date, reg) : null;
  res.json({
    row: { ...listView({ ...row, company: co.id }, { [co.id]: await RV.load(co.id) }), explain: row.explain, candidates: cands, tolerance_p: row.tolerance_p, partition: row.partition, run_version: row.run_version },
    review: rv, claim_deadline: deadline ? { ...deadline, days_left: N.daysBetween(N.todayIST(), deadline.deadline), class: RULES.exposureClass(deadline.deadline, N.todayIST(), soon(req)) } : null,
    run: { version: d.version, ran_at: d.ran_at },
  });
}));

router.get('/recon/vendors', gate(), wrap(async (req, res) => {
  const { rows, reviews } = await loadScope(req);
  res.json({ vendors: D.vendors(D.filterRows(rows, filtersOf(req.query), reviewForFilter(reviews))).slice(0, 1000) });
}));
router.get('/recon/bridge', gate(), wrap(async (req, res) => {
  const { rows, reviews } = await loadScope(req);
  res.json(D.bridge(D.filterRows(rows, filtersOf(req.query), reviewForFilter(reviews))));
}));
router.get('/recon/options', gate(), wrap(async (req, res) => {
  const { rows } = await loadScope(req);
  res.json(D.options(rows));
}));

/** The rows of one recon document named by "company|gstin|rowid" keys (all in one registration) */
async function pickRows(req, keys) {
  const list = (Array.isArray(keys) ? keys : []).slice(0, 200);
  if (!list.length) throw Object.assign(new Error('Select at least one row'), { status: 400 });
  const out = [];
  let co = null, reg = null, d = null;
  for (const k of list) {
    const [company, gstin, ...rest] = String(k).split('|');
    if (!co) { co = companyOf(req, company); reg = regOf(req, co, gstin); d = await need().recon.load(co.id, reg.gstin); }
    else if (co.id !== company || reg.gstin !== N.normGstin(gstin)) throw Object.assign(new Error('Act on rows of one GSTIN at a time'), { status: 400 });
    const row = d && d.rows.find(r => r.id === rest.join('|'));
    if (row) out.push(row);
  }
  if (!out.length) throw Object.assign(new Error('The selected rows no longer exist — refresh the list'), { status: 409 });
  return { co, reg, rows: out };
}
const rerun = (co, reg, by) => need().recon.run({ company: co.id, gstin: reg.gstin, by, mode: 'dirty' });

router.post('/recon/link', gate('review'), wrap(async (req, res) => {
  const co = companyOf(req, String(req.body?.company || '')), reg = regOf(req, co, req.body?.gstin);
  const d = await need().recon.load(co.id, reg.gstin);
  const bs = [].concat(req.body?.books_ids || []).map(String), ps = [].concat(req.body?.portal_ids || []).map(String);
  if (!bs.length || !ps.length) return bad(res, 400, 'Choose at least one Books document and one GSTR-2B document');
  const live = new Set(d ? d.rows.filter(r => r.status !== 'excluded').flatMap(r => [...r.books_ids, ...r.portal_ids]) : []);
  if (![...bs, ...ps].every(id => live.has(id))) return bad(res, 400, 'Only documents of this GSTIN that can be matched can be linked. Documents of another GSTIN, or excluded documents, cannot.');
  if (!String(req.body?.reason || '').trim()) return bad(res, 400, 'Give the reason for linking these documents');
  await RV.link(co.id, { books_ids: bs, portal_ids: ps, by: byName(req), reason: req.body.reason });
  await AUD.log({ by: byName(req), action: 'recon.link', company: co.id, gstin: reg.gstin, detail: `${bs.length} Books + ${ps.length} GSTR-2B: ${req.body.reason}`.slice(0, 300) });
  const r = (await rerun(co, reg, byName(req))).results[0];
  res.json({ ok: true, version: r.version });
}));

router.post('/recon/unlink', gate('review'), wrap(async (req, res) => {
  const { co, reg, rows } = await pickRows(req, [req.body?.key]);
  const row = rows[0];
  if (!row.books_ids.length || !row.portal_ids.length) return bad(res, 400, 'Only a matched or suggested pair can be unlinked');
  await RV.unlink(co.id, row, byName(req), req.body?.reason || '');
  await AUD.log({ by: byName(req), action: row.decision.mode === 'manual' ? 'recon.unlink' : 'recon.reject', company: co.id, gstin: reg.gstin, ref: row.id, detail: String(req.body?.reason || '').slice(0, 300) });
  res.json({ ok: true, version: (await rerun(co, reg, byName(req))).results[0].version });
}));

router.post('/recon/approve', gate('review'), wrap(async (req, res) => {
  const { co, reg, rows } = await pickRows(req, req.body?.keys);
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return bad(res, 400, 'Give the reason for approving');
  const sensitive = r => r.flags.some(f => ['ambiguous', 'wrong_supplier_gstin', 'grouped', 'number_differs'].includes(f));
  const done = [], skipped = [];
  for (const r of rows) {
    if (r.status !== 'suggested') { skipped.push({ id: r.id, why: 'not a suggested match' }); continue; }
    if (rows.length > 1 && sensitive(r) && !req.body?.allow_special) { skipped.push({ id: r.id, why: 'needs a single, individual approval (ambiguous / wrong GSTIN / grouped / different numbers)' }); continue; }
    const approved = req.body?.approve_variance && r.diffs ? Object.fromEntries(['taxable', 'igst', 'cgst', 'sgst', 'cess'].map(c => [c, Math.abs(r.diffs[c])])) : null;
    await RV.link(co.id, { books_ids: r.books_ids, portal_ids: r.portal_ids, by: byName(req), reason, approved_tol_p: approved, approved_from: r.rule });
    done.push(r.id);
  }
  if (done.length) await AUD.log({ by: byName(req), action: 'recon.approve', company: co.id, gstin: reg.gstin, detail: `${done.length} suggested match(es) approved${req.body?.approve_variance ? ' with their variance' : ''}: ${reason}`.slice(0, 300) });
  const v = done.length ? (await rerun(co, reg, byName(req))).results[0].version : null;
  res.json({ approved: done.length, skipped, version: v });
}));

router.post('/recon/exclude', gate('review'), wrap(async (req, res) => {
  const co = companyOf(req, String(req.body?.company || '')), reg = regOf(req, co, req.body?.gstin);
  const id = String(req.body?.doc_id || '');
  if (req.body?.include) { await RV.include(co.id, { doc_id: id, by: byName(req) }); await AUD.log({ by: byName(req), action: 'recon.include', company: co.id, gstin: reg.gstin, ref: id, detail: 'manual exclusion removed' }); }
  else {
    try { await RV.exclude(co.id, { doc_id: id, side: req.body?.side === 'portal' ? 'portal' : 'books', reason: req.body?.reason, by: byName(req) }); } catch (e) { return bad(res, 400, e.message); }
    await AUD.log({ by: byName(req), action: 'recon.exclude', company: co.id, gstin: reg.gstin, ref: id, detail: String(req.body.reason).slice(0, 300) });
  }
  res.json({ ok: true, version: (await rerun(co, reg, byName(req))).results[0].version });
}));

router.post('/recon/assign', gate('prepare'), wrap(async (req, res) => {
  const { co, reg, rows } = await pickRows(req, req.body?.keys);
  const patch = {};
  for (const k of ['owner', 'workflow', 'next_action', 'due']) if (req.body?.[k] !== undefined) patch[k] = req.body[k];
  if (patch.workflow && ['accepted', 'resolved'].includes(patch.workflow) && !req.g2b.review) return bad(res, 403, 'Marking a row Accepted or Resolved needs the "Review" right');
  try { await RV.assign(co.id, rows.map(r => RV.anchorOf(r)), patch, byName(req)); } catch (e) { return bad(res, 400, e.message); }
  await AUD.log({ by: byName(req), action: 'recon.assign', company: co.id, gstin: reg.gstin, detail: `${rows.length} row(s): ${JSON.stringify(patch)}`.slice(0, 300) });
  res.json({ ok: true, rows: rows.length });
}));

router.post('/recon/note', gate('prepare'), wrap(async (req, res) => {
  const { co, rows } = await pickRows(req, [req.body?.key]);
  try { await RV.note(co.id, RV.anchorOf(rows[0]), req.body?.text, byName(req)); } catch (e) { return bad(res, 400, e.message); }
  res.json({ ok: true });
}));

// ── Coverage, ITC (planned), audit, export, demo ──────────────────────────────
router.get('/coverage', gate(), wrap(async (req, res) => {
  const co = companyOf(req, String(req.query.company || ''));
  const out = { matrix: RC.COVERAGE_MATRIX, company: { id: co.id, name: co.name, demo: !!co.demo } };
  if (!co.demo) {
    const st = await need().sync.status(co.id);
    const sync = await need().sync.loadState(co.id);
    const configured = new Set(co.registrations.map(r => r.gstin));
    out.documents = { total: st.stats.total, in_scope: st.stats.in_scope, detailed: st.stats.detailed, waiting_for_details: st.stats.pending, edited_not_refreshed: st.stats.stale, excluded: st.stats.excluded, by_kind: st.stats.by_kind, failing: st.failing_documents };
    out.branches = Object.values(sync.branches || {}).map(b => ({ id: b.id, name: b.name, gstin: b.gstin, active: b.active, state: b.state, configured: !!b.gstin && configured.has(N.normGstin(b.gstin)) }))
      .sort((a, b) => Number(a.configured) - Number(b.configured) || a.name.localeCompare(b.name));
    out.branches_at = sync.branches_at;
    out.attention = [
      ...out.branches.filter(b => !b.gstin).map(b => `Branch "${b.name}" has no GSTIN in Zoho — its documents cannot be reconciled.`),
      ...[...new Set(out.branches.filter(b => b.gstin && !b.configured).map(b => b.gstin))].map(g => `GSTIN ${g} is on Zoho branches but is not set up here — add it in Settings to reconcile its documents.`),
    ];
  }
  res.json(out);
}));

router.get('/itc', gate(), (req, res) => res.json({ implemented: false, phase: 2,
  message: 'The ITC register is planned for Phase 2. Reconciliation status is not ITC eligibility: a matched invoice is not automatically eligible, claimed or reversible.',
  planned: ['Eligibility status and reason, with evidence', 'Available, deferred, blocked / ineligible, claimed, reversed and reclaimed amounts and periods', 'Section 16, Section 17(5), Rule 37 (180 days, partial payments), Rule 37A, reverse charge, imports, ISD, credit-note and common-credit reviews', 'Reviewable GSTR-3B working that separates proposed from filed amounts', 'Duplicate-claim prevention across months, re-imports, amendments, reversals and reclaims'],
  rules_source: RULES.RULES.sections.map(s => ({ id: s.id, title: s.title, source: s.source })) }));

router.get('/audit', gate('config'), wrap(async (req, res) => {
  const ym = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : new Date().toISOString().slice(0, 7);
  const list = (await AUD.month(ym)).filter(e => !e.company || CFG.canSeeCompany(req.acc, e.company)).reverse().slice(0, 1000);
  res.json({ month: ym, entries: list });
}));
router.get('/audit/verify', gate('config'), wrap(async (req, res) => res.json(await AUD.verify())));

router.get('/export/xlsx', gate(), wrap(async (req, res) => {
  const { regs, rows, reviews } = await loadScope(req);
  const f = filtersOf(req.query);
  const sel = D.filterRows(rows, f, reviewForFilter(reviews));
  const regL = regLookup(req);
  const summary = D.summarize(sel, { regOf: regL, soonDays: soon(req), reviewDoc: reviewForFilter(reviews) });
  const ok = new Set(regs.map(x => x.reg.gstin));
  const stmts = (await ST.list()).filter(s => ok.has(s.gstin) && s.is_current).sort((a, b) => a.gstin.localeCompare(b.gstin) || a.period.localeCompare(b.period));
  const syncInfo = [];
  for (const co of [...new Set(regs.map(x => x.co))].filter(c => !c.demo)) { try { const st = await need().sync.status(co.id); syncInfo.push({ label: `Zoho sync — ${co.name}`, value: st.last_ok_at ? `last successful ${st.last_ok_at.slice(0, 16).replace('T', ' ')} UTC; ${st.stats.pending} document(s) still waiting for details` : 'never synced' }); } catch (_) { /* optional */ } }
  const meta = Object.assign({}, ...Object.values(reviews).map(x => x.meta)), notes = Object.assign({}, ...Object.values(reviews).map(x => x.notes));
  const out = EX.build({
    rows: sel, filters: f, summary, bridge: D.bridge(sel), vendors: D.vendors(sel), statements: stmts, companies: req.cfg.companies, regOf: regL, meta, notes, workflow: RV.WORKFLOW,
    syncInfo, generatedBy: byName(req), today: N.todayIST(), scopeText: `${scopeText(req, regs)}${Object.keys(f).length ? ` · filters: ${Object.entries(f).filter(([k]) => !['company', 'gstin'].includes(k)).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}` : ''}`,
    basisText: CFG.PERIOD_BASES[f.basis || req.cfg.settings.period_basis] || '',
  });
  await AUD.log({ by: byName(req), action: 'export.xlsx', company: req.query.company && req.query.company !== 'all' ? req.query.company : '', detail: `${sel.length} row(s); filters ${JSON.stringify(f).slice(0, 200)}` });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="GSTR2B_Reco_${(req.query.company || 'all')}_${N.todayIST()}.xlsx"`);
  res.send(out.buffer);
}));

router.post('/demo/load', gate('config'), wrap(async (req, res) => {
  if (!req.g2b.admin) return bad(res, 403, WHY.admin);
  const r = await DEMO.load({ cfgNow, saveConfig: (patch, detail) => saveConfig(patch, byName(req), 'demo.load', detail, 'demo'), recon: need().recon, by: byName(req) });
  await AUD.log({ by: byName(req), action: 'demo.load', company: 'demo', detail: JSON.stringify(r.counts).slice(0, 300) });
  res.json(r);
}));
router.post('/demo/remove', gate('config'), wrap(async (req, res) => {
  if (!req.g2b.admin) return bad(res, 403, WHY.admin);
  const r = await DEMO.remove({ cfgNow, saveConfig: (patch, detail) => saveConfig(patch, byName(req), 'demo.remove', detail, 'demo') });
  await AUD.log({ by: byName(req), action: 'demo.remove', company: 'demo', detail: JSON.stringify(r).slice(0, 300) });
  res.json(r);
}));

// ── Errors ────────────────────────────────────────────────────────────────────
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.status && err.status < 500) return bad(res, err.status, err.message);
  console.error('[gstr2b]', req.method, req.path, err.response?.data?.message || err.stack || err.message);
  bad(res, 500, `Something went wrong: ${err.message}`);
});

// ── Scheduled sync on the office PC (hours from Settings, India time) ─────────
let timer = null;
router.startScheduler = () => {
  if (timer || IS_VERCEL) return;
  let ticking = false, lastStamp = '';
  timer = setInterval(async () => {
    if (ticking) return;
    try {
      const cfg = await cfgNow();
      if (!cfg.schedule.enabled || !cfg.companies.some(c => c.active && !c.demo && c.registrations.length)) return;
      const ist = new Date(Date.now() + 330 * 60000).toISOString();
      const hhmm = ist.slice(11, 16), stamp = ist.slice(0, 16);
      if (!cfg.schedule.times.includes(hhmm) || stamp === lastStamp) return;
      lastStamp = stamp; ticking = true;
      const sched = await store.read('sched', {});
      const day = ist.slice(0, 10);
      const mode = sched.last_recheck_day === day ? 'incremental' : 'recheck';          // the first run of each day also checks for deletions
      const results = [];
      for (const co of cfg.companies.filter(c => c.active && !c.demo && c.registrations.length)) {
        const r = await need().sync.run({ company: co.id, mode, by: 'schedule', maxMs: 50 * 60 * 1000 });
        results.push(`${co.short || co.id}: ${r.status || (r.busy ? 'busy' : '?')}`);
        if (!r.busy) await reconAfter(co.id, 'schedule');
      }
      await store.write('sched', { ...sched, last_tick_at: new Date().toISOString(), last_mode: mode, last_result: results.join('; '), last_recheck_day: mode === 'recheck' ? day : sched.last_recheck_day });
    } catch (e) { console.error('[gstr2b] scheduled sync:', e.message); }
    finally { ticking = false; }
  }, 30000);
  if (timer.unref) timer.unref();
};
router.stopScheduler = () => { if (timer) { clearInterval(timer); timer = null; } };

module.exports = router;
