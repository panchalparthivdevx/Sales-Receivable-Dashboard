/**
 * Bill Collection & Booking — API routes, mounted at /api/bill-booking (see server/index.js).
 *
 * Every route needs the app's login (JWT) except the mailbox sign-in callback, which carries its own
 * signed state. Rights (User Settings → Bill Collection & Booking):
 *   view            module ticked                 report, bill details, original files
 *   bb_review       "Review & correct bills"     edit details, choose category / accounts / tax, upload ERP bills, mappings
 *   bb_create_draft "Create Zoho drafts"         create the draft bill in Zoho
 *   bb_config       "Configure"                  team & mailboxes, categories & fields, settings, Zoho checks
 * Admins have all rights; the draft test (writes a test bill to Zoho) is admin only.
 * Logic lives in ./lib — see README.md.
 */

'use strict';

const express = require('express');
const multer  = require('multer');

const { loadUsers } = require('../auth');
const { background } = require('../background');
const store    = require('./lib/store');
const C        = require('./lib/config');
const EX       = require('./lib/extract');
const files    = require('./lib/files');
const ZC       = require('./lib/zohoClient');
const LK       = require('./lib/lookups');
const PL       = require('./lib/pipeline');
const ML       = require('./lib/mail');
const T        = require('./lib/text');

const router = express.Router();
const IS_VERCEL = !!process.env.VERCEL;

// ── Wiring (index.js calls init with the synced-data reader; tests inject fakes) ──
let ctx = null;
let usersOf = loadUsers;
router.init = (deps = {}) => {
  if (!deps.files) files.init();
  if (deps.loadUsers) usersOf = deps.loadUsers;
  const zc = deps.zc || ZC.create({ zoho: deps.zoho });
  const lookups = deps.lookups || LK.create({ store, zc, readSynced: deps.readSynced || (async () => null) });
  const pipeline = PL.create({ store, zc, lookups, files: deps.files || files, extractFn: deps.extractFn, log: deps.log || console });
  const mail = ML.create({ store, pipeline, files: deps.files || files, lookups, http: deps.http, log: deps.log || console });
  ctx = { zc, lookups, pipeline, mail };
  return ctx;
};
const need = () => { if (!ctx) router.init(); return ctx; };

// ── Helpers ───────────────────────────────────────────────────────────────────
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, status, error) => res.status(status).json({ error });

async function rights(req) {
  const users = await usersOf();
  const u = users.find(x => x.id === req.user?.id);
  if (!u || u.active === false) return { view: false };
  const admin = u.role === 'admin';
  const p = u.permissions?.bill_booking;
  const view = admin || p?.enabled === true;
  const sec = k => admin || (view && p?.sections?.[k] === true);
  return { user: u, admin, view, review: sec('bb_review'), draft: sec('bb_create_draft'), config: sec('bb_config') };
}
function gate(right) {
  return wrap(async (req, res, next) => {
    const r = await rights(req);
    req.bb = r;
    if (!r.view) return bad(res, 403, 'You do not have access to Bill Collection & Booking');
    if (right && !r[right]) return bad(res, 403, {
      review: 'Reviewing bills needs the "Review & correct bills" right', draft: 'Creating Zoho drafts needs the "Create Zoho drafts" right',
      config: 'Changing the set-up needs the "Configure" right', admin: 'Only an administrator can do this',
    }[right] || 'Not permitted');
    next();
  });
}
const byName = req => req.bb?.user?.name || req.bb?.user?.username || 'unknown';

async function cfgNow() { return C.merge((await store.snapshot()).doc('bb_config')); }
async function saveCfg(fn, by, action, detail) {
  const out = await store.tx(async t => { const c = C.merge(t.doc('bb_config')); const r = await fn(c); t.setDoc('bb_config', c); return r; });
  await store.audit({ by, action, detail });
  return out;
}

const redirectUri = req => `${process.env.BB_PUBLIC_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`}/api/bill-booking/oauth/callback`;

function publicTeam(team) {
  return team.map(m => ({ ...m, connection: { ...(m.connection || {}) } }));
}

/** One report row (the table and the Excel export) */
function row(b, cfg) {
  const m = cfg.team.find(x => x.id === b.member_id);
  const co = cfg.companies.find(x => x.id === b.company);
  const blocks = (b.issues || []).filter(i => i.severity === 'block' && !i.acked);
  const warns = (b.issues || []).filter(i => i.severity === 'warn');
  const lines = b.lines || [];
  return {
    id: b.id, status: b.status, source: b.source, received_at: b.source_ref?.received_at || b.created_at, created_at: b.created_at, updated_at: b.updated_at,
    mailbox: b.source_ref?.mailbox || '', member_id: b.member_id, member: m?.name || '', from: b.source_ref?.from || '', subject: b.source_ref?.subject || '',
    source_ref: b.source === 'email' ? (b.source_ref?.internet_message_id || b.source_ref?.message_id || '') : (b.source_ref?.erp_ref || ''),
    uploaded_by: b.source === 'erp_upload' ? b.source_ref?.uploaded_by || '' : '',
    file_name: b.source_ref?.attachment_name || b.file?.name, doc_type: b.doc_type?.value || '',
    vendor_id: b.vendor?.id || '', vendor: b.vendor?.name || b.fields?.vendor_name || '', vendor_gstin: b.fields?.vendor_gstin || '',
    company: b.company || '', company_name: co?.name || '', org_id: co?.org_id || '',
    invoice_number: b.fields?.invoice_number || '', invoice_date: b.fields?.invoice_date || '', due_date: b.fields?.due_date || '',
    description: b.fields?.description || lines[0]?.description || '',
    sub_total: b.fields?.sub_total ?? null, tax_total: b.fields?.tax_total ?? null, total: b.fields?.total ?? null, currency: b.fields?.currency || 'INR',
    category_id: b.category?.id || '', category: b.category?.name || '', category_source: b.category?.source || '', category_basis: b.category?.basis || '',
    account: lines.map(l => l.account?.name).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '),
    account_source: lines.map(l => l.account?.source).filter(Boolean)[0] || '',
    account_basis: lines.map(l => l.account?.basis || l.account_issue).filter(Boolean).join(' | '),
    blocks: blocks.length, warns: warns.length,
    exceptions: [...blocks, ...warns].map(i => i.message).slice(0, 6).join(' | '),
    duplicate: b.duplicate?.certainty ? b.duplicate.reason : '',
    zoho_bill_id: b.zoho?.bill_id || '', zoho_bill_number: b.zoho?.bill_number || '', zoho_status: b.zoho?.status || '', zoho_url: b.zoho?.url || '',
    not_draft: !!b.zoho?.not_draft, reviewed_at: b.reviewed?.at || '',
    engine: b.extraction?.engine || '',
  };
}

// ── Mailbox sign-in callback (public: the provider redirects the browser here) ──
router.get('/oauth/callback', wrap(async (req, res) => {
  const page = (title, msg, ok) => res.status(ok ? 200 : 400).type('html').send(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:Figtree,Segoe UI,sans-serif;background:#F9F9F9;color:#18191B;display:flex;align-items:center;justify-content:center;min-height:90vh">
<div style="background:#fff;border:1px solid #DFE7E3;border-radius:12px;padding:28px 32px;max-width:460px">
<h2 style="margin:0 0 8px;color:${ok ? '#1C4942' : '#B91C1C'}">${title}</h2><p style="color:#5D6C7B;line-height:1.5">${String(msg).replace(/[<>&]/g, '')}</p>
<p><a href="/" style="color:#1C4942">Back to the dashboard</a> — you can close this tab.</p></div></body>`);
  if (req.query.error) return page('Mailbox not connected', req.query.error_description || req.query.error, false);
  try {
    const r = await need().mail.completeAuth(req.query.state, req.query.code, redirectUri(req));
    page('Mailbox connected', `${r.member}'s mailbox (${r.account}) is connected. Bills will be collected on the next mailbox check.${r.mismatch ? ' Note: the account signed in differs from the email set up for this member.' : ''}`, true);
  } catch (e) {
    page('Mailbox not connected', e.status ? e.message : 'The sign-in could not be completed. Start again from Team & Mailboxes.', false);
    if (!e.status) console.error('[bill-booking] oauth callback:', e.response?.data?.error || e.message);
  }
}));

// ── Meta / configuration ──────────────────────────────────────────────────────
router.get('/meta', gate(), wrap(async (req, res) => {
  const cfg = await cfgNow();
  const r = req.bb;
  res.json({
    rights: { review: r.review, draft: r.draft, config: r.config, admin: r.admin },
    me: { id: r.user.id, username: r.user.username, name: r.user.name },
    statuses: C.STATUSES, companies: cfg.companies, categories: cfg.categories, team: publicTeam(cfg.team), settings: cfg.settings,
    doc_types: EX.DOC_TYPE_LABEL,
    field_meta: { types: C.FIELD_TYPES, sources: C.FIELD_SOURCES, references: C.REFERENCE_KINDS, zoho_targets: C.ZOHO_TARGETS, extraction_keys: C.EXTRACTION_KEYS },
    integrations: {
      claude: { enabled: EX.claudeEnabled(), model: EX.claudeModel() },
      providers: Object.fromEntries(Object.entries(ML.providers).map(([k, p]) => [k, { label: p.label, configured: p.configured() }])),
      redirect_uri: redirectUri(req), vercel: IS_VERCEL,
    },
  });
}));

router.put('/config/categories', gate('config'), wrap(async (req, res) => {
  const v = C.validateCategories(req.body?.categories);
  if (v.error) return bad(res, 400, v.error);
  await saveCfg(c => { c.categories = v.categories; }, byName(req), 'categories', `${v.categories.length} categories saved`);
  res.json({ categories: v.categories });
}));

router.put('/config/companies', gate('config'), wrap(async (req, res) => {
  const cfg = await cfgNow();
  const v = C.validateCompanies(req.body?.companies, cfg.companies);
  if (v.error) return bad(res, 400, v.error);
  await saveCfg(c => { c.companies = v.companies; }, byName(req), 'companies', v.companies.map(c => `${c.name}: ${c.gstins.join(', ') || '—'}`).join('; '));
  res.json({ companies: v.companies });
}));

router.put('/config/settings', gate('config'), wrap(async (req, res) => {
  const cfg = await cfgNow();
  const input = req.body || {};
  if (input.auto_create_drafts && !Object.values(cfg.settings.draft_capability || {}).some(x => x.verified)) {
    return bad(res, 409, 'Automatic drafts can be switched on only after the Zoho draft test has passed');
  }
  const s = C.validateSettings(input, cfg.settings);
  await saveCfg(c => { c.settings = s; }, byName(req), 'settings', JSON.stringify(input).slice(0, 500));
  res.json({ settings: s });
}));

router.post('/config/team', gate('config'), wrap(async (req, res) => {
  const out = await store.tx(async t => {
    const c = C.merge(t.doc('bb_config'));
    const v = C.validateMember(req.body || {}, c, null);
    if (v.error) return v;
    c.team.push(v.member);
    t.setDoc('bb_config', c);
    return v;
  });
  if (out.error) return bad(res, 400, out.error);
  await store.audit({ by: byName(req), action: 'team_added', detail: `${out.member.name} <${out.member.email}>` });
  res.json({ member: out.member });
}));

router.put('/config/team/:id', gate('config'), wrap(async (req, res) => {
  const out = await store.tx(async t => {
    const c = C.merge(t.doc('bb_config'));
    const cur = c.team.find(m => m.id === req.params.id);
    if (!cur) return { error: 'Team member not found', status: 404 };
    const v = C.validateMember(req.body || {}, c, cur);
    if (v.error) return v;
    c.team = c.team.map(m => (m.id === cur.id ? v.member : m));
    if (v.providerChanged) { const s = { ...(t.doc('bb_secrets') || {}) }; delete s[cur.id]; t.setDoc('bb_secrets', s); }
    t.setDoc('bb_config', c);
    return v;
  });
  if (out.error) return bad(res, out.status || 400, out.error);
  await store.audit({ by: byName(req), action: 'team_changed', detail: `${out.member.name} <${out.member.email}>${out.providerChanged ? ' (mailbox changed — reconnect)' : ''}` });
  res.json({ member: out.member });
}));

router.delete('/config/team/:id', gate('config'), wrap(async (req, res) => {
  const snap = await store.snapshot();
  if (snap.bills.some(b => b.member_id === req.params.id)) return bad(res, 409, 'This member has bills in the report — mark them inactive instead');
  await store.tx(async t => {
    const c = C.merge(t.doc('bb_config'));
    c.team = c.team.filter(m => m.id !== req.params.id);
    t.setDoc('bb_config', c);
    const s = { ...(t.doc('bb_secrets') || {}) }; delete s[req.params.id]; t.setDoc('bb_secrets', s);
  });
  await store.audit({ by: byName(req), action: 'team_removed', detail: req.params.id });
  res.json({ ok: true });
}));

/** Connect a mailbox: the member themself (their dashboard login) or someone with Configure */
async function memberFor(req, res) {
  const cfg = await cfgNow();
  const m = cfg.team.find(x => x.id === req.params.id);
  if (!m) { bad(res, 404, 'Team member not found'); return null; }
  const self = m.dashboard_user && m.dashboard_user === req.bb.user.username;
  if (!req.bb.config && !self) { bad(res, 403, 'Only the member or someone with the Configure right can connect this mailbox'); return null; }
  return m;
}

router.post('/config/team/:id/connect', gate(), wrap(async (req, res) => {
  const m = await memberFor(req, res);
  if (!m) return;
  const p = ML.providers[m.provider];
  if (!p) return bad(res, 400, 'This member has no mailbox to connect');
  if (!p.configured()) return bad(res, 409, `${p.label} is not set up on the server yet — see Settings & Integrations`);
  if (m.provider === 'microsoft_app') {
    try { await need().mail.connectApp(m, req.bb.user); } catch (e) {
      return bad(res, 502, `The company app could not read ${m.email}: ${e.response?.data?.error?.message || e.message}`);
    }
    return res.json({ connected: true });
  }
  res.json({ url: need().mail.authUrl(m, redirectUri(req), req.bb.user) });
}));

router.post('/config/team/:id/disconnect', gate(), wrap(async (req, res) => {
  const m = await memberFor(req, res);
  if (!m) return;
  await need().mail.disconnect(m.id, req.bb.user);
  res.json({ ok: true });
}));

// ── Mail ──────────────────────────────────────────────────────────────────────
router.post('/mail/poll', gate('review'), wrap(async (req, res) => {
  const results = await need().mail.pollAll({ memberId: req.body?.member_id || null, by: byName(req) });
  if (IS_VERCEL) await background(need().pipeline.idle());
  res.json({ results });
}));

router.get('/mail/log', gate(), wrap(async (req, res) => {
  const m = (await store.snapshot()).doc('bb_mail') || {};
  res.json({ log: (m.log || []).slice(0, 100), skipped: (m.skipped || []).slice(0, 300), cursors: m.cursors || {} });
}));

router.post('/mail/skipped/process', gate('review'), wrap(async (req, res) => {
  const r = await need().mail.processSkipped(String(req.body?.key || ''), req.bb.user);
  if (IS_VERCEL) await background(need().pipeline.idle());
  res.json(r);
}));

// ── ERP upload ────────────────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: (IS_VERCEL ? 4 : 25) * 1024 * 1024, files: 50 } });
router.post('/upload', gate('review'), (req, res, next) => upload.array('files', 50)(req, res, err => {
  if (err) return bad(res, 400, err.code === 'LIMIT_FILE_SIZE' ? `Each file must be under ${IS_VERCEL ? 4 : 25} MB` : err.message);
  next();
}), wrap(async (req, res) => {
  const cfg = await cfgNow();
  const company = String(req.body?.company || '');
  if (company && !cfg.companies.some(c => c.id === company)) return bad(res, 400, 'Unknown company');
  const memberId = String(req.body?.member_id || '');
  if (memberId && !cfg.team.some(m => m.id === memberId)) return bad(res, 400, 'Unknown team member');
  if (!req.files?.length) return bad(res, 400, 'Choose at least one bill file');
  const out = [];
  for (const f of req.files) {
    try {
      const r = await need().pipeline.ingest({
        buffer: f.buffer, name: f.originalname, mime: f.mimetype, source: 'erp_upload', member_id: memberId, company,
        source_ref: { erp_ref: String(req.body?.erp_ref || '').slice(0, 120), uploaded_by: byName(req), received_at: new Date().toISOString() },
        by: byName(req),
      });
      out.push({ name: files.fixName(f.originalname), id: r.id });
    } catch (e) { out.push({ name: files.fixName(f.originalname), error: e.message }); }
  }
  if (IS_VERCEL) await background(need().pipeline.idle());
  res.json({ files: out });
}));

// ── Report ────────────────────────────────────────────────────────────────────
router.get('/bills', gate(), wrap(async (req, res) => {
  const cfg = await cfgNow();
  const snap = await store.snapshot();
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  const rows = snap.bills.map(b => row(b, cfg))
    .filter(r => (!from || r.received_at.slice(0, 10) >= from) && (!to || r.received_at.slice(0, 10) <= to))
    .sort((a, b) => b.received_at.localeCompare(a.received_at));
  res.json({ rows, generated_at: new Date().toISOString() });
}));

router.get('/bills/:id', gate(), wrap(async (req, res) => {
  const b = await store.bill(req.params.id);
  if (!b) return bad(res, 404, 'Bill not found');
  const cfg = await cfgNow();
  res.json({ bill: b, row: row(b, cfg) });
}));

router.get('/file/:id', gate(), wrap(async (req, res) => {
  const b = await store.bill(req.params.id);
  if (!b) return bad(res, 404, 'Bill not found');
  const buf = await files.read(b.id, b.file.name);
  if (!buf) return bad(res, 404, 'The original file is missing');
  res.setHeader('Content-Type', b.file.type);
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(b.source_ref?.attachment_name || b.file.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buf);
}));

/** Accounts, taxes, branches and projects of a company's Zoho organisation (cached) */
router.get('/lookups', gate(), wrap(async (req, res) => {
  const cfg = await cfgNow();
  const co = cfg.companies.find(c => c.id === req.query.company);
  if (!co) return bad(res, 400, 'Choose a company');
  const { lookups, zc } = need();
  const out = { accounts: [], taxes: [], branches: [], projects: [], errors: [] };
  for (const k of ['accounts', 'taxes', 'branches', 'projects']) {
    try { out[k] = await lookups[k](co.org_id); } catch (e) { out.errors.push(`${k}: ${zc.errText(e)}`); }
  }
  res.json(out);
}));

router.get('/vendors', gate(), wrap(async (req, res) => {
  const cfg = await cfgNow();
  const co = cfg.companies.find(c => c.id === req.query.company);
  if (!co) return bad(res, 400, 'Choose a company');
  const q = String(req.query.q || '').toLowerCase().trim();
  const list = require('./lib/match').vendorIndex(await need().lookups.vendors(co.id));
  const hits = list.filter(v => !q || v.name.toLowerCase().includes(q) || v.gstin.toLowerCase().includes(q) || (v.email || '').includes(q))
    .sort((a, b) => (a.status === 'inactive') - (b.status === 'inactive') || a.name.localeCompare(b.name)).slice(0, 50);
  res.json({ vendors: hits, total: list.length });
}));

router.put('/bills/:id', gate('review'), wrap(async (req, res) => {
  const b = await store.bill(req.params.id);
  if (!b) return bad(res, 404, 'Bill not found');
  const cfg = await cfgNow();
  const changes = req.body || {};
  const company = changes.company !== undefined ? changes.company : b.company;
  const co = cfg.companies.find(c => c.id === company);
  const look = {};
  if (co) {
    const { lookups } = need();
    if (changes.lines) { look.accounts = await lookups.accounts(co.org_id); look.taxes = await lookups.taxes(co.org_id); }
    if (changes.bill_level) look.branches = await lookups.branches(co.org_id);
    if (changes.vendor) look.vendors = require('./lib/match').vendorIndex(await lookups.vendors(co.id));
  } else if (changes.vendor?.id || changes.lines?.some(l => l.account_id || l.tax_id)) {
    return bad(res, 400, 'Choose the company first');
  }
  const r = await need().pipeline.edit(b.id, changes, req.bb.user, look);
  res.json({ bill: r.bill, row: row(r.bill, await cfgNow()) });
}));

router.post('/bills/:id/action', gate('review'), wrap(async (req, res) => {
  const b = await need().pipeline.action(req.params.id, String(req.body?.action || ''), req.body || {}, req.bb.user);
  res.json({ bill: b, row: row(b, await cfgNow()) });
}));

router.post('/bills/:id/draft', gate('draft'), wrap(async (req, res) => {
  const b = await need().pipeline.createDraft(req.params.id, req.bb.user);
  res.json({ bill: b, row: row(b, await cfgNow()) });
}));

router.post('/zoho/refresh', gate('review'), wrap(async (req, res) => {
  res.json({ results: await need().pipeline.refreshZoho({ by: byName(req), ids: Array.isArray(req.body?.ids) ? req.body.ids : null }) });
}));

// ── Mappings ──────────────────────────────────────────────────────────────────
router.get('/mappings', gate(), wrap(async (req, res) => {
  res.json({ mappings: (await store.snapshot()).doc('bb_mappings') || [] });
}));

router.put('/mappings/:id', gate('review'), wrap(async (req, res) => {
  const cfg = await cfgNow();
  const body = req.body || {};
  const cur = ((await store.snapshot()).doc('bb_mappings') || []).find(x => x.id === req.params.id);
  if (!cur) return bad(res, 404, 'Mapping not found');
  const co = cfg.companies.find(c => c.id === cur.company);
  // Zoho look-ups before the transaction (they write their own cache)
  const accounts = body.account_id !== undefined ? await need().lookups.accounts(co.org_id) : [];
  const taxes = body.tax_id ? await need().lookups.taxes(co.org_id) : [];
  const out = await store.tx(async t => {
    const list = [...(t.doc('bb_mappings') || [])];
    const m = list.find(x => x.id === req.params.id);
    if (!m) return { error: 'Mapping not found', status: 404 };
    const before = JSON.stringify({ a: m.account_name, t: m.tax_name, d: m.description, on: m.active, v: m.value });
    if (body.account_id !== undefined && m.kind !== 'field') {
      const acc = accounts.find(a => a.id === body.account_id);
      if (!acc) return { error: 'Account not found in Zoho', status: 400 };
      m.account_id = acc.id; m.account_name = acc.name;
    }
    if (body.tax_id !== undefined && m.kind !== 'field') {
      if (!body.tax_id) { m.tax_id = ''; m.tax_name = ''; }
      else {
        const tx = taxes.find(x => x.id === body.tax_id);
        if (!tx) return { error: 'Tax not found in Zoho', status: 400 };
        m.tax_id = tx.id; m.tax_name = tx.name;
      }
    }
    if (body.description !== undefined) m.description = String(body.description).trim().slice(0, 500);
    if (body.value !== undefined && m.kind === 'field') m.value = body.value;
    if (body.active !== undefined) m.active = !!body.active;
    m.updated_by = byName(req); m.updated_at = new Date().toISOString();
    t.setDoc('bb_mappings', list);
    return { m, before };
  });
  if (out.error) return bad(res, out.status, out.error);
  await store.audit({ by: byName(req), action: 'mapping_changed', detail: `${out.m.id}: ${out.before} → ${JSON.stringify({ a: out.m.account_name, t: out.m.tax_name, d: out.m.description, on: out.m.active, v: out.m.value })}` });
  res.json({ mapping: out.m });
}));

router.delete('/mappings/:id', gate('review'), wrap(async (req, res) => {
  const removed = await store.tx(async t => {
    const list = t.doc('bb_mappings') || [];
    const m = list.find(x => x.id === req.params.id);
    if (m) t.setDoc('bb_mappings', list.filter(x => x.id !== m.id));
    return m;
  });
  if (!removed) return bad(res, 404, 'Mapping not found');
  await store.audit({ by: byName(req), action: 'mapping_removed', detail: JSON.stringify(removed).slice(0, 500) });
  res.json({ ok: true });
}));

// ── Zoho checks ───────────────────────────────────────────────────────────────
router.post('/zoho/check', gate('config'), wrap(async (req, res) => {
  const cfg = await cfgNow();
  const co = cfg.companies.find(c => c.id === req.body?.company);
  if (!co) return bad(res, 400, 'Choose a company');
  const { zc, lookups } = need();
  const access = await zc.checkAccess(co.org_id);
  let gstins = [];
  try { gstins = await zc.ownGstins(co.org_id); } catch (_) {}
  const doc = await store.zohoCache(co.org_id);
  doc.own_gstins = { at: new Date().toISOString(), data: gstins };
  await store.saveZohoCache(co.org_id);
  let counts = {};
  try { counts = { accounts: (await lookups.accounts(co.org_id)).length, taxes: (await lookups.taxes(co.org_id)).length, branches: (await lookups.branches(co.org_id)).length }; } catch (e) { access.detail.push(`Look-ups: ${zc.errText(e)}`); }
  const result = { ...access, gstins, counts, checked_at: new Date().toISOString(), by: byName(req) };
  await saveCfg(c => { c.settings.zoho_access = { ...c.settings.zoho_access, [co.org_id]: result }; }, byName(req), 'zoho_check', `${co.name}: read ${access.read}, create ${access.create}`);
  res.json(result);
}));

router.post('/zoho/draft-test', gate('admin'), wrap(async (req, res) => {
  res.json(await need().pipeline.draftTest(String(req.body?.company || ''), req.body || {}, req.bb.user));
}));

router.get('/audit', gate('config'), wrap(async (req, res) => {
  const ym = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  res.json({ month: ym, entries: (await store.auditMonth(ym)).slice(-1000).reverse() });
}));

// Errors: the message for expected problems; a generic one (and the log) for the rest
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.status && err.status < 500) return bad(res, err.status, err.message);
  if (err.status === 502) return bad(res, 502, err.message);
  console.error('[bill-booking]', req.method, req.path, err.response?.data?.message || err.message);
  bad(res, 500, err.message?.startsWith('ZOHO_DAILY_LIMIT') ? err.message : `Something went wrong: ${err.message}`);
});

// ── Background work on the office PC (mailbox checks, Zoho review status) ─────
let timer = null;
router.startScheduler = () => {
  if (timer || IS_VERCEL) return;
  const { pipeline, mail } = need();
  let lastPoll = 0, lastRefresh = 0;
  pipeline.resume().catch(e => console.error('[bill-booking] resume:', e.message));
  timer = setInterval(async () => {
    try {
      const cfg = await cfgNow();
      if (Date.now() - lastPoll >= cfg.settings.poll_minutes * 60000 && cfg.team.some(m => m.active && m.connection?.status === 'connected')) {
        lastPoll = Date.now();
        await mail.pollAll({ by: 'schedule' });
      }
      const snap = await store.snapshot();
      if (Date.now() - lastRefresh >= 30 * 60000 && snap.bills.some(b => b.status === 'draft_created')) {
        lastRefresh = Date.now();
        await pipeline.refreshZoho({ by: 'schedule' });
      }
    } catch (e) { console.error('[bill-booking] scheduler:', e.message); }
  }, 60000);
  if (timer.unref) timer.unref();
};

module.exports = router;
module.exports.store = store;
module.exports._row = row;
module.exports._text = T;
