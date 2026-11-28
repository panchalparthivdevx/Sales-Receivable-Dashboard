/**
 * Management Cash Flow — API routes, mounted at /api/cashflow (see server/index.js). Phase 1: three outflow tabs —
 * Brokerage Charges, Rent Expense, Electricity Charges — and the monthly overview.
 *
 * Every route needs the app's login (JWT). Rights (User Settings → Management Cash Flow, ticked one by one):
 *   view         module ticked     overview, category tabs, drill-downs, financial-year grid
 *   cf_plan      "Plan"            budgets and commitments, Pay On date / amount (instalments), links to bills, client names
 *   cf_payments  "Payments"        payment initiation records and their status, payment advice slips
 *   cf_config    "Configure"       category accounts and rules, refresh from Zoho
 * Admins have every right.
 *
 * Zoho Books is only READ (GET). Nothing is written to Zoho. Calculations: lib/engine.js; reading Zoho: lib/sync.js.
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');

const { loadUsers } = require('../auth');
const { background } = require('../background');
const store = require('./lib/store');
const files = require('./lib/files');
const CFG = require('./lib/config');
const M = require('./lib/months');
const CL = require('./lib/classify');
const E = require('./lib/engine');
const SY = require('./lib/sync');
const ZR = require('../gstr2b/lib/zohoRead');

const router = express.Router();
const IS_VERCEL = !!process.env.VERCEL;
const MAX_MB = IS_VERCEL ? 4 : 20;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024 } });

// ── Wiring ────────────────────────────────────────────────────────────────────
let ctx = null;
let usersOf = loadUsers;
const cfgNow = async () => CFG.merge(await store.read('config', null));
router.init = (deps = {}) => {
  if (deps.loadUsers) usersOf = deps.loadUsers;
  // the app's own Zoho login (the GSTR-2B module's dedicated read-only token may not read the chart of accounts)
  const env = new Proxy(process.env, { get: (t, k) => (k === 'GSTR2B_ZOHO_REFRESH_TOKEN' ? '' : t[k]) });
  const zr = deps.zr || ZR.create({ zoho: deps.zoho, env });
  const readSynced = deps.readSynced || (async () => null);
  const sync = SY.create({ zr, readSynced, cfgNow, log: deps.log || console });
  ctx = { zr, sync, readSynced, readPortal: deps.readPortal || (async () => []), now: deps.now || (() => new Date()) };
  return ctx;
};
const need = () => ctx || router.init();
const today = () => M.todayIST(need().now());

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const byName = req => req.cf?.user?.name || req.cf?.user?.username || 'unknown';
const newId = p => `${p}${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const r2 = CL.r2;

// ── Rights ────────────────────────────────────────────────────────────────────
async function rights(req) {
  const users = await usersOf();
  const u = users.find(x => x.id === req.user?.id);
  if (!u || u.active === false) return { view: false };
  const admin = u.role === 'admin';
  const p = u.permissions?.cashflow;
  const view = admin || p?.enabled === true;
  const sec = k => admin || (view && p?.sections?.[k] === true);
  return { user: u, admin, view, plan: sec('cf_plan'), payments: sec('cf_payments'), config: sec('cf_config') };
}
const WHY = { plan: 'This needs the "Plan" right (budgets, schedules, links).', payments: 'This needs the "Payments" right (initiation records, payment advice slips).',
  config: 'This needs the "Configure" right.' };
function gate(right) {
  return wrap(async (req, res, next) => {
    const r = await rights(req);
    req.cf = r;
    if (!r.view) return bad(res, 403, 'You do not have access to Management Cash Flow');
    if (right && !r[right]) return bad(res, 403, WHY[right] || 'Not permitted');
    req.cfg = await cfgNow();
    next();
  });
}
function companyOf(req, id = req.query.company || req.body?.company) {
  const co = req.cfg.companies.find(c => c.id === String(id || ''));
  if (!co) throw Object.assign(new Error('Choose a company'), { status: 400 });
  return co;
}
const companiesOf = (req, id) => (!id || id === 'all' ? req.cfg.companies : [companyOf(req, id)]);

async function audit(by, action, detail, company = '') {
  const key = `audit_${today().slice(0, 7)}`;
  await store.update(key, [], list => { list.push({ at: new Date().toISOString(), by, action, company, detail: String(detail).slice(0, 600) }); return list.slice(-3000); });
}

// ── Building the model of a company ───────────────────────────────────────────
const planDef = () => ({ budgets: [], parts: {}, advances: {}, slips: {} });

async function portalInitiations(company) {
  if (company !== 'devx') return new Map();          // the Finance Portal raises requests for Dev Accelerator's Zoho organisation
  let list = [];
  try { list = await need().readPortal(); } catch (_) { list = []; }
  const st = { pending: 'initiated', in_progress: 'initiated', completed: 'settled', rejected: 'cancelled' };
  const out = new Map();
  for (const s of list || []) {
    if (s.request_type !== 'vendor_payment' || s.zoho_doc_type !== 'bill' || !s.zoho_doc_id) continue;
    const id = String(s.zoho_doc_id);
    if (!out.has(id)) out.set(id, []);
    out.get(id).push({ id: `portal-${s.id}`, date: String(s.submitted_at || '').slice(0, 10), amount: Number(s.payment_amount) || 0,
      reference: `Finance Portal request ${s.id}${s.notes ? ` — ${s.notes}` : ''}`, status: st[s.status] || 'initiated', by: s.submitted_by_name || '' });
  }
  return out;
}

async function modelOf(cfg, co) {
  const sy = need().sync;
  const [bills, coaDoc, plan, L, portal] = await Promise.all([
    sy.loadBills(co.id), store.read(`coa_${co.id}`, null), store.read(`plan_${co.id}`, planDef()), sy.lists(co.id), portalInitiations(co.id),
  ]);
  const accCat = CL.accountCategories(coaDoc?.rows || [], cfg.categories);
  const vm = sy.vendorMasterMap(L.vendors);
  const vendorMasterCategory = vid => {
    const master = String(vm.get(vid) || '').toLowerCase();
    const name = String((L.vendors.find(v => String(v.contact_id) === vid) || {}).contact_name || '').toLowerCase();
    for (const [k, d] of Object.entries(cfg.categories)) {
      if (master && (d.vendor_master_categories || []).includes(master)) return k;
      if (name && (d.name_hints || []).some(h => name.includes(h))) return k;
    }
    return null;
  };
  const model = E.buildModel({ company: co, bills, accCat, plan, portal, payments: L.payments, customers: CL.customerIndex(L.customers), categories: cfg.categories, vendorMasterCategory });
  model.coa_ready = !!coaDoc;
  model.vendors = L.vendors;
  return model;
}

const statusOf = async company => store.read(`status_${company}`, {});

// ── Meta ──────────────────────────────────────────────────────────────────────
router.get('/meta', gate(), wrap(async (req, res) => {
  const r = req.cf, cfg = req.cfg, t = today();
  const fyNow = M.fyOf(t);
  const statuses = {};
  for (const c of cfg.companies) statuses[c.id] = await statusOf(c.id);
  res.json({
    rights: { plan: r.plan, payments: r.payments, config: r.config, admin: r.admin },
    me: { id: r.user.id, name: r.user.name || r.user.username },
    companies: cfg.companies.map(c => ({ id: c.id, name: c.name, org_id: c.org_id })),
    categories: CFG.CATEGORY_ORDER.map(k => ({ key: k, label: cfg.categories[k].label, kind: cfg.categories[k].kind })),
    category_config: r.config ? cfg.categories : undefined,
    today: t, current_month: t.slice(0, 7), current_fy: fyNow,
    fys: [M.fyOf(M.addMonths(t.slice(0, 7), -12)), fyNow, M.fyOf(M.addMonths(t.slice(0, 7), 12))],
    status: statuses, vercel: IS_VERCEL, max_upload_mb: MAX_MB,
  });
}));

// ── The month view and the financial-year grid ────────────────────────────────
function viewFilters(q) { return { branch: String(q.branch || '').trim(), vendor: String(q.vendor || '').trim() }; }

router.get('/view', gate(), wrap(async (req, res) => {
  const month = M.isMonth(req.query.month) ? req.query.month : today().slice(0, 7);
  const mode = req.query.mode === 'month_end' ? 'month_end' : 'current';
  const cos = companiesOf(req, req.query.company);
  const models = [];
  for (const co of cos) models.push(await modelOf(req.cfg, co));
  const v = E.monthView(models, { month, mode, today: today(), categories: CFG.CATEGORY_ORDER, filter: viewFilters(req.query) });
  const branches = [...new Set(models.flatMap(m => [...m.parts.map(p => p.branch), ...m.budgets.map(b => b.branch)]).filter(Boolean))].sort();
  res.json({ ...v, branches, coa_ready: models.every(m => m.coa_ready), coa_missing: models.filter(m => !m.coa_ready).map(m => m.company.name), statuses: Object.fromEntries(await Promise.all(cos.map(async c => [c.id, await statusOf(c.id)]))) });
}));

router.get('/fy-grid', gate(), wrap(async (req, res) => {
  const fy = M.isFy(req.query.fy) ? req.query.fy : M.fyOf(today());
  const category = CFG.CATEGORY_ORDER.includes(req.query.category) ? req.query.category : 'rent';
  const models = [];
  for (const co of companiesOf(req, req.query.company)) models.push(await modelOf(req.cfg, co));
  const g = E.fyGrid(models, { fy, category, today: today(), filter: viewFilters(req.query) });
  // the bills behind the cells, for the drill-down
  const keys = new Set(g.rows.flatMap(r => Object.values(r.cells).flatMap(c => c.parts)));
  const parts = {};
  for (const m of models) for (const p of m.parts) if (keys.has(p.key)) { const at = E.partAt(p, today(), today()); parts[p.key] = { ...p, at }; }
  res.json({ ...g, parts });
}));

router.get('/vendors', gate(), wrap(async (req, res) => {
  const co = companyOf(req);
  const q = String(req.query.q || '').trim().toLowerCase();
  const L = await need().sync.lists(co.id);
  const hits = L.vendors.filter(v => !q || String(v.contact_name || '').toLowerCase().includes(q)).slice(0, 40)
    .map(v => ({ id: String(v.contact_id), name: v.contact_name || '', category: v.cf_vendor_category_formatted || v.cf_vendor_category || '', status: v.status || 'active' }));
  res.json({ vendors: hits });
}));

// ── Budgets and commitments ───────────────────────────────────────────────────
function cleanSchedule(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (const s of list.slice(0, 24)) {
    const amount = r2(s.amount);
    if (!M.isDate(s.pay_on) || !(amount > 0)) throw Object.assign(new Error('Each instalment needs a Pay On date and an amount above zero'), { status: 400 });
    out.push({ id: s.id && /^[\w-]{1,40}$/.test(s.id) ? s.id : newId('s'), pay_on: s.pay_on, amount, note: String(s.note || '').slice(0, 200) });
  }
  return out;
}
function cleanBudget(body, partial = false) {
  const b = {};
  const has = k => body[k] !== undefined;
  if (!partial || has('category')) { if (!CFG.CATEGORY_ORDER.includes(body.category)) throw Object.assign(new Error('Choose the category'), { status: 400 }); b.category = body.category; }
  if (!partial || has('planned_month')) { if (!M.isMonth(body.planned_month)) throw Object.assign(new Error('Choose the planned payment month'), { status: 400 }); b.planned_month = body.planned_month; }
  if (!partial || has('amount')) { const a = r2(body.amount); if (!(a > 0)) throw Object.assign(new Error('The finalised budget must be an amount above zero'), { status: 400 }); b.amount = a; }
  for (const k of ['branch', 'vendor_id', 'vendor_name', 'client', 'period_label', 'connection', 'notes']) if (has(k)) b[k] = String(body[k] || '').trim().slice(0, k === 'notes' ? 1000 : 200);
  if (has('expects_more_bills')) b.expects_more_bills = !!body.expects_more_bills;
  if (has('schedule')) b.schedule = cleanSchedule(body.schedule) || [];
  return b;
}

/** Budget lines (all months) of a company or all companies — to link a bill to any month's line */
router.get('/budgets', gate(), wrap(async (req, res) => {
  const out = [];
  for (const co of companiesOf(req, req.query.company)) {
    const plan = await store.read(`plan_${co.id}`, planDef());
    for (const b of plan.budgets || []) {
      if (b.deleted || (req.query.category && b.category !== req.query.category)) continue;
      out.push({ ...b, company: co.id, company_name: co.name });
    }
  }
  out.sort((a, b) => a.planned_month.localeCompare(b.planned_month) || String(a.branch || '').localeCompare(String(b.branch || '')));
  res.json({ budgets: out });
}));

router.post('/budgets', gate('plan'), wrap(async (req, res) => {
  const co = companyOf(req);
  const b = { id: newId('bud'), ...cleanBudget(req.body || {}), created_by: byName(req), created_at: new Date().toISOString() };
  b.original_amount = b.amount;
  await store.update(`plan_${co.id}`, planDef(), p => { p.budgets.push(b); });
  await audit(byName(req), 'budget_added', `${co.name} · ${b.category} · ${b.planned_month} · ₹${b.amount}${b.vendor_name ? ` · ${b.vendor_name}` : ''}${b.client ? ` · client ${b.client}` : ''}`, co.id);
  res.json({ budget: b });
}));

router.put('/budgets/:id', gate('plan'), wrap(async (req, res) => {
  const co = companyOf(req);
  const patch = cleanBudget(req.body || {}, true);
  const out = await store.update(`plan_${co.id}`, planDef(), p => {
    const b = p.budgets.find(x => x.id === req.params.id && !x.deleted);
    if (!b) return { out: null, doc: p };
    const changes = Object.entries(patch).filter(([k, v]) => JSON.stringify(b[k]) !== JSON.stringify(v));
    if (!changes.length) return { out: b, doc: p };
    b.history = [...(b.history || []), ...changes.map(([k, v]) => ({ at: new Date().toISOString(), by: byName(req), field: k, from: b[k] ?? null, to: v }))].slice(-50);
    Object.assign(b, patch, { updated_by: byName(req), updated_at: new Date().toISOString() });
    if (b.original_amount === undefined) b.original_amount = b.amount;   // the first finalised figure is kept for comparison
    return { out: { ...b, changed: changes.map(c => c[0]) }, doc: p };
  });
  if (!out) return bad(res, 404, 'Budget line not found');
  if (out.changed?.length) await audit(byName(req), 'budget_changed', `${co.name} · ${out.category} · ${out.planned_month}: ${out.changed.join(', ')}`, co.id);
  res.json({ budget: out });
}));

router.delete('/budgets/:id', gate('plan'), wrap(async (req, res) => {
  const co = companyOf(req);
  const out = await store.update(`plan_${co.id}`, planDef(), p => {
    const b = p.budgets.find(x => x.id === req.params.id && !x.deleted);
    if (!b) return { out: null, doc: p };
    Object.assign(b, { deleted: true, deleted_by: byName(req), deleted_at: new Date().toISOString() });
    for (const meta of Object.values(p.parts)) if (meta.budget_id === b.id) delete meta.budget_id;
    return { out: b, doc: p };
  });
  if (!out) return bad(res, 404, 'Budget line not found');
  await audit(byName(req), 'budget_removed', `${co.name} · ${out.category} · ${out.planned_month} · ₹${out.amount}`, co.id);
  res.json({ ok: true });
}));

/** Copy a month's budget lines (e.g. last month's rent) to another month — amounts and commitments as they are */
router.post('/budgets/copy', gate('plan'), wrap(async (req, res) => {
  const co = companyOf(req);
  const { from_month, to_month, category } = req.body || {};
  if (!M.isMonth(from_month) || !M.isMonth(to_month) || from_month === to_month) return bad(res, 400, 'Choose the month to copy from and a different month to copy to');
  if (category && !CFG.CATEGORY_ORDER.includes(category)) return bad(res, 400, 'Unknown category');
  const added = await store.update(`plan_${co.id}`, planDef(), p => {
    const src = p.budgets.filter(b => !b.deleted && b.planned_month === from_month && (!category || b.category === category));
    const same = b => [b.category, b.branch, b.vendor_id, b.client].map(x => String(x || '').trim().toLowerCase()).join('|');
    const have = new Set(p.budgets.filter(b => !b.deleted && b.planned_month === to_month).map(same));
    const at = new Date().toISOString();
    const add = src.filter(b => !have.has(same(b))).map(b => ({
      id: newId('bud'), category: b.category, planned_month: to_month, amount: b.amount, original_amount: b.amount, branch: b.branch || '', vendor_id: b.vendor_id || '',
      vendor_name: b.vendor_name || '', client: b.client || '', period_label: '', connection: b.connection || '', notes: b.notes || '', expects_more_bills: !!b.expects_more_bills,
      created_by: byName(req), created_at: at, copied_from: b.id,
    }));
    p.budgets.push(...add);
    return { out: add.length, doc: p };
  });
  await audit(byName(req), 'budget_copied', `${co.name}: ${added} line(s) ${from_month} → ${to_month}${category ? ` (${category})` : ''}`, co.id);
  res.json({ added });
}));

// ── Bills: link to a budget, client, planned month, schedule, remarks ─────────
const KEY_RE = /^\d{1,25}:(brokerage|rent|electricity)$/;
router.put('/parts/:key', gate('plan'), wrap(async (req, res) => {
  const co = companyOf(req);
  if (!KEY_RE.test(req.params.key)) return bad(res, 400, 'Unknown bill');
  const body = req.body || {};
  const patch = {};
  if (body.budget_id !== undefined) patch.budget_id = body.budget_id === null ? null : String(body.budget_id || '');
  if (body.client !== undefined) patch.client = String(body.client || '').trim().slice(0, 200);
  if (body.meter !== undefined) patch.meter = String(body.meter || '').trim().slice(0, 80);
  if (body.planned_month !== undefined) { if (body.planned_month && !M.isMonth(body.planned_month)) return bad(res, 400, 'Planned month must be a month'); patch.planned_month = body.planned_month || ''; }
  if (body.schedule !== undefined) patch.schedule = cleanSchedule(body.schedule) || [];
  if (body.remarks !== undefined) patch.remarks = String(body.remarks || '').slice(0, 1000);
  const out = await store.update(`plan_${co.id}`, planDef(), p => {
    if (patch.budget_id && !p.budgets.some(b => b.id === patch.budget_id && !b.deleted && b.category === req.params.key.split(':')[1])) return { out: 'no_budget', doc: p };
    const meta = p.parts[req.params.key] || {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'budget_id' && v === null) delete meta.budget_id;     // back to the automatic link
      else meta[k] = v;
    }
    meta.updated_by = byName(req); meta.updated_at = new Date().toISOString();
    p.parts[req.params.key] = meta;
    return { out: meta, doc: p };
  });
  if (out === 'no_budget') return bad(res, 400, 'That budget line does not exist for this category');
  await audit(byName(req), 'bill_updated', `${co.name} · ${req.params.key}: ${Object.keys(patch).join(', ')}`, co.id);
  res.json({ part: out });
}));

// ── Payment initiation ────────────────────────────────────────────────────────
const INIT_STATUS = ['initiated', 'settled', 'failed', 'cancelled'];
function cleanInitiation(body, partial = false) {
  const i = {};
  if (!partial || body.date !== undefined) { if (!M.isDate(body.date)) throw Object.assign(new Error('Initiation date is required'), { status: 400 }); i.date = body.date; }
  if (!partial || body.amount !== undefined) { const a = r2(body.amount); if (!(a > 0)) throw Object.assign(new Error('Initiated amount must be above zero'), { status: 400 }); i.amount = a; }
  if (body.reference !== undefined) i.reference = String(body.reference || '').trim().slice(0, 200);
  if (!partial || body.status !== undefined) { const s = body.status || 'initiated'; if (!INIT_STATUS.includes(s)) throw Object.assign(new Error('Unknown status'), { status: 400 }); i.status = s; }
  return i;
}
router.post('/parts/:key/initiations', gate('payments'), wrap(async (req, res) => {
  const co = companyOf(req);
  if (!KEY_RE.test(req.params.key)) return bad(res, 400, 'Unknown bill');
  const i = { id: newId('ini'), ...cleanInitiation(req.body || {}), by: byName(req), at: new Date().toISOString() };
  await store.update(`plan_${co.id}`, planDef(), p => { const m = p.parts[req.params.key] || {}; m.initiations = [...(m.initiations || []), i]; p.parts[req.params.key] = m; });
  await audit(byName(req), 'initiation_added', `${co.name} · ${req.params.key}: ₹${i.amount} on ${i.date}${i.reference ? ` (${i.reference})` : ''}`, co.id);
  res.json({ initiation: i });
}));
router.put('/parts/:key/initiations/:id', gate('payments'), wrap(async (req, res) => {
  const co = companyOf(req);
  const patch = cleanInitiation(req.body || {}, true);
  const out = await store.update(`plan_${co.id}`, planDef(), p => {
    const i = (p.parts[req.params.key]?.initiations || []).find(x => x.id === req.params.id);
    if (!i) return { out: null, doc: p };
    i.history = [...(i.history || []), { at: new Date().toISOString(), by: byName(req), from: { status: i.status, amount: i.amount, date: i.date, reference: i.reference } }].slice(-20);
    Object.assign(i, patch, { updated_by: byName(req), updated_at: new Date().toISOString() });
    return { out: i, doc: p };
  });
  if (!out) return bad(res, 404, 'Initiation record not found');
  await audit(byName(req), 'initiation_changed', `${co.name} · ${req.params.key}: ${JSON.stringify(patch)}`, co.id);
  res.json({ initiation: out });
}));
router.delete('/parts/:key/initiations/:id', gate('payments'), wrap(async (req, res) => {
  const co = companyOf(req);
  const out = await store.update(`plan_${co.id}`, planDef(), p => {
    const m = p.parts[req.params.key];
    const i = (m?.initiations || []).find(x => x.id === req.params.id);
    if (!i) return { out: null, doc: p };
    m.initiations = m.initiations.filter(x => x.id !== req.params.id);
    return { out: i, doc: p };
  });
  if (!out) return bad(res, 404, 'Initiation record not found');
  await audit(byName(req), 'initiation_removed', `${co.name} · ${req.params.key}: ₹${out.amount} on ${out.date}`, co.id);
  res.json({ ok: true });
}));

// ── Advances: budget line / category of an advance payment ────────────────────
router.put('/advances/:pid', gate('plan'), wrap(async (req, res) => {
  const co = companyOf(req);
  if (!/^\d{1,25}$/.test(req.params.pid)) return bad(res, 400, 'Unknown payment');
  const { budget_id, category } = req.body || {};
  if (category && !CFG.CATEGORY_ORDER.includes(category)) return bad(res, 400, 'Unknown category');
  const out = await store.update(`plan_${co.id}`, planDef(), p => {
    if (budget_id && !p.budgets.some(b => b.id === budget_id && !b.deleted)) return { out: 'no_budget', doc: p };
    p.advances[req.params.pid] = { ...(p.advances[req.params.pid] || {}), ...(budget_id !== undefined ? { budget_id: String(budget_id || '') } : {}), ...(category !== undefined ? { category: category || '' } : {}),
      updated_by: byName(req), updated_at: new Date().toISOString() };
    return { out: p.advances[req.params.pid], doc: p };
  });
  if (out === 'no_budget') return bad(res, 400, 'That budget line does not exist');
  await audit(byName(req), 'advance_updated', `${co.name} · payment ${req.params.pid}: ${JSON.stringify(req.body || {})}`, co.id);
  res.json({ advance: out });
}));

// ── Payment advice slips (one or more files per Zoho payment) ─────────────────
const SLIP_TYPES = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|application\/vnd\.openxmlformats-officedocument\.(spreadsheetml\.sheet|wordprocessingml\.document)|application\/vnd\.ms-excel|text\/csv)$/;
router.post('/slips/:pid', gate('payments'), upload.single('file'), wrap(async (req, res) => {
  const co = companyOf(req);
  if (!/^\d{1,25}$/.test(req.params.pid)) return bad(res, 400, 'Unknown payment');
  if (!req.file) return bad(res, 400, 'Choose a file');
  if (!SLIP_TYPES.test(req.file.mimetype)) return bad(res, 400, 'PDF, image, Excel, Word or CSV files only');
  const sha = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  await files.save(sha, req.file.buffer, req.file.mimetype);
  const name = Buffer.from(req.file.originalname || 'slip', 'latin1').toString('utf8').slice(0, 180);
  const slip = { sha, name, size: req.file.size, type: req.file.mimetype, by: byName(req), at: new Date().toISOString() };
  await store.update(`plan_${co.id}`, planDef(), p => { const l = p.slips[req.params.pid] || []; if (!l.some(s => s.sha === sha)) l.push(slip); p.slips[req.params.pid] = l; });
  await audit(byName(req), 'slip_added', `${co.name} · payment ${req.params.pid}: ${name}`, co.id);
  res.json({ slip });
}));
router.delete('/slips/:pid/:sha', gate('payments'), wrap(async (req, res) => {
  const co = companyOf(req);
  const out = await store.update(`plan_${co.id}`, planDef(), p => {
    const l = p.slips[req.params.pid] || [];
    const s = l.find(x => x.sha === req.params.sha);
    if (!s) return { out: null, doc: p };
    p.slips[req.params.pid] = l.filter(x => x.sha !== req.params.sha);
    return { out: s, doc: p };
  });
  if (!out) return bad(res, 404, 'Slip not found');
  await audit(byName(req), 'slip_removed', `${co.name} · payment ${req.params.pid}: ${out.name}`, co.id);
  res.json({ ok: true });
}));
// …/file/… links may carry the login token as ?token= (server/index.js)
router.get('/file/:company/:pid/:sha', gate(), wrap(async (req, res) => {
  const co = companyOf(req, req.params.company);
  const plan = await store.read(`plan_${co.id}`, planDef());
  const s = (plan.slips?.[req.params.pid] || []).find(x => x.sha === req.params.sha);
  if (!s) return bad(res, 404, 'Slip not found');
  const buf = await files.read(s.sha);
  if (!buf) return bad(res, 404, 'The file is missing from storage');
  res.setHeader('Content-Type', s.type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(s.name)}`);
  res.send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
}));

// ── Refresh from Zoho, status ─────────────────────────────────────────────────
router.get('/status', gate(), wrap(async (req, res) => {
  const out = {};
  for (const c of req.cfg.companies) out[c.id] = await statusOf(c.id);
  res.json({ status: out });
}));

/** Reads bill details for one company (or all) — online in the background after answering, on the office PC the same */
router.post('/refresh', gate('config'), wrap(async (req, res) => {
  const cos = companiesOf(req, req.body?.company);
  const seconds = Number(IS_VERCEL ? req.cfg.settings.step_seconds_online : req.cfg.settings.step_seconds_pc) || 230;
  const until = Date.now() + seconds * 1000;
  const by = byName(req);
  const work = (async () => { for (const c of cos) { if (Date.now() > until - 20000) break; try { await need().sync.step(c.id, { until, by, forceCoa: !!req.body?.reload_accounts }); } catch (e) { console.error('[cashflow] refresh', c.id, e.message); } } })();
  background(work);
  await audit(by, 'refresh', `Refresh from Zoho started (${cos.map(c => c.name).join(', ')})`);
  res.json({ started: true, seconds });
}));

// ── Configuration ─────────────────────────────────────────────────────────────
router.put('/config', gate('config'), wrap(async (req, res) => {
  const patch = CFG.cleanCategoryPatch(req.body?.categories || {});
  const next = await store.update('config', {}, c => {
    c.categories = c.categories || {};
    for (const [k, v] of Object.entries(patch)) c.categories[k] = { ...(c.categories[k] || {}), ...v };
    return c;
  }).then(() => cfgNow());
  await audit(byName(req), 'config_changed', JSON.stringify(patch));
  res.json({ categories: next.categories });
}));

/** The accounts each category picks up in a company's chart of accounts (to check the configuration) */
router.get('/accounts', gate('config'), wrap(async (req, res) => {
  const co = companyOf(req);
  const coaDoc = await store.read(`coa_${co.id}`, null);
  const accCat = CL.accountCategories(coaDoc?.rows || [], req.cfg.categories);
  const by = {};
  for (const a of coaDoc?.rows || []) { const c = accCat.get(a.id); if (c) (by[c] = by[c] || []).push({ id: a.id, name: a.name, parent: a.parent, active: a.active }); }
  res.json({ at: coaDoc?.at || null, accounts: by });
}));

router.get('/audit', gate(), wrap(async (req, res) => {
  const m = M.isMonth(req.query.month) ? req.query.month : today().slice(0, 7);
  res.json({ month: m, entries: (await store.read(`audit_${m}`, [])).slice(-500).reverse() });
}));

// ── Errors ────────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return bad(res, 413, `The file is larger than ${MAX_MB} MB`);
  const status = err.status && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('[cashflow]', err.stack || err.message);
  bad(res, status, err.message || 'Something went wrong');
});

// ── Scheduler: online by Vercel Cron (/api/cron/cashflow), on the office PC every 30 minutes ─────────────
router.cronTick = async ({ maxMs = 230000, source = 'a scheduler call' } = {}) => {
  const cfg = await cfgNow();
  const until = Date.now() + maxMs;
  const out = {};
  for (const c of cfg.companies) {
    if (Date.now() > until - 20000) break;
    try { const st = await need().sync.step(c.id, { until, by: source }); out[c.id] = { fetched: st.fetched_last, remaining: st.remaining, busy: !!st.busy, errors: st.errors }; }
    catch (e) { out[c.id] = { error: e.message }; }
  }
  return out;
};
router.cron = async (req, res) => {
  try { res.json(await router.cronTick({ source: 'Vercel Cron' })); } catch (e) { res.status(500).json({ error: e.message }); }
};
let timer = null;
router.startScheduler = () => {
  if (timer || IS_VERCEL) return;
  const tick = () => router.cronTick({ maxMs: 9 * 60000, source: 'office PC scheduler' }).catch(e => console.error('[cashflow] scheduler', e.message));
  tick();
  timer = setInterval(tick, 30 * 60000);
  if (timer.unref) timer.unref();
};

module.exports = router;
