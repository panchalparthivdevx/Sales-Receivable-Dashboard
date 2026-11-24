/**
 * 26AS Reconciliation — API routes, mounted at /api/tds26as (see server/index.js).
 *
 * Every route needs the app's login (JWT). Rights (User Settings → 26AS Reconciliation, all ticked one by one):
 *   view          module ticked        dashboard, reports, exports, imports list, mapping list
 *   t26_prepare   "Prepare"            Zoho sync, upload Form 26AS statements, re-run reconciliation
 *   t26_review    "Review"             final status, remarks, references / attachments, carry forward, links, client mapping, owners
 *   t26_config    "Configure"          entities (PAN, Zoho organisation, TDS Receivable ledgers), settings, access
 * Admins have every right; a user may be limited to some entities (Settings → Access).
 *
 * Zoho Books is only READ (the Zoho client has GET only). Nothing is written to Zoho or to the Income-tax / TRACES portals.
 * Logic lives in ./lib — see README.md.
 */

'use strict';

const express = require('express');
const multer  = require('multer');

const { loadUsers } = require('../auth');
const store = require('./lib/store');
const files = require('./lib/files');
const CFG = require('./lib/config');
const PER = require('./lib/periods');
const ST = require('./lib/statements');
const CL = require('./lib/clients');
const RV = require('./lib/review');
const RP = require('./lib/reports');
const EX = require('./lib/exporter');
const AUD = require('./lib/audit');
const BS = require('./lib/booksSync');
const RC = require('./lib/recon');
const M = require('./lib/match');
const P26 = require('./lib/parse26as');
const ZR = require('../gstr2b/lib/zohoRead');
const { sha256, todayIST, fmtR, normTan } = require('./lib/util');

const router = express.Router();
const IS_VERCEL = !!process.env.VERCEL;
const MAX_MB = IS_VERCEL ? 4 : 30;

// ── Wiring ────────────────────────────────────────────────────────────────────
let ctx = null;
let usersOf = loadUsers;
const cfgNow = async () => CFG.merge(await store.read('config', null));
router.init = (deps = {}) => {
  if (deps.loadUsers) usersOf = deps.loadUsers;
  const zr = deps.zr || ZR.create({ zoho: deps.zoho });
  const sync = BS.create({ zr, cfgNow, readSynced: deps.readSynced || (async () => null), log: deps.log || console });
  const recon = RC.create({ sync, cfgNow });
  ctx = { zr, sync, recon };
  return ctx;
};
const need = () => ctx || router.init();

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const byName = req => req.t26?.user?.name || req.t26?.user?.username || 'unknown';

// ── Rights and scope ──────────────────────────────────────────────────────────
async function rights(req) {
  const users = await usersOf();
  const u = users.find(x => x.id === req.user?.id);
  if (!u || u.active === false) return { view: false };
  const admin = u.role === 'admin';
  const p = u.permissions?.tds26as;
  const view = admin || p?.enabled === true;
  const sec = k => admin || (view && p?.sections?.[k] === true);
  return { user: u, users, admin, view, prepare: sec('t26_prepare'), review: sec('t26_review'), config: sec('t26_config') };
}
const WHY = { prepare: 'This needs the "Prepare" right (Zoho sync, statement upload).', review: 'This needs the "Review" right (statuses, remarks, carry forward, client mapping).',
  config: 'This needs the "Configure" right (entities, ledgers, settings).', admin: 'Only an administrator can do this.' };
function gate(right) {
  return wrap(async (req, res, next) => {
    const r = await rights(req);
    req.t26 = r;
    if (!r.view) return bad(res, 403, 'You do not have access to 26AS Reconciliation');
    if (right && !r[right]) return bad(res, 403, WHY[right] || 'Not permitted');
    req.cfg = await cfgNow();
    req.acc = CFG.accessOf(req.cfg, r.user);
    next();
  });
}
function entityOf(req, id = req.query.entity || (req.body && req.body.entity)) {
  const e = req.cfg.entities.find(x => x.id === String(id || ''));
  if (!e || !CFG.canSeeEntity(req.acc, e.id)) throw Object.assign(new Error('Choose an entity (Settings → Entities sets them up)'), { status: 404 });
  return e;
}
const periodOf = (q = {}) => PER.resolve({ fy: q.fy, q: q.q, from: q.from, to: q.to });
const people = users => users.filter(u => u.active !== false && (u.role === 'admin' || u.permissions?.tds26as?.enabled === true)).map(u => ({ id: String(u.id), name: u.name || u.username }));
const orgOf = e => (e.demo ? null : e.org_id);

// ── Meta ──────────────────────────────────────────────────────────────────────
router.get('/meta', gate(), wrap(async (req, res) => {
  const r = req.t26, cfg = req.cfg;
  res.json({
    rights: { prepare: r.prepare, review: r.review, config: r.config, admin: r.admin },
    me: { id: r.user.id, name: r.user.name || r.user.username },
    entities: cfg.entities.filter(e => CFG.canSeeEntity(req.acc, e.id)),
    settings: cfg.settings, sync: cfg.sync, schedule: cfg.schedule, statuses: M.STATUS, methods: M.METHOD, booking_status: P26.BOOKING_STATUS, definitions: RP.DEFINITIONS,
    people: people(r.users), admin_users: r.admin ? r.users.filter(u => u.active !== false).map(u => ({ id: String(u.id), name: u.name || u.username, role: u.role })) : undefined,
    access: r.admin ? cfg.access : undefined, today: todayIST(), current_fy: PER.fyOf(todayIST()),
    integrations: { zoho: need().zr.identity(), read_only: true, vercel: IS_VERCEL, max_upload_mb: MAX_MB, scheduler: !IS_VERCEL },
  });
}));

// ── Configuration ─────────────────────────────────────────────────────────────
async function saveConfig(patch, by, action, detail, entity = '') {
  const next = await store.withLock('config', async () => { const c = CFG.merge(await store.read('config', null)); const n = { ...c, ...patch }; await store.write('config', n); return n; });
  await AUD.log({ by, action, entity, detail });
  need().recon.bump();
  return next;
}

router.post('/onboard/zoho-orgs', gate('config'), wrap(async (req, res) => {
  try { res.json({ organizations: await need().zr.listOrganizations() }); } catch (e) { bad(res, 502, need().zr.errText(e)); }
}));

/** TDS Receivable ledgers of an organisation: asset accounts whose name says TDS / 194x, with the section read from the name */
router.post('/onboard/ledgers', gate('config'), wrap(async (req, res) => {
  const org = String(req.body?.org_id || '');
  if (!/^\d{6,20}$/.test(org)) return bad(res, 400, 'Enter the Zoho organisation id first');
  const zr = need().zr;
  try {
    const all = [];
    for (let page = 1; page <= 40; page++) {
      const d = await zr.get(org, '/chartofaccounts', { filter_by: 'AccountType.All', sort_column: 'account_name', per_page: 200, page }, { paceMs: 700 });
      all.push(...(d.chartofaccounts || []));
      if (!(d.page_context && d.page_context.has_more_page)) break;
    }
    const assetish = a => /asset|receivable/i.test(String(a.account_type || '')) && !/payable/i.test(String(a.account_type || ''));
    const looks = a => /tds|tax deducted|19[2-6][a-z]?/i.test(`${a.account_name} ${a.parent_account_name || ''}`) && assetish(a);
    const list = all.filter(looks).map(a => ({ account_id: String(a.account_id), name: a.account_name, parent: a.parent_account_name || '', type: a.account_type, active: a.is_active !== false,
      section: CFG.ledgerSection(a.account_name), fy_label: CFG.ledgerFy(a.account_name), suggested: a.is_active !== false && /receivable|19[2-6]/i.test(`${a.account_name} ${a.parent_account_name || ''}`) }));
    res.json({ accounts: list, scanned: all.length });
  } catch (e) { bad(res, 502, zr.errText(e)); }
}));

router.post('/onboard/check', gate('config'), wrap(async (req, res) => {
  const e = entityOf(req);
  const zr = need().zr, out = [];
  const probe = async (label, path, params) => { try { await zr.get(e.org_id, path, params, { paceMs: 600 }); out.push({ label, ok: true }); } catch (x) { out.push({ label, ok: false, message: zr.errText(x) }); } };
  await probe('Organisation', `/organizations/${e.org_id}`, {});
  for (const l of e.ledgers) await probe(`Ledger postings — ${l.name}`, '/chartofaccounts/transactions', { account_id: l.account_id, date_start: `${PER.fyOf(todayIST()).slice(0, 4)}-04-01`, date_end: todayIST(), per_page: 1 });
  await probe('Invoices', '/invoices', { per_page: 1 });
  await probe('Customer payments', '/customerpayments', { per_page: 1 });
  await probe('Journals', '/journals', { per_page: 1 });
  res.json({ ok: out.every(x => x.ok), results: out, read_only: true, credentials: zr.identity() });
}));

router.put('/config/entities', gate('config'), wrap(async (req, res) => {
  const cur = req.cfg.entities;
  const v = CFG.validateEntities(req.body?.entities, cur);
  if (v.error) return bad(res, 400, v.error);
  const removed = cur.filter(c => !v.entities.some(n => n.id === c.id));
  if (removed.length && !req.t26.admin) return bad(res, 403, 'Only an administrator can remove an entity');
  if (removed.some(r => !r.demo)) return bad(res, 409, `Removing an entity is not allowed here (its statements and decisions are kept): set it to inactive instead — ${removed.map(r => r.name).join(', ')}`);
  const next = await saveConfig({ entities: v.entities }, byName(req), 'config.entities', v.entities.map(e => `${e.short} ${e.pan} org ${e.org_id || '—'} · ${e.ledgers.length} ledger(s)`).join('; '));
  res.json({ entities: next.entities });
}));
router.put('/config/settings', gate('config'), wrap(async (req, res) => {
  const v = CFG.validateSettings(req.body || {}, req.cfg.settings);
  if (v.error) return bad(res, 400, v.error);
  const next = await saveConfig({ settings: v.settings }, byName(req), 'config.settings', JSON.stringify(v.settings).slice(0, 400));
  res.json({ settings: next.settings });
}));
router.put('/config/schedule', gate('config'), wrap(async (req, res) => {
  const times = (req.body?.times || []).map(String).filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).slice(0, 6);
  const next = await saveConfig({ schedule: { enabled: req.body?.enabled !== false, times: times.length ? times : CFG.DEFAULT_CONFIG.schedule.times } }, byName(req), 'config.schedule', JSON.stringify(req.body || {}).slice(0, 200));
  res.json({ schedule: next.schedule });
}));
router.put('/config/access', gate('config'), wrap(async (req, res) => {
  if (!req.t26.admin) return bad(res, 403, WHY.admin);
  const v = CFG.validateAccess(req.body?.access, req.cfg.entities);
  const next = await saveConfig({ access: v.access }, byName(req), 'config.access', JSON.stringify(v.access).slice(0, 400));
  res.json({ access: next.access });
}));

// ── Zoho sync (read-only) ─────────────────────────────────────────────────────
router.get('/sync/status', gate(), wrap(async (req, res) => {
  const e = entityOf(req);
  const st = await need().sync.status(e.id);
  res.json({ ...st, entity: e.id, budget: req.cfg.sync.daily_budget });
}));
/** One step of a sync (the page keeps calling while `more` is true; online a step stays inside Vercel's time limit) */
router.post('/sync/step', gate('prepare'), wrap(async (req, res) => {
  const e = entityOf(req);
  if (e.demo) return bad(res, 400, 'The demo entity has no Zoho organisation — its data is synthetic');
  const b = req.body || {};
  let from = b.from, to = b.to;
  if (b.start) { const p = periodOf(b); from = p.from; to = p.to > todayIST() ? todayIST() : p.to; }
  const r = await need().sync.step({ entity: e, from: b.start ? from : undefined, to: b.start ? to : undefined, mode: b.mode === 'full' ? 'full' : 'changes', by: byName(req), maxMs: Math.min(req.cfg.sync.step_seconds, IS_VERCEL ? 200 : 600) * 1000 });
  if (b.start) await AUD.log({ by: byName(req), action: 'sync.start', entity: e.id, detail: `${from} to ${to} (${b.mode === 'full' ? 'full' : 'changes'})` });
  if (!r.more && !r.busy) { need().recon.bump(); await need().recon.settlePass(e).catch(x => console.error('[tds26as] settle:', x.message)); if (!r.error) await AUD.log({ by: byName(req), action: 'sync.done', entity: e.id, detail: `calls ${r.calls}` }); }
  res.json(r);
}));
router.post('/sync/cancel', gate('prepare'), wrap(async (req, res) => { const e = entityOf(req); res.json(await need().sync.cancel(e.id)); }));

// ── Form 26AS import ──────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });
const oneFile = (req, res, next) => upload.single('file')(req, res, err => (err ? bad(res, 400, err.code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${MAX_MB} MB${IS_VERCEL ? ' (online uploads are limited to 4 MB — upload larger files from the office PC)' : ''}` : err.message) : next()));
router.post('/import/preview', gate('prepare'), oneFile, wrap(async (req, res) => {
  if (!req.file) return bad(res, 400, 'Choose a Form 26AS file (PDF, Excel, or the TRACES text / ZIP)');
  const e = entityOf(req, req.body?.entity);
  try {
    const pv = await ST.preview({ buffer: req.file.buffer, fileName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), password: req.body?.password || '', entity: e, by: byName(req), settings: req.cfg.settings });
    res.json(pv);
  } catch (x) { bad(res, x.status || 400, x.message, { needs_password: !!x.needs_password, wrong_password: !!x.wrong_password }); }
}));
router.post('/import/commit', gate('prepare'), wrap(async (req, res) => {
  const e = entityOf(req);
  let r;
  try { r = await ST.commit({ previewId: String(req.body?.preview_id || ''), entity: e, fy: req.body?.fy, statementDate: req.body?.statement_date, ack: !!req.body?.ack, by: byName(req), settings: req.cfg.settings }); }
  catch (x) { return bad(res, x.status || 400, x.message, { needs_ack: !!x.needs_ack, blockers: x.blockers }); }
  if (!r.unchanged) {
    const s = r.statement;
    await AUD.log({ by: byName(req), action: 'import.statement', entity: e.id, ref: s.id, detail: `FY ${s.fy} v${s.version} dated ${s.statement_date}${s.active ? ' (in use)' : ' (history)'} — ${s.totals.rows} rows, deposited ${fmtR(s.totals.deposited)}${s.revision ? `; revision +${s.revision.added} −${s.revision.removed} ~${s.revision.changed}` : ''}; sha256 ${s.sha256}` });
    need().recon.bump();
    await need().recon.settlePass(e).catch(x => console.error('[tds26as] settle:', x.message));
  }
  res.json(r);
}));
router.get('/imports', gate(), wrap(async (req, res) => { const e = entityOf(req); res.json({ statements: (await ST.list(e.id)).reverse() }); }));
router.get('/imports/:id', gate(), wrap(async (req, res) => {
  const doc = await ST.get(req.params.id);
  if (!doc) return bad(res, 404, 'Statement not found');
  entityOf(req, doc.meta.entity);
  res.json({ meta: doc.meta, header: doc.header, deductors: doc.deductors, credits: doc.credits.slice(0, 3000), problems: doc.problems, revision: doc.revision });
}));
router.get('/imports/:id/file', gate(), wrap(async (req, res) => {
  const doc = await ST.get(req.params.id);
  if (!doc) return bad(res, 404, 'Statement not found');
  entityOf(req, doc.meta.entity);
  const buf = await files.read(doc.meta.sha256);
  if (!buf) return bad(res, 404, 'The original file is not stored on this copy of the dashboard');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.meta.file_name.replace(/[^\w.() -]/g, '_')}"`);
  res.send(buf);
}));

// ── Reconciliation views ──────────────────────────────────────────────────────
async function runFor(req) {
  const e = entityOf(req);
  const period = periodOf(req.query);
  const { d, res } = await need().recon.run(e, period);
  return { e, period, d, res };
}
async function coverageOf(e, period, d) {
  const z = await need().sync.coverage(e.id, period.from, period.to > todayIST() ? todayIST() : period.to);
  const fys = [...new Set(PER.quartersBetween(period.from, period.to).map(q => PER.parseQ(q).fy))];
  const quarters = PER.quartersBetween(period.from, period.to).map(q => {
    const p = PER.parseQ(q), st = d.statements.find(s => s.fy === p.fy), due = PER.filingDue(p.fy, p.q);
    return { quarter: q, label: PER.qLabel(q), statement_date: st ? st.statement_date : null, filing_due: due, state: !st ? 'missing' : st.statement_date < due ? 'early' : 'complete' };
  });
  return { zoho: z, statements: fys.map(fy => d.statements.find(s => s.fy === fy) || { fy, missing: true }), quarters, gaps: [...z.missing.map(m => `Zoho ledgers not synced for ${m}`), ...quarters.filter(q => q.state !== 'complete').map(q => q.state === 'missing' ? `No Form 26AS uploaded for ${q.label}` : `${q.label}: statement dated ${q.statement_date}, before the ${q.filing_due} filing date — credits may be incomplete`)] };
}

router.get('/recon/dashboard', gate(), wrap(async (req, res) => {
  const { e, period, d, res: r } = await runFor(req);
  const dash = RP.dashboard(d, r, period);
  res.json({ entity: e.id, period, ...dash, coverage: await coverageOf(e, period, d), sync: { last_ok_at: d.sync.last_ok_at || null, running: d.sync.running, last_error: d.sync.last_error || null },
    mapping: { groups: d.clientsDoc.groups.length, by_tan: new Set([...d.clients.byEntry.values()].filter(CL.isAuto)).size }, statements: d.statements });
}));

router.get('/recon/units', gate(), wrap(async (req, res) => {
  const { e, d, res: r } = await runFor(req);
  const mp = RP.maps(d);
  const list = RP.sortUnits(RP.filterUnits(r.units, req.query, d));
  const limit = Math.min(Number(req.query.limit) || 500, 3000);
  const groups = [...d.clients.groups.values()].map(g => ({ id: g.id, name: g.name, tans: g.tans.map(t => t.tan) })).sort((a, b) => a.name.localeCompare(b.name));
  res.json({ total: list.length, units: list.slice(0, limit).map(u => RP.unitView(u, d, mp, orgOf(e))), groups,
    sums: { zoho: list.reduce((a, u) => a + u.z_amount, 0), deducted: list.reduce((a, u) => a + u.deducted, 0), deposited: list.reduce((a, u) => a + u.deposited, 0), diff: list.reduce((a, u) => a + u.diff, 0), open_zoho: list.reduce((a, u) => a + u.open_zoho, 0), open_26as: list.reduce((a, u) => a + u.open_26as, 0) },
    sections: [...new Set(r.units.flatMap(u => u.sections))].sort() });
}));
router.get('/recon/unit', gate(), wrap(async (req, res) => {
  const { e, d, res: r } = await runFor(req);
  const u = r.units.find(x => x.id === String(req.query.id || ''));
  if (!u) return bad(res, 404, 'This item is not in the selected period any more (the data changed) — reload the list');
  const mp = RP.maps(d);
  const history = [...u.zoho, ...u.credits].map(k => ({ key: k, history: ((d.review.items[k] || {}).history) || [] }));
  const links = d.review.links.filter(l => [...l.zoho, ...l.credits].some(k => u.zoho.includes(k) || u.credits.includes(k)));
  res.json({ unit: RP.unitView(u, d, mp, orgOf(e)), comparison: RP.comparison(u, mp), history, links,
    evidence: u.evidence.map(x => ({ ...x, credit_line: x.credit ? RP.cBrief(mp.cBy.get(x.credit)) : null, zoho_line: x.zoho && mp.zBy.get(x.zoho) ? RP.zBrief(mp.zBy.get(x.zoho), orgOf(e)) : null })) });
}));
router.get('/reports/followup', gate(), wrap(async (req, res) => {
  const { period, d, res: r } = await runFor(req);
  const fu = RP.followUp(d, r, period, people(req.t26.users));
  let rows = fu.rows;
  if (req.query.group) rows = rows.filter(x => x.id === req.query.group);
  if (req.query.tan) rows = rows.filter(x => x.tans.includes(normTan(req.query.tan)));
  if (req.query.only_open === '1') rows = rows.filter(x => x.follow_up > 0 || x.open_units.length);
  if (req.query.status || req.query.section) { const keep = new Set(RP.filterUnits(r.units, { status: req.query.status, section: req.query.section }, d).map(u => u.id)); rows = rows.filter(x => x.units.some(id => keep.has(id))); }
  res.json({ ...fu, rows, all_totals: fu.totals, period });
}));
router.get('/reports/corrections', gate(), wrap(async (req, res) => {
  const { e, d, res: r } = await runFor(req);
  const cr = RP.corrections(d, r, orgOf(e));
  let rows = cr.rows;
  if (req.query.kind) rows = rows.filter(x => x.kind === req.query.kind);
  if (req.query.group) { const ids = new Set(r.units.filter(u => u.group === req.query.group).map(u => u.id)); rows = rows.filter(x => ids.has(x.unit)); }
  res.json({ ...cr, rows });
}));
router.get('/reports/carryforward', gate(), wrap(async (req, res) => {
  const e = entityOf(req);
  const period = periodOf(req.query);
  const d = await need().recon.load(e);
  res.json(RP.carryForward(d, period.from, period.to, req.query.by === 'fy' ? 'fy' : 'quarter'));
}));
router.get('/recon/transfers', gate(), wrap(async (req, res) => { const { period, d } = await runFor(req); res.json({ transfers: d.books.transfers.filter(t => t.date >= period.from && t.date <= period.to) }); }));

// ── Client mapping ────────────────────────────────────────────────────────────
router.get('/clients', gate(), wrap(async (req, res) => {
  const e = entityOf(req);
  const d = await need().recon.load(e);
  const s = CL.suggestions(d.clientsDoc, d.items, d.credits, d.clients);
  // totals per client as the matching sees them: an entry counts where the TAN rule placed it
  const stats = new Map([...d.clients.groups.keys()].map(id => [id, { zoho: 0, credits: 0, entries: 0, n_credits: 0, per_customer: {} }]));
  for (const z of d.items) {
    const g = d.clients.byEntry.get(z.key);
    if (!g || !stats.has(g)) continue;
    const st = stats.get(g);
    st.zoho += z.amount; st.entries++;
    st.per_customer[z.customer_id] = (st.per_customer[z.customer_id] || 0) + z.amount;
  }
  for (const c of d.credits) { const g = d.clients.byTan.get(c.tan); if (g && stats.has(g)) { stats.get(g).credits += c.deducted; stats.get(g).n_credits++; } }
  const view = g => ({ ...g, totals: stats.get(g.id) });
  const auto = [...d.clients.groups.values()].filter(g => g.auto && (stats.get(g.id).entries || stats.get(g.id).n_credits)).map(view)
    .sort((a, b) => (b.totals.zoho + b.totals.credits) - (a.totals.zoho + a.totals.credits) || a.name.localeCompare(b.name));
  const rejected = Object.entries(d.clientsDoc.rejected || {}).map(([k, v]) => { const [customer_id, tan] = k.split('|'); return { customer_id, tan, ...v }; });
  res.json({ groups: d.clientsDoc.groups.map(g => view(d.clients.groups.get(g.id) || g)), auto, rejected, no_customer: d.clientsDoc.no_customer, ...s, history: (d.clientsDoc.history || []).slice(0, 50) });
}));
const clientsChange = fn => wrap(async (req, res) => {
  const e = entityOf(req);
  const out = await fn(e, req);
  await AUD.log({ by: byName(req), action: 'clients.change', entity: e.id, detail: (out && out.what) || '' });
  need().recon.bump();
  await need().recon.settlePass(e).catch(() => {});
  res.json(out || { ok: true });
});
router.post('/clients/approve', gate('review'), clientsChange((e, req) => CL.approve(e.id, byName(req), (req.body?.suggestions || []).slice(0, 2000))));
router.post('/clients/group', gate('review'), clientsChange((e, req) => CL.saveGroup(e.id, byName(req), req.body?.group || {})));
router.post('/clients/remove', gate('review'), clientsChange((e, req) => CL.removeGroup(e.id, byName(req), String(req.body?.id || ''))));
router.post('/clients/no-customer', gate('review'), clientsChange((e, req) => CL.noCustomer(e.id, byName(req), req.body?.tan, req.body?.on !== false, req.body?.note)));
router.post('/clients/reject', gate('review'), clientsChange((e, req) => CL.reject(e.id, byName(req), String(req.body?.customer_id || ''), req.body?.tan, req.body?.on !== false, req.body?.name)));
router.get('/clients/customers', gate(), wrap(async (req, res) => {
  const e = entityOf(req);
  const d = await need().recon.load(e);
  const m = new Map();
  for (const z of d.items) if (z.customer_id && !m.has(z.customer_id)) m.set(z.customer_id, { id: z.customer_id, name: z.customer_name });
  for (const i of Object.values(d.docs.invoices || {})) if (i.cust && !m.has(i.cust)) m.set(i.cust, { id: i.cust, name: i.cust_name });
  res.json({ customers: [...m.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))) });
}));

// ── Review ────────────────────────────────────────────────────────────────────
router.post('/review/decision', gate('review'), wrap(async (req, res) => {
  const e = entityOf(req);
  const period = periodOf(req.body || {});
  const { res: r } = await need().recon.run(e, period);
  const u = r.units.find(x => x.id === String(req.body?.unit || ''));
  if (!u) return bad(res, 409, 'This item changed since the page was loaded — reload and review it again');
  let out;
  try { out = await RV.decide(e.id, byName(req), u, req.body || {}, period); } catch (x) { return bad(res, x.status || 400, x.message); }
  await AUD.log({ by: byName(req), action: 'review.decision', entity: e.id, ref: u.id, detail: `${M.STATUS[u.status]} → ${req.body.final_status ? M.STATUS[req.body.final_status] : 'system status'}${out.carry_forward ? ` (carry ${fmtR(out.carry_forward.balance)} to ${PER.qLabel(out.carry_forward.target_quarter)})` : ''}${req.body.non_deposit ? ' · confirmed non-deposit' : ''}` });
  need().recon.bump();
  await need().recon.settlePass(e).catch(x => console.error('[tds26as] settle:', x.message));
  res.json(out);
}));
const attachUp = multer({ storage: multer.memoryStorage(), limits: { fileSize: (IS_VERCEL ? 4 : 15) * 1024 * 1024, files: 1 } });
router.post('/review/attachment', gate('review'), (req, res, next) => attachUp.single('file')(req, res, err => (err ? bad(res, 400, err.message) : next())), wrap(async (req, res) => {
  if (!req.file) return bad(res, 400, 'Choose a file');
  entityOf(req, req.body?.entity);
  const sha = sha256(req.file.buffer);
  await files.save(sha, req.file.buffer, req.file.mimetype || 'application/octet-stream');
  res.json({ sha256: sha, name: Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 200), size: req.file.size, by: byName(req), at: new Date().toISOString() });
}));
router.get('/review/attachment/:sha', gate(), wrap(async (req, res) => {
  const e = entityOf(req);
  const rv = await RV.load(e.id);
  const sha = String(req.params.sha);
  const meta = Object.values(rv.items).flatMap(i => i.attachments || []).find(a => a.sha256 === sha);
  if (!meta) return bad(res, 404, 'Attachment not found for this entity');
  const buf = await files.read(sha);
  if (!buf) return bad(res, 404, 'The file is not stored on this copy of the dashboard');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${meta.name.replace(/[^\w.() -]/g, '_')}"`);
  res.send(buf);
}));
router.post('/review/link', gate('review'), wrap(async (req, res) => {
  const e = entityOf(req);
  let l; try { l = await RV.link(e.id, byName(req), (req.body?.zoho || []).map(String), (req.body?.credits || []).map(String), req.body?.note); } catch (x) { return bad(res, x.status || 400, x.message); }
  await AUD.log({ by: byName(req), action: 'review.link', entity: e.id, ref: l.id, detail: `${l.zoho.length} Zoho ↔ ${l.credits.length} 26AS` });
  need().recon.bump();
  res.json(l);
}));
router.post('/review/unlink', gate('review'), wrap(async (req, res) => {
  const e = entityOf(req);
  try { await RV.unlink(e.id, byName(req), String(req.body?.id || '')); } catch (x) { return bad(res, x.status || 400, x.message); }
  await AUD.log({ by: byName(req), action: 'review.unlink', entity: e.id, ref: String(req.body?.id || '') });
  need().recon.bump();
  res.json({ ok: true });
}));
router.post('/review/client', gate('review'), wrap(async (req, res) => {
  const e = entityOf(req);
  const g = String(req.body?.group || '');
  if (!g) return bad(res, 400, 'Which client?');
  const ownerId = req.body?.owner_id;
  const owner = ownerId ? (people(req.t26.users).find(p => p.id === String(ownerId)) || {}).name || '' : req.body?.owner;
  const out = await RV.setClient(e.id, byName(req), g, { owner_id: ownerId, owner, remarks: req.body?.remarks });
  await AUD.log({ by: byName(req), action: 'review.client', entity: e.id, ref: g, detail: `owner ${out.owner || '—'}; remarks ${String(out.remarks || '').slice(0, 120)}` });
  need().recon.bump();
  res.json(out);
}));
router.post('/cf/close', gate('review'), wrap(async (req, res) => {
  const e = entityOf(req);
  let it; try { it = await RV.closeCf(e.id, byName(req), String(req.body?.id || ''), req.body || {}); } catch (x) { return bad(res, x.status || 400, x.message); }
  await AUD.log({ by: byName(req), action: 'cf.close', entity: e.id, ref: it.id, detail: `${fmtR(it.balance)} closed in ${PER.qLabel(it.closure.quarter)}: ${it.closure.reason}` });
  need().recon.bump();
  res.json(it);
}));
router.post('/recon/rerun', gate('prepare'), wrap(async (req, res) => {
  const e = entityOf(req);
  need().recon.bump();
  const settled = await need().recon.settlePass(e);
  await AUD.log({ by: byName(req), action: 'recon.rerun', entity: e.id, detail: `${settled.length} carry-forward item(s) settled` });
  res.json({ settled: settled.length, items: settled.map(x => ({ id: x.id, client: x.client, balance: x.balance, quarter: x.settlement.quarter })) });
}));

// ── Export ────────────────────────────────────────────────────────────────────
router.get('/export/xlsx', gate(), wrap(async (req, res) => {
  const { e, period, d, res: r } = await runFor(req);
  const kind = ['followup', 'transactions', 'corrections', 'carryforward', 'all'].includes(req.query.report) ? req.query.report : 'all';
  const mp = RP.maps(d);
  const dash = RP.dashboard(d, r, period);
  const fu = RP.followUp(d, r, period, people(req.t26.users));
  if (req.query.group) fu.rows = fu.rows.filter(x => x.id === req.query.group);
  if (req.query.tan) fu.rows = fu.rows.filter(x => x.tans.includes(normTan(req.query.tan)));
  let unitsSel = RP.sortUnits(RP.filterUnits(r.units, req.query, d));
  if (kind === 'followup') { const open = new Set(fu.rows.flatMap(x => x.open_units)); unitsSel = unitsSel.filter(u => open.has(u.id)); }
  const cov = await coverageOf(e, period, d);
  const buf = EX.build({
    kind, scope: { entity: e.name, pan: e.pan, period: period.label, filters: Object.entries(req.query).filter(([k, v]) => v && !['entity', 'fy', 'q', 'from', 'to', 'report'].includes(k)).map(([k, v]) => `${k}=${v}`).join(', ') },
    dash, fu, units: unitsSel.map(u => RP.unitView(u, d, mp, orgOf(e))), cr: RP.corrections(d, r, orgOf(e)), cf: RP.carryForward(d, period.from, period.to, req.query.by === 'fy' ? 'fy' : 'quarter'),
    coverage: [{ label: 'Last Zoho sync', value: d.sync.last_ok_at || 'never' }, ...cov.statements.map(s => ({ label: `Form 26AS FY ${s.fy}`, value: s.missing ? 'not uploaded' : `dated ${s.statement_date} (version ${s.version})` })), ...cov.gaps.map(g => ({ label: 'Coverage gap', value: g }))],
    generatedBy: byName(req), today: todayIST(),
  });
  await AUD.log({ by: byName(req), action: 'export.xlsx', entity: e.id, detail: `${kind} · ${period.label}` });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="26AS_${kind}_${e.short.replace(/[^\w-]/g, '')}_${period.label.replace(/[^\w-]+/g, '_')}.xlsx"`);
  res.send(buf);
}));

// ── Audit ─────────────────────────────────────────────────────────────────────
router.get('/audit', gate(), wrap(async (req, res) => {
  const ym = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : new Date().toISOString().slice(0, 7);
  const list = (await AUD.month(ym)).filter(x => !x.entity || CFG.canSeeEntity(req.acc, x.entity) || (req.cfg.entities.every(en => en.id !== x.entity))).reverse().slice(0, 1000);
  res.json({ month: ym, entries: list });
}));
router.get('/audit/verify', gate('config'), wrap(async (req, res) => res.json(await AUD.verify())));

// ── Demo data (synthetic, labelled; admin only) ───────────────────────────────
router.post('/demo/load', gate('config'), wrap(async (req, res) => {
  if (!req.t26.admin) return bad(res, 403, WHY.admin);
  const r = await require('./lib/demo').load({ cfgNow, saveConfig: (patch, detail) => saveConfig(patch, byName(req), 'demo.load', detail), by: byName(req) });
  need().recon.bump();
  for (const e of (await cfgNow()).entities.filter(x => x.demo)) await need().recon.settlePass(e).catch(() => {});
  res.json(r);
}));
router.post('/demo/remove', gate('config'), wrap(async (req, res) => {
  if (!req.t26.admin) return bad(res, 403, WHY.admin);
  const r = await require('./lib/demo').remove({ cfgNow, saveConfig: (patch, detail) => saveConfig(patch, byName(req), 'demo.remove', detail) });
  need().recon.bump();
  res.json(r);
}));

// ── Errors ────────────────────────────────────────────────────────────────────
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.status && err.status < 500) return bad(res, err.status, err.message);
  console.error('[tds26as]', req.method, req.path, err.response?.data?.message || err.stack || err.message);
  bad(res, 500, `Something went wrong: ${err.message}`);
});

// ── Daily "changes" sync on the office PC (current financial year, India time) ─
let timer = null;
router.startScheduler = () => {
  if (timer || IS_VERCEL) return;
  let busy = false, lastStamp = '';
  timer = setInterval(async () => {
    if (busy) return;
    try {
      const cfg = await cfgNow();
      if (!cfg.schedule.enabled) return;
      const ist = new Date(Date.now() + 330 * 60000).toISOString();
      const hhmm = ist.slice(11, 16), stamp = ist.slice(0, 16);
      if (!cfg.schedule.times.includes(hhmm) || stamp === lastStamp) return;
      lastStamp = stamp; busy = true;
      for (const e of cfg.entities.filter(x => x.active && !x.demo && x.ledgers.length)) {
        const st = await need().sync.status(e.id);
        if (!st.last_ok_at) continue;                                     // the first load is started by a person on the page
        const fy = PER.fyRange(PER.fyOf(todayIST()));
        let r = await need().sync.step({ entity: e, from: fy.from, to: todayIST(), mode: 'changes', by: 'schedule', maxMs: 10 * 60000 });
        for (let i = 0; r.more && i < 30; i++) r = await need().sync.step({ entity: e, mode: 'changes', by: 'schedule', maxMs: 10 * 60000 });
        need().recon.bump();
        await need().recon.settlePass(e).catch(() => {});
        await AUD.log({ by: 'schedule', action: 'sync.scheduled', entity: e.id, detail: r.error ? `failed: ${r.error}` : `done, ${r.calls || 0} calls in the last step` });
      }
    } catch (x) { console.error('[tds26as] scheduled sync:', x.message); }
    finally { busy = false; }
  }, 30000);
  if (timer.unref) timer.unref();
};
router.stopScheduler = () => { if (timer) { clearInterval(timer); timer = null; } };

module.exports = router;
