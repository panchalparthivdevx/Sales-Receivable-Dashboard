require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

// Prevent unhandled promise rejections from crashing the server process.
// Individual endpoints already catch their own errors; this is the last-resort guard.
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled promise rejection (caught at process level):', reason?.message || reason);
});

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const NodeCache = require('node-cache');
const XLSX = require('xlsx');
const pdfParse = require('pdf-parse');
// MSME multi-company: zoho / db / cache / syncEngine below follow the running company context and
// pass straight through for DevX (no context) — see company-context.js
const companyCtx = require('./company-context');
const _zoho = require('./zoho');
const { zohoGet, zohoGetAll, zohoPost, zohoPut } = companyCtx.contextZoho(_zoho);
const multer = require('multer');
const { MODULES, allPerms, loadUsers, saveUsers, signToken, authMiddleware, adminOnly } = require('./auth');
const _db        = require('./db');
const db         = companyCtx.contextDb(_db);
const workbooks  = require('./workbooks');
const fileStore  = require('./file-store');
const { background } = require('./background');
const IS_VERCEL  = !!process.env.VERCEL;
const _devxSyncEngine = require('./sync-engine');
const _companyEngines = {};   // company → its own sync engine (created after the MSME entities below)
const syncEngine  = companyCtx.contextEngine(_devxSyncEngine, _companyEngines);
const { attachAgreed: attachRentAgreed } = require('./rent-agreed');
const pocmSync    = require('./pocm-sync');

// pdfjs-dist v3 requires 'canvas' at load time, but canvas.node native binary is not compiled.
// Shim it with @napi-rs/canvas which ships pre-built Windows binaries.
(function shimNodeCanvas() {
  try {
    require('canvas');
  } catch (_) {
    try {
      const canvasPath = require.resolve('canvas');
      require.cache[canvasPath] = {
        id: canvasPath, filename: canvasPath, loaded: true,
        exports: require('@napi-rs/canvas'),
      };
    } catch (_2) {}
  }
})();

// ─── Agreement file paths ──────────────────────────────────────────────────────
const { AGREEMENTS_DIR, isAmendmentFile, scanAgreementsFolder } = require('./agreements-folder');
const AGREEMENTS_DATA_FILE = path.join(__dirname, 'agreements_data.json');

async function readAgreementsData() {
  return await db.readJSON('agreements_data', AGREEMENTS_DATA_FILE, {});
}
async function writeAgreementsData(d) {
  await db.writeJSON('agreements_data', AGREEMENTS_DATA_FILE, d);
}

// Parse "12 months", "1 year", "6 months" → add to a date string, return YYYY-MM-DD
function addTermToDate(startDateStr, term) {
  if (!startDateStr || !term) return null;
  const m = String(term).match(/(\d+)\s*(month|year|day)/i);
  if (!m) return null;
  try {
    const d = new Date(startDateStr);
    if (isNaN(d.getTime())) return null;
    const n = parseInt(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === 'month') d.setMonth(d.getMonth() + n);
    else if (unit === 'year') d.setFullYear(d.getFullYear() + n);
    else if (unit === 'day') d.setDate(d.getDate() + n);
    d.setDate(d.getDate() - 1); // last day of the period
    return d.toISOString().substring(0, 10);
  } catch (_) { return null; }
}

function resolvedDate(explicit, startDate, term) {
  return explicit || addTermToDate(startDate, term) || null;
}

const app = express();
const _rawCache = new NodeCache({ stdTTL: 300 });
const cache = companyCtx.contextCache(_rawCache);
// Shared full-invoice detail cache — 24h TTL. Used by both sub_total enrichment and occupancy.
// Prevents fetching the same invoice from Zoho more than once per day across ALL endpoints.
const detailCache = new NodeCache({ stdTTL: 86400 });
const inFlight = new Map(); // deduplicates concurrent fetches for the same invoice_id
// Neon mode: an Excel upload seen by this instance refreshes every report built from it
workbooks.onChange(() => cache.flushAll());

app.use(cors());
// MSME multi-company: /api/c/<company>/<MSME route> runs that route in the company's context
app.use(companyCtx.companyRouter);
// Report exports post the full report back (GST 180-day, MSME Form-1 and Interest: 100–300 KB+),
// so they skip the default 100 KB parser here and use their own larger limit on the route.
const _jsonParser = express.json();
const _largeJsonRoutes = new Set(['/api/gst/export', '/api/msme-form1/export', '/api/msme-interest/export']);
app.use((req, res, next) => (_largeJsonRoutes.has(req.path) ? next() : _jsonParser(req, res, next)));

// Requests wait for start-up (DB tables, sync + POCM modules). Locally the server only
// listens after start-up, so this never waits; on Vercel a request can arrive sooner.
let _markReady;
const _appReady = new Promise(resolve => { _markReady = resolve; });
app.use((req, res, next) => { _appReady.then(() => { workbooks.refreshIfStale(); next(); }); });

// ─── Login required for every /api route ──────────────────────────────────────
// Open only to what the login page, the public vendor form and Vercel Cron use
// (cron routes check CRON_SECRET themselves). Plain <a href> file links can't send
// a header, so GET …/file/… requests may carry the login token as ?token=.
const PUBLIC_API = new Set([
  'POST /api/auth/login',
  'GET /api/health',
  'POST /api/vendor-registration/submit',
  'POST /api/vendor-registration/upload-session',
  'POST /api/vendor-registration/upload-file',
  'GET /api/vendor-registration/public-url',
  'GET /api/cron/sync',
  'GET /api/cron/pocm',
  'GET /api/cron/pl',
]);
// The CRM team's standalone form (/crm-form) has no dashboard login: its calls stay open as
// before, unless CRM_FORM_KEY is set — then the form link must carry ?key=<CRM_FORM_KEY>.
// Without the key, these routes fall through to the normal login (the Budget page uses them).
const CRM_FORM_API = new Set([
  'GET /api/crm/branches',
  'GET /api/crm/actuals',
  'POST /api/crm/actuals',
  'POST /api/crm/upload-bill',
]);
app.use('/api', (req, res, next) => {
  const route = `${req.method} ${req.baseUrl}${req.path}`;
  if (req.method === 'OPTIONS' || PUBLIC_API.has(route)) return next();
  if (CRM_FORM_API.has(route) && (!process.env.CRM_FORM_KEY || req.headers['x-form-key'] === process.env.CRM_FORM_KEY)) return next();
  if (!req.headers.authorization && req.method === 'GET' && req.query.token && req.path.includes('/file/')) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  authMiddleware(req, res, next);
});

// Neon mode (Vercel): POCM pages need the POCM store in memory (loaded on first use)
app.use('/api/pocm', (req, res, next) => {
  pocmSync.ensureLoaded().then(() => next(), e => res.status(503).json({ error: `POCM data could not be loaded: ${e.message}` }));
});

function cached(key, ttl, fn) {
  return async (req, res) => {
    const hit = cache.get(key);
    if (hit) return res.json(hit);
    try {
      const data = await fn(req);
      cache.set(key, data, ttl);
      res.json(data);
    } catch (e) {
      console.error(e.response?.data || e.message);
      res.status(500).json({ error: e.message });
    }
  };
}

// Date helpers — use local date (not UTC) to avoid IST offset shifting dates
function localDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { start: localDate(start), end: localDate(now) };
}

function getFYRange() {
  const now = new Date();
  // Indian FY: April 1 to March 31
  const fyStart = now.getMonth() >= 3
    ? new Date(now.getFullYear(), 3, 1)
    : new Date(now.getFullYear() - 1, 3, 1);
  return { start: localDate(fyStart), end: localDate(now) };
}

// Read a centrally synced entity sliced to [from, to] (record `date`). Falls back to the
// given live Zoho fetch when the cache is stale/missing or doesn't cover `from`.
// Includes future-dated records the sync holds outside its data window.
async function syncedRange(entity, from, to, liveFn) {
  try {
    const c = await syncEngine.readSyncedData(entity);
    if (c && Array.isArray(c.data) && syncEngine.isFresh(c.synced_at) && (!c.window_from || from >= c.window_from)) {
      return syncEngine.filterByDateRange([...c.data, ...(c.future || [])], 'date', from, to);
    }
  } catch (e) {
    console.warn(`[sync] syncedRange(${entity}) cache read error:`, e.message);
  }
  return liveFn();
}

// Whole synced entity (no date slicing) with live fallback
async function syncedAll(entity, liveFn) {
  return (await syncEngine.getSyncedOrFetch(entity, liveFn)).data;
}

// Active vendors — same set as Zoho /contacts?contact_type=vendor&filter_by=Status.Active,
// read from the central Vendors — All cache (which holds every status)
async function activeVendors(opts = {}) {
  const r = await syncEngine.getSyncedOrFetch('vendors_all',
    () => zohoGetAll('/contacts', 'contacts', { contact_type: 'vendor', filter_by: 'Status.Active' }, opts));
  return r.source === 'sync' ? r.data.filter(v => v.status === 'active') : r.data;
}

function getPast12MonthsRange() {
  const now = new Date();
  const start = new Date(now);
  start.setMonth(start.getMonth() - 12);
  return { start: localDate(start), end: localDate(now) };
}

// Extract sub-total from an invoice (amount without tax).
// Priority: enriched _sub_total → persistent map (detail-fetched) → list sub_total → tax_total → approx.
function subTotal(inv) {
  if (inv._sub_total != null) return inv._sub_total;
  if (inv.invoice_id && _invSubTotals[inv.invoice_id] != null) return _invSubTotals[inv.invoice_id];
  if (inv.sub_total  != null) return inv.sub_total;
  if (inv.tax_total  != null) return inv.total - inv.tax_total;
  return Math.round((inv.total / 1.18) * 100) / 100;
}

// Fetch full invoice detail with deduplication + 24h cache.
// If two endpoints request the same invoice simultaneously, only ONE Zoho API call is made.
async function fetchDetail(inv) {
  const key = `d_${inv.invoice_id}`;
  const hit = detailCache.get(key);
  if (hit !== undefined) return hit;

  if (inFlight.has(inv.invoice_id)) return inFlight.get(inv.invoice_id);

  const promise = zohoGet(`/invoices/${inv.invoice_id}`, {})
    .then(d => {
      const detail = d.invoice ?? null;
      detailCache.set(key, detail);
      inFlight.delete(inv.invoice_id);
      return detail;
    })
    .catch(() => {
      inFlight.delete(inv.invoice_id);
      return null;
    });

  inFlight.set(inv.invoice_id, promise);
  return promise;
}

// Branch and seat count (cf_no_of_seat over the line items) of one invoice — only Zoho's invoice
// detail carries them. The office PC keeps details in memory (detailCache, 24 h). A Vercel
// instance starts empty, and re-reading hundreds of details took ~3 minutes and as many Zoho calls
// per Occupancy / Operational Data load, so Neon mode also keeps the result per invoice in kv
// 'invoice_seats', re-read from Zoho only when the invoice's last_modified_time changes.
// fetched = a Zoho call was needed (callers pause between batches only then).
let _invSeats = {};
const _invSeatsTouched = new Set();
async function loadInvoiceSeats() {
  if (!db.USE_DB) return;
  const loaded = (await db.readJSON('invoice_seats', null, null)) || {};
  for (const id of _invSeatsTouched) loaded[id] = _invSeats[id];       // not saved yet (other report running)
  _invSeats = loaded;
}
async function saveInvoiceSeats() {
  if (!db.USE_DB || !_invSeatsTouched.size) return;
  const cur = (await db.readJSON('invoice_seats', null, null)) || {};   // keep other instances' entries
  for (const id of _invSeatsTouched) if (_invSeats[id]) cur[id] = _invSeats[id];
  _invSeatsTouched.clear();
  _invSeats = cur;
  await db.writeJSON('invoice_seats', null, cur).catch(e => console.warn('[invoice-seats] save error:', e.message));
}
async function invoiceSeats(inv) {
  const lmt = inv.last_modified_time || null;
  const kept = db.USE_DB ? _invSeats[inv.invoice_id] : null;
  if (kept && kept.lmt === lmt) return { branch: kept.branch, seats: kept.seats, fetched: false };
  const fetched = detailCache.get(`d_${inv.invoice_id}`) === undefined;
  const full = await fetchDetail(inv);
  if (!full) return null;
  let seats = 0;
  for (const li of full.line_items || []) {
    for (const cf of li.item_custom_fields || []) {
      if (cf.api_name === 'cf_no_of_seat') seats += parseFloat(cf.value) || 0;
    }
  }
  const branch = full.branch_name || 'Unknown';
  if (db.USE_DB) { _invSeats[inv.invoice_id] = { lmt, branch, seats }; _invSeatsTouched.add(inv.invoice_id); }
  return { branch, seats, fetched };
}

// Mutates each invoice in-place with _sub_total.
// BATCH=5 + 2s inter-batch delay keeps Zoho under 100 req/min rate limit.
async function enrichWithSubTotals(invoices) {
  const BATCH = 5;
  for (let i = 0; i < invoices.length; i += BATCH) {
    await Promise.all(
      invoices.slice(i, i + BATCH).map(async inv => {
        const detail = await fetchDetail(inv);
        inv._sub_total = detail?.sub_total ?? Math.round(inv.total / 1.18 * 100) / 100;
      })
    );
    if (i + BATCH < invoices.length) await new Promise(r => setTimeout(r, 2000));
  }
}

// ── Persistent invoice sub_total map ─────────────────────────────────────────
// Zoho invoice list API does NOT return sub_total — only the detail API does.
// We persist fetched sub_totals to disk so they survive restarts and only fetch
// once per invoice_id. This map is consulted by subTotal() above all fallbacks.
const INV_SUBTOTALS_FILE = path.join(__dirname, 'sync_data', 'invoice_subtotals.json');
let _invSubTotals = {}; // invoice_id → sub_total (number)
let _enrichingNow = false;

// Neon mode keeps the map in kv_store 'invoice_subtotals'; the office PC keeps the file.
async function _loadInvSubTotals() {
  try {
    if (db.USE_DB) {
      _invSubTotals = (await db.readJSON('invoice_subtotals', null, null)) || {};
      console.log(`[inv-subtotals] loaded ${Object.keys(_invSubTotals).length} entries`);
    } else if (fs.existsSync(INV_SUBTOTALS_FILE)) {
      _invSubTotals = JSON.parse(fs.readFileSync(INV_SUBTOTALS_FILE, 'utf8'));
      console.log(`[inv-subtotals] loaded ${Object.keys(_invSubTotals).length} entries`);
    }
  } catch (e) { console.warn('[inv-subtotals] load error:', e.message); }
}

function _saveInvSubTotals() {
  if (db.USE_DB) {
    background(db.writeJSON('invoice_subtotals', null, _invSubTotals)
      .catch(e => console.warn('[inv-subtotals] save error:', e.message)));
    return;
  }
  try {
    fs.writeFileSync(INV_SUBTOTALS_FILE, JSON.stringify(_invSubTotals), 'utf8');
  } catch (e) { console.warn('[inv-subtotals] save error:', e.message); }
}

// Background enrichment: fetches sub_total from Zoho detail for invoices not yet in the map.
// Runs without blocking the caller. Busts the 'revenue' cache when done so KPI refreshes.
async function enrichSubTotalsBackground(invoices) {
  if (_enrichingNow) return;
  const toFetch = (invoices || []).filter(i => i.invoice_id && _invSubTotals[i.invoice_id] == null);
  if (!toFetch.length) return;
  _enrichingNow = true;
  console.log(`[inv-subtotals] background enriching ${toFetch.length} invoices…`);
  const BATCH = 5;
  let changed = false;
  try {
    for (let i = 0; i < toFetch.length; i += BATCH) {
      await Promise.all(toFetch.slice(i, i + BATCH).map(async inv => {
        const detail = await fetchDetail(inv);
        if (detail?.sub_total != null) {
          _invSubTotals[inv.invoice_id] = detail.sub_total;
          changed = true;
        }
      }));
      if (i + BATCH < toFetch.length) await new Promise(r => setTimeout(r, 1200));
    }
    if (changed) {
      _saveInvSubTotals();
      // Bust KPI caches so next request recomputes with correct sub_totals
      ['revenue', 'inv-count', 'top-customer-revenue'].forEach(k => cache.del(k));
      console.log(`[inv-subtotals] enriched ${toFetch.length} invoices — caches busted`);
    }
  } catch (e) {
    console.warn('[inv-subtotals] enrichment error:', e.message);
  } finally {
    _enrichingNow = false;
  }
}

function invSummary(i) {
  return {
    invoice_number: i.invoice_number,
    customer_name: i.customer_name,
    date: i.date,
    branch_name: i.branch_name || '-',
    sub_total: subTotal(i),
    total: i.total,
    balance: i.balance,
    status: i.status,
    cf_invoice_category: i.cf_invoice_category,
    cf_tier_wise_revenue: i.cf_tier_wise_revenue,
    cf_city_wise_revenue: i.cf_city_wise_revenue,
  };
}

// ─── KPI: Average Payment Delay ───────────────────────────────────────────────
app.get('/api/kpi/avg-payment-delay', cached('avg-delay', 600, async () => {
  const { start, end } = getPast12MonthsRange();

  // Fetch paid invoices by invoice date (Zoho sorts by date); filter by last_payment_date in code
  const paidInvoices = await zohoGetAll(
    '/invoices', 'invoices',
    { filter_by: 'Status.Paid' },
    { dateFrom: start, dateTo: end }
  );

  const delayData = [];
  for (const inv of paidInvoices) {
    if (!inv.due_date || !inv.last_payment_date) continue;
    const paid = new Date(inv.last_payment_date);
    const due = new Date(inv.due_date);
    const delay = Math.round((paid - due) / (1000 * 60 * 60 * 24));
    delayData.push({
      invoice_number: inv.invoice_number,
      customer_name: inv.customer_name,
      branch_name: inv.branch_name || '-',
      due_date: inv.due_date,
      payment_date: inv.last_payment_date,
      delay_days: delay,
      amount: inv.total,
    });
  }

  const onlyDelayed = delayData.filter(d => d.delay_days > 0);
  const avg = onlyDelayed.length
    ? Math.round(onlyDelayed.reduce((s, d) => s + d.delay_days, 0) / onlyDelayed.length)
    : 0;

  return {
    avg_delay_days: avg,
    total_payments_analyzed: delayData.length,
    delayed_count: onlyDelayed.length,
    detail: delayData.sort((a, b) => b.delay_days - a.delay_days),
  };
}));

// ─── KPI: Collections (Actual Bank Payments + Credit Notes separately) ────────
app.get('/api/kpi/collections', cached('collections', 300, async () => {
  const today = localDate(new Date());
  const { start: mStart, end: mEnd } = getMonthRange();

  // Fetch actual bank/cash customer payments and credit notes in parallel
  const [todayPayments, monthPayments, todayCN, monthCN] = await Promise.all([
    syncedRange('customer_payments_fy', today, today, () => zohoGetAll('/customerpayments', 'customerpayments',
      { date_start: today, date_end: today },
      { dateFrom: today, dateTo: today }
    )),
    syncedRange('customer_payments_fy', mStart, mEnd, () => zohoGetAll('/customerpayments', 'customerpayments',
      { date_start: mStart, date_end: mEnd },
      { dateFrom: mStart, dateTo: mEnd }
    )),
    syncedRange('credit_notes_fy', today, today, () => zohoGetAll('/creditnotes', 'creditnotes',
      { date_start: today, date_end: today },
      { dateFrom: today, dateTo: today }
    )),
    syncedRange('credit_notes_fy', mStart, mEnd, () => zohoGetAll('/creditnotes', 'creditnotes',
      { date_start: mStart, date_end: mEnd },
      { dateFrom: mStart, dateTo: mEnd }
    )),
  ]);

  const sumPayments = arr => arr.reduce((s, p) => s + (p.amount || 0), 0);
  // Credit applied = total issued minus any unused balance remaining
  const sumCN = arr => arr.reduce((s, c) => s + Math.max(0, (c.total || 0) - (c.balance || 0)), 0);

  const paymentDetail = arr => arr
    .map(p => ({
      customer_name: p.customer_name,
      payment_date: p.date,
      amount: p.amount,
      payment_mode: p.payment_mode,
      reference_number: p.reference_number || '-',
      branch_name: p.branch_name || '-',
      invoice_numbers: p.invoice_numbers || '-',
    }))
    .sort((a, b) => b.amount - a.amount);

  const cnDetail = arr => arr
    .map(c => ({
      creditnote_number: c.creditnote_number,
      customer_name: c.customer_name,
      date: c.date,
      total: c.total,
      applied_amount: Math.max(0, (c.total || 0) - (c.balance || 0)),
      balance: c.balance,
      branch_name: c.branch_name || '-',
      status: c.status,
    }))
    .sort((a, b) => b.applied_amount - a.applied_amount);

  return {
    today:              sumPayments(todayPayments),
    this_month:         sumPayments(monthPayments),
    today_credit_notes: sumCN(todayCN),
    month_credit_notes: sumCN(monthCN),
    today_detail:       paymentDetail(todayPayments),
    this_month_detail:  paymentDetail(monthPayments),
    today_cn_detail:    cnDetail(todayCN),
    month_cn_detail:    cnDetail(monthCN),
  };
}));

// ─── ESCROW Collection Report ──────────────────────────────────────────────────
// Each ESCROW account: account number (used to match Zoho bank account name),
// lender label, monthly EMI, and due day.
const ESCROW_MAPPING_FILE = path.join(__dirname, 'escrow_client_mapping.json');

const ESCROW_ACCOUNTS = [
  { acctNo: '002405033164', label: 'Zaveri Group',                   emi: 15213744, dueDay: 15 },
  { acctNo: '777705888101', label: 'Poonawalla',                     emi: 8157022,  dueDay:  5 },
  { acctNo: '777705888102', label: 'Jio Credit',                     emi: 5401311,  dueDay: 10 },
  { acctNo: '777705888103', label: 'Catalyst',                       emi: 10000000, dueDay: 28 },
  { acctNo: '777705888107', label: 'MIZUHO',                         emi: 3536000,  dueDay: 15 },
  { acctNo: '777705888109', label: 'BANQUITY',                       emi: 2064960,  dueDay: 16 },
  { acctNo: 'ABFCFG5023819', label: 'HDFC Bank Escrow - Recur(Aditya)', emi: 2580582, dueDay: 24 },
  { acctNo: '0100',          label: 'Term Loan',                        emi: 0,       dueDay: 0  },
];

// Client → ESCROW bank account mapping (from the uploaded reference sheet)
// Key = client name substring (lowercase), value = acctNo from ESCROW_ACCOUNTS
const CLIENT_ESCROW_MAP = {
  // Jio Credit (777705888102)
  'jio': '777705888102',
  // Poonawalla (777705888101)
  'poonawalla': '777705888101',
  // Zaveri Group (002405033164)
  'zaveri': '002405033164',
  // Catalyst (777705888103)
  'catalyst': '777705888103',
  // MIZUHO (777705888107)
  'mizuho': '777705888107',
  // BANQUITY (777705888109)
  'banquity': '777705888109',
  // HDFC Recur/Aditya (ABFCFG5023819)
  'recur': 'ABFCFG5023819',
  'aditya': 'ABFCFG5023819',
};

app.get('/api/escrow/report', cached('escrow-report', 300, async () => {
  const { start: mStart, end: mEnd } = getMonthRange();
  const { start: fyStart }           = getFYRange();

  // Load saved manual mapping from DB (customer_id → acctNo)
  const savedMapping = (await db.readJSON('escrow_client_mapping', ESCROW_MAPPING_FILE, {})) || {};

  // 1. Fetch bank accounts and current-month data in parallel
  const [bankAccountsRaw, monthInvoices, fyPayments] = await Promise.all([
    (async () => {
      let all = [];
      try {
        let pg = 1;
        while (true) {
          const d = await zohoGet('/bankaccounts', { per_page: 200, page: pg });
          all = all.concat(d.bankaccounts || []);
          if (!d.page_context?.has_more_page) break;
          pg++;
        }
      } catch (e) { console.error('[escrow] bankaccounts:', e.message); }
      return all;
    })(),
    syncedRange('invoices_fy', mStart, mEnd, () => zohoGetAll('/invoices', 'invoices',
      { filter_by: 'Status.All' },
      { dateFrom: mStart, dateTo: mEnd }
    )).catch(() => []),
    // Fetch FY customer payments to auto-detect customer → ESCROW account mapping
    syncedRange('customer_payments_fy', fyStart, mEnd, () => zohoGetAll('/customerpayments', 'customerpayments',
      {},
      { dateFrom: fyStart, dateTo: mEnd }
    )).catch(() => []),
  ]);

  // Build a map: account_id → acctNo for our ESCROW accounts
  function findBankAccount(acctNo) {
    const needle = acctNo.toLowerCase();
    return bankAccountsRaw.find(b =>
      (b.account_number || '').toLowerCase().includes(needle) ||
      (b.account_name  || '').toLowerCase().includes(needle)
    );
  }

  const escrowAccountIdMap = {}; // zoho_account_id → acctNo
  for (const ea of ESCROW_ACCOUNTS) {
    const ba = findBankAccount(ea.acctNo);
    if (ba?.account_id) escrowAccountIdMap[ba.account_id] = ea.acctNo;
  }

  // Build customer_id → acctNo map from payment deposit history
  const customerEscrowMap = {}; // customer_id → acctNo (most-recent assignment wins)
  for (const pmt of fyPayments) {
    const depositId = pmt.deposit_to_account_id || pmt.account_id;
    if (depositId && escrowAccountIdMap[depositId]) {
      customerEscrowMap[pmt.customer_id] = escrowAccountIdMap[depositId];
    }
  }

  // Aggregate receivables: unpaid/partial invoices for this month, by ESCROW account
  // Priority: 1) saved manual mapping (DB)  2) auto-detected from payment deposits  3) keyword fallback
  const receivablesByAcct = {};
  for (const inv of monthInvoices) {
    if (inv.status === 'paid') continue;
    const balance = inv.balance || 0;
    if (!balance) continue;
    let acctNo = savedMapping[inv.customer_id]          // 1. manual
              || customerEscrowMap[inv.customer_id];    // 2. auto-detected
    if (!acctNo) {                                      // 3. keyword fallback
      const cn = (inv.customer_name || '').toLowerCase();
      for (const [kw, an] of Object.entries(CLIENT_ESCROW_MAP)) {
        if (cn.includes(kw)) { acctNo = an; break; }
      }
    }
    if (!acctNo) continue;
    receivablesByAcct[acctNo] = (receivablesByAcct[acctNo] || 0) + balance;
  }

  // Build report rows
  const rows = ESCROW_ACCOUNTS.map(ea => {
    const ba            = findBankAccount(ea.acctNo);
    const availableFund = ba ? (ba.balance || 0) : null;
    const receivables   = receivablesByAcct[ea.acctNo] || 0;
    const balanceFund   = (availableFund != null && ea.emi > 0) ? availableFund - ea.emi : null;
    return {
      acctNo:        ea.acctNo,
      label:         ea.label,
      accountName:   ba?.account_name || `Acct #${ea.acctNo}`,
      availableFund,
      receivables,
      emi:           ea.emi,
      dueDay:        ea.dueDay,
      balanceFund,
    };
  });

  // ICICI DevX current account (transfer destination)
  const icici = bankAccountsRaw.find(b =>
    (b.account_name || '').toLowerCase().includes('icici') &&
    (b.account_name || '').toLowerCase().includes('4485')
  );

  return {
    monthLabel:       mStart.slice(0, 7),
    rows,
    iciciBalance:     icici ? (icici.balance || 0) : null,
    iciciName:        icici?.account_name || 'ICICI Bank_Current Account #4485',
    totalAvailable:   rows.reduce((s, r) => s + (r.availableFund || 0), 0),
    totalReceivables: rows.reduce((s, r) => s + r.receivables, 0),
    totalEmi:         rows.reduce((s, r) => s + r.emi, 0),
    totalBalance:     rows.reduce((s, r) => s + (r.balanceFund || 0), 0),
  };
}));

// ─── ESCROW Debug: list bank account names from Zoho ──────────────────────────
app.get('/api/escrow/debug-accounts', async (req, res) => {
  try {
    let all = [];
    let pg = 1;
    while (true) {
      const d = await zohoGet('/bankaccounts', { per_page: 200, page: pg });
      const items = d.bankaccounts || [];
      all = all.concat(items.map(b => ({ name: b.account_name, number: b.account_number, balance: b.balance, type: b.account_type })));
      if (!d.page_context?.has_more_page) break;
      pg++;
    }
    res.json({ count: all.length, accounts: all });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ESCROW: Client-by-branch list (for mapping UI) ──────────────────────────
// Derives unique customers + their branch from FY invoices, returns them grouped
// by branch alongside the current saved mapping so the UI can pre-fill dropdowns.
app.get('/api/escrow/clients-by-branch', async (req, res) => {
  try {
    const { start: fyStart, end: fyEnd } = getFYRange();
    const savedMapping = (await db.readJSON('escrow_client_mapping', ESCROW_MAPPING_FILE, {})) || {};

    const invoices = await zohoGetAll('/invoices', 'invoices',
      { filter_by: 'Status.All' },
      { dateFrom: fyStart, dateTo: fyEnd }
    );

    // Build unique customer rows with branch info
    const seen = new Map(); // customer_id → { customer_id, customer_name, branches: Set }
    for (const inv of invoices) {
      if (!inv.customer_id) continue;
      if (!seen.has(inv.customer_id)) {
        seen.set(inv.customer_id, {
          customer_id:   inv.customer_id,
          customer_name: inv.customer_name,
          branches:      new Set(),
          escrow_acct:   savedMapping[inv.customer_id] || null,
        });
      }
      if (inv.branch_name) seen.get(inv.customer_id).branches.add(inv.branch_name);
    }

    // Convert to array, group by branch (a client can appear in multiple branches)
    const byBranch = {}; // branch_name → [client, ...]
    const nobranchClients = [];
    for (const c of seen.values()) {
      const row = { customer_id: c.customer_id, customer_name: c.customer_name, escrow_acct: c.escrow_acct, branches: [...c.branches].sort() };
      if (c.branches.size === 0) {
        nobranchClients.push(row);
      } else {
        for (const br of c.branches) {
          if (!byBranch[br]) byBranch[br] = [];
          byBranch[br].push(row);
        }
      }
    }

    // Sort branches and clients within each branch
    const branches = Object.keys(byBranch).sort().map(br => ({
      branch_name: br,
      clients: byBranch[br].sort((a, b) => a.customer_name.localeCompare(b.customer_name)),
    }));
    if (nobranchClients.length) {
      branches.push({ branch_name: '(No Branch)', clients: nobranchClients.sort((a, b) => a.customer_name.localeCompare(b.customer_name)) });
    }

    res.json({
      branches,
      totalClients: seen.size,
      mappedClients: [...seen.values()].filter(c => savedMapping[c.customer_id]).length,
      escrowAccounts: ESCROW_ACCOUNTS.map(e => ({ acctNo: e.acctNo, label: e.label })),
    });
  } catch (e) {
    console.error('[escrow] clients-by-branch:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── ESCROW: Get saved client mapping ─────────────────────────────────────────
app.get('/api/escrow/client-mapping', async (req, res) => {
  try {
    const mapping = (await db.readJSON('escrow_client_mapping', ESCROW_MAPPING_FILE, {})) || {};
    res.json(mapping);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ESCROW: Save client mapping ──────────────────────────────────────────────
// Body: { mapping: { [customer_id]: acctNo | null } }
app.post('/api/escrow/client-mapping', async (req, res) => {
  try {
    const { mapping } = req.body || {};
    if (!mapping || typeof mapping !== 'object') return res.status(400).json({ error: 'mapping object required' });
    // Merge with existing (only update keys provided)
    const existing = (await db.readJSON('escrow_client_mapping', ESCROW_MAPPING_FILE, {})) || {};
    const merged = { ...existing, ...mapping };
    // Remove nulls (unmapped)
    for (const k of Object.keys(merged)) { if (!merged[k]) delete merged[k]; }
    await db.writeJSON('escrow_client_mapping', ESCROW_MAPPING_FILE, merged);
    // Bust the report cache so next load uses new mapping
    cache.del('escrow-report');
    res.json({ ok: true, totalMapped: Object.keys(merged).length });
  } catch (e) {
    console.error('[escrow] save client-mapping:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── ESCROW Receivables Detail ────────────────────────────────────────────────
// Returns list of open invoices for the month assigned to a given ESCROW account
app.get('/api/escrow/receivables-detail', async (req, res) => {
  const { acctNo } = req.query;
  if (!acctNo) return res.status(400).json({ error: 'acctNo required' });
  try {
    const { start: mStart, end: mEnd } = getMonthRange();
    const { start: fyStart }           = getFYRange();

    // Rebuild customer→ESCROW map from FY payments (same logic as main report)
    const [bankAccountsRaw, fyPayments, monthInvoices] = await Promise.all([
      (async () => {
        let all = [];
        let pg = 1;
        while (true) {
          const d = await zohoGet('/bankaccounts', { per_page: 200, page: pg });
          all = all.concat(d.bankaccounts || []);
          if (!d.page_context?.has_more_page) break;
          pg++;
        }
        return all;
      })(),
      syncedRange('customer_payments_fy', fyStart, mEnd, () => zohoGetAll('/customerpayments', 'customerpayments', {}, { dateFrom: fyStart, dateTo: mEnd })).catch(() => []),
      syncedRange('invoices_fy', mStart, mEnd, () => zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.All' }, { dateFrom: mStart, dateTo: mEnd })).catch(() => []),
    ]);

    const escrowAccountIdMap = {};
    for (const ea of ESCROW_ACCOUNTS) {
      const needle = ea.acctNo.toLowerCase();
      const ba = bankAccountsRaw.find(b =>
        (b.account_number || '').toLowerCase().includes(needle) ||
        (b.account_name  || '').toLowerCase().includes(needle)
      );
      if (ba?.account_id) escrowAccountIdMap[ba.account_id] = ea.acctNo;
    }

    const customerEscrowMap = {};
    for (const pmt of fyPayments) {
      const depositId = pmt.deposit_to_account_id || pmt.account_id;
      if (depositId && escrowAccountIdMap[depositId]) {
        customerEscrowMap[pmt.customer_id] = escrowAccountIdMap[depositId];
      }
    }

    const invoices = monthInvoices.filter(inv => {
      if (inv.status === 'paid' || !(inv.balance || 0)) return false;
      let matched = customerEscrowMap[inv.customer_id];
      if (!matched) {
        const cn = (inv.customer_name || '').toLowerCase();
        for (const [kw, an] of Object.entries(CLIENT_ESCROW_MAP)) {
          if (cn.includes(kw)) { matched = an; break; }
        }
      }
      return matched === acctNo;
    }).map(inv => ({
      invoice_number: inv.invoice_number || inv.reference_number || '-',
      customer_name:  inv.customer_name,
      invoice_date:   inv.date,
      due_date:       inv.due_date,
      total:          inv.total || 0,
      balance:        inv.balance || 0,
      status:         inv.status,
      branch_name:    inv.branch_name || '-',
    })).sort((a, b) => b.balance - a.balance);

    res.json({ acctNo, invoices, total: invoices.reduce((s, i) => s + i.balance, 0) });
  } catch (e) {
    console.error('[escrow] receivables-detail:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── ESCROW Fund (Bank Account) Transactions Detail ───────────────────────────
// Returns recent transactions for a given ESCROW bank account
app.get('/api/escrow/fund-detail', async (req, res) => {
  const { acctNo } = req.query;
  if (!acctNo) return res.status(400).json({ error: 'acctNo required' });
  try {
    // Find the bank account id
    let bankAccounts = [];
    let pg = 1;
    while (true) {
      const d = await zohoGet('/bankaccounts', { per_page: 200, page: pg });
      bankAccounts = bankAccounts.concat(d.bankaccounts || []);
      if (!d.page_context?.has_more_page) break;
      pg++;
    }
    const needle = acctNo.toLowerCase();
    const ba = bankAccounts.find(b =>
      (b.account_number || '').toLowerCase().includes(needle) ||
      (b.account_name  || '').toLowerCase().includes(needle)
    );
    if (!ba) return res.status(404).json({ error: `Bank account not found for ${acctNo}` });

    // Fetch transactions for this bank account (last 90 days)
    const now    = new Date();
    const from90 = new Date(now); from90.setDate(from90.getDate() - 90);
    const fromDt = localDate(from90);
    const toDt   = localDate(now);

    let transactions = [];
    try {
      let tpg = 1;
      while (tpg <= 10) {
        const d = await zohoGet(`/bankaccounts/${ba.account_id}/transactions`, {
          from_date: fromDt, to_date: toDt, per_page: 200, page: tpg,
        });
        const items = d.banktransactions || d.transactions || [];
        transactions = transactions.concat(items);
        if (!d.page_context?.has_more_page) break;
        tpg++;
      }
    } catch (e) {
      console.error('[escrow] bank transactions fetch failed:', e.message);
    }

    const txns = transactions.map(t => ({
      date:         t.date || t.transaction_date,
      description:  t.description || t.reference_number || t.transaction_id || '-',
      debit:        t.debit_or_credit === 'debit' ? (t.amount || 0) : 0,
      credit:       t.debit_or_credit === 'credit' ? (t.amount || 0) : 0,
      amount:       t.amount || 0,
      type:         t.debit_or_credit || t.transaction_type || '-',
      running_balance: t.balance || null,
    })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    res.json({
      acctNo,
      accountName: ba.account_name,
      balance:     ba.balance || 0,
      fromDate:    fromDt,
      toDate:      toDt,
      transactions: txns,
    });
  } catch (e) {
    console.error('[escrow] fund-detail:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── KPI: Invoice Count ────────────────────────────────────────────────────────
app.get('/api/kpi/invoice-count', cached('inv-count', 60, async () => {
  const { start: mStart } = getMonthRange();
  const { start: fyStart, end: fyEnd } = getFYRange();
  const r = await syncEngine.getSyncedOrFetch(
    'invoices_fy',
    () => zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd })
  );
  const thisFY    = r.data;
  const thisMonth = thisFY.filter(inv => inv.date >= mStart);
  return {
    this_month:        thisMonth.length,
    this_fy:           thisFY.length,
    this_month_detail: thisMonth.map(invSummary),
    _data_source:      r.source,
    _synced_at:        r.synced_at,
  };
}));

// ─── KPI: Revenue ─────────────────────────────────────────────────────────────
app.get('/api/kpi/revenue', cached('revenue', 60, async () => {
  const { start: mStart } = getMonthRange();
  const { start: fyStart, end: fyEnd } = getFYRange();
  const r = await syncEngine.getSyncedOrFetch(
    'invoices_fy',
    () => zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd })
  );
  const thisFY    = r.data;
  const thisMonth = thisFY.filter(inv => inv.date >= mStart);

  // Trigger background detail-enrichment for any invoices missing sub_total.
  // Non-blocking: response is served immediately with best available data.
  // When enrichment completes the 'revenue' cache is busted so next request is accurate.
  background(enrichSubTotalsBackground(thisFY).catch(() => {}));

  return {
    this_month:        thisMonth.reduce((s, i) => s + subTotal(i), 0),
    this_fy:           thisFY.reduce((s, i) => s + subTotal(i), 0),
    this_month_detail: thisMonth.map(invSummary),
    this_fy_detail:    thisFY.map(invSummary),
    _data_source:      r.source,
    _synced_at:        r.synced_at,
  };
}));

// ─── KPI: Receivables ─────────────────────────────────────────────────────────
app.get('/api/kpi/receivables', cached('receivables', 60, async () => {
  const { start: mStart } = getMonthRange();

  const r = await syncEngine.getSyncedOrFetch(
    'invoices_unpaid',
    () => zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.Unpaid' }, {})
  );
  const allUnpaid = r.data;
  const thisMonth = allUnpaid.filter(inv => inv.date >= mStart);

  const receivableDetail = i => ({
    invoice_number: i.invoice_number,
    customer_name: i.customer_name,
    date: i.date,
    due_date: i.due_date,
    branch_name: i.branch_name || '-',
    balance: i.balance,
    total: i.total,
    status: i.status,
  });

  return {
    this_month:        thisMonth.reduce((s, i) => s + (i.balance || 0), 0),
    all_time:          allUnpaid.reduce((s, i) => s + (i.balance || 0), 0),
    this_month_detail: thisMonth.map(receivableDetail),
    all_time_detail:   allUnpaid.map(receivableDetail),
    _data_source:      r.source,
    _synced_at:        r.synced_at,
  };
}));

// ─── Revenue by Invoice Category ──────────────────────────────────────────────
app.get('/api/charts/revenue-by-category', cached('rev-category', 60, async () => {
  const { start: mStart } = getMonthRange();
  const { start: fyStart, end: fyEnd } = getFYRange();
  const r = await syncEngine.getSyncedOrFetch(
    'invoices_fy',
    () => zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd })
  );
  const thisFY    = r.data;
  const thisMonth = thisFY.filter(inv => inv.date >= mStart);

  function groupByCategory(invoices) {
    const map = {};
    for (const i of invoices) {
      const cat = i.cf_invoice_category || 'Uncategorized';
      const amt = subTotal(i);
      if (!map[cat]) map[cat] = { category: cat, revenue: 0, count: 0, invoices: [] };
      map[cat].revenue += amt;
      map[cat].count += 1;
      map[cat].invoices.push(invSummary(i));
    }
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }

  return { this_month: groupByCategory(thisMonth), all_time: groupByCategory(thisFY) };
}));

// ─── Tier wise Revenue ─────────────────────────────────────────────────────────
app.get('/api/charts/revenue-by-tier', cached('rev-tier', 60, async () => {
  const { start: mStart } = getMonthRange();
  const { start: fyStart, end: fyEnd } = getFYRange();
  const r = await syncEngine.getSyncedOrFetch(
    'invoices_fy',
    () => zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd })
  );
  const thisFY    = r.data;
  const thisMonth = thisFY.filter(inv => inv.date >= mStart);

  function groupByTier(invoices) {
    const map = {};
    for (const i of invoices) {
      const tier = i.cf_tier_wise_revenue || 'Unassigned';
      const amt = subTotal(i);
      if (!map[tier]) map[tier] = { tier, revenue: 0, count: 0, invoices: [] };
      map[tier].revenue += amt;
      map[tier].count += 1;
      map[tier].invoices.push(invSummary(i));
    }
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }

  return { this_month: groupByTier(thisMonth), all_time: groupByTier(thisFY) };
}));

// ─── City wise Revenue ─────────────────────────────────────────────────────────
app.get('/api/charts/revenue-by-city', cached('rev-city', 60, async () => {
  const { start: mStart } = getMonthRange();
  const { start: fyStart, end: fyEnd } = getFYRange();
  const r = await syncEngine.getSyncedOrFetch(
    'invoices_fy',
    () => zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd })
  );
  const thisFY    = r.data;
  const thisMonth = thisFY.filter(inv => inv.date >= mStart);

  function groupByCity(invoices) {
    const map = {};
    for (const i of invoices) {
      const city = i.cf_city_wise_revenue || 'Unknown';
      const amt = subTotal(i);
      if (!map[city]) map[city] = { city, revenue: 0, count: 0, invoices: [] };
      map[city].revenue += amt;
      map[city].count += 1;
      map[city].invoices.push(invSummary(i));
    }
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }

  return { this_month: groupByCity(thisMonth), all_time: groupByCity(thisFY) };
}));

// ─── Branch wise Outstanding ───────────────────────────────────────────────────
app.get('/api/charts/branch-outstanding', cached('branch-outstanding', 60, async () => {
  const r = await syncEngine.getSyncedOrFetch(
    'invoices_unpaid',
    () => zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.Unpaid' }, {})
  );
  const unpaid = r.data;

  const map = {};
  for (const i of unpaid) {
    const branch = i.branch_name || 'Unknown';
    if (!map[branch]) map[branch] = { branch_name: branch, total_outstanding: 0, invoice_count: 0, invoices: [] };
    map[branch].total_outstanding += i.balance || 0;
    map[branch].invoice_count += 1;
    map[branch].invoices.push({
      invoice_number: i.invoice_number,
      customer_name: i.customer_name,
      date: i.date,
      due_date: i.due_date,
      balance: i.balance,
      total: i.total,
      status: i.status,
    });
  }

  return Object.values(map).sort((a, b) => b.total_outstanding - a.total_outstanding);
}));

// ─── Top 10 Clients ────────────────────────────────────────────────────────────
app.get('/api/charts/top-clients', cached('top-clients', 60, async () => {
  const { start: fyStart, end: fyEnd } = getFYRange();
  const r = await syncEngine.getSyncedOrFetch(
    'invoices_fy',
    () => zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd })
  );
  const all = r.data;

  const map = {};
  for (const i of all) {
    const name = i.customer_name;
    const amt = subTotal(i);
    if (!map[name]) map[name] = { customer_name: name, revenue: 0, invoice_count: 0, outstanding: 0, invoices: [] };
    map[name].revenue += amt;
    map[name].invoice_count += 1;
    map[name].outstanding += i.balance || 0;
    map[name].invoices.push({
      invoice_number: i.invoice_number,
      date: i.date,
      sub_total: amt,
      balance: i.balance,
      branch_name: i.branch_name || '-',
      status: i.status,
    });
  }

  return Object.values(map).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
}));

// ─── Analytical Ratios ────────────────────────────────────────────────────────
app.get('/api/kpi/ar-ratios', cached('ar-ratios', 60, async () => {
  const { start: mStart } = getMonthRange();
  const { start: fyStart } = getFYRange();
  const today = localDate(new Date());

  const [fyResult, unpaidResult, preFYInvoices] = await Promise.all([
    syncEngine.getSyncedOrFetch(
      'invoices_fy',
      () => zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: today })
    ),
    syncEngine.getSyncedOrFetch(
      'invoices_unpaid',
      () => zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.Unpaid' }, {})
    ),
    // Pre-FY paid invoices stay live (small, infrequent, historical)
    zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.Paid' }, { dateFrom: '2023-04-01', dateTo: fyStart }),
  ]);
  const fyInvoices = fyResult.data;
  const allUnpaid  = unpaidResult.data;

  // ── Net Credit Sales ──────────────────────────────────────────────────────
  const netSalesFY    = fyInvoices.reduce((s, i) => s + subTotal(i), 0);
  const netSalesMonth = fyInvoices.filter(i => i.date >= mStart).reduce((s, i) => s + subTotal(i), 0);

  // ── Closing AR (current outstanding balance) ──────────────────────────────
  const closingAR = allUnpaid.reduce((s, i) => s + (i.balance || 0), 0);

  // ── Opening AR at FY start ────────────────────────────────────────────────
  // Part 1: invoices created before FY start still unpaid today
  const preFYStillUnpaid = allUnpaid
    .filter(i => i.date < fyStart)
    .reduce((s, i) => s + (i.balance || 0), 0);
  // Part 2: invoices created before FY start but paid during FY (full amount was AR at FY open)
  const preFYPaidInFY = preFYInvoices
    .filter(i => i.last_payment_date && i.last_payment_date >= fyStart)
    .reduce((s, i) => s + (i.total || 0), 0);

  const openingARFY = preFYStillUnpaid + preFYPaidInFY;
  const avgARFY     = (openingARFY + closingAR) / 2;

  // ── Opening AR at month start ─────────────────────────────────────────────
  const preMonthUnpaid = allUnpaid
    .filter(i => i.date < mStart)
    .reduce((s, i) => s + (i.balance || 0), 0);
  const preMonthPaidThisMonth = fyInvoices
    .filter(i => i.date < mStart && i.status === 'paid' && i.last_payment_date >= mStart)
    .reduce((s, i) => s + (i.total || 0), 0);

  const openingARMonth = preMonthUnpaid + preMonthPaidThisMonth;
  const avgARMonth     = (openingARMonth + closingAR) / 2;

  const round2 = n => Math.round(n * 100) / 100;

  const compute = (netSales, openingAR, avgAR) => ({
    net_credit_sales:        netSales,
    opening_ar:              openingAR,
    closing_ar:              closingAR,
    average_ar:              avgAR,
    ar_turnover:             avgAR > 0 ? round2(netSales / avgAR) : 0,
    receivables_to_sales_pct: netSales > 0 ? round2((avgAR / netSales) * 100) : 0,
    days_to_collect:         netSales > 0 ? Math.round((avgAR / netSales) * 365) : 0,
  });

  return {
    this_month: compute(netSalesMonth, openingARMonth, avgARMonth),
    fy:         compute(netSalesFY,    openingARFY,    avgARFY),
  };
}));

// ─── Client-wise Payment Delay (past 6 months) ────────────────────────────────
app.get('/api/charts/client-payment-delay', cached('client-delay', 600, async () => {
  const now = new Date();
  const start = new Date(now);
  start.setMonth(start.getMonth() - 6);
  const startStr = localDate(start);
  const endStr = localDate(now);

  const paidInvoices = await zohoGetAll(
    '/invoices', 'invoices',
    { filter_by: 'Status.Paid' },
    { dateFrom: startStr, dateTo: endStr }
  );

  // Build month labels for past 6 months
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }

  const clientMap = {};

  for (const inv of paidInvoices) {
    if (!inv.due_date || !inv.last_payment_date) continue;
    const delay = Math.round((new Date(inv.last_payment_date) - new Date(inv.due_date)) / 86400000);
    const name = inv.customer_name;
    const month = inv.last_payment_date.substring(0, 7);

    if (!clientMap[name]) {
      clientMap[name] = {
        customer_name: name,
        total_invoices: 0,
        delayed_invoices: 0,
        total_delay_days: 0,
        max_delay_days: 0,
        avg_delay_days: 0,
        monthly: {},
        payments: [],
      };
      months.forEach(m => { clientMap[name].monthly[m] = { count: 0, total_delay: 0, avg_delay: 0 }; });
    }

    const c = clientMap[name];
    c.total_invoices++;
    c.total_delay_days += delay;
    if (delay > 0) {
      c.delayed_invoices++;
      if (delay > c.max_delay_days) c.max_delay_days = delay;
    }
    if (c.monthly[month]) {
      c.monthly[month].count++;
      c.monthly[month].total_delay += delay;
    }
    c.payments.push({
      invoice_number: inv.invoice_number,
      due_date: inv.due_date,
      payment_date: inv.last_payment_date,
      delay_days: delay,
      amount: inv.total,
      branch_name: inv.branch_name || '-',
    });
  }

  // Compute averages and format monthly trend
  const result = Object.values(clientMap).map(c => {
    c.avg_delay_days = c.total_invoices > 0 ? Math.round(c.total_delay_days / c.total_invoices) : 0;
    months.forEach(m => {
      if (c.monthly[m].count > 0)
        c.monthly[m].avg_delay = Math.round(c.monthly[m].total_delay / c.monthly[m].count);
    });
    c.monthly_trend = months.map(m => ({
      month: m,
      avg_delay: c.monthly[m].avg_delay,
      count: c.monthly[m].count,
    }));
    delete c.monthly;
    c.payments.sort((a, b) => b.delay_days - a.delay_days);
    return c;
  });

  return {
    months,
    clients: result.sort((a, b) => b.avg_delay_days - a.avg_delay_days),
  };
}));

// ─── Branch Seats (read from Excel) ───────────────────────────────────────────
const BRANCH_SEATS_FILE = path.join(__dirname, '..', 'Branch wise Total Seat.xlsx');

function readBranchSeats() {
  const excelPath = BRANCH_SEATS_FILE;
  const workbook = workbooks.read('branch_seats', excelPath);
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const name = rows[i][0];
    const seats = rows[i][1];
    if (name && typeof seats === 'number' && !String(name).toLowerCase().includes('total')) {
      map[name] = seats;
    }
  }
  return map;
}

// Branches confirmed closed — excluded from FY 2026-27 capacity calculations
const CLOSED_BRANCHES = new Set([
  'Amd_Gift City_Tower One_Gandhinagar',
  'Noi_Logix',
]);

function readBranchConfig() {
  const excelPath = BRANCH_SEATS_FILE;
  const workbook = workbooks.read('branch_seats', excelPath);
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  let totalSeats = 0, totalArea = 0;
  for (let i = 1; i < rows.length; i++) {
    const name  = rows[i][0];
    const seats = rows[i][1];
    const area  = rows[i][2];
    if (name && !String(name).toLowerCase().includes('total') && !CLOSED_BRANCHES.has(name)) {
      if (typeof seats === 'number') totalSeats += seats;
      if (typeof area  === 'number') totalArea  += area;
    }
  }
  return { totalSeats, totalArea: Math.round(totalArea) };
}

// ─── Occupancy (Total Seats vs Occupied Seats) ────────────────────────────────
app.get('/api/kpi/occupancy', cached('occupancy', 3600, async () => {
  const branchSeats = readBranchSeats();
  const { start, end } = getMonthRange();

  const invoices = await syncedRange('invoices_fy', start, end, () => zohoGetAll('/invoices', 'invoices',
    { filter_by: 'Status.All' },
    { dateFrom: start, dateTo: end }
  ));

  const occupiedSeats = {};
  const BATCH = 5;

  await loadInvoiceSeats();
  for (let i = 0; i < invoices.length; i += BATCH) {
    const batch = invoices.slice(i, i + BATCH);
    let fetched = false;
    await Promise.all(batch.map(async inv => {
      // invoiceSeats → fetchDetail (shared detailCache + in-flight deduplication)
      const s = await invoiceSeats(inv);
      if (!s) return;
      if (s.fetched) fetched = true;
      occupiedSeats[s.branch] = (occupiedSeats[s.branch] || 0) + s.seats;
    }));
    if (fetched && i + BATCH < invoices.length) await new Promise(r => setTimeout(r, 2000));
  }
  await saveInvoiceSeats();

  const totalSeatCount = Object.values(branchSeats).reduce((s, n) => s + n, 0);
  const totalOccupied = Math.round(Object.values(occupiedSeats).reduce((s, n) => s + n, 0));

  const branches = Object.entries(branchSeats).map(([name, total]) => {
    const occupied = Math.round(occupiedSeats[name] || 0);
    return {
      branch_name: name,
      total_seats: total,
      occupied_seats: occupied,
      unoccupied_seats: Math.max(0, total - occupied),
      occupancy_pct: total > 0 ? Math.round((occupied / total) * 100) : 0,
    };
  }).sort((a, b) => b.total_seats - a.total_seats);

  return {
    total_seats: totalSeatCount,
    total_occupied: totalOccupied,
    total_unoccupied: Math.max(0, totalSeatCount - totalOccupied),
    overall_pct: totalSeatCount > 0 ? Math.round((totalOccupied / totalSeatCount) * 100) : 0,
    branches,
    month: start.substring(0, 7),
  };
}));

// ─── AR Aging Summary ─────────────────────────────────────────────────────────
app.get('/api/kpi/ar-aging', cached('ar-aging', 60, async () => {
  const today   = localDate(new Date());
  const todayMs = new Date(today).getTime();
  const r        = await syncEngine.getSyncedOrFetch(
    'invoices_unpaid',
    () => zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.Unpaid' }, {})
  );
  const allUnpaid = r.data;

  const bucketDefs = [
    { label: 'Current',      min: -Infinity, max: 0   },
    { label: '1-90 Days',    min: 1,         max: 90  },
    { label: '91-180 Days',  min: 91,        max: 180 },
    { label: '181-270 Days', min: 181,       max: 270 },
    { label: '271-360 Days', min: 271,       max: 360 },
    { label: '361-450 Days', min: 361,       max: 450 },
    { label: '451-540 Days', min: 451,       max: 540 },
    { label: '541+ Days',    min: 541,       max: Infinity },
  ];

  const summary = bucketDefs.map(b => ({ label: b.label, amount: 0, count: 0 }));
  const customerMap = {};

  for (const inv of allUnpaid) {
    if (!inv.due_date) continue;
    const daysOverdue = Math.floor((todayMs - new Date(inv.due_date).getTime()) / 86400000);
    const balance = inv.balance || 0;

    let idx = 0;
    if (daysOverdue > 0) idx = Math.min(Math.ceil(daysOverdue / 90), 7);

    summary[idx].amount += balance;
    summary[idx].count  += 1;

    const name = inv.customer_name;
    if (!customerMap[name]) {
      customerMap[name] = {
        customer_name: name,
        total_outstanding: 0,
        buckets: bucketDefs.map(() => ({ amount: 0, count: 0 })),
        invoices: [],
      };
    }
    const c = customerMap[name];
    c.total_outstanding += balance;
    c.buckets[idx].amount += balance;
    c.buckets[idx].count  += 1;
    c.invoices.push({
      invoice_number: inv.invoice_number,
      date: inv.date,
      due_date: inv.due_date,
      days_overdue: daysOverdue,
      balance,
      total: inv.total,
      branch_name: inv.branch_name || '-',
    });
  }

  const customers = Object.values(customerMap)
    .sort((a, b) => b.total_outstanding - a.total_outstanding);

  return {
    as_of: today,
    total_outstanding: summary.reduce((s, b) => s + b.amount, 0),
    total_invoices: allUnpaid.length,
    buckets: summary,
    customers,
  };
}));

// ─── Client Agreements ────────────────────────────────────────────────────────

// Serve PDF/DOCX files — path validated to stay inside AGREEMENTS_DIR
app.get('/api/agreements/file/*', (req, res) => {
  const rel  = decodeURIComponent(req.params[0] || '');
  if (IS_VERCEL) {
    // Vercel holds no PDFs: open the company OneDrive/SharePoint copy of "Client Agreements"
    // (same folder layout), e.g. AGREEMENTS_BASE_URL=https://<tenant>.sharepoint.com/sites/<site>/Shared Documents/Client Agreements
    const base = (process.env.AGREEMENTS_BASE_URL || '').replace(/\/+$/, '');
    if (!base) return res.status(404).send('Agreement PDFs are kept in the company OneDrive — AGREEMENTS_BASE_URL is not set.');
    return res.redirect(`${base}/${rel.split('/').map(encodeURIComponent).join('/')}`);
  }
  const full = path.resolve(AGREEMENTS_DIR, rel);
  if (!full.startsWith(path.resolve(AGREEMENTS_DIR))) return res.status(403).send('Forbidden');
  if (!fs.existsSync(full)) return res.status(404).send('Not found');
  res.sendFile(full);
});

// Folder structure scan
app.get('/api/agreements/structure', async (req, res) => {
  try {
    // Vercel has no agreements folder: the listing stored by upload-to-neon.js
    if (IS_VERCEL) return res.json((await db.readJSON('agreements_structure', null, null)) || {});
    res.json(scanAgreementsFolder());
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Read all stored agreement data
app.get('/api/agreements/data', async (req, res) => res.json(await readAgreementsData()));

// Save agreement data for one client
app.post('/api/agreements/save', async (req, res) => {
  const { state, branch, client, data } = req.body || {};
  if (!state || !branch || !client || !data) return res.status(400).json({ error: 'Missing fields' });
  const all = await readAgreementsData();
  if (!all[state])          all[state] = {};
  if (!all[state][branch])  all[state][branch] = {};
  all[state][branch][client] = data;
  await writeAgreementsData(all);
  res.json({ ok: true });
});

// Expiry report — returns clients whose end_date or lock_in_date falls in
// current month / current quarter / next quarter
app.get('/api/agreements/expiry', async (req, res) => {
  const allData = await readAgreementsData();
  const today   = new Date();

  const qIdx = Math.floor(today.getMonth() / 3);
  const nextQIdx = (qIdx + 1) % 4;
  const nextQYear = qIdx === 3 ? today.getFullYear() + 1 : today.getFullYear();

  const ranges = {
    current_month: {
      label: today.toLocaleString('en-IN', { month: 'long', year: 'numeric' }),
      start: new Date(today.getFullYear(), today.getMonth(), 1),
      end:   new Date(today.getFullYear(), today.getMonth() + 1, 0),
    },
    current_quarter: {
      label: `Q${qIdx + 1} FY ${today.getFullYear()}-${String(today.getFullYear() + 1).slice(2)}`,
      start: new Date(today.getFullYear(), qIdx * 3, 1),
      end:   new Date(today.getFullYear(), (qIdx + 1) * 3, 0),
    },
    next_quarter: {
      label: `Q${nextQIdx + 1} FY ${nextQYear}-${String(nextQYear + 1).slice(2)}`,
      start: new Date(nextQYear, nextQIdx * 3, 1),
      end:   new Date(nextQYear, (nextQIdx + 1) * 3, 0),
    },
  };

  function inRange(dateStr, start, end) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    return d >= start && d <= end;
  }

  const result = {};
  for (const [key, range] of Object.entries(ranges)) {
    const items = [];
    for (const [state, branches] of Object.entries(allData)) {
      for (const [branch, clients] of Object.entries(branches)) {
        for (const [client, cdata] of Object.entries(clients)) {
          const endDate    = resolvedDate(cdata.end_date,     cdata.start_date, cdata.agreement_term);
          const lockInDate = resolvedDate(cdata.lock_in_date, cdata.start_date, cdata.lock_in_term);
          const endExp     = inRange(endDate, range.start, range.end);
          const lockExp    = inRange(lockInDate, range.start, range.end);
          if (endExp || lockExp) {
            items.push({
              state, branch, client,
              no_of_seats:    cdata.no_of_seats,
              rate_per_seat:  cdata.rate_per_seat,
              start_date:     cdata.start_date,
              end_date:       endDate,
              lock_in_date:   lockInDate,
              agreement_term: cdata.agreement_term,
              lock_in_term:   cdata.lock_in_term,
              notice_period:  cdata.notice_period,
              end_expires:    endExp,
              lock_in_expires: lockExp,
            });
          }
        }
      }
    }
    result[key] = { label: range.label, items };
  }
  res.json(result);
});

// ─── PDF Extraction Helpers ────────────────────────────────────────────────────

function pdfNormalize(t) {
  return t
    .replace(/ /g, ' ')          // non-breaking space → regular space
    .replace(/[‐‑‒–—―‐-―]/g, '-')  // various dashes → ASCII hyphen
    .replace(/[“”]/g, '"')   // curly double quotes
    .replace(/[‘’]/g, "'")   // curly single quotes
    .replace(/(\d)\n(st|nd|rd|th)\n/g, '$1$2 ')  // "7\nth\n" → "7th "
    .replace(/-\n(\w)/g, '-$1');        // hyphenated line breaks
}

function parsePdfDate(s) {
  if (!s) return null;
  s = s.replace(/(\d+)[^\w\s]h/g, '$1 ')  // "24'h" → "24 "
       .replace(/(\d+)\s*(st|nd|rd|th)\b/gi, '$1')
       .trim();
  const M = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const m = s.match(/(\d{1,2})\s+(\w{3,})[,\s]+(\d{4})/i);
  if (!m) return null;
  const mon = M[m[2].toLowerCase().substring(0, 3)];
  return mon ? `${m[3]}-${String(mon).padStart(2,'0')}-${m[1].padStart(2,'0')}` : null;
}

function parsePdfINR(s) {
  if (!s) return null;
  const m = s.match(/INR\s*([\d,]+(?:\.\d+)?)/i) || s.match(/([\d,]+(?:\.\d+)?)\s*\/-/);
  return m ? Math.round(parseFloat(m[1].replace(/,/g, ''))) : null;
}

function pdfNormalizeTerm(s) {
  if (!s) return null;
  return s.replace(/\([a-z\s-]+\)/gi, '').replace(/\s+/g, ' ').trim()
    .replace(/Months?/gi, 'months').replace(/Years?/gi, 'years').replace(/Days?/gi, 'days');
}

function isPdfValue(s) {
  return /[\d₹%*]|INR|months?|years?|days?/i.test(s);
}

function extractPdfAnnexureA(rawText) {
  const text = pdfNormalize(rawText);

  // Search last 45% of document for Annexure A table
  const searchFrom = Math.floor(text.length * 0.55);
  const tail = text.substring(searchFrom);

  // Find EARLIEST anchor in the tail (= start of Annexure A table)
  let relStart = -1;
  const ANCHORS = ['Name of the Member', 'Lock In Term', 'Agreement Term', 'Price per Seat',
                   'Number of Seats', 'No. of Seats', 'Seat Details', 'Number of Individual'];
  for (const a of ANCHORS) {
    const idx = tail.indexOf(a);
    if (idx >= 0 && (relStart < 0 || idx < relStart)) relStart = idx;
  }
  if (relStart < 0) return {};

  let section = tail.substring(Math.max(0, relStart - 100), relStart + 4000);
  const bIdx = section.indexOf('ANNEXURE B');
  if (bIdx > 0) section = section.substring(0, bIdx);

  // Keep 2-digit numbers — they may be date day numbers (e.g. "01", "15")
  const lines = section.split('\n').map(l => l.trim())
    .filter(l => l && !/^(-{3,}|={3,})$/.test(l) && !/^\d{4,}\s*$/.test(l));

  const FIELDS = [
    { rx: /^name of the member/i,                                                       key: 'client_legal_name' },
    { rx: /^industry/i,                                                                  key: '_skip' },
    { rx: /^agreement date/i,                                                            key: '_adate' },
    { rx: /^start date|^rent commencement|^start dated/i,                               key: '_sdate' },
    { rx: /^lock[\s-]*in term/i,                                                         key: 'lock_in_term' },
    { rx: /^agreement term/i,                                                            key: 'agreement_term' },
    { rx: /^annual increment(?:\s+in\s+fees)?/i,                                        key: 'annual_increment' },
    { rx: /^membership plan/i,                                                           key: 'membership_plan' },
    { rx: /^shift timings?/i,                                                            key: 'shift_timing' },
    { rx: /^number of (?:individual\s+)?(?:members?|seats?|desks?)|^no\.?\s*of\s+(?:seats?|members?)|^seat details?/i, key: 'no_of_seats' },
    { rx: /^price per seat/i,                                                            key: '_rate' },
    { rx: /^membership fee per month/i,                                                  key: '_mfee' },
    { rx: /^interest free security deposit/i,                                            key: '_sec_dep' },
  ];

  const isFieldLabel = l => FIELDS.some(f => f.rx.test(l));
  const result = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = FIELDS.find(f => f.rx.test(line));
    if (!match || match.key === '_skip') continue;

    const labelM = line.match(match.rx);
    const afterLabel = labelM ? line.substring(labelM[0].length).trim() : '';
    const cleanInline = afterLabel.replace(/^\([^)]*\)\s*/, '').trim();

    // Collect up to 5 next lines for date fields (dates are often split across lines)
    const maxNext = (match.key === '_adate' || match.key === '_sdate') ? 5 : 3;
    const nextLines = [];
    for (let j = i + 1; j < lines.length && !isFieldLabel(lines[j]); j++) {
      nextLines.push(lines[j]);
      if (nextLines.length >= maxNext) break;
    }

    if (match.key === '_sec_dep') {
      result._sec_inline = afterLabel;
      result._sec_amount = nextLines[0] || '';
    } else if (match.key === '_adate' || match.key === '_sdate') {
      // Dates are often split: day on label line, month+year on next lines — combine all
      const combined = [cleanInline, ...nextLines].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (combined) result[match.key] = combined;
    } else {
      // Prefer inline value if it looks like data; fall back to next lines; fall back to cleanInline
      let val;
      if (isPdfValue(cleanInline)) {
        val = cleanInline;
      } else if (nextLines.length > 0) {
        val = nextLines.join(' ');
      } else if (cleanInline) {
        val = cleanInline; // last resort: use whatever's on the label line
      }
      if (val) result[match.key] = val.replace(/\s+/g, ' ').trim();
    }
  }

  if (result._adate) { result.agreement_date = parsePdfDate(result._adate); delete result._adate; }
  if (result._sdate) { result.start_date = parsePdfDate(result._sdate); delete result._sdate; }
  if (result._rate)  { result.rate_per_seat = parsePdfINR(result._rate); delete result._rate; }
  if (result._mfee)  { result.monthly_fee = parsePdfINR(result._mfee); delete result._mfee; }
  if (result._sec_inline !== undefined) {
    const combined = result._sec_inline + ' ' + result._sec_amount;
    const mM = combined.match(/(\d+)\s*months?/i);
    if (mM) result.security_deposit_months = parseInt(mM[1]);
    result.security_deposit_amount = parsePdfINR(result._sec_amount) || null;
    delete result._sec_inline; delete result._sec_amount;
  }

  if (result.lock_in_term) result.lock_in_term = pdfNormalizeTerm(result.lock_in_term);
  if (result.agreement_term) result.agreement_term = pdfNormalizeTerm(result.agreement_term);
  if (result.no_of_seats) {
    const n = String(result.no_of_seats).match(/^(\d+)/);
    result.no_of_seats = n ? parseInt(n[1]) : null;
  }
  return result;
}

function extractPdfBodyInfo(rawText) {
  const text = pdfNormalize(rawText);
  const result = {};

  // Find invoicing section anchored to "Bill To :"
  const billStart = text.search(/Bill\s+[Tt]o\s*:/);
  if (billStart >= 0) {
    const inv = text.substring(billStart, billStart + 800);
    const billM = inv.match(/Bill\s+[Tt]o\s*:?\s*(?:i+\.\s*)?([^\n]+)/i);
    if (billM) result.billing_name = billM[1].trim().replace(/\s+/g, ' ');

    // Address: capture up to 3 lines, stop at GSTIN/PAN
    const addrM = inv.match(/Address\s*:?\s*(?:ii?\.\s*)?([^\n]+(?:\n[^\n]+){0,2})/i);
    if (addrM) {
      const raw = addrM[1].replace(/\n/g, ' ');
      const stop = raw.search(/GSTIN|PAN\s*Number?|Place of Supply|iii\.|iv\./i);
      result.billing_address = (stop > 0 ? raw.substring(0, stop) : raw)
        .replace(/\s+/g, ' ').trim().replace(/,\s*$/, '');
    }

    const gstM = inv.match(/GSTIN\s*:?\s*([0-9A-Z]{15}|N\/A|NA)/i);
    if (gstM) result.client_gst = gstM[1].toUpperCase().replace(/\s/g, '');

    const panM = inv.match(/PAN(?:\s*Number)?\s*:?\s*([A-Z]{5}[0-9]{4}[A-Z])/i);
    if (panM) result.client_pan = panM[1];
  }

  // Notice period from termination clause
  const noticeM = text.match(/minimum\s+of\s*,?\s*(\d+)\s*\([a-z\s-]+\)\s*months?/i)
               || text.match(/(\d+)\s*\([a-z\s-]+\)\s*months?.*?(?:notice|termination|assigning no reason)/i);
  if (noticeM) result.notice_months = parseInt(noticeM[1]);

  // Interest rate on delay
  const intM = text.match(/(\d+)%\s*p\.a\./i);
  if (intM) result.interest_rate = parseFloat(intM[1]);

  return result;
}

function collectClientPDFs(dir) {
  const pdfs = [];
  function scan(d, depth) {
    if (!fs.existsSync(d)) return;
    for (const item of fs.readdirSync(d)) {
      if (item.toLowerCase() === 'kyc') continue; // skip KYC folders
      const full = path.join(d, item);
      const stat = fs.statSync(full);
      if (stat.isDirectory() && depth < 3) {
        scan(full, depth + 1);
      } else if (item.toLowerCase().endsWith('.pdf')) {
        pdfs.push({ path: full, name: item, isAmendment: isAmendmentFile(item) });
      }
    }
  }
  scan(dir, 0);
  return pdfs;
}

// ─── OCR helpers ──────────────────────────────────────────────────────────────

let _ocrWorkerPool = null;
async function getOcrWorker() {
  const { createWorker } = require('tesseract.js');
  const worker = await createWorker('eng', 1, {
    logger: () => {},
    errorHandler: () => {},
  });
  return worker;
}

async function ocrPdfText(pdfPath) {
  const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  const { createCanvas } = require('@napi-rs/canvas');
  pdfjsLib.GlobalWorkerOptions.workerSrc = false;

  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const pdf = await pdfjsLib.getDocument({ data, disableFontFace: true, verbosity: 0 }).promise;

  // OCR last 3 pages (Annexure A is always near the end) + first page (billing info)
  const totalPages = pdf.numPages;
  const pageNums = new Set();
  pageNums.add(1);
  for (let i = Math.max(1, totalPages - 2); i <= totalPages; i++) pageNums.add(i);

  const yield_ = () => new Promise(r => setImmediate(r));

  let fullText = '';
  const worker = await getOcrWorker();
  try {
    for (const pageNum of [...pageNums].sort((a,b)=>a-b)) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.5 });
      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
      await yield_(); // yield after synchronous canvas rendering
      const imageData = canvas.toBuffer('image/png');
      await yield_(); // yield after synchronous PNG encoding
      const { data: { text } } = await worker.recognize(imageData);
      fullText += text + '\n';
      page.cleanup();
    }
  } finally {
    await worker.terminate();
  }
  return fullText;
}

// OCR progress state (in-memory, single session)
const ocrState = { running: false, done: 0, total: 0, errors: 0, log: [] };

// OCR extract endpoint — processes scanned PDFs using Tesseract
app.get('/api/agreements/ocr-extract', async (req, res) => {
  if (ocrState.running) return res.json({ status: 'running', ...ocrState });
  res.json({ status: 'started', message: 'OCR extraction started in background' });

  ocrState.running = true;
  ocrState.done = 0;
  ocrState.errors = 0;
  ocrState.log = [];

  (async () => {
    try {
      const allData = await readAgreementsData();
      const scannedClients = [];

      for (const state of fs.readdirSync(AGREEMENTS_DIR)) {
        const statePath = path.join(AGREEMENTS_DIR, state);
        if (!fs.statSync(statePath).isDirectory()) continue;
        for (const branch of fs.readdirSync(statePath)) {
          const branchPath = path.join(statePath, branch);
          if (!fs.statSync(branchPath).isDirectory()) continue;
          for (const client of fs.readdirSync(branchPath)) {
            const clientPath = path.join(branchPath, client);
            if (!fs.statSync(clientPath).isDirectory()) continue;
            const existing = allData[state]?.[branch]?.[client] || {};
            // Only process clients marked as scanned OR with very few fields
            const hasGoodData = existing.no_of_seats && existing.rate_per_seat && existing.start_date;
            if (!hasGoodData) {
              const pdfs = collectClientPDFs(clientPath).filter(f => !f.isAmendment);
              if (pdfs.length > 0) scannedClients.push({ state, branch, client, pdfs, clientPath });
            }
          }
        }
      }

      ocrState.total = scannedClients.length;

      for (const { state, branch, client, pdfs } of scannedClients) {
        let bestFields = {};
        let bestFieldCount = 0;
        let bestFileName = null;

        for (const pdf of pdfs) {
          try {
            // Try normal text extraction first (faster)
            const buf = fs.readFileSync(pdf.path);
            const parsed = await pdfParse(buf).catch(() => null);
            let text = parsed?.text || '';

            // If text is too short, use OCR
            if (text.length < 300) {
              text = await ocrPdfText(pdf.path);
            }

            if (text.length < 100) continue;

            const annexData = extractPdfAnnexureA(text);
            const bodyData  = extractPdfBodyInfo(text);

            const ef = {};
            if (bodyData.billing_name)           ef.invoicing_legal_name = bodyData.billing_name;
            else if (annexData.client_legal_name) ef.invoicing_legal_name = annexData.client_legal_name;
            if (annexData.no_of_seats)            ef.no_of_seats = annexData.no_of_seats;
            if (annexData.rate_per_seat)          ef.rate_per_seat = annexData.rate_per_seat;
            if (annexData.start_date)             ef.start_date = annexData.start_date;
            if (annexData.agreement_term)         ef.agreement_term = annexData.agreement_term;
            if (annexData.lock_in_term)           ef.lock_in_term = annexData.lock_in_term;
            if (annexData.annual_increment)       ef.annual_increment = annexData.annual_increment;
            if (annexData.membership_plan)        ef.membership_plan = annexData.membership_plan;
            if (annexData.shift_timing)           ef.shift_timing = annexData.shift_timing;
            if (annexData.security_deposit_amount) ef.security_deposit_amount = annexData.security_deposit_amount;
            if (annexData.security_deposit_months) ef.security_deposit_months = annexData.security_deposit_months;
            if (annexData.monthly_fee)            ef.monthly_fee = annexData.monthly_fee;
            if (bodyData.billing_address)         ef.billing_address = bodyData.billing_address;
            if (bodyData.client_gst && bodyData.client_gst !== 'N/A') ef.gst_number = bodyData.client_gst;
            if (bodyData.notice_months)           ef.notice_period = `${bodyData.notice_months} months`;
            if (bodyData.interest_rate)           ef.interest_rate = bodyData.interest_rate;

            for (const [k, v] of Object.entries(ef)) {
              if (v !== null && v !== undefined && v !== '' && !bestFields[k]) bestFields[k] = v;
            }
            const count = Object.keys(bestFields).filter(k => !k.startsWith('_')).length;
            if (count > bestFieldCount) { bestFieldCount = count; bestFileName = pdf.name; }
          } catch (e) {
            ocrState.errors++;
          }
        }

        if (bestFieldCount > 0) {
          if (bestFields.start_date && bestFields.agreement_term)
            bestFields.end_date = addTermToDate(bestFields.start_date, bestFields.agreement_term);
          if (bestFields.start_date && bestFields.lock_in_term)
            bestFields.lock_in_date = addTermToDate(bestFields.start_date, bestFields.lock_in_term);

          bestFields._extracted_from = bestFileName;
          bestFields._extraction_note = bestFieldCount >= 4
            ? `Auto-extracted via OCR (${bestFieldCount} fields found)`
            : 'OCR partial — check and complete manually';

          const existing = allData[state]?.[branch]?.[client] || {};
          const merged = { ...bestFields };
          for (const [k, v] of Object.entries(existing)) {
            if (k.startsWith('_')) continue;
            if (v !== null && v !== undefined && v !== '') merged[k] = v;
          }
          if (existing.amendments) merged.amendments = existing.amendments;

          if (!allData[state]) allData[state] = {};
          if (!allData[state][branch]) allData[state][branch] = {};
          allData[state][branch][client] = merged;

          ocrState.log.push({ client, branch, fields: bestFieldCount, status: 'extracted' });
        } else {
          ocrState.log.push({ client, branch, fields: 0, status: 'no_data' });
        }

        ocrState.done++;
        // Save incrementally every 10 clients so progress is not lost
        if (ocrState.done % 10 === 0) await writeAgreementsData(allData);
        // Yield to event loop so HTTP requests aren't starved between clients
        await new Promise(r => setImmediate(r));
      }

      await writeAgreementsData(allData);
      cache.del('agreements-expiry');
    } catch (e) {
      ocrState.errors++;
    } finally {
      ocrState.running = false;
    }
  })();
});

// OCR progress poll endpoint
app.get('/api/agreements/ocr-status', (req, res) => {
  res.json(ocrState);
});

// Auto-extract data from all main (non-amendment) PDFs across all clients
// Merges extracted data into agreements_data.json without overwriting manual entries
app.get('/api/agreements/extract', async (req, res) => {
  const summary = { processed: 0, extracted: 0, scanned: 0, skipped: 0, errors: 0, clients: [] };

  if (!fs.existsSync(AGREEMENTS_DIR)) return res.json(summary);

  const allData = await readAgreementsData();

  for (const state of fs.readdirSync(AGREEMENTS_DIR)) {
    const statePath = path.join(AGREEMENTS_DIR, state);
    if (!fs.statSync(statePath).isDirectory()) continue;

    for (const branch of fs.readdirSync(statePath)) {
      const branchPath = path.join(statePath, branch);
      if (!fs.statSync(branchPath).isDirectory()) continue;

      for (const client of fs.readdirSync(branchPath)) {
        const clientPath = path.join(branchPath, client);
        if (!fs.statSync(clientPath).isDirectory()) continue;

        const pdfs = collectClientPDFs(clientPath);
        const mainPdfs = pdfs.filter(f => !f.isAmendment);
        if (mainPdfs.length === 0) { summary.skipped++; continue; }

        // Try ALL text-based PDFs and accumulate fields — more PDFs = more complete data
        let bestFields = {};
        let bestFieldCount = 0;
        let bestFileName = null;
        let anyExtracted = false;
        let allScanned = true;

        for (const pdf of mainPdfs) {
          summary.processed++;
          try {
            const buf = fs.readFileSync(pdf.path);
            const parsed = await pdfParse(buf);
            const text = parsed.text;

            if (text.length < 300) {
              summary.scanned++;
              summary.clients.push({ client, branch, file: pdf.name, status: 'scanned' });
              continue;
            }

            allScanned = false;
            const annexData = extractPdfAnnexureA(text);
            const bodyData  = extractPdfBodyInfo(text);

            const ef = {};
            if (bodyData.billing_name)           ef.invoicing_legal_name = bodyData.billing_name;
            else if (annexData.client_legal_name) ef.invoicing_legal_name = annexData.client_legal_name;
            if (annexData.no_of_seats)            ef.no_of_seats = annexData.no_of_seats;
            if (annexData.rate_per_seat)          ef.rate_per_seat = annexData.rate_per_seat;
            if (annexData.start_date)             ef.start_date = annexData.start_date;
            if (annexData.agreement_term)         ef.agreement_term = annexData.agreement_term;
            if (annexData.lock_in_term)           ef.lock_in_term = annexData.lock_in_term;
            if (annexData.annual_increment)       ef.annual_increment = annexData.annual_increment;
            if (annexData.membership_plan)        ef.membership_plan = annexData.membership_plan;
            if (annexData.shift_timing)           ef.shift_timing = annexData.shift_timing;
            if (annexData.security_deposit_amount) ef.security_deposit_amount = annexData.security_deposit_amount;
            if (annexData.security_deposit_months) ef.security_deposit_months = annexData.security_deposit_months;
            if (annexData.monthly_fee)            ef.monthly_fee = annexData.monthly_fee;
            if (bodyData.billing_address)         ef.billing_address = bodyData.billing_address;
            if (bodyData.client_gst && bodyData.client_gst !== 'N/A') ef.gst_number = bodyData.client_gst;
            if (bodyData.notice_months)           ef.notice_period = `${bodyData.notice_months} months`;
            if (bodyData.interest_rate)           ef.interest_rate = bodyData.interest_rate;

            // Accumulate: merge this PDF's fields into bestFields (fill in any missing fields)
            for (const [k, v] of Object.entries(ef)) {
              if (v !== null && v !== undefined && v !== '' && !bestFields[k]) bestFields[k] = v;
            }
            const count = Object.keys(bestFields).filter(k => !k.startsWith('_')).length;
            if (count > bestFieldCount) { bestFieldCount = count; bestFileName = pdf.name; }
            anyExtracted = true;
            summary.clients.push({ client, branch, file: pdf.name, status: 'extracted', fields: Object.keys(ef).length });

          } catch (e) {
            summary.errors++;
            summary.clients.push({ client, branch, file: pdf.name, status: 'error', error: e.message });
          }
        }

        if (!anyExtracted && allScanned) {
          // All PDFs are scanned — mark client
          if (!allData[state]) allData[state] = {};
          if (!allData[state][branch]) allData[state][branch] = {};
          if (!allData[state][branch][client]) allData[state][branch][client] = {};
          if (!allData[state][branch][client]._extraction_note)
            allData[state][branch][client]._extraction_note = 'PDF is scanned — please enter data manually';
        } else if (anyExtracted) {
          // Compute derived dates from accumulated fields
          if (bestFields.start_date && bestFields.agreement_term)
            bestFields.end_date = addTermToDate(bestFields.start_date, bestFields.agreement_term);
          if (bestFields.start_date && bestFields.lock_in_term)
            bestFields.lock_in_date = addTermToDate(bestFields.start_date, bestFields.lock_in_term);

          bestFields._extracted_from = bestFileName;
          bestFields._extraction_note = bestFieldCount >= 4
            ? `Auto-extracted from PDF (${bestFieldCount} fields found)`
            : 'PDF partially readable — check and complete manually';

          // Merge: preserve existing non-null manually-entered fields
          const existing = allData[state]?.[branch]?.[client] || {};
          const merged = { ...bestFields };
          for (const [k, v] of Object.entries(existing)) {
            if (k.startsWith('_')) continue;
            if (v !== null && v !== undefined && v !== '') merged[k] = v;
          }
          if (existing.amendments) merged.amendments = existing.amendments;

          if (!allData[state]) allData[state] = {};
          if (!allData[state][branch]) allData[state][branch] = {};
          allData[state][branch][client] = merged;
          summary.extracted++;
        }
      }
    }
  }

  await writeAgreementsData(allData);
  cache.del('agreements-expiry'); // invalidate expiry cache
  res.json(summary);
});

// ═══════════════════════════════════════════════════════════════════════════════
// PURCHASE & PAYABLES DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

function billSubTotal(b) {
  if (b.sub_total != null) return b.sub_total;
  if (b.tax_total != null) return (b.total || 0) - b.tax_total;
  return Math.round(((b.total || 0) / 1.18) * 100) / 100;
}

// ─── Rent bill details (persistent) ───────────────────────────────────────────
// The rent report needs each bill's pre-tax sub_total, office no. and line account,
// which only the bill DETAIL API has. Details are kept permanently per bill and
// refetched only when Zoho's last_modified_time changes. Fetches go through the
// shared paced queue (rptZohoGet, ~65/min) because a FY holds ~1,500 landlord bills;
// firing them all at once got most calls throttled and silently replaced by a
// wrong total ÷ 1.18 estimate.
const RENT_DETAILS_FILE = path.join(__dirname, 'rent_bill_details.json');
const _rentQueue = new Map();  // bill_id → bills-list row awaiting a detail fetch
let _rentWorker = null;

function rentDetailStale(store, b) {
  const s = store[b.bill_id];
  return !s || (b.last_modified_time && s.lmt !== b.last_modified_time);
}

// Pre-tax estimate from list fields while a bill's detail is not stored yet: the list
// total is net of TDS, and only GST-registered landlords add GST (18% on rent).
function rentEstimate(b) {
  const gross = (b.total || 0) + (b.tds_total || 0);
  return b.gst_treatment === 'business_gst' ? Math.round((gross / 1.18) * 100) / 100 : gross;
}

function queueRentDetails(bills) {
  for (const b of bills) _rentQueue.set(b.bill_id, b);
  if (!_rentWorker) _rentWorker = drainRentQueue().finally(() => { _rentWorker = null; });
  return _rentWorker;
}

async function drainRentQueue() {
  const store = await rptStore('rent_bill_details', RENT_DETAILS_FILE);
  let unsaved = 0, blocked = false;
  try {
    while (_rentQueue.size && !blocked) {
      const batch = [..._rentQueue.values()].slice(0, 3);
      batch.forEach(b => _rentQueue.delete(b.bill_id));
      await Promise.all(batch.map(async b => {
        try {
          const bill = (await rptZohoGet(`/bills/${b.bill_id}`)).bill || {};
          let office_no = null, account_name = null;
          for (const li of (bill.line_items || [])) {
            if (!office_no) {
              const cf = (li.item_custom_fields || []).find(f => f.api_name === 'cf_office_no');
              if (cf?.value) office_no = String(cf.value);
            }
            if (!account_name && li.account_name) account_name = li.account_name;
            if (office_no && account_name) break;
          }
          store[b.bill_id] = {
            lmt: b.last_modified_time || bill.last_modified_time || null,
            sub_total: bill.sub_total ?? null, office_no, account_name,
          };
          unsaved++;
        } catch (e) {
          if (e.response?.status === 429 || /LIMIT/.test(e.message)) blocked = true;
          console.warn(`[rent] bill ${b.bill_id} detail failed:`, e.message);
        }
      }));
      if (unsaved >= 60) { await rptStoreSave('rent_bill_details', RENT_DETAILS_FILE); unsaved = 0; }
    }
  } finally {
    // Throttled: stop here; the next report load re-queues whatever is still missing
    if (blocked) _rentQueue.clear();
    if (unsaved) await rptStoreSave('rent_bill_details', RENT_DETAILS_FILE);
    cache.keys().filter(k => k.startsWith('pur-rent-mw-')).forEach(k => cache.del(k));
  }
}

function billSummary(b) {
  return {
    bill_number: b.bill_number,
    vendor_name: b.vendor_name,
    date: b.date,
    due_date: b.due_date,
    branch_name: b.branch_name || '-',
    sub_total: billSubTotal(b),
    total: b.total || 0,
    balance: b.balance || 0,
    status: b.status,
    account_name: b.account_name || '-',
    sub_category: (b.cf_category_unformatted || b.cf_category || '-'),
  };
}

// ─── Purchase KPI: Avg Vendor Payment Delay ───────────────────────────────────
app.get('/api/purchase/kpi/avg-payment-delay', cached('pur-avg-delay', 600, async () => {
  const { start, end } = getPast12MonthsRange();
  const paidBills = await zohoGetAll('/bills', 'bills', { filter_by: 'Status.Paid' }, { dateFrom: start, dateTo: end });

  const delayData = [];
  for (const b of paidBills) {
    if (!b.due_date || !b.last_payment_date) continue;
    const delay = Math.round((new Date(b.last_payment_date) - new Date(b.due_date)) / 86400000);
    delayData.push({
      bill_number: b.bill_number,
      vendor_name: b.vendor_name,
      branch_name: b.branch_name || '-',
      due_date: b.due_date,
      payment_date: b.last_payment_date,
      delay_days: delay,
      amount: b.total,
    });
  }

  const onlyDelayed = delayData.filter(d => d.delay_days > 0);
  const avg = onlyDelayed.length
    ? Math.round(onlyDelayed.reduce((s, d) => s + d.delay_days, 0) / onlyDelayed.length)
    : 0;

  return {
    avg_delay_days: avg,
    total_payments_analyzed: delayData.length,
    delayed_count: onlyDelayed.length,
    detail: delayData.sort((a, b) => b.delay_days - a.delay_days),
  };
}));

// ─── Purchase KPI: Bill Count ─────────────────────────────────────────────────
app.get('/api/purchase/kpi/bill-count', cached('pur-bill-count', 60, async () => {
  const { start: mStart } = getMonthRange();
  const { start: fyStart, end: fyEnd } = getFYRange();
  const r = await syncEngine.getSyncedOrFetch(
    'bills_fy',
    () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd })
  );
  const thisFY    = r.data;
  const thisMonth = thisFY.filter(b => b.date >= mStart);
  return {
    this_month:        thisMonth.length,
    this_fy:           thisFY.length,
    this_month_detail: thisMonth.map(billSummary),
    _data_source:      r.source,
    _synced_at:        r.synced_at,
  };
}));

// ─── Purchase KPI: Expense (ex-tax) ──────────────────────────────────────────
app.get('/api/purchase/kpi/expense', cached('pur-expense', 60, async () => {
  const { start: mStart } = getMonthRange();
  const { start: fyStart, end: fyEnd } = getFYRange();
  const r = await syncEngine.getSyncedOrFetch(
    'bills_fy',
    () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd })
  );
  const thisFY    = r.data;
  const thisMonth = thisFY.filter(b => b.date >= mStart);
  return {
    this_month:        thisMonth.reduce((s, b) => s + billSubTotal(b), 0),
    this_fy:           thisFY.reduce((s, b) => s + billSubTotal(b), 0),
    this_month_detail: thisMonth.map(billSummary),
    this_fy_detail:    thisFY.map(billSummary),
    _data_source:      r.source,
    _synced_at:        r.synced_at,
  };
}));

// ─── Purchase KPI: Vendor Payments + Vendor Credits ──────────────────────────
app.get('/api/purchase/kpi/payments', cached('pur-payments', 300, async () => {
  const today = localDate(new Date());
  const { start: mStart, end: mEnd } = getMonthRange();

  const [todayPay, monthPay, todayVC, monthVC] = await Promise.all([
    syncedRange('vendor_payments_fy', today,  today, () => zohoGetAll('/vendorpayments', 'vendorpayments', { date_start: today,  date_end: today  }, { dateFrom: today,  dateTo: today  })),
    syncedRange('vendor_payments_fy', mStart, mEnd,  () => zohoGetAll('/vendorpayments', 'vendorpayments', { date_start: mStart, date_end: mEnd   }, { dateFrom: mStart, dateTo: mEnd   })),
    syncedRange('vendor_credits_all', today,  today, () => zohoGetAll('/vendorcredits',  'vendor_credits',  { date_start: today,  date_end: today  }, { dateFrom: today,  dateTo: today  })),
    syncedRange('vendor_credits_all', mStart, mEnd,  () => zohoGetAll('/vendorcredits',  'vendor_credits',  { date_start: mStart, date_end: mEnd   }, { dateFrom: mStart, dateTo: mEnd   })),
  ]);

  const sumPay = arr => arr.reduce((s, p) => s + (p.amount || 0), 0);
  const sumVC  = arr => arr.reduce((s, c) => s + Math.max(0, (c.total || 0) - (c.balance || 0)), 0);

  const payDetail = arr => arr.map(p => ({
    vendor_name:      p.vendor_name,
    payment_date:     p.date,
    amount:           p.amount,
    payment_mode:     p.payment_mode,
    reference_number: p.reference_number || '-',
    branch_name:      p.branch_name || '-',
    bill_numbers:     p.bill_numbers || '-',
  })).sort((a, b) => b.amount - a.amount);

  const vcDetail = arr => arr.map(c => ({
    vendor_credit_number: c.vendor_credit_number,
    vendor_name:          c.vendor_name,
    date:                 c.date,
    total:                c.total,
    applied_amount:       Math.max(0, (c.total || 0) - (c.balance || 0)),
    status:               c.status,
    branch_name:          c.branch_name || '-',
  })).sort((a, b) => b.applied_amount - a.applied_amount);

  return {
    today:                sumPay(todayPay),
    this_month:           sumPay(monthPay),
    today_vendor_credits: sumVC(todayVC),
    month_vendor_credits: sumVC(monthVC),
    today_detail:         payDetail(todayPay),
    this_month_detail:    payDetail(monthPay),
    today_vc_detail:      vcDetail(todayVC),
    month_vc_detail:      vcDetail(monthVC),
  };
}));

// ─── Purchase KPI: Payables ───────────────────────────────────────────────────
app.get('/api/purchase/kpi/payables', cached('pur-payables', 60, async () => {
  const { start: mStart } = getMonthRange();

  // Zoho India: Status.Open = current (not yet overdue); Status.Overdue = past due.
  // Fetching only Status.Open misses the overdue bucket — must combine both.
  const [openResult, overdueResult] = await Promise.all([
    syncEngine.getSyncedOrFetch('bills_open',    () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Open' },    {})),
    syncEngine.getSyncedOrFetch('bills_overdue', () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Overdue' }, {})),
  ]);
  // For this-month bills, derive from open+overdue (already have all outstanding bills)
  const openBills    = openResult.data;
  const overdueBills = overdueResult.data;
  const thisMonthBills = [...openBills, ...overdueBills].filter(b => b.date >= mStart);
  // Deduplicate by bill_id in case any bill appears in both buckets
  const _seen = new Set();
  const allUnpaid = [];
  for (const b of [...openBills, ...overdueBills]) {
    if (!_seen.has(b.bill_id)) { _seen.add(b.bill_id); allUnpaid.push(b); }
  }

  const payableRow = b => ({
    bill_number:  b.bill_number,
    vendor_name:  b.vendor_name,
    date:         b.date,
    due_date:     b.due_date,
    branch_name:  b.branch_name || '-',
    balance:      b.balance || 0,
    total:        b.total || 0,
    status:       b.status,
  });

  return {
    this_month:         thisMonthBills.filter(b => (b.balance || 0) > 0).reduce((s, b) => s + b.balance, 0),
    all_time:           allUnpaid.reduce((s, b) => s + (b.balance || 0), 0),
    this_month_detail:  thisMonthBills.filter(b => (b.balance || 0) > 0).map(payableRow),
    all_time_detail:    allUnpaid.map(payableRow),
  };
}));

// ─── Finance Overview: Branch List ───────────────────────────────────────────
app.get('/api/finance/branches', authMiddleware, (req, res) => {
  res.json(BUDGET_BRANCHES.map(b => b.name).sort());
});

// ─── Finance Overview: Combined Sales + Purchase KPIs with Branch Filter ─────
app.get('/api/finance/overview', authMiddleware, async (req, res) => {
  try {
    const branchesParam = (req.query.branches || '').trim();
    const selectedBranches = branchesParam
      ? branchesParam.split(',').map(b => b.trim()).filter(Boolean)
      : [];
    const isAll = selectedBranches.length === 0;

    const cacheKey = 'finance-overview-all';
    if (isAll) {
      const hit = cache.get(cacheKey);
      if (hit) return res.json(hit);
    }

    const today  = localDate(new Date());
    const { start: mStart, end: mEnd } = getMonthRange();
    const { start: fyStart, end: fyEnd } = getFYRange();

    const bf = item => isAll || selectedBranches.includes(item.branch_name);

    const [
      invFYR, invUnpaidR, custPayR, cnR,
      billsFYR, billsOpenR, billsOvrR, vPayR, vCrR,
    ] = await Promise.all([
      syncEngine.getSyncedOrFetch('invoices_fy',          () => zohoGetAll('/invoices',         'invoices',         { filter_by: 'Status.All'     }, { dateFrom: fyStart, dateTo: fyEnd })),
      syncEngine.getSyncedOrFetch('invoices_unpaid',       () => zohoGetAll('/invoices',         'invoices',         { filter_by: 'Status.Unpaid'  }, {})),
      syncEngine.getSyncedOrFetch('customer_payments_fy',  () => zohoGetAll('/customerpayments', 'customerpayments', {}, { dateFrom: fyStart, dateTo: fyEnd })),
      syncEngine.getSyncedOrFetch('credit_notes_fy',       () => zohoGetAll('/creditnotes',      'creditnotes',      {}, { dateFrom: fyStart, dateTo: fyEnd })),
      syncEngine.getSyncedOrFetch('bills_fy',              () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.All'     }, { dateFrom: fyStart, dateTo: fyEnd })),
      syncEngine.getSyncedOrFetch('bills_open',            () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Open'    }, {})),
      syncEngine.getSyncedOrFetch('bills_overdue',         () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Overdue' }, {})),
      syncEngine.getSyncedOrFetch('vendor_payments_fy',    () => zohoGetAll('/vendorpayments',  'vendorpayments',  {}, { dateFrom: fyStart, dateTo: fyEnd })),
      syncEngine.getSyncedOrFetch('vendor_credits_all',    () => zohoGetAll('/vendorcredits',   'vendor_credits',  {}, {})),
    ]);

    const invFY     = invFYR.data.filter(bf);
    const invUnpaid = invUnpaidR.data.filter(bf);
    const custPay   = custPayR.data.filter(bf);
    const cn        = cnR.data.filter(bf);
    const billsFY   = billsFYR.data.filter(bf);
    const billsOpen = billsOpenR.data.filter(bf);
    const billsOvr  = billsOvrR.data.filter(bf);
    const vPay      = vPayR.data.filter(bf);
    const vCr       = vCrR.data.filter(bf);

    // ── SALES ────────────────────────────────────────────────────────────────
    const invFYMo = invFY.filter(i => i.date >= mStart);

    const delayRows = [];
    for (const i of invFY) {
      if (i.status !== 'paid' || !i.due_date || !i.last_payment_date) continue;
      const d = Math.round((new Date(i.last_payment_date) - new Date(i.due_date)) / 86400000);
      delayRows.push({ invoice_number: i.invoice_number, customer_name: i.customer_name, branch_name: i.branch_name || '-', due_date: i.due_date, payment_date: i.last_payment_date, delay_days: d, amount: i.total });
    }
    const sDelayed = delayRows.filter(r => r.delay_days > 0);
    const sAvgDelay = sDelayed.length ? Math.round(sDelayed.reduce((s, r) => s + r.delay_days, 0) / sDelayed.length) : 0;

    const cpToday = custPay.filter(p => p.date === today);
    const cpMonth = custPay.filter(p => p.date >= mStart && p.date <= mEnd);
    const cnToday = cn.filter(c => c.date === today);
    const cnMonth = cn.filter(c => c.date >= mStart && c.date <= mEnd);
    const invUnpaidMo = invUnpaid.filter(i => i.date >= mStart);

    const sCNToday = cnToday.reduce((s, c) => s + Math.max(0, (c.total || 0) - (c.balance || 0)), 0);
    const sCNMo    = cnMonth.reduce((s, c)  => s + Math.max(0, (c.total || 0) - (c.balance || 0)), 0);

    // ── PURCHASE ─────────────────────────────────────────────────────────────
    const billsFYMo = billsFY.filter(b => b.date >= mStart);

    const billDelayRows = [];
    for (const b of billsFY) {
      if (b.status !== 'paid' || !b.due_date || !b.last_payment_date) continue;
      const d = Math.round((new Date(b.last_payment_date) - new Date(b.due_date)) / 86400000);
      billDelayRows.push({ bill_number: b.bill_number, vendor_name: b.vendor_name, branch_name: b.branch_name || '-', due_date: b.due_date, payment_date: b.last_payment_date, delay_days: d, amount: b.total });
    }
    const pDelayed = billDelayRows.filter(r => r.delay_days > 0);
    const pAvgDelay = pDelayed.length ? Math.round(pDelayed.reduce((s, r) => s + r.delay_days, 0) / pDelayed.length) : 0;

    const vpToday = vPay.filter(p => p.date === today);
    const vpMonth = vPay.filter(p => p.date >= mStart && p.date <= mEnd);
    const vcToday = vCr.filter(c => c.date === today);
    const vcMonth = vCr.filter(c => c.date >= mStart && c.date <= mEnd);

    const pVCToday = vcToday.reduce((s, c) => s + Math.max(0, (c.total || 0) - (c.balance || 0)), 0);
    const pVCMo    = vcMonth.reduce((s, c)  => s + Math.max(0, (c.total || 0) - (c.balance || 0)), 0);

    const _seenB = new Set();
    const allUnpaidBills = [];
    for (const b of [...billsOpen, ...billsOvr]) {
      if (!_seenB.has(b.bill_id)) { _seenB.add(b.bill_id); allUnpaidBills.push(b); }
    }
    const _seenBMo = new Set();
    const unpaidBillsMo = [];
    for (const b of [...billsOpen, ...billsOvr].filter(b => b.date >= mStart)) {
      if (!_seenBMo.has(b.bill_id)) { _seenBMo.add(b.bill_id); unpaidBillsMo.push(b); }
    }

    // ── Detail mappers ────────────────────────────────────────────────────────
    const iSum  = i => ({ invoice_number: i.invoice_number, customer_name: i.customer_name, date: i.date, branch_name: i.branch_name || '-', sub_total: subTotal(i), status: i.status });
    const rDet  = i => ({ invoice_number: i.invoice_number, customer_name: i.customer_name, date: i.date, due_date: i.due_date, branch_name: i.branch_name || '-', balance: i.balance, status: i.status });
    const cpDet = arr => arr.map(p => ({ customer_name: p.customer_name, payment_date: p.date, amount: p.amount, payment_mode: p.payment_mode, reference_number: p.reference_number || '-', branch_name: p.branch_name || '-', invoice_numbers: p.invoice_numbers || '-' })).sort((a, b) => b.amount - a.amount);
    const cDet  = arr => arr.map(c => ({ creditnote_number: c.creditnote_number, customer_name: c.customer_name, date: c.date, applied_amount: Math.max(0, (c.total || 0) - (c.balance || 0)), branch_name: c.branch_name || '-', status: c.status })).sort((a, b) => b.applied_amount - a.applied_amount);
    const bSum  = b => ({ bill_number: b.bill_number, vendor_name: b.vendor_name, date: b.date, branch_name: b.branch_name || '-', sub_total: billSubTotal(b), status: b.status });
    const vpDet = arr => arr.map(p => ({ vendor_name: p.vendor_name, payment_date: p.date, amount: p.amount, payment_mode: p.payment_mode, reference_number: p.reference_number || '-', branch_name: p.branch_name || '-', bill_numbers: p.bill_numbers || '-' })).sort((a, b) => b.amount - a.amount);
    const vcDet = arr => arr.map(c => ({ vendor_credit_number: c.vendor_credit_number, vendor_name: c.vendor_name, date: c.date, applied_amount: Math.max(0, (c.total || 0) - (c.balance || 0)), branch_name: c.branch_name || '-', status: c.status })).sort((a, b) => b.applied_amount - a.applied_amount);
    const bpDet = b => ({ bill_number: b.bill_number, vendor_name: b.vendor_name, date: b.date, due_date: b.due_date, branch_name: b.branch_name || '-', balance: b.balance || 0, status: b.status });

    const result = {
      sales: {
        avg_delay_days:       sAvgDelay,
        avg_delay_analyzed:   delayRows.length,
        avg_delay_detail:     delayRows.slice().sort((a, b) => b.delay_days - a.delay_days),
        inv_count_month:      invFYMo.length,
        inv_count_fy:         invFY.length,
        inv_count_detail:     invFYMo.map(iSum),
        revenue_month:        invFYMo.reduce((s, i) => s + subTotal(i), 0),
        revenue_fy:           invFY.reduce((s, i) => s + subTotal(i), 0),
        revenue_month_detail: invFYMo.map(iSum),
        revenue_fy_detail:    invFY.map(iSum),
        coll_today:           cpToday.reduce((s, p) => s + (p.amount || 0), 0),
        coll_month:           cpMonth.reduce((s, p) => s + (p.amount || 0), 0),
        coll_today_detail:    cpDet(cpToday),
        coll_month_detail:    cpDet(cpMonth),
        cn_today:             sCNToday,
        cn_month:             sCNMo,
        cn_today_detail:      cDet(cnToday),
        cn_month_detail:      cDet(cnMonth),
        recv_month:           invUnpaidMo.reduce((s, i) => s + (i.balance || 0), 0),
        recv_total:           invUnpaid.reduce((s, i) => s + (i.balance || 0), 0),
        recv_month_detail:    invUnpaidMo.map(rDet),
        recv_total_detail:    invUnpaid.map(rDet),
      },
      purchase: {
        avg_delay_days:        pAvgDelay,
        avg_delay_analyzed:    billDelayRows.length,
        avg_delay_detail:      billDelayRows.slice().sort((a, b) => b.delay_days - a.delay_days),
        bill_count_month:      billsFYMo.length,
        bill_count_fy:         billsFY.length,
        bill_count_detail:     billsFYMo.map(bSum),
        expense_month:         billsFYMo.reduce((s, b) => s + billSubTotal(b), 0),
        expense_fy:            billsFY.reduce((s, b) => s + billSubTotal(b), 0),
        expense_month_detail:  billsFYMo.map(bSum),
        expense_fy_detail:     billsFY.map(bSum),
        paid_today:            vpToday.reduce((s, p) => s + (p.amount || 0), 0),
        paid_month:            vpMonth.reduce((s, p) => s + (p.amount || 0), 0),
        paid_today_detail:     vpDet(vpToday),
        paid_month_detail:     vpDet(vpMonth),
        vc_today:              pVCToday,
        vc_month:              pVCMo,
        vc_today_detail:       vcDet(vcToday),
        vc_month_detail:       vcDet(vcMonth),
        payable_month:         unpaidBillsMo.filter(b => (b.balance || 0) > 0).reduce((s, b) => s + b.balance, 0),
        payable_total:         allUnpaidBills.reduce((s, b) => s + (b.balance || 0), 0),
        payable_month_detail:  unpaidBillsMo.filter(b => (b.balance || 0) > 0).map(bpDet),
        payable_total_detail:  allUnpaidBills.map(bpDet),
      },
    };

    if (isAll) cache.set(cacheKey, result, 300);
    res.json(result);
  } catch (err) {
    console.error('[finance/overview]', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BRANCH P&L REPORT
// ═══════════════════════════════════════════════════════════════════════════════

const PL_MAPPING_FILE  = path.join(__dirname, 'pl_mapping.json');
const PL_CAPACITY_FILE = path.join(__dirname, 'pl_branch_capacity.json');
const PL_FY_CACHE_DIR  = path.join(__dirname, 'pl_fy_cache');

// Display order within each section follows this list. Heads are identified by id
// (never by label), so one label may appear in several sections as separate heads.
const PL_DEFAULT_HEADS = [
  { id: 'revenue',         label: 'Revenue From Operations',        section: 'revenue',   is_income: true  },
  { id: 'other_income',    label: 'Other Income',                   section: 'revenue',   is_income: true  },
  { id: 'off_rent',        label: 'Office Rent',                    section: 'occupancy', is_income: false },
  { id: 'off_maint',       label: 'Office Maintenance',             section: 'occupancy', is_income: false },
  { id: 'off_furniture_rent', label: 'Office Furniture Rent',       section: 'occupancy', is_income: false },
  { id: 'hk_material',     label: 'Housekeeping Material',          section: 'recurring', is_income: false },
  { id: 'hk_services',     label: 'Housekeeping Services',          section: 'recurring', is_income: false },
  { id: 'security',        label: 'Security Services',              section: 'recurring', is_income: false },
  { id: 'internet',        label: 'Internet Connectivity Charges',  section: 'recurring', is_income: false },
  { id: 'tea_coffee',      label: 'Tea, Coffee & Milk Expense',     section: 'recurring', is_income: false },
  { id: 'marketing',       label: 'Marketing Expense',              section: 'recurring', is_income: false },
  { id: 'electricity',     label: 'Electricity Charges',            section: 'recurring', is_income: false },
  { id: 'bad_debt',        label: 'Bad Debt',                       section: 'recurring', is_income: false },
  { id: 'bank_charges',    label: 'Bank Fees & Charges',            section: 'recurring', is_income: false },
  { id: 'property_tax',    label: 'Property Tax Expense',           section: 'opex',      is_income: false },
  { id: 'salary',          label: 'Salary & Wages',                 section: 'opex',      is_income: false },
  { id: 'elec_safety',     label: 'Electrical Safety Audit Work',   section: 'opex',      is_income: false },
  { id: 'vending',         label: 'Vending Machine Charges',        section: 'opex',      is_income: false },
  { id: 'parking',         label: 'Parking Charges',                section: 'opex',      is_income: false },
  { id: 'gen_consultancy', label: 'Legal & Professional Charges',   section: 'opex',      is_income: false },
  { id: 'cogs',            label: 'Cost of Goods Sold',             section: 'opex',      is_income: false },
  { id: 'stamp_duty',      label: 'Stamp Duty & Reg. Fees',         section: 'opex',      is_income: false },
  { id: 'repairs',         label: 'Repairs & Maintenance',          section: 'other',     is_income: false },
  { id: 'subscription',    label: 'Subscription Charges',           section: 'other',     is_income: false },
  { id: 'brokerage',       label: 'Brokerage Charges',              section: 'other',     is_income: false },
  { id: 'event_expense',   label: 'Event Expense',                  section: 'other',     is_income: false },
  { id: 'misc_general',    label: 'Other Misc. General Expense',    section: 'other',     is_income: false },
  { id: 'travel_other',    label: 'Accommodation & Travelling Charges', section: 'other', is_income: false },
  { id: 'membership_subscription', label: 'Membership & Subscription Charges', section: 'other', is_income: false },
  { id: 'prior_period',    label: 'Prior Period Expenses',          section: 'other',     is_income: false },
  { id: 'interest_loan',   label: 'Interest Charges on Loan',       section: 'finance',   is_income: false },
  { id: 'fund_raising',    label: 'Fund Raising & Processing Charges', section: 'finance', is_income: false },
];

// Removed heads. Ignored if a stale mapping save writes them back, so they never
// return as custom heads. Travel now lives only under Other Expenses (travel_other).
const PL_RETIRED_HEAD_IDS = new Set(['travel_recurring', 'travel_opex']);

// Label, section and order come from PL_DEFAULT_HEADS; the saved file supplies each
// head's mapped accounts by id, so renamed or moved heads keep their mappings.
async function readPLMapping() {
  let savedHeads = [];
  try { savedHeads = (await db.readJSON('pl_mapping', PL_MAPPING_FILE, null))?.heads || []; } catch {}
  savedHeads = savedHeads.filter(h => !PL_RETIRED_HEAD_IDS.has(h.id));
  const savedById  = new Map(savedHeads.map(h => [h.id, h]));
  const defaultIds = new Set(PL_DEFAULT_HEADS.map(h => h.id));
  return { heads: [
    ...PL_DEFAULT_HEADS.map(dh => ({ ...dh, accounts: savedById.get(dh.id)?.accounts || [] })),
    ...savedHeads.filter(h => !defaultIds.has(h.id)),
  ] };
}

// Head amount from its mapped accounts. Ledger nets are debit − credit, so income
// heads (credit balances) are sign-flipped to show as positive income.
function plHeadAmount(head, acctAmounts) {
  const net = (head.accounts || []).reduce((s, a) => s + (acctAmounts[a.account_id] || 0), 0);
  return head.is_income ? -net : net;
}

// Revenue From Operations uses its mapped income ledgers once any account is mapped;
// until then it is computed from synced invoices − applied credit notes.
function plRevenueMapped(heads) {
  return (heads.find(h => h.id === 'revenue')?.accounts || []).length > 0;
}

// Total Revenue = every revenue-section head (Revenue From Operations + Other Income)
function plTotalRevenue(heads, headAmounts) {
  return heads.filter(h => h.section === 'revenue').reduce((s, h) => s + (headAmounts[h.id] || 0), 0);
}

async function writePLMapping(data) {
  await db.writeJSON('pl_mapping', PL_MAPPING_FILE, data);
}

async function readPLCapacity() {
  const saved = await db.readJSON('pl_branch_capacity', PL_CAPACITY_FILE, null);
  if (saved) return saved;
  const cap = {};
  for (const b of BUDGET_BRANCHES) cap[b.name] = { sqft: b.sqft, seats: 0 };
  return cap;
}

async function writePLCapacity(data) {
  await db.writeJSON('pl_branch_capacity', PL_CAPACITY_FILE, data);
}

function parseFYStr(fy) {
  const y = parseInt((fy || '').split('-')[0], 10) || new Date().getFullYear();
  return { startYear: y, fyStart: `${y}-04-01`, fyEnd: `${y + 1}-03-31` };
}

function currentFYTag() {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-${String(y + 1).slice(-2)}`;
}

function parsePLPeriod(fy, period_type, period) {
  const { startYear, fyStart, fyEnd } = parseFYStr(fy);
  const todayStr = localDate(new Date());
  switch (period_type) {
    case 'month': {
      if (!period || !/^\d{4}-\d{2}$/.test(period)) return { dateFrom: fyStart, dateTo: fyEnd };
      const [py, pm] = period.split('-').map(Number);
      const lastDay = new Date(py, pm, 0).getDate();
      return {
        dateFrom: `${py}-${String(pm).padStart(2,'0')}-01`,
        dateTo:   `${py}-${String(pm).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`,
      };
    }
    case 'quarter': {
      const qMap = {
        Q1: [`${startYear}-04-01`,    `${startYear}-06-30`],
        Q2: [`${startYear}-07-01`,    `${startYear}-09-30`],
        Q3: [`${startYear}-10-01`,    `${startYear}-12-31`],
        Q4: [`${startYear+1}-01-01`,  `${startYear+1}-03-31`],
      };
      const [df, dt] = qMap[period] || qMap['Q1'];
      return { dateFrom: df, dateTo: dt };
    }
    case 'half_year':
      if (period === 'H2') return { dateFrom: `${startYear}-10-01`,  dateTo: `${startYear+1}-03-31` };
      return                       { dateFrom: `${startYear}-04-01`,  dateTo: `${startYear}-09-30` };
    case 'ytd':
    default: {
      const dateTo = todayStr < fyEnd ? todayStr : fyEnd;
      return { dateFrom: fyStart, dateTo };
    }
  }
}

function getQuarterMonths(fy, quarter) {
  const { startYear } = parseFYStr(fy);
  const Q = {
    Q1: [['04', startYear], ['05', startYear], ['06', startYear]],
    Q2: [['07', startYear], ['08', startYear], ['09', startYear]],
    Q3: [['10', startYear], ['11', startYear], ['12', startYear]],
    Q4: [['01', startYear+1], ['02', startYear+1], ['03', startYear+1]],
  };
  return (Q[quarter] || []).map(([mm, yyyy]) => {
    const lastDay = new Date(yyyy, parseInt(mm, 10), 0).getDate();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return {
      month: `${yyyy}-${mm}`,
      label: `${months[parseInt(mm,10)-1]}-${String(yyyy).slice(-2)}`,
      from:  `${yyyy}-${mm}-01`,
      to:    `${yyyy}-${mm}-${String(lastDay).padStart(2,'0')}`,
    };
  });
}

function plFYCachePath(fy, entity) {
  return path.join(PL_FY_CACHE_DIR, fy, `${entity}.json`);
}

// Neon mode: kv_store 'pl_fy_<fy>_<entity>' (the office PC keeps pl_fy_cache/<fy>/<entity>.json)
async function readPLFYCache(fy, entity) {
  if (db.USE_DB) return db.readJSON(`pl_fy_${fy}_${entity}`, null, null);
  try { return JSON.parse(await fs.promises.readFile(plFYCachePath(fy, entity), 'utf8')); }
  catch { return null; }
}

async function writePLFYCache(fy, entity, data) {
  if (db.USE_DB) return db.writeJSON(`pl_fy_${fy}_${entity}`, null, data);
  const dir = path.join(PL_FY_CACHE_DIR, fy);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(plFYCachePath(fy, entity), JSON.stringify(data), 'utf8');
}

async function getPLFYData(fy) {
  const curFY = currentFYTag();
  const { fyStart, fyEnd } = parseFYStr(fy);
  if (fy === curFY) {
    const [invC, billsC, cnC, vcC] = await Promise.all([
      syncEngine.readSyncedData('invoices_fy'),
      syncEngine.readSyncedData('bills_fy'),
      syncEngine.readSyncedData('credit_notes_fy'),
      syncEngine.readSyncedData('vendor_credits_all'),
    ]);
    if (!invC || !billsC) {
      return { invoices: [], bills: [], credit_notes: [], vendor_credits: [], from_cache: true, needs_refresh: true };
    }
    return {
      invoices:       invC.data,
      bills:          billsC.data,
      credit_notes:   cnC?.data || [],
      vendor_credits: (vcC?.data || []).filter(vc => vc.date >= fyStart && vc.date <= fyEnd),
      from_cache: true, needs_refresh: false,
      synced_at: invC.synced_at,
    };
  }
  const [invoices, bills, creditNotes, vendorCredits] = await Promise.all([
    readPLFYCache(fy, 'invoices'),
    readPLFYCache(fy, 'bills'),
    readPLFYCache(fy, 'credit_notes'),
    readPLFYCache(fy, 'vendor_credits'),
  ]);
  if (!invoices || !bills) {
    return { invoices: [], bills: [], credit_notes: [], vendor_credits: [], from_cache: true, needs_refresh: true };
  }
  return {
    invoices, bills, credit_notes: creditNotes || [], vendor_credits: vendorCredits || [],
    from_cache: true, needs_refresh: false,
  };
}

const _plSyncStatus = {};

// ─── Persistent disk cache for P&L account transactions ──────────────────────
// Transactions are fetched for the FULL FY range once and stored on disk.
// All period queries (month, quarter, half-year, YTD) filter from the stored data.
// This means page load never hits Zoho; data stays valid across server restarts.
const PL_ACCT_TXN_DISK_TTL = 23 * 3600 * 1000; // 23-hour disk TTL (refreshed at 11 PM)
const _plPrefetchStatus = {};                    // fy → { running, total, done, … }

async function readPLAcctTxnsDisk(fy, accountId) {
  if (db.USE_DB) return db.readJSON(`pl_fy_${fy}_acct_${accountId}`, null, null);
  try {
    const p = path.join(PL_FY_CACHE_DIR, fy, `acct_${accountId}.json`);
    const raw = await fs.promises.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function writePLAcctTxnsDisk(fy, accountId, txns) {
  const { fyStart, fyEnd } = parseFYStr(fy);
  const doc = { account_id: accountId, fy, fy_start: fyStart, fy_end: fyEnd,
    fetched_at: new Date().toISOString(), transactions: txns };
  if (db.USE_DB) return db.writeJSON(`pl_fy_${fy}_acct_${accountId}`, null, doc);
  const dir = path.join(PL_FY_CACHE_DIR, fy);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `acct_${accountId}.json`), JSON.stringify(doc), 'utf8');
}

// Fetch ALL FY transactions for one account from Zoho, save to disk, return rows.
async function fetchAndCacheAccountTxnsFY(fy, accountId) {
  const { fyStart } = parseFYStr(fy);
  const rows = [];
  let page = 1;
  while (page <= 60) {
    let r;
    try {
      r = await zohoGet('/chartofaccounts/transactions', {
        account_id: accountId, 'date.start': fyStart, per_page: 200, page,
      });
    } catch (e) {
      if (e?.response?.status === 429 || String(e?.message).includes('429')) {
        const retry = parseInt(e?.response?.headers?.['retry-after'] || '20', 10);
        console.warn(`[prefetch] 429 on ${accountId} pg ${page}, waiting ${Math.min(retry,60)}s`);
        await new Promise(ok => setTimeout(ok, Math.min(retry, 60) * 1000));
        continue; // retry same page
      }
      throw e;
    }
    const txns = r.transactions || r.account_transactions || [];
    if (txns.length === 0) break;
    for (const t of txns) {
      const d = t.transaction_date || '';
      if (d >= fyStart) rows.push(t);
    }
    if (!r.page_context?.has_more_page) break;
    const lastDate = txns[txns.length - 1]?.transaction_date || '';
    if (lastDate && lastDate < fyStart) break;
    page++;
  }
  await writePLAcctTxnsDisk(fy, accountId, rows);
  console.log(`[prefetch] ${fy} acct ${accountId}: ${rows.length} txns cached`);
  return rows;
}

// Get filtered transactions for a date range: always from disk cache.
// Returns { txns, stale } — stale=true means background re-fetch is queued.
async function getDiskTxnsForRange(fy, accountId, dateFrom, dateTo) {
  const disk = await readPLAcctTxnsDisk(fy, accountId);
  if (!disk) return { txns: [], stale: true, missing: true };
  const age = Date.now() - new Date(disk.fetched_at).getTime();
  const txns = (disk.transactions || []).filter(t => {
    const d = t.transaction_date || '';
    return d >= dateFrom && d <= dateTo;
  });
  return { txns, stale: age > PL_ACCT_TXN_DISK_TTL, missing: false };
}

// Compute net debit-credit from a txn array
function plRowNet(t) {
  return (parseFloat(t.debit_amount || 0) || 0) - (parseFloat(t.credit_amount || 0) || 0);
}
function sumTxnNet(txns) {
  return txns.reduce((s, t) => s + plRowNet(t), 0);
}

// ─── Branch attribution of P&L ledger rows ────────────────────────────────────
// Account ledgers carry no branch. Bills and vendor credits take it from the synced
// documents. Journals carry it per line (one journal can split an account across
// branches), so their detail is fetched once in the background through the paced
// queue and kept in pl_txn_branches. A journal is refetched when its ledger amount
// no longer matches the stored lines (edited in Zoho).
const PL_TXN_BRANCH_FILE = path.join(__dirname, 'pl_txn_branches.json');
const PL_TXN_DETAIL = {
  journal:       { path: '/journals/',      key: 'journal' },
  expense:       { path: '/expenses/',      key: 'expense' },
  bill:          { path: '/bills/',         key: 'bill' },
  vendor_credit: { path: '/vendorcredits/', key: 'vendor_credit' },
};
const PL_BRANCH_RECHECK_MS = 6 * 3600 * 1000;
const _plBranchQueue = new Map();  // transaction_id → transaction_type awaiting a detail fetch
let _plBranchWorker = null;

async function plBranchCtx(fyData) {
  const docBranch = new Map();
  for (const b of fyData.bills || [])          docBranch.set(b.bill_id, b.branch_name || 'Unknown');
  for (const v of fyData.vendor_credits || []) docBranch.set(v.vendor_credit_id, v.branch_name || 'Unknown');
  // Income ledgers (e.g. Other Income) are posted mostly from invoices and credit notes
  for (const i of fyData.invoices || [])       docBranch.set(i.invoice_id, i.branch_name || 'Unknown');
  for (const c of fyData.credit_notes || [])   docBranch.set(c.creditnote_id, c.branch_name || 'Unknown');
  return { docBranch, store: await rptStore('pl_txn_branches', PL_TXN_BRANCH_FILE), pending: [], unknownIds: new Set() };
}

// One account's ledger rows grouped per Zoho document with their branch split:
// [{ t, net, parts: [[branch, amount], …] }]; parts is null while the branch is unknown.
function plAttributeRows(rows, accountId, ctx) {
  const byTxn = new Map();
  for (const t of rows) {
    const e = byTxn.get(t.transaction_id);
    if (e) e.net += plRowNet(t); else byTxn.set(t.transaction_id, { t, net: plRowNet(t) });
  }
  return [...byTxn.values()].map(({ t, net }) => {
    if (ctx.docBranch.has(t.transaction_id)) return { t, net, parts: [[ctx.docBranch.get(t.transaction_id), net]] };
    const s = ctx.store[t.transaction_id];
    if (!s && !PL_TXN_DETAIL[t.transaction_type]) return { t, net, parts: [['Unknown', net]] };
    if (!s) {
      ctx.pending.push(t);
      ctx.unknownIds.add(t.transaction_id);
      return { t, net, parts: null };
    }
    const lines = s.lines?.[accountId];
    const sum   = lines ? Object.values(lines).reduce((a, b) => a + b, 0) : null;
    if ((!lines && s.type === 'journal') || (lines && Math.abs(sum - net) >= 1)) {
      if (Date.now() - Date.parse(s.fetched_at || 0) > PL_BRANCH_RECHECK_MS) ctx.pending.push(t);
    }
    if (!lines) return { t, net, parts: [[s.branch || 'Unknown', net]] };
    const f = Math.abs(sum - net) < 1 || !sum ? 1 : net / sum;  // scale to the ledger until refetched
    return { t, net, parts: Object.entries(lines).map(([b, a]) => [b, a * f]) };
  });
}

// Net of one account's ledger rows for the selected branches (branchSet null = all).
// Documents whose branch is still being fetched are left out of a branch figure.
function plAcctNet(rows, accountId, ctx, branchSet) {
  let net = 0;
  for (const { net: n, parts } of plAttributeRows(rows, accountId, ctx)) {
    if (!branchSet) net += n;
    else if (parts) for (const [b, a] of parts) if (branchSet.has(b)) net += a;
  }
  return net;
}

function queuePLBranchDetails(rows) {
  for (const t of rows) if (PL_TXN_DETAIL[t.transaction_type]) _plBranchQueue.set(t.transaction_id, t.transaction_type);
  if (_plBranchQueue.size && !_plBranchWorker) _plBranchWorker = background(drainPLBranchQueue().finally(() => { _plBranchWorker = null; }));
}

async function drainPLBranchQueue() {
  const store = await rptStore('pl_txn_branches', PL_TXN_BRANCH_FILE);
  let unsaved = 0, blocked = false;
  try {
    while (_plBranchQueue.size && !blocked) {
      const batch = [..._plBranchQueue.entries()].slice(0, 3);
      batch.forEach(([id]) => _plBranchQueue.delete(id));
      await Promise.all(batch.map(async ([id, type]) => {
        try {
          const kind = PL_TXN_DETAIL[type];
          const det  = (await rptZohoGet(kind.path + id))[kind.key] || {};
          const entry = { type, branch: det.branch_name || null, fetched_at: new Date().toISOString() };
          if (type === 'journal') {
            entry.lines = {};
            for (const li of (det.line_items || [])) {
              const acc = entry.lines[li.account_id] || (entry.lines[li.account_id] = {});
              const br  = li.branch_name || det.branch_name || 'Unknown';
              acc[br] = (acc[br] || 0) + (li.debit_or_credit === 'credit' ? -1 : 1) * (Number(li.amount) || 0);
            }
          }
          store[id] = entry;
          unsaved++;
        } catch (e) {
          if (e.response?.status === 429 || /LIMIT/.test(e.message)) blocked = true;
          console.warn(`[pl/branches] ${type} ${id} detail failed:`, e.message);
        }
      }));
      if (unsaved >= 50) { await rptStoreSave('pl_txn_branches', PL_TXN_BRANCH_FILE); unsaved = 0; }
    }
  } finally {
    // Throttled: stop here; the next report load re-queues whatever is still missing
    if (blocked) _plBranchQueue.clear();
    if (unsaved) await rptStoreSave('pl_txn_branches', PL_TXN_BRANCH_FILE);
  }
}

// Sequentially prefetch all accounts for a FY; saves to disk.
// Neon: accounts ordered oldest-cache-first, dropping any written within freshMs
async function plPrefetchOrder(fy, accountIds, freshMs) {
  const prefix = `pl_fy_${fy}_acct_`;
  const age = {};
  for (const r of await db.listKeys(prefix)) age[r.key.slice(prefix.length)] = new Date(r.updated_at).getTime();
  const now = Date.now();
  return accountIds
    .filter(id => !(age[id] && now - age[id] < freshMs))
    .sort((a, b) => (age[a] || 0) - (age[b] || 0));
}

async function runPLPrefetch(fy, accountIds, label) {
  if (_plPrefetchStatus[fy]?.running) {
    console.log(`[prefetch] FY ${fy} already running, skipping`);
    return;
  }
  // Vercel: one function run lasts at most 5 minutes, so refresh the stalest accounts first
  // and stop in time; the next trigger (cron, report load, button) carries on from there.
  let deadline = Infinity;
  if (IS_VERCEL) {
    accountIds = await plPrefetchOrder(fy, accountIds, label === 'manual' ? 3600e3 : 20 * 3600e3);
    deadline = Date.now() + 240e3;
  }
  _plPrefetchStatus[fy] = { running: true, label: label || 'prefetch',
    started_at: new Date().toISOString(), total: accountIds.length, done: 0,
    total_txns: 0, error: null, accounts: {} };
  console.log(`[prefetch] FY ${fy}: fetching ${accountIds.length} accounts sequentially`);
  for (const accountId of accountIds) {
    if (Date.now() > deadline) { _plPrefetchStatus[fy].stopped_early = true; break; }
    try {
      const txns = await fetchAndCacheAccountTxnsFY(fy, accountId);
      _plPrefetchStatus[fy].done++;
      _plPrefetchStatus[fy].total_txns += txns.length;
      _plPrefetchStatus[fy].accounts[accountId] = { ok: true, count: txns.length };
    } catch (e) {
      _plPrefetchStatus[fy].accounts[accountId] = { ok: false, error: e.message };
      console.error(`[prefetch] ${fy} ${accountId} failed:`, e.message);
    }
    await new Promise(ok => setTimeout(ok, 500)); // 500 ms between accounts
  }
  _plPrefetchStatus[fy] = { ..._plPrefetchStatus[fy],
    running: false, completed_at: new Date().toISOString() };
  console.log(`[prefetch] FY ${fy} done — ${_plPrefetchStatus[fy].total_txns} txns total`);
}

// ─── Daily 11 PM auto-sync ─────────────────────────────────────────────────────
// Refresh every mapped account's FY transactions (also called by Vercel Cron: /api/cron/pl)
async function plDailyRefresh(label) {
  const fy = currentFYTag();
  const mapping = await readPLMapping();
  const ids = [...new Set(
    mapping.heads.flatMap(h => (h.accounts || []).map(a => a.account_id).filter(Boolean))
  )];
  if (ids.length) await runPLPrefetch(fy, ids, label);
}

;(function schedulePLDailySync() {
  if (IS_VERCEL) return; // no long-lived timers on Vercel — Vercel Cron calls /api/cron/pl
  function msUntil11PM() {
    const now = new Date();
    const t = new Date(now);
    t.setHours(23, 0, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    return t - now;
  }
  setTimeout(async function runSync() {
    console.log('[pl/daily-sync] 11 PM trigger running…');
    try {
      await plDailyRefresh('daily-11pm');
    } catch (e) { console.error('[pl/daily-sync]', e.message); }
    setTimeout(runSync, msUntil11PM());
  }, msUntil11PM());
  const nextRun = new Date(Date.now() + msUntil11PM());
  console.log(`[pl/daily-sync] Scheduled for ${nextRun.toLocaleString('en-IN', { hour12: false })}`);
})();

// Secured debug: shows disk-cache status for a mapped account
app.get('/api/pl/debug-acct', authMiddleware, async (req, res) => {
  try {
    const fy = (req.query.fy || currentFYTag()).trim();
    const accountId = req.query.account_id || '1714732000000110955';
    const dateFrom = req.query.from || parseFYStr(fy).fyStart;
    const dateTo   = req.query.to   || localDate(new Date());
    const disk = await readPLAcctTxnsDisk(fy, accountId);
    if (!disk) return res.json({ accountId, fy, status: 'no_cache', message: 'No disk cache. POST /api/pl/prefetch to fetch.' });
    const age = Date.now() - new Date(disk.fetched_at).getTime();
    const filtered = (disk.transactions||[]).filter(t => { const d = t.transaction_date||''; return d >= dateFrom && d <= dateTo; });
    const net = sumTxnNet(filtered);
    res.json({ accountId, fy, status: age > PL_ACCT_TXN_DISK_TTL ? 'stale' : 'fresh', fetched_at: disk.fetched_at, age_hours: (age/3600000).toFixed(1), total_txns: disk.transactions.length, filtered_txns: filtered.length, net: Math.round(net), sample: filtered[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnostic: shows top bill accounts from cache (helps verify P&L mapping matches)
app.get('/api/pl/bills-summary', authMiddleware, async (req, res) => {
  try {
    const billsC = await syncEngine.readSyncedData('bills_fy');
    if (!billsC) return res.json({ error: 'bills_fy not synced', total: 0, accounts: [] });
    const bills = billsC.data || [];
    const { fyStart, fyEnd } = parseFYStr(currentFYTag());
    const fy_bills = bills.filter(b => b.date >= fyStart && b.date <= fyEnd);
    const accts = {};
    for (const b of fy_bills) {
      const name = b.account_name || '(empty — no account_name)';
      if (!accts[name]) accts[name] = { amount: 0, count: 0 };
      accts[name].amount += billSubTotal(b);
      accts[name].count++;
    }
    const top = Object.entries(accts).sort((a, b) => b[1].amount - a[1].amount).slice(0, 30)
      .map(([name, d]) => ({ account_name: name, amount: Math.round(d.amount), bill_count: d.count }));
    res.json({ total_bills: fy_bills.length, synced_at: billsC.synced_at, top_accounts: top });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pl/mapping', authMiddleware, async (req, res) => {
  try { res.json(await readPLMapping()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pl/mapping', authMiddleware, async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try { await writePLMapping(req.body); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pl/branch-capacity', authMiddleware, async (req, res) => {
  try { res.json(await readPLCapacity()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pl/branch-capacity', authMiddleware, async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try { await writePLCapacity(req.body); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/pl/coa', authMiddleware, async (req, res) => {
  try {
    const cacheKey = 'pl-coa-list';
    let hit = cache.get(cacheKey);
    if (!hit) {
      const all = await zohoGetAll('/chartofaccounts', 'chartofaccounts', {}, {});
      const PLTypes = new Set(['income','other_income','expense','cost_of_goods_sold','other_expense']);
      hit = all
        .filter(a => PLTypes.has((a.account_type || '').toLowerCase().replace(/ /g,'_')))
        .map(a => ({ account_id: a.account_id, account_name: a.account_name, account_type: a.account_type, account_code: a.account_code || '' }))
        .sort((a, b) => a.account_name.localeCompare(b.account_name));
      cache.set(cacheKey, hit, 3600);

      // Also populate the shared COA tree used by getPLLeafIds, so the P&L report
      // doesn't need its own separate Zoho COA fetch (avoids rate limit on first load).
      if (!_coaCache) {
        const coaFull = {};
        for (const a of all) {
          if (a.account_id) coaFull[a.account_id] = { name: a.account_name || '', parentId: a.parent_account_id || null };
        }
        const coaParentIds = new Set();
        for (const { parentId } of Object.values(coaFull)) { if (parentId) coaParentIds.add(parentId); }
        _coaCache = { coaFull, coaParentIds, nameToGroupId: {}, getGroupId: () => null };
        _coaCacheTime = Date.now();
        console.log(`[pl/coa] seeded COA tree cache with ${Object.keys(coaFull).length} accounts`);
      }
    }
    res.json(hit);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pl/sync', authMiddleware, async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const fy = ((req.query.fy || req.body?.fy) || '').trim();
  if (!fy) return res.status(400).json({ error: 'fy required' });
  if (fy === currentFYTag()) {
    const result = syncEngine.startRun({ mode: 'normal', trigger: 'pl-report-ui', entities: ['invoices_fy', 'bills_fy', 'credit_notes_fy', 'vendor_credits_all'] });
    _plSyncStatus[fy] = { running: result.status === 'started', last_run: null, error: null, counts: {}, via_engine: true, run_id: result.run_id };
    return res.json({ ok: true, fy, via_engine: true, run_id: result.run_id, message: result.status === 'busy' ? 'Sync engine busy – try again shortly' : 'Sync started via engine' });
  }
  if (_plSyncStatus[fy]?.running) return res.json({ queued: true, fy });
  _plSyncStatus[fy] = { running: true, last_run: null, error: null, counts: {} };
  res.json({ ok: true, fy, message: 'Sync started in background' });
  (async () => {
    try {
      const { fyStart, fyEnd } = parseFYStr(fy);
      const [inv, bills, cn, vc] = await Promise.all([
        zohoGetAll('/invoices',       'invoices',       { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd }),
        zohoGetAll('/bills',          'bills',          { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd }),
        zohoGetAll('/creditnotes',    'creditnotes',    {},                           { dateFrom: fyStart, dateTo: fyEnd }),
        zohoGetAll('/vendorcredits',  'vendor_credits', {},                           { dateFrom: fyStart, dateTo: fyEnd }),
      ]);
      await Promise.all([
        writePLFYCache(fy, 'invoices',       inv),
        writePLFYCache(fy, 'bills',          bills),
        writePLFYCache(fy, 'credit_notes',   cn),
        writePLFYCache(fy, 'vendor_credits', vc),
      ]);
      _plSyncStatus[fy] = { running: false, last_run: new Date().toISOString(), error: null, counts: { invoices: inv.length, bills: bills.length, credit_notes: cn.length, vendor_credits: vc.length } };
      console.log(`[pl/sync] ${fy} done — inv:${inv.length} bills:${bills.length}`);
    } catch (e) {
      _plSyncStatus[fy] = { running: false, last_run: new Date().toISOString(), error: e.message, counts: {} };
      console.error('[pl/sync]', fy, e.message);
    }
  })();
});

app.get('/api/pl/sync/status', authMiddleware, async (req, res) => {
  const fy = (req.query.fy || '').trim();
  if (fy === currentFYTag()) {
    const s = _plSyncStatus[fy];
    if (s?.via_engine && s.running) {
      const { running } = syncEngine.getProgress();
      if (!running) _plSyncStatus[fy] = { ...s, running: false, last_run: new Date().toISOString() };
    }
    return res.json(_plSyncStatus[fy] || { running: false, last_run: null, error: null, counts: {} });
  }
  res.json(fy ? (_plSyncStatus[fy] || { running: false, last_run: null, error: null, counts: {} }) : _plSyncStatus);
});

app.get('/api/pl/report', authMiddleware, async (req, res) => {
  try {
    const fy          = (req.query.fy          || currentFYTag()).trim();
    const period_type = (req.query.period_type || 'ytd').trim();
    const period      = (req.query.period      || '').trim();
    const bParam      = (req.query.branches    || '').trim();
    const selBranches = bParam ? bParam.split(',').map(s => s.trim()).filter(Boolean) : [];
    const isAll       = selBranches.length === 0;

    const { dateFrom, dateTo } = parsePLPeriod(fy, period_type, period);
    const fyData = await getPLFYData(fy);
    if (fyData.needs_refresh) return res.json({ needs_refresh: true, fy, message: `Data not synced for FY ${fy}. Use Refresh to fetch.` });

    const bf  = item => isAll || selBranches.includes(item.branch_name);
    const df  = item => item.date >= dateFrom && item.date <= dateTo;
    const bdf = item => bf(item) && df(item);

    const invoices    = fyData.invoices.filter(bdf);
    const creditNotes = fyData.credit_notes.filter(bdf);

    const mapping  = await readPLMapping();
    const capacity = await readPLCapacity();
    const branchList = isAll ? BUDGET_BRANCHES.map(b => b.name) : selBranches;
    let totalSqft = 0, totalSeats = 0;
    const capacityMissing = [];
    for (const name of branchList) {
      const cap = capacity[name];
      if (cap?.sqft)  totalSqft  += cap.sqft;
      if (cap?.seats) totalSeats += cap.seats;
      else if (name !== 'Support Branch') capacityMissing.push(name);
    }

    const revAmount  = invoices.reduce((s, i) => s + subTotal(i), 0);
    const cnApplied  = creditNotes.reduce((s, c) => s + Math.max(0, (c.total || 0) - (c.balance || 0)), 0);
    const netRevenue = revAmount - cnApplied;

    // Unique mapped account_ids (Revenue From Operations included once mapped)
    const revMapped = plRevenueMapped(mapping.heads);
    const uniqueMappedAccts = new Map();
    for (const head of mapping.heads) {
      for (const acct of (head.accounts || [])) {
        if (acct.account_id && !uniqueMappedAccts.has(acct.account_id))
          uniqueMappedAccts.set(acct.account_id, acct.account_name);
      }
    }

    // Read from disk cache; queue background prefetch for missing/stale accounts.
    // Ledgers are company-wide, so a branch selection is applied per document.
    const branchCtx = await plBranchCtx(fyData);
    const branchSet = isAll ? null : new Set(selBranches);
    const acctAmounts = {};
    const missingAccounts = [];
    for (const [accountId] of uniqueMappedAccts.entries()) {
      const { txns, missing } = await getDiskTxnsForRange(fy, accountId, dateFrom, dateTo);
      acctAmounts[accountId] = plAcctNet(txns, accountId, branchCtx, branchSet);
      if (missing) missingAccounts.push(accountId);
    }

    // Trigger background prefetch only if not already running
    if (missingAccounts.length > 0 && !_plPrefetchStatus[fy]?.running) {
      const allAcctIds = [...new Set(
        mapping.heads.flatMap(h => (h.accounts || []).map(a => a.account_id).filter(Boolean))
      )];
      console.log(`[pl/report] ${missingAccounts.length} accounts missing cache; queuing prefetch for FY ${fy}`);
      background(new Promise(done => setImmediate(() => runPLPrefetch(fy, allAcctIds, 'auto-on-report-load').finally(done))));
    }

    const headResults = {};
    for (const head of mapping.heads) {
      headResults[head.id] = head.id === 'revenue' && !revMapped ? netRevenue : plHeadAmount(head, acctAmounts);
    }
    const totalRevenue = plTotalRevenue(mapping.heads, headResults);

    // Sections: finance (interest) is below EBITDA and not counted in totalExpense/EBITDA
    const EBITDA_SECTIONS = ['occupancy', 'recurring', 'opex', 'other'];
    const sectionTotals = { revenue: totalRevenue, occupancy: 0, recurring: 0, opex: 0, other: 0, finance: 0 };
    for (const head of mapping.heads) {
      if (!head.section || head.section === 'revenue') continue;
      sectionTotals[head.section] = (sectionTotals[head.section] || 0) + (headResults[head.id] || 0);
    }
    const totalExpense = EBITDA_SECTIONS.reduce((s, sec) => s + (sectionTotals[sec] || 0), 0);
    const ebitda       = totalRevenue - totalExpense;
    const interestCost = sectionTotals['finance'] || 0;
    const pbdt         = ebitda - interestCost;

    const ps = a => totalSqft  > 0 ? a / totalSqft  : null;
    const pt = a => totalSeats > 0 ? a / totalSeats : null;
    const pr = a => totalRevenue > 0 ? a / totalRevenue : null;

    const lines = mapping.heads.map(head => {
      const amt = headResults[head.id] || 0;
      return { id: head.id, label: head.label, section: head.section, is_income: head.is_income,
        amount: amt, per_sqft: ps(amt), per_seat: pt(amt), pct_rev: pr(Math.abs(amt)),
        account_count: (head.accounts || []).length };
    });

    // Monthly breakdown for quarter view
    let monthly_breakdown = null;
    if (period_type === 'quarter' && period) {
      const qMonths = getQuarterMonths(fy, period);
      const monthly = {};
      for (const { month, from: mFrom, to: mTo } of qMonths) {
        const mInv = fyData.invoices.filter(i => bf(i) && i.date >= mFrom && i.date <= mTo);
        const mCns = fyData.credit_notes.filter(c => bf(c) && c.date >= mFrom && c.date <= mTo);
        const mRev = mInv.reduce((s, i) => s + subTotal(i), 0) -
                     mCns.reduce((s, c) => s + Math.max(0, (c.total||0)-(c.balance||0)), 0);
        const mAcct = {};
        for (const [accountId] of uniqueMappedAccts.entries()) {
          const disk = await readPLAcctTxnsDisk(fy, accountId);
          if (disk) {
            const txns = (disk.transactions||[]).filter(t => { const d = t.transaction_date||''; return d >= mFrom && d <= mTo; });
            mAcct[accountId] = plAcctNet(txns, accountId, branchCtx, branchSet);
          } else { mAcct[accountId] = 0; }
        }
        const mHeads = {};
        for (const head of mapping.heads) {
          mHeads[head.id] = head.id === 'revenue' && !revMapped ? mRev : plHeadAmount(head, mAcct);
        }
        const mTotalRev = plTotalRevenue(mapping.heads, mHeads);
        const mSecTotals = { revenue: mTotalRev, occupancy:0, recurring:0, opex:0, other:0, finance:0 };
        for (const head of mapping.heads) {
          if (!head.section || head.section === 'revenue') continue;
          mSecTotals[head.section] = (mSecTotals[head.section]||0) + (mHeads[head.id]||0);
        }
        const mTotalExp = EBITDA_SECTIONS.reduce((s,sec) => s+(mSecTotals[sec]||0), 0);
        monthly[month] = { revenue: mTotalRev, head_amounts: mHeads, section_totals: mSecTotals,
          total_expense: mTotalExp, ebitda: mTotalRev - mTotalExp,
          interest: mSecTotals['finance']||0, pbdt: mTotalRev - mTotalExp - (mSecTotals['finance']||0) };
      }
      monthly_breakdown = { months: qMonths, data: monthly };
    }

    queuePLBranchDetails(branchCtx.pending);

    const prefetch = _plPrefetchStatus[fy];
    const cache_status = {
      has_cache:   missingAccounts.length < uniqueMappedAccts.size,
      missing_count: missingAccounts.length,
      prefetch_running: prefetch?.running || false,
      prefetch_progress: prefetch ? { done: prefetch.done, total: prefetch.total } : null,
    };

    res.json({ fy, period_type, period, dateFrom, dateTo,
      branches: isAll ? 'all' : selBranches,
      capacity: { sqft: totalSqft, seats: totalSeats, missing: capacityMissing },
      revenue: totalRevenue, revenue_ops: headResults['revenue'], revenue_source: revMapped ? 'mapped' : 'invoices',
      total_expense: totalExpense, ebitda, interest_cost: interestCost, pbdt,
      section_totals: sectionTotals, lines,
      unmapped_accounts: [], unmapped_total: 0, needs_refresh: false,
      branch_pending: isAll ? 0 : branchCtx.unknownIds.size,
      monthly_breakdown, cache_status, synced_at: fyData.synced_at });
  } catch (e) {
    console.error('[pl/report]', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pl/report/drill', authMiddleware, async (req, res) => {
  try {
    const fy          = (req.query.fy          || currentFYTag()).trim();
    const period_type = (req.query.period_type || 'ytd').trim();
    const period      = (req.query.period      || '').trim();
    const bParam      = (req.query.branches    || '').trim();
    const headId      = (req.query.head_id     || '').trim();
    if (!headId) return res.status(400).json({ error: 'head_id required' });
    const selBranches = bParam ? bParam.split(',').map(s => s.trim()).filter(Boolean) : [];
    const isAll       = selBranches.length === 0;
    const { dateFrom, dateTo } = parsePLPeriod(fy, period_type, period);
    const fyData = await getPLFYData(fy);
    if (fyData.needs_refresh) return res.json({ rows: [], needs_refresh: true });
    const bf  = item => isAll || selBranches.includes(item.branch_name);
    const bdf = item => bf(item) && item.date >= dateFrom && item.date <= dateTo;
    const mapping = await readPLMapping();
    const head    = mapping.heads.find(h => h.id === headId);
    if (!head) return res.status(404).json({ error: 'Head not found' });
    let rows = [];
    if (headId === 'revenue' && !plRevenueMapped(mapping.heads)) {
      rows = [
        ...fyData.invoices.filter(bdf).map(i => ({ date: i.date, branch_name: i.branch_name || '-', account_name: 'Revenue', voucher_type: 'Invoice',     voucher_number: i.invoice_number,    party: i.customer_name, description: i.reference || '-', amount:  subTotal(i) })),
        ...fyData.credit_notes.filter(bdf).map(c => ({ date: c.date, branch_name: c.branch_name || '-', account_name: 'Revenue', voucher_type: 'Credit Note', voucher_number: c.creditnote_number, party: c.customer_name, description: '-',              amount: -Math.max(0,(c.total||0)-(c.balance||0)) })),
      ];
    } else {
      // Read from disk cache — no Zoho call. One row per document and branch.
      const branchCtx = await plBranchCtx(fyData);
      const drillRows = await Promise.all((head.accounts || []).map(async acct => {
        if (!acct.account_id) return [];
        const disk = await readPLAcctTxnsDisk(fy, acct.account_id);
        if (!disk) return [{ date: '-', branch_name: '-', account_name: acct.account_name, voucher_type: 'N/A', voucher_number: '-', party: '-', description: 'Data not yet synced — click Fetch Data button', amount: 0 }];
        const txns = (disk.transactions||[]).filter(t => { const d = t.transaction_date||''; return d >= dateFrom && d <= dateTo; });
        const out = [];
        for (const { t, net, parts } of plAttributeRows(txns, acct.account_id, branchCtx)) {
          const base = {
            date:           t.transaction_date || '-',
            account_name:   acct.account_name,
            voucher_type:   t.transaction_type_formatted || t.transaction_type || '-',
            voucher_number: t.entry_number || t.reference_number || '-',
            party:          t.payee || '-',
            description:    t.description || '-',
          };
          const sign = head.is_income ? -1 : 1;  // income heads show credits as positive
          if (!parts) { if (isAll) out.push({ ...base, branch_name: 'Fetching…', amount: sign * net }); continue; }
          for (const [b, a] of parts) if (isAll || selBranches.includes(b)) out.push({ ...base, branch_name: b, amount: sign * a });
        }
        return out;
      }));
      queuePLBranchDetails(branchCtx.pending);
      rows = drillRows.flat();
    }
    rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json({ rows, head_id: headId, head_label: head.label, count: rows.length });
  } catch (e) {
    console.error('[pl/report/drill]', e);
    res.status(500).json({ error: e.message });
  }
});

// Prefetch: trigger full FY transaction fetch for all mapped accounts
app.post('/api/pl/prefetch', authMiddleware, async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const fy = ((req.query.fy || req.body?.fy) || currentFYTag()).trim();
  if (_plPrefetchStatus[fy]?.running) return res.json({ ok: false, message: 'Already running', status: _plPrefetchStatus[fy] });
  const mapping = await readPLMapping();
  const accountIds = [...new Set(mapping.heads.flatMap(h => (h.accounts||[]).map(a => a.account_id).filter(Boolean)))];
  if (!accountIds.length) return res.json({ ok: false, message: 'No accounts mapped yet. Configure P&L Mapping first.' });
  background(new Promise(done => setImmediate(() => runPLPrefetch(fy, accountIds, 'manual').finally(done))));
  res.json({ ok: true, fy, account_count: accountIds.length, message: `Fetching ${accountIds.length} accounts for FY ${fy}. Check /api/pl/prefetch/status for progress.` });
});

app.get('/api/pl/prefetch/status', authMiddleware, (req, res) => {
  const fy = (req.query.fy || currentFYTag()).trim();
  res.json(_plPrefetchStatus[fy] || { running: false, total: 0, done: 0, total_txns: 0, message: 'No prefetch run yet for this FY' });
});

// Compare two periods: returns side-by-side amounts + variance
app.get('/api/pl/compare', authMiddleware, async (req, res) => {
  try {
    const fy       = (req.query.fy       || currentFYTag()).trim();
    const p1_type  = req.query.p1_type   || 'quarter';
    const p1       = req.query.p1        || 'Q1';
    const p2_type  = req.query.p2_type   || 'quarter';
    const p2       = req.query.p2        || 'Q2';
    const bParam   = (req.query.branches || '').trim();
    const selBranches = bParam ? bParam.split(',').map(s => s.trim()).filter(Boolean) : [];
    const isAll    = selBranches.length === 0;

    const { dateFrom: df1, dateTo: dt1 } = parsePLPeriod(fy, p1_type, p1);
    const { dateFrom: df2, dateTo: dt2 } = parsePLPeriod(fy, p2_type, p2);

    const [mapping, capacity, fyData] = await Promise.all([readPLMapping(), readPLCapacity(), getPLFYData(fy)]);
    if (fyData.needs_refresh) return res.json({ needs_refresh: true });

    const branchList = isAll ? BUDGET_BRANCHES.map(b => b.name) : selBranches;
    let totalSqft = 0, totalSeats = 0;
    for (const name of branchList) {
      const cap = capacity[name] || {};
      totalSqft  += cap.sqft  || 0;
      totalSeats += cap.seats || 0;
    }
    const bf = item => isAll || selBranches.includes(item.branch_name);
    const branchCtx = await plBranchCtx(fyData);
    const branchSet = isAll ? null : new Set(selBranches);

    const uniqueAcctIds = [...new Set(
      mapping.heads.flatMap(h => (h.accounts||[]).map(a => a.account_id)).filter(Boolean)
    )];

    async function computePeriod(dateFrom, dateTo) {
      const invs = fyData.invoices.filter(i => bf(i) && i.date >= dateFrom && i.date <= dateTo);
      const cns  = fyData.credit_notes.filter(c => bf(c) && c.date >= dateFrom && c.date <= dateTo);
      const rev  = invs.reduce((s,i) => s+subTotal(i), 0) - cns.reduce((s,c) => s+Math.max(0,(c.total||0)-(c.balance||0)), 0);
      const acctAmt = {};
      for (const accountId of uniqueAcctIds) {
        const disk = await readPLAcctTxnsDisk(fy, accountId);
        if (disk) {
          const txns = (disk.transactions||[]).filter(t => { const d=t.transaction_date||''; return d>=dateFrom&&d<=dateTo; });
          acctAmt[accountId] = plAcctNet(txns, accountId, branchCtx, branchSet);
        } else { acctAmt[accountId] = 0; }
      }
      const headAmt = {};
      for (const head of mapping.heads) {
        headAmt[head.id] = head.id === 'revenue' && !plRevenueMapped(mapping.heads) ? rev : plHeadAmount(head, acctAmt);
      }
      const totalRev = plTotalRevenue(mapping.heads, headAmt);
      const EBITDA_SECS = ['occupancy','recurring','opex','other'];
      const secTotals = { revenue: totalRev, occupancy:0, recurring:0, opex:0, other:0, finance:0 };
      for (const head of mapping.heads) {
        if (!head.section||head.section==='revenue') continue;
        secTotals[head.section] = (secTotals[head.section]||0) + (headAmt[head.id]||0);
      }
      const totalExp = EBITDA_SECS.reduce((s,sec) => s+(secTotals[sec]||0), 0);
      return { headAmt, rev: totalRev, totalExp, ebitda: totalRev-totalExp, interest: secTotals['finance']||0, secTotals };
    }

    const [p1d, p2d] = await Promise.all([computePeriod(df1, dt1), computePeriod(df2, dt2)]);
    queuePLBranchDetails(branchCtx.pending);
    const ps = (a,sq) => sq>0 ? a/sq : null;
    const pt = (a,se) => se>0 ? a/se : null;
    const pct = (a,r) => r>0 ? a/r : null;

    const lines = mapping.heads.map(head => {
      const a1 = p1d.headAmt[head.id]||0, a2 = p2d.headAmt[head.id]||0;
      const varAbs = a2 - a1, varPct = a1!==0 ? varAbs/Math.abs(a1) : null;
      return { id: head.id, label: head.label, section: head.section, is_income: head.is_income,
        p1_amount: a1, p2_amount: a2, var_abs: varAbs, var_pct: varPct,
        p1_per_sqft: ps(a1,totalSqft), p2_per_sqft: ps(a2,totalSqft),
        p1_per_seat: pt(a1,totalSeats), p2_per_seat: pt(a2,totalSeats),
        p1_pct_rev: pct(Math.abs(a1),p1d.rev), p2_pct_rev: pct(Math.abs(a2),p2d.rev) };
    });

    res.json({
      fy, capacity: { sqft: totalSqft, seats: totalSeats },
      p1: { type: p1_type, period: p1, dateFrom: df1, dateTo: dt1, revenue: p1d.rev, total_expense: p1d.totalExp, ebitda: p1d.ebitda, interest: p1d.interest },
      p2: { type: p2_type, period: p2, dateFrom: df2, dateTo: dt2, revenue: p2d.rev, total_expense: p2d.totalExp, ebitda: p2d.ebitda, interest: p2d.interest },
      lines,
      branch_pending: isAll ? 0 : branchCtx.unknownIds.size,
    });
  } catch (e) { console.error('[pl/compare]', e); res.status(500).json({ error: e.message }); }
});

// ─── Purchase Chart: Expense by Category ──────────────────────────────────────
app.get('/api/purchase/charts/expense-by-category', cached('pur-exp-cat', 60, async () => {
  const { start: mStart } = getMonthRange();
  const { start: fyStart, end: fyEnd } = getFYRange();
  const r = await syncEngine.getSyncedOrFetch(
    'bills_fy',
    () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd })
  );
  const thisFY    = r.data;
  const thisMonth = thisFY.filter(b => b.date >= mStart);

  function groupByCat(bills) {
    const map = {};
    for (const b of bills) {
      const cat = b.account_name || 'Uncategorized';
      const amt = billSubTotal(b);
      if (!map[cat]) map[cat] = { category: cat, expense: 0, count: 0, bills: [] };
      map[cat].expense += amt;
      map[cat].count   += 1;
      map[cat].bills.push(billSummary(b));
    }
    return Object.values(map).sort((a, b) => b.expense - a.expense);
  }

  return { this_month: groupByCat(thisMonth), all_time: groupByCat(thisFY) };
}));

// ─── Purchase Chart: Expense by Branch ────────────────────────────────────────
app.get('/api/purchase/charts/expense-by-branch', cached('pur-exp-branch', 60, async () => {
  const { start: mStart } = getMonthRange();
  const { start: fyStart, end: fyEnd } = getFYRange();
  const r = await syncEngine.getSyncedOrFetch(
    'bills_fy',
    () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd })
  );
  const thisFY    = r.data;
  const thisMonth = thisFY.filter(b => b.date >= mStart);

  function groupByBranch(bills) {
    const map = {};
    for (const b of bills) {
      const branch = b.branch_name || 'Unknown';
      const amt = billSubTotal(b);
      if (!map[branch]) map[branch] = { branch, expense: 0, count: 0, bills: [] };
      map[branch].expense += amt;
      map[branch].count   += 1;
      map[branch].bills.push(billSummary(b));
    }
    return Object.values(map).sort((a, b) => b.expense - a.expense);
  }

  return { this_month: groupByBranch(thisMonth), all_time: groupByBranch(thisFY) };
}));

// ─── Purchase Chart: Top 10 Vendors ───────────────────────────────────────────
app.get('/api/purchase/charts/top-vendors', cached('pur-top-vendors', 60, async () => {
  const { start: fyStart, end: fyEnd } = getFYRange();
  const r = await syncEngine.getSyncedOrFetch(
    'bills_fy',
    () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd })
  );
  const allBills = r.data;

  const map = {};
  for (const b of allBills) {
    const name = b.vendor_name;
    const amt  = billSubTotal(b);
    if (!map[name]) map[name] = { vendor_name: name, expense: 0, bill_count: 0, outstanding: 0, bills: [] };
    map[name].expense     += amt;
    map[name].bill_count  += 1;
    map[name].outstanding += b.balance || 0;
    map[name].bills.push(billSummary(b));
  }

  return Object.values(map).sort((a, b) => b.expense - a.expense).slice(0, 10);
}));

// ─── Purchase Chart: Month-wise Rent Expense ──────────────────────────────────
// Strategy:
//   1. Identify rent vendor IDs from ACTIVE recurring bill templates
//   2. Fetch ALL bills globally newest-first; stop when oldest bill on page < fyStart
//      (Zoho ignores vendor_id as a filter, so per-vendor calls return all bills —
//       we fetch once globally and filter client-side instead)
//   3. Keep only bills whose vendor_id is in rentVendorIds
//   4. Group by month and branch
app.get('/api/purchase/charts/rent-monthwise', async (req, res) => {
  const fyParam  = req.query.fy || 'current';
  const cacheKey = `pur-rent-mw-${fyParam}`;
  const hit      = cache.get(cacheKey);
  if (hit) return res.json(hit);

  try {
    const now = new Date();
    let fyStart, fyEnd, fyLabel;

    if (fyParam === 'fy2526') {
      fyStart = '2025-04-01';
      fyEnd   = '2026-03-31';
      fyLabel = 'FY 2025-26';
    } else {
      const fyStartDate = now.getMonth() >= 3
        ? new Date(now.getFullYear(), 3, 1)
        : new Date(now.getFullYear() - 1, 3, 1);
      fyStart = localDate(fyStartDate);
      fyEnd   = localDate(now);
      const fy1 = fyStartDate.getFullYear();
      fyLabel = `FY ${fy1}-${String(fy1 + 1).slice(2)}`;
    }

    // ── Step 1: collect all ACTIVE recurring bill vendor IDs (used as a hint) ──
    // We no longer rely solely on this to identify rent vendors — many landlord
    // templates do not contain "rent" in their name or category.
    // The primary filter in Step 3 uses cf_vendor_category = "Landlord" instead.
    const rentVendorNames = {};  // vendor_id → vendor_name (for the result payload)
    let rbPage = 1;
    while (true) {
      const rbData = await zohoGet('/recurringbills', { filter_by: 'Status.Active', per_page: 200, page: rbPage });
      for (const rb of (rbData.recurring_bills || [])) {
        const name    = (rb.recurrence_name || '').toLowerCase();
        const cat     = (rb.cf_category_unformatted || rb.cf_category || '').toLowerCase();
        const vendCat = (rb.cf_vendor_category_unformatted || rb.cf_vendor_category || '').toLowerCase();
        if (name.includes('rent') || cat.includes('rent') || vendCat.includes('landlord')) {
          rentVendorNames[rb.vendor_id] = rb.vendor_name;
        }
      }
      if (!rbData.page_context?.has_more_page) break;
      rbPage++;
    }

    // ── Step 2: bills in our FY window — synced copy when fresh, else live ─────
    // Live: bills come roughly newest-first but are NOT strictly sorted — old bills
    // can appear on early pages. Checking NEWEST (not oldest) item per page is the
    // reliable stop signal: when even the newest bill on a page predates fyStart,
    // we've scrolled past the beginning of our window.
    let fyBills = (await rptSynced('bills_fy', fyStart))?.filter(b => b.date >= fyStart && b.date <= fyEnd);
    if (!fyBills) {
      fyBills = [];
      for (let pg = 1; ; pg++) {
        const d    = await zohoGet('/bills', { filter_by: 'Status.All', per_page: 200, page: pg });
        const list = d.bills || [];
        if (!list.length) break;
        fyBills.push(...list.filter(b => b.date >= fyStart && b.date <= fyEnd));
        if (!d.page_context?.has_more_page) break;
        // Stop when the newest bill on this page is before our window — we've passed it
        const newest = list.reduce((m, b) => (b.date > m ? b.date : m), '');
        if (newest < fyStart) break;
      }
    }

    // ── Step 3: identify rent bills; de-duplicate by bill_id ─────────────────
    // PRIMARY filter: cf_vendor_category = "Landlord" (set by the widget on ALL
    // landlord bills regardless of template naming convention).  This captures
    // vendors whose recurring templates don't have "rent" in the name/category —
    // which was the cause of ~60% of bills being missed previously.
    {
      const seen = new Map();
      for (const b of fyBills) seen.set(b.bill_id, b);
      fyBills.length = 0;
      for (const b of seen.values()) fyBills.push(b);
    }
    const rentBills = fyBills.filter(b => {
      const vc = (b.cf_vendor_category_unformatted || b.cf_vendor_category || '').trim().toLowerCase();
      return vc === 'landlord';
    });

    // ── Step 4: month skeleton ────────────────────────────────────────────────
    const allMonthKeys = [];
    {
      const cursor = new Date(fyStart + 'T00:00:00');
      const endD   = new Date(fyEnd   + 'T00:00:00');
      while (cursor <= endD) {
        allMonthKeys.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`);
        cursor.setMonth(cursor.getMonth() + 1);
      }
    }

    // ── Step 4b: per-bill detail (pre-tax sub_total, office no., line account) ──
    // The bills LIST API has no sub_total and its total is net of TDS, so amounts
    // come from each bill's stored DETAIL (see queueRentDetails). A handful of new
    // or changed bills is fetched before responding; a large backlog (first fill of
    // a FY) is fetched in the background and those bills show an estimate meanwhile.
    const detailStore = await rptStore('rent_bill_details', RENT_DETAILS_FILE);
    const staleBills  = rentBills.filter(b => rentDetailStale(detailStore, b));
    if (staleBills.length) {
      const worker = queueRentDetails(staleBills);
      if (_rentQueue.size <= 30) await worker;
    }
    const detailsPending = rentBills.filter(b => detailStore[b.bill_id]?.sub_total == null).length;

    // Build office_no map (one per branch × vendor)
    const officeNoMap = {};
    for (const b of rentBills) {
      const key = `${b.branch_name || 'Unknown'}|||${b.vendor_name || 'Unknown'}`;
      if (!officeNoMap[key] && detailStore[b.bill_id]?.office_no) {
        officeNoMap[key] = detailStore[b.bill_id].office_no;
      }
    }

    // Map line-item account_name → normalised sub_category label
    function accountToSubCat(accountName) {
      const lower = (accountName || '').toLowerCase();
      if (lower.includes('rent'))        return 'property rental expenses';
      if (lower.includes('maintenance')) return 'property maintenance expenses';
      return accountName || '';
    }

    // ── Step 5: pivot by (branch × vendor × sub_category) with month columns ──
    const monthSet = new Set(allMonthKeys);
    const rowMap   = {};  // key: "branch|||vendor|||sub_category"

    for (const b of rentBills) {
      const mkey      = b.date ? b.date.slice(0, 7) : null;
      if (!mkey || !monthSet.has(mkey)) continue;
      const branch    = b.branch_name || 'Unknown';
      const vendor    = b.vendor_name || 'Unknown';
      const vendorCat = (b.cf_vendor_category_unformatted || b.cf_vendor_category || '').trim();

      // Use line-item account_name as the authoritative sub_category source.
      // Fall back to bill-level cf_category only when account_name is unavailable.
      const detail  = detailStore[b.bill_id];
      const subCat  = detail?.account_name
        ? accountToSubCat(detail.account_name)
        : (b.cf_category_unformatted || b.cf_category || '').trim();

      const rkey     = `${branch}|||${vendor}|||${subCat}`;
      const officeKey = `${branch}|||${vendor}`;

      if (!rowMap[rkey]) {
        const uscore = branch.indexOf('_');
        rowMap[rkey] = {
          branch_full:     branch,
          office:          officeNoMap[officeKey] || (uscore >= 0 ? branch.slice(uscore + 1) : '—'),
          vendor,
          vendor_category: vendorCat,
          sub_category:    subCat,
          monthly:         Object.fromEntries(allMonthKeys.map(k => [k, 0])),
          bills_by_month:  Object.fromEntries(allMonthKeys.map(k => [k, []])),
          total:           0,
        };
      }
      // Pre-tax sub_total from the bill detail; list-based estimate until it is stored
      const amt = detail?.sub_total ?? rentEstimate(b);
      rowMap[rkey].monthly[mkey]         += amt;
      rowMap[rkey].total                 += amt;
      const summary = billSummary(b);
      summary.sub_total = amt;  // override with correct amount
      rowMap[rkey].bills_by_month[mkey].push(summary);
    }

    // ── Step 6: Attach agreed amounts from the Rent Recurring Module workbook ──
    // (newest "Rent Recurring Module*.xlsx" in the project root — see rent-agreed.js)
    const agreed = attachRentAgreed(Object.values(rowMap), allMonthKeys);

    const rows = Object.values(rowMap)
      .sort((a, b) => a.branch_full.localeCompare(b.branch_full) || a.vendor.localeCompare(b.vendor));

    // Monthly grand totals (across all rows)
    const monthlyTotals = Object.fromEntries(
      allMonthKeys.map(k => [k, rows.reduce((s, r) => s + (r.monthly[k] || 0), 0)])
    );

    // Month header descriptors
    const months = allMonthKeys.map(k => {
      const d = new Date(k + '-01');
      return { key: k, label: d.toLocaleString('en-IN', { month: 'short', year: '2-digit' }) };
    });

    // Unique lists for filter dropdowns
    const allBranches        = ['All Branches',        ...new Set(rows.map(r => r.branch_full))].sort();
    const allVendors         = ['All Vendors',         ...new Set(rows.map(r => r.vendor))].sort();
    const allVendorCategories = ['All Categories',      ...new Set(rows.map(r => r.vendor_category).filter(Boolean))].sort();
    const allSubCategories   = ['All Sub-Categories',  ...new Set(rows.map(r => r.sub_category).filter(Boolean))].sort();

    const result = {
      fy:              fyLabel,
      months,
      rows,
      monthly_totals:         monthlyTotals,
      grand_total:            rows.reduce((s, r) => s + r.total, 0),
      all_branches:           allBranches,
      all_vendors:            allVendors,
      all_vendor_categories:  allVendorCategories,
      all_sub_categories:     allSubCategories,
      rent_vendors:           Object.values(rentVendorNames),
      details_pending:        detailsPending,
      agreed_source:          agreed.file,
      agreed_unmatched:       agreed.unmatched,
    };

    // While estimates remain, keep the result briefly; the detail worker also clears it when done
    cache.set(cacheKey, result, detailsPending ? 120 : 3600);
    res.json(result);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Debug: test account_transactions for a specific account + branch ─────────
app.get('/api/purchase/debug/acct-txn', async (req, res) => {
  try {
    const { account_id, branch_id, from_date, to_date } = req.query;
    const params = { account_id, branch_id, from_date: from_date || '2026-04-01', to_date: to_date || '2026-09-03' };
    const r = await zohoGet('/reports/accounttransactions', params);
    res.json({ params, raw_keys: Object.keys(r), txn_count: (r.account_transactions || r.transactions || []).length, sample: (r.account_transactions || r.transactions || []).slice(0, 3), full_response_keys: Object.keys(r) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Debug: COA leaf check for recurring expense accounts ─────────────────────
app.get('/api/purchase/debug/recur-coa', async (req, res) => {
  try {
    const TARGET_NAMES = ['Housekeeping Material Expense','Housekeeping Service','Internet Connect. Charges','Security Services','Tea & Coffee Machine Maint. Charges','Tea_Coffee & Milk Expense','Electricity Expense'];
    const { coaFull, coaParentIds } = await getCoaData();
    const found = [];
    const targetIds = new Set();
    for (const [aid, acct] of Object.entries(coaFull)) {
      if (TARGET_NAMES.includes(acct.name)) {
        found.push({ id: aid, name: acct.name, parentId: acct.parentId, isParent: coaParentIds.has(aid) });
        targetIds.add(aid);
      }
    }
    // Also find children of these target accounts
    const children = [];
    for (const [aid, acct] of Object.entries(coaFull)) {
      if (targetIds.has(acct.parentId)) {
        children.push({ id: aid, name: acct.name, parentId: acct.parentId, parentName: coaFull[acct.parentId]?.name, isParent: coaParentIds.has(aid) });
      }
    }
    res.json({ total_coa: Object.keys(coaFull).length, found, found_count: found.length, children, children_count: children.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Purchase: Month-wise & Branch-wise Recurring Expense Report ──────────────
// Reads from branchSync cache (branch_bills_cache/*.json) — no Zoho API calls needed.
// Tea Machine vs Tea Milk split is derived from account_name in monthlyBillsByItem.
app.get('/api/purchase/charts/recurring-expense-report', async (req, res) => {
  const fyParam  = req.query.fy || 'current';
  const cacheKey = `pur-recur-exp-v5-${fyParam}`;
  const hit      = cache.get(cacheKey);
  if (hit) return res.json(hit);

  try {
    const now = new Date();
    let fyStart, fyEnd, fyLabel;
    if (fyParam === 'fy2526') {
      fyStart = '2025-04-01'; fyEnd = '2026-03-31'; fyLabel = 'FY 2025-26';
    } else {
      const fyStartDate = now.getMonth() >= 3
        ? new Date(now.getFullYear(), 3, 1)
        : new Date(now.getFullYear() - 1, 3, 1);
      fyStart  = localDate(fyStartDate);
      fyEnd    = localDate(now);
      const fy1 = fyStartDate.getFullYear();
      fyLabel  = `FY ${fy1}-${String(fy1 + 1).slice(2)}`;
    }

    const HEADS = [
      { key: 'hk_material', label: 'Housekeeping Material Expense' },
      { key: 'hk_service',  label: 'Housekeeping Service' },
      { key: 'internet',    label: 'Internet Connect. Charges' },
      { key: 'security',    label: 'Security Services' },
      { key: 'tc_machine',  label: 'Tea & Coffee Machine Maint.' },
      { key: 'tc_milk',     label: 'Tea, Coffee & Milk Expense' },
      { key: 'electricity', label: 'Electricity Expense' },
    ];
    const HEADS_BY_KEY = Object.fromEntries(HEADS.map(h => [h.key, h]));

    // Build month key list for the FY
    const monthKeys = [];
    for (let d = new Date(fyStart + 'T00:00:00'); localDate(d) <= fyEnd; d.setMonth(d.getMonth() + 1)) {
      const mk = localDate(d).slice(0, 7);
      if (!monthKeys.includes(mk)) monthKeys.push(mk);
    }
    const monthKeySet = new Set(monthKeys);

    // Classify a tea_coffee bill item as tc_machine or tc_milk by account_name
    function tcHead(accountName) {
      const n = (accountName || '').toLowerCase();
      if (n.includes('machine')) return 'tc_machine';
      return 'tc_milk';
    }

    // ── Read all branchSync cache files ──────────────────────────────────────
    const emptyCell = () => ({ amount: 0, transactions: [] });
    const rowMap = {};
    const getRow = (headKey, branchName) => {
      const rkey = `${headKey}|||${branchName}`;
      if (!rowMap[rkey]) {
        rowMap[rkey] = { head_key: headKey, head_label: HEADS_BY_KEY[headKey].label, branch: branchName,
          monthly: Object.fromEntries(monthKeys.map(m => [m, emptyCell()])) };
      }
      return rowMap[rkey];
    };

    const allBranchData = await db.listBranchCaches(BRANCH_BILLS_DIR);

    for (const branchData of allBranchData) {
      if (!branchData) continue;

      const branchName = branchData.branchName || '';
      const mt  = branchData.monthlyTotals       || {};
      const mbi = branchData.monthlyBillsByItem   || {};

      // Map each budget field to the correct head key
      const HEAD_FIELD = {
        hk_material: 'hk_materials',
        hk_service:  'hk_service',
        internet:    'internet',
        security:    'security',
        electricity: 'elec_util',
      };

      for (const mk of monthKeys) {
        const totals = mt[mk];
        if (!totals) continue;

        // Simple 1:1 head → budget field mapping
        for (const [headKey, field] of Object.entries(HEAD_FIELD)) {
          const amt = parseFloat(totals[field] || 0);
          if (amt === 0) continue;
          const row = getRow(headKey, branchName);
          row.monthly[mk].amount += amt;
          // Transaction detail from monthlyBillsByItem
          for (const b of (mbi[mk]?.[field === 'hk_materials' ? 'hk_materials' : field === 'elec_util' ? 'elec_util' : field] || [])) {
            row.monthly[mk].transactions.push({
              type:   b.type === 'journal' ? 'Journal' : 'Bill',
              ref:    b.bill_number || b.bill_id || '',
              vendor: b.vendor || b.account_name || '',
              date:   b.date || '',
              amount: Math.round((b.line_item_total || b.bill_total || 0) * 100) / 100,
            });
          }
        }

        // Tea machine + tea milk — split from combined tea_coffee budget item
        const tcBills = mbi[mk]?.tea_coffee || [];
        for (const b of tcBills) {
          const hk = tcHead(b.account_name);
          const amt = parseFloat(b.line_item_total || b.bill_total || 0);
          if (amt === 0) continue;
          const row = getRow(hk, branchName);
          row.monthly[mk].amount += amt;
          row.monthly[mk].transactions.push({
            type:   b.type === 'journal' ? 'Journal' : 'Bill',
            ref:    b.bill_number || b.bill_id || '',
            vendor: b.vendor || b.account_name || '',
            date:   b.date || '',
            amount: Math.round(amt * 100) / 100,
          });
        }
      }
    }

    // Round accumulated amounts
    for (const row of Object.values(rowMap)) {
      for (const cell of Object.values(row.monthly)) {
        cell.amount = Math.round(cell.amount * 100) / 100;
      }
    }

    const rows = Object.values(rowMap)
      .map(r => ({ ...r, total: monthKeys.reduce((s, m) => s + (r.monthly[m].amount || 0), 0) }))
      .filter(r => r.total > 0)
      .sort((a, b) => {
        const hi = HEADS.findIndex(h => h.key === a.head_key) - HEADS.findIndex(h => h.key === b.head_key);
        return hi !== 0 ? hi : a.branch.localeCompare(b.branch);
      });

    const months = monthKeys.map(k => {
      const dt = new Date(k + '-01');
      return { key: k, label: dt.toLocaleString('en-IN', { month: 'short', year: '2-digit' }) };
    });

    const result = {
      fy:           fyLabel,
      months,
      rows,
      heads:        HEADS.map(h => ({ key: h.key, label: h.label, meta: [] })),
      all_branches: ['All Branches', ...new Set(rows.map(r => r.branch))].sort((a, b) => a === 'All Branches' ? -1 : b === 'All Branches' ? 1 : a.localeCompare(b)),
    };

    cache.set(cacheKey, result, 300); // 5-minute cache — refreshes when branchSync updates
    res.json(result);
  } catch (e) {
    console.error('[recurring-expense-report]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Purchase KPI: AP Aging ───────────────────────────────────────────────────
app.get('/api/purchase/kpi/ap-aging', cached('pur-ap-aging', 60, async () => {
  const [openResult, overdueResult] = await Promise.all([
    syncEngine.getSyncedOrFetch('bills_open',    () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Open' },    {})),
    syncEngine.getSyncedOrFetch('bills_overdue', () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Overdue' }, {})),
  ]);
  const openBills    = openResult.data;
  const overdueBills = overdueResult.data;
  const _seen2 = new Set();
  const allUnpaid = [];
  for (const b of [...openBills, ...overdueBills]) {
    if (!_seen2.has(b.bill_id)) { _seen2.add(b.bill_id); allUnpaid.push(b); }
  }
  const todayMs   = new Date().getTime();

  const buckets = { current: [], '0-30': [], '31-60': [], '61-90': [], '90+': [] };

  for (const b of allUnpaid) {
    if (!b.balance || b.balance <= 0) continue;
    const ageDays = b.date ? Math.round((todayMs - new Date(b.date).getTime()) / 86400000) : 0;
    const row = { ...billSummary(b), age_days: ageDays };

    const dueMs       = b.due_date ? new Date(b.due_date).getTime() : null;
    const overdueDays = dueMs ? Math.round((todayMs - dueMs) / 86400000) : -1;
    row.overdue_days  = Math.max(0, overdueDays);

    if (overdueDays <= 0)       buckets.current.push(row);
    else if (overdueDays <= 30) buckets['0-30'].push(row);
    else if (overdueDays <= 60) buckets['31-60'].push(row);
    else if (overdueDays <= 90) buckets['61-90'].push(row);
    else                        buckets['90+'].push(row);
  }

  const summarize = arr => ({
    count: arr.length,
    total: arr.reduce((s, b) => s + b.balance, 0),
    bills: arr,
  });

  return {
    current:     summarize(buckets.current),
    '0-30':      summarize(buckets['0-30']),
    '31-60':     summarize(buckets['31-60']),
    '61-90':     summarize(buckets['61-90']),
    '90+':       summarize(buckets['90+']),
    grand_total: allUnpaid.reduce((s, b) => s + (b.balance || 0), 0),
  };
}));

// ─── Purchase: Vendor Category & Recurring Report ────────────────────────────
app.get('/api/purchase/charts/vendor-category-report', cached('pur-vc-report', 600, async () => {
  const { start: mStart, end: mEnd } = getMonthRange();
  const { start: fyStart, end: fyEnd } = getFYRange();

  // Fetch open+overdue bills, recurring templates, vendor contacts (for unused credits),
  // and vendor credit notes (for drill-down detail only) in parallel.
  // Unused credit TOTALS come from the contacts API (unused_credits_payable_amount field)
  // because that is exactly what Zoho shows in its own Vendor list — computing it from
  // individual credit note balances in the /vendorcredits API is unreliable as Zoho's
  // list endpoint often omits the balance field.
  const [openResult, overdueResult, recurringRaw, allVendors, allVCreds] = await Promise.all([
    syncEngine.getSyncedOrFetch('bills_open',    () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Open' },    {})),
    syncEngine.getSyncedOrFetch('bills_overdue', () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Overdue' }, {})),
    (async () => {
      const all = [];
      for (let pg = 1; ; pg++) {
        const d = await zohoGet('/recurringbills', { filter_by: 'Status.Active', per_page: 200, page: pg });
        all.push(...(d.recurring_bills || []));
        if (!d.page_context?.has_more_page) break;
      }
      return all;
    })(),
    syncedAll('vendors_all', () => zohoGetAll('/contacts', 'contacts', { contact_type: 'vendor' }, {})),
    syncedAll('vendor_credits_all', () => zohoGetAll('/vendorcredits', 'vendor_credits', { filter_by: 'Status.All' }, {})),
  ]);
  const openBills    = openResult.data;
  const overdueBills = overdueResult.data;
  // Same set activeVendors() returns (Zoho Status.Active)
  const vendorContacts = allVendors.filter(v => v.status === 'active');

  // Vendor Category: the bill's own cf_vendor_category when filled, else the vendor master's
  // Vendor Category (contact custom field cf_vendor_category), matched on vendor_id. All
  // vendor statuses are included so inactive vendors with bills still resolve.
  // 'Uncategorized' only when both are blank in Zoho.
  const vendorMasterCat = {};
  for (const c of allVendors) {
    const vc = (c.cf_vendor_category_unformatted || c.cf_vendor_category || '').trim();
    if (vc) vendorMasterCat[c.contact_id] = vc;
  }
  const vendorCategory = r =>
    ((r.cf_vendor_category_unformatted || r.cf_vendor_category || '').trim()) || vendorMasterCat[r.vendor_id] || 'Uncategorized';

  // FY bills (FY start → today) from the central Bills — FY All cache; live scan as fallback
  const fyBills = await syncedRange('bills_fy', fyStart, fyEnd, async () => {
    const out = [];
    for (let pg = 1; ; pg++) {
      const d    = await zohoGet('/bills', { filter_by: 'Status.All', per_page: 200, page: pg });
      const list = d.bills || [];
      if (!list.length) break;
      out.push(...list.filter(b => b.date >= fyStart && b.date <= fyEnd));
      if (!d.page_context?.has_more_page) break;
      const newest = list.reduce((m, b) => (b.date > m ? b.date : m), '');
      if (newest < fyStart) break;
    }
    return out;
  });
  const monthBills = fyBills.filter(b => b.date >= mStart && b.date <= mEnd);

  // Deduplicate payable bills (open + overdue)
  const seenP = new Set();
  const payBills = [];
  for (const b of [...openBills, ...overdueBills]) {
    if (!seenP.has(b.bill_id)) { seenP.add(b.bill_id); payBills.push(b); }
  }

  // Group ALL payable bills by (category, sub_category, vendor) — independent of FY window.
  const payCatMap = {};
  for (const b of payBills) {
    if (!b.balance || b.balance <= 0) continue;
    const cat    = vendorCategory(b);
    const subcat = ((b.cf_category_unformatted       || b.cf_category       || '').trim()) || 'General';
    const vKey   = b.vendor_id || b.vendor_name;
    if (!payCatMap[cat]) payCatMap[cat] = {};
    if (!payCatMap[cat][subcat]) payCatMap[cat][subcat] = {};
    if (!payCatMap[cat][subcat][vKey]) payCatMap[cat][subcat][vKey] = { vendor_id: b.vendor_id, vendor_name: b.vendor_name, payable: 0, payable_bills: [] };
    payCatMap[cat][subcat][vKey].payable += b.balance;
    payCatMap[cat][subcat][vKey].payable_bills.push({ ...billSummary(b), balance: b.balance });
  }

  // Build vendor credit detail map from /vendorcredits (for drill-down modals only).
  // Exclude closed/void; use total as the proxy since balance is unreliable in list API.
  const vcDetailMap = {}; // vendor_id → credit_details[]
  for (const vc of allVCreds) {
    const st = (vc.status || '').toLowerCase();
    if (st === 'closed' || st === 'void') continue;
    const vKey = vc.vendor_id || vc.vendor_name;
    if (!vcDetailMap[vKey]) vcDetailMap[vKey] = [];
    vcDetailMap[vKey].push({
      vendor_credit_number: vc.vendor_credit_number,
      vendor_name:          vc.vendor_name,
      branch_name:          vc.branch_name || '-',
      date:                 vc.date,
      balance:              vc.total || 0,
      total:                vc.total || 0,
      status:               vc.status,
    });
  }

  // Build vendor→category lookup from bills (category resolved per bill as above).
  // If a vendor has no bills at all, their credits use the vendor master category.
  const vendorCatFromBills = {};
  for (const b of payBills) {
    const vKey = b.vendor_id || b.vendor_name;
    const cat  = vendorCategory(b);
    // Use the bill with the highest amount as the "primary" category for the vendor
    if (!vendorCatFromBills[vKey] || (b.total || 0) > (vendorCatFromBills[vKey].amount || 0)) {
      vendorCatFromBills[vKey] = { category: cat, amount: b.total || 0 };
    }
  }
  // Also scan FY bills so vendors with no outstanding bills but FY expense are found
  for (const b of fyBills) {
    const vKey = b.vendor_id || b.vendor_name;
    if (!vendorCatFromBills[vKey]) {
      const cat = vendorCategory(b);
      vendorCatFromBills[vKey] = { category: cat, amount: b.total || 0 };
    }
  }

  // Build credit SUMMARY from vendor contacts — the contacts API exposes
  // unused_credits_payable_amount which is the exact figure Zoho displays
  // in its own Vendor list "Unused Credits" column.
  const creditCatMap = {};
  for (const c of vendorContacts) {
    const unused = c.unused_credits_payable_amount || 0;
    if (unused <= 0) continue;
    const vKey  = c.contact_id;
    const vName = c.contact_name || c.vendor_name || '';
    // Category from bills; if vendor has no bills at all → vendor master category
    const cat   = vendorCatFromBills[vKey]?.category || vendorMasterCat[vKey] || 'Uncategorized';
    if (!creditCatMap[cat]) creditCatMap[cat] = {};
    creditCatMap[cat][vKey] = {
      vendor_id:      c.contact_id,
      vendor_name:    vName,
      credits:        unused,
      credit_details: vcDetailMap[vKey] || [],
    };
  }

  // Group FY/month bills by (category, sub_category, vendor) for expense columns
  function groupBills(bills) {
    const catMap = {};
    for (const b of bills) {
      const cat    = vendorCategory(b);
      const subcat = ((b.cf_category_unformatted       || b.cf_category       || '').trim()) || 'General';
      const vKey   = b.vendor_id || b.vendor_name;
      if (!catMap[cat]) catMap[cat] = {};
      if (!catMap[cat][subcat]) catMap[cat][subcat] = {};
      if (!catMap[cat][subcat][vKey]) catMap[cat][subcat][vKey] = { vendor_id: b.vendor_id, vendor_name: b.vendor_name, expense: 0, bills: [] };
      catMap[cat][subcat][vKey].expense += b.total || 0;
      catMap[cat][subcat][vKey].bills.push(billSummary(b));
    }
    return catMap;
  }
  const mCat  = groupBills(monthBills);
  const fyCat = groupBills(fyBills);

  // Merge expense + payable + credits per category → sub_category → vendor
  const allCats = new Set([
    ...Object.keys(mCat), ...Object.keys(fyCat),
    ...Object.keys(payCatMap), ...Object.keys(creditCatMap),
  ]);
  const categories = [];

  for (const cat of [...allCats].sort()) {
    const mSub  = mCat[cat]        || {};
    const fySub = fyCat[cat]       || {};
    const pSub  = payCatMap[cat]   || {};
    const cV    = creditCatMap[cat] || {};   // cat → vendor (credits have no sub-cat)

    const allSubCats = new Set([
      ...Object.keys(mSub), ...Object.keys(fySub), ...Object.keys(pSub),
    ]);

    const sub_categories = [];
    const seenCredits = new Set(); // track vendors whose credits have been counted

    for (const subcat of [...allSubCats].sort()) {
      const mV = mSub[subcat]  || {};
      const fV = fySub[subcat] || {};
      const pV = pSub[subcat]  || {};
      const allVKeys = new Set([...Object.keys(mV), ...Object.keys(fV), ...Object.keys(pV)]);

      const vendors = [...allVKeys].map(vKey => {
        const pay  = pV[vKey] || { payable: 0, payable_bills: [] };
        // Credits are vendor-level; only assign to the first sub-cat the vendor appears in
        const cred = (!seenCredits.has(vKey) && cV[vKey]) ? cV[vKey] : { credits: 0, credit_details: [] };
        return {
          vendor_id:      fV[vKey]?.vendor_id   || mV[vKey]?.vendor_id   || pay.vendor_id   || cred.vendor_id,
          vendor_name:    fV[vKey]?.vendor_name  || mV[vKey]?.vendor_name  || pay.vendor_name || cred.vendor_name,
          month_expense:  mV[vKey]?.expense       || 0,
          fy_expense:     fV[vKey]?.expense       || 0,
          payable:        pay.payable,
          credits:        cred.credits,
          month_bills:    mV[vKey]?.bills         || [],
          fy_bills:       fV[vKey]?.bills         || [],
          payable_bills:  pay.payable_bills,
          credit_details: cred.credit_details,
        };
      }).sort((a, b) => b.fy_expense - a.fy_expense);

      // Mark vendors as seen so their credits aren't double-counted in other sub-cats
      for (const v of vendors) { if (v.credits > 0) seenCredits.add(v.vendor_id || v.vendor_name); }

      sub_categories.push({
        sub_category:  subcat,
        month_expense: vendors.reduce((s, v) => s + v.month_expense, 0),
        fy_expense:    vendors.reduce((s, v) => s + v.fy_expense, 0),
        payable:       vendors.reduce((s, v) => s + v.payable, 0),
        credits:       vendors.reduce((s, v) => s + v.credits, 0),
        vendors,
      });
    }

    // Also include vendors that only have credits (not in any expense/payable sub-cat)
    const creditOnlyVendors = Object.entries(cV)
      .filter(([vKey]) => !seenCredits.has(vKey))
      .map(([, c]) => ({ ...c, month_expense: 0, fy_expense: 0, payable: 0, month_bills: [], fy_bills: [], payable_bills: [] }));
    if (creditOnlyVendors.length) {
      sub_categories.push({
        sub_category:  'Other Credits',
        month_expense: 0,
        fy_expense:    0,
        payable:       0,
        credits:       creditOnlyVendors.reduce((s, v) => s + v.credits, 0),
        vendors:       creditOnlyVendors,
      });
    }

    sub_categories.sort((a, b) => b.fy_expense - a.fy_expense);

    categories.push({
      category:      cat,
      month_expense: sub_categories.reduce((s, s2) => s + s2.month_expense, 0),
      fy_expense:    sub_categories.reduce((s, s2) => s + s2.fy_expense, 0),
      payable:       sub_categories.reduce((s, s2) => s + s2.payable, 0),
      credits:       Object.values(cV).reduce((s, c) => s + c.credits, 0), // accurate category total
      sub_categories,
    });
  }
  categories.sort((a, b) => b.fy_expense - a.fy_expense);

  // Build recurring vendor list (one entry per vendor_id from active templates)
  const recurMap = {};
  for (const rb of recurringRaw) {
    const vKey = rb.vendor_id || rb.vendor_name;
    if (!recurMap[vKey]) {
      const cat = vendorCategory(rb);
      recurMap[vKey] = {
        recurring_bill_id:    rb.recurring_bill_id,
        recurrence_name:      rb.recurrence_name || rb.vendor_name,
        vendor_id:            rb.vendor_id,
        vendor_name:          rb.vendor_name,
        category:             cat,
        template_amount:      rb.amount || 0,
        recurrence_frequency: rb.recurrence_frequency || rb.repeat_every_unit || '',
        repeat_every:         rb.repeat_every || 1,
        next_bill_date:       rb.next_bill_date || '',
        month_expense:        0,
        fy_expense:           0,
        payable:              0,
        credits:              0,
        month_bills:          [],
        fy_bills:             [],
        payable_bills:        [],
        credit_details:       [],
      };
    }
    // accumulate if same vendor has multiple templates
    recurMap[vKey].template_amount += (rb.amount || 0);
  }
  // Cross-reference with expense/payable/credits (iterate through sub_categories)
  for (const cat of categories) {
    for (const sc of cat.sub_categories) {
      for (const v of sc.vendors) {
        const key = v.vendor_id || v.vendor_name;
        if (recurMap[key]) {
          recurMap[key].month_expense  += v.month_expense;
          recurMap[key].fy_expense     += v.fy_expense;
          recurMap[key].payable        += v.payable;
          recurMap[key].credits        += v.credits;
          recurMap[key].month_bills.push(...v.month_bills);
          recurMap[key].fy_bills.push(...v.fy_bills);
          recurMap[key].payable_bills.push(...v.payable_bills);
          recurMap[key].credit_details.push(...v.credit_details);
        }
      }
    }
  }
  const recurring_vendors = Object.values(recurMap).sort((a, b) => b.fy_expense - a.fy_expense);

  return { categories, recurring_vendors };
}));

// ─── Purchase: MSME Payment Report ────────────────────────────────────────────
// Bills-first approach: fetch open+overdue bills → unique vendor IDs from bills
// (~20-80 vendors) → fetch contact details for ONLY those vendors to check msme_type.
// No full vendor scan needed. Cached 5 minutes.

app.get('/api/purchase/msme-report', async (req, res) => {
  const cacheKey = 'pur-msme-report';
  const hit = cache.get(cacheKey);
  if (hit) return res.json(hit);

  try {
    const now     = new Date();
    const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    function daysSince(dateStr) {
      if (!dateStr) return 0;
      try {
        const d  = new Date(dateStr);
        const ms = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
        return Math.max(0, Math.floor((todayMs - ms) / 86400000));
      } catch { return 0; }
    }

    // Step 1: fetch all open + overdue bills (via sync cache if fresh)
    const [openResult, overdueResult] = await Promise.all([
      syncEngine.getSyncedOrFetch('bills_open',    () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Open' },    {})),
      syncEngine.getSyncedOrFetch('bills_overdue', () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Overdue' }, {})),
    ]);
    const billMap = {};
    for (const b of [...openResult.data, ...overdueResult.data]) billMap[b.bill_id] = b;
    const allBills = Object.values(billMap);

    // Step 2: unique vendor IDs — outstanding bills + vendor_master (admin-confirmed MSME vendors)
    const irDataForPmtRpt = await readMsmeIR();
    const vmVidsForPmtRpt = Object.keys(irDataForPmtRpt.vendor_master || {});
    const billVendorIds   = [...new Set([
      ...allBills.map(b => b.vendor_id).filter(Boolean),
      ...vmVidsForPmtRpt,
    ])];

    // Step 3: contact details — shared persistent contact map (MSME fields incl. MSME Sector)
    const { map: rawCM } = await loadMsmeContactMap(billVendorIds, vmVidsForPmtRpt);

    // Build msmeMap (only Micro/Small — exclude Medium) from contact cache
    const msmeMap = {};
    for (const [cid, c] of Object.entries(rawCM)) {
      if (!billVendorIds.includes(cid)) continue;
      const t = (c.msme_type || '').toLowerCase();
      if (t.includes('medium')) continue;
      msmeMap[cid] = {
        vendor_id:    cid,
        vendor_name:  c.vendor_name,
        msme_type:    c.msme_type,
        udyam_number: c.udyam_reg_no || '',
        vm_confirmed: c.vm_confirmed,
      };
    }
    // Stub for any vendor_master vendor not already in map
    for (const vid of vmVidsForPmtRpt) {
      if (!msmeMap[vid]) {
        msmeMap[vid] = { vendor_id: vid, vendor_name: rawCM[vid]?.vendor_name || '', msme_type: '', udyam_number: '', vm_confirmed: true };
      }
    }

    const msmeIds   = new Set(Object.keys(msmeMap));
    const total_msme = msmeIds.size;
    const msmeBills  = allBills.filter(b => msmeIds.has(b.vendor_id));

    // Step 4: enrich bills with day counts and categories
    const enriched = msmeBills.map(b => {
      const days = daysSince(b.date);
      return {
        bill_id:       b.bill_id,
        bill_number:   b.bill_number || '',
        date:          b.date        || '',
        due_date:      b.due_date    || '',
        status:        b.status      || '',
        days_since:    days,
        days_until_45: Math.max(0, 45 - days),
        days_overdue:  Math.max(0, days - 45),
        total:         b.total   || 0,
        balance:       b.balance || b.total || 0,
        category:    ((b.cf_vendor_category_unformatted || b.cf_vendor_category || '').trim()) || 'Uncategorized',
        sub_category:((b.cf_category_unformatted       || b.cf_category       || '').trim()) || 'General',
        vendor_id:    b.vendor_id,
        vendor_name:  b.vendor_name,
      };
    });

    // Step 5: group by vendor
    function groupVendors(bills) {
      const map = {};
      for (const b of bills) {
        const vid = b.vendor_id;
        if (!map[vid]) {
          const msme = msmeMap[vid] || {};
          map[vid] = {
            vendor_id:     vid,
            vendor_name:   b.vendor_name,
            msme_type:     msme.msme_type    || 'MSME',
            udyam_number:  msme.udyam_number || '',
            category:      b.category,
            sub_category:  b.sub_category,
            total_pending: 0,
            max_days:      0,
            bills:         [],
            _topBalance:   0,
          };
        }
        map[vid].total_pending += b.balance;
        map[vid].max_days = Math.max(map[vid].max_days, b.days_since);
        map[vid].bills.push(b);
        if (b.balance > map[vid]._topBalance) {
          map[vid].category     = b.category;
          map[vid].sub_category = b.sub_category;
          map[vid]._topBalance  = b.balance;
        }
      }
      return Object.values(map).map(v => { delete v._topBalance; return v; });
    }

    const overdue_vendors  = groupVendors(enriched.filter(b => b.days_since >= 45)).sort((a, b) => b.total_pending - a.total_pending);
    const due_soon_vendors = groupVendors(enriched.filter(b => b.days_since >= 38 && b.days_since < 45)).sort((a, b) => b.max_days - a.max_days);

    for (const v of [...overdue_vendors, ...due_soon_vendors]) {
      v.bills.sort((a, b) => b.days_since - a.days_since);
    }

    // Vendor list for the Vendors tab: every MSME-registered vendor found in bills — Micro, Small and
    // Medium — with its Enterprise Type and Udyam number as held from Zoho. Display only: the 45-day
    // tracking above still uses msmeMap (Micro/Small + vendor_master stubs) unchanged.
    const msme_vendors = Object.values(msmeMap).map(v => {
      const c = rawCM[v.vendor_id];
      return c?.vendor_name ? { ...v, vendor_name: c.vendor_name, msme_type: c.msme_type || v.msme_type, udyam_number: c.udyam_reg_no || v.udyam_number } : v;
    });
    for (const [cid, c] of Object.entries(rawCM)) {
      if (!msmeMap[cid] && billVendorIds.includes(cid) && c.vendor_name && /medium/i.test(c.msme_type || '')) {
        msme_vendors.push({ vendor_id: cid, vendor_name: c.vendor_name, msme_type: c.msme_type, udyam_number: c.udyam_reg_no || '', vm_confirmed: c.vm_confirmed });
      }
    }

    const result = {
      total_msme,
      msme_vendors,
      overdue_vendors,
      due_soon_vendors,
      total_overdue_amount:  overdue_vendors.reduce( (s, v) => s + v.total_pending, 0),
      total_due_soon_amount: due_soon_vendors.reduce((s, v) => s + v.total_pending, 0),
    };
    cache.set(cacheKey, result, 300);
    res.json(result);
  } catch (e) {
    console.error('msme-report', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── MSME Interest Report ─────────────────────────────────────────────────────
const MSME_IR_DATA_FILE = path.join(__dirname, 'msme_interest_data.json');

async function readMsmeIR() {
  const def = {
    settings: { bank_rate: 0.055, multiplier: 3, credit_period_agreement: 45, credit_period_no_agreement: 15 },
    vendor_master: {}, frozen_quarters: {}, audit_trail: [],
  };
  const d = await db.readJSON('msme_interest_data', MSME_IR_DATA_FILE, def);
  return { ...def, ...d, settings: { ...def.settings, ...(d?.settings || {}) } };
}
async function writeMsmeIR(d) { await db.writeJSON('msme_interest_data', MSME_IR_DATA_FILE, d); }

// ── MSME Persistent Cache Helpers ─────────────────────────────────────────────
// These two caches together eliminate all repeated Zoho contact API calls.
//
// 1. Contact map (msme_contact_map) — vendor_id → MSME fields
//    TTL: 4h (matches sync schedule). Survives server restarts.
//    Fetches only MISSING vendor IDs on each request — amortises over time.
//
// 2. Quarter result (msme_qr_{fy}_{q}) — fully computed quarter result
//    Keyed to bills_sync_hash (open+overdue timestamps).
//    Invalidated automatically when bills_open/overdue sync runs.
//    Survives server restarts and browser hard-refreshes.

const _MSME_CM_KEY   = 'msme_contact_map';
const _MSME_CM_FILE  = path.join(__dirname, 'sync_data', 'msme_contact_map.json');
// Safety-net TTL; the map is kept current by the incremental post-sync refresh
// (resyncMsmeVendorMaster), which re-reads only vendors whose Zoho last_modified_time changed.
const _MSME_CM_TTL_H = 24;

function _ensureSyncDir2() {
  const dir = path.join(__dirname, 'sync_data');
  // Optional on Vercel: its disk is read-only and these caches live in Neon there
  try { if (!require('fs').existsSync(dir)) require('fs').mkdirSync(dir, { recursive: true }); } catch (_) {}
}

// Returns { data, fetched_at } when the map is within TTL, else null
// non_msme: { vendor_id: zoho last_modified_time } for bill vendors checked and found not MSME,
// so they are not re-fetched from Zoho on every request.
// The TTL runs from checked_at (last time the vendor sync confirmed the map against Zoho), not
// fetched_at (last change): a day without MSME edits must not trigger a re-read of every vendor.
async function readMsmeCMMeta({ ignoreTTL = false } = {}) {
  const c = await db.readJSON(_MSME_CM_KEY, _MSME_CM_FILE, null);
  if (c && c.data && (ignoreTTL || syncEngine.isFresh(c.checked_at || c.fetched_at, _MSME_CM_TTL_H))) {
    return { data: c.data, non_msme: c.non_msme || {}, fetched_at: c.fetched_at };
  }
  return null;
}

async function readMsmeCM() {
  return (await readMsmeCMMeta())?.data || null;
}

// fetchedAt: pass the existing timestamp when topping up a still-fresh map so partial
// writes don't extend the TTL (otherwise vendor fields changed in Zoho are never re-read).
async function writeMsmeCM(data, fetchedAt, nonMsme = {}) {
  _ensureSyncDir2();
  // Never persist empty stubs (vendor_name='') — only write entries confirmed from Zoho.
  // A missing entry is always re-fetched; an empty stub silently blocks re-fetching.
  const persistable = {};
  for (const [k, v] of Object.entries(data)) {
    if (v && v.vendor_name) persistable[k] = v;
  }
  const stamp = fetchedAt || new Date().toISOString();
  await db.writeJSON(_MSME_CM_KEY, _MSME_CM_FILE, { data: persistable, non_msme: nonMsme, fetched_at: stamp, checked_at: new Date().toISOString() });
  return stamp;
}

// The vendor sync found the map current: restart the TTL, keep fetched_at (quarter results stay valid)
async function markMsmeCMChecked() {
  const c = await db.readJSON(_MSME_CM_KEY, _MSME_CM_FILE, null);
  if (!c?.data) return;
  c.checked_at = new Date().toISOString();
  await db.writeJSON(_MSME_CM_KEY, _MSME_CM_FILE, c);
}

// One vendor's MSME classification changed on the dashboard side (vendor_master edit): drop only
// that vendor so the next report reads it again from Zoho — every other vendor stays cached.
async function forgetMsmeCMVendor(vid) {
  const c = await db.readJSON(_MSME_CM_KEY, _MSME_CM_FILE, null);
  if (!c?.data) return;
  delete c.data[vid];
  if (c.non_msme) delete c.non_msme[vid];
  c.fetched_at = new Date().toISOString();
  await db.writeJSON(_MSME_CM_KEY, _MSME_CM_FILE, c);
}

// Load vendor MSME details for the given vendor IDs: one Zoho /contacts/{id} call per
// unique vendor (never per bill), only for IDs missing/stale in the persistent map.
// Returns { map, fetched_at }. `cmMeta` = result of readMsmeCMMeta() if already read.
async function loadMsmeContactMap(billVids, vmVids, cmMeta) {
  if (cmMeta === undefined) cmMeta = await readMsmeCMMeta();
  const map = cmMeta?.data || {};
  const nonMsme = cmMeta?.non_msme || {};
  const vmSet = new Set(vmVids);
  const allVids = [...new Set([...billVids, ...vmVids])];
  const missing = allVids.filter(v => msmeCMNeedsFetch(map[v]) && (!(v in nonMsme) || vmSet.has(v)));
  let fetchedAt = cmMeta?.fetched_at;

  if (missing.length > 0) {
    const BATCH = 10;
    let fetched = 0, withSector = 0, unrecognized = 0, failed = 0;
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(vid => zohoGet(`/contacts/${vid}`).then(r => r.contact || null).catch(() => null))
      );
      for (const c of results) {
        if (!c) { failed++; continue; }
        fetched++;
        const isVm = vmSet.has(c.contact_id);
        if (!c.msme_type?.trim() && !isVm) { nonMsme[c.contact_id] = c.last_modified_time || ''; delete map[c.contact_id]; continue; }
        delete nonMsme[c.contact_id];
        const entry = buildMsmeCMEntry(c, isVm);
        map[c.contact_id] = entry;
        if (entry.major_activity_zoho) withSector++;
        if (entry.msme_sector_unrecognized) {
          unrecognized++;
          console.warn(`[msme-cm] Unrecognised MSME Sector "${entry.msme_sector_raw}" for ${entry.vendor_name} (${c.contact_id}) — preserved, flagged for review`);
        }
      }
      if (i + BATCH < missing.length) await new Promise(r => setTimeout(r, 50));
    }
    for (const vid of vmVids) {
      if (!map[vid]) map[vid] = { msme_type: '', vendor_name: '', major_activity_zoho: null, vm_confirmed: true, udyam_reg_no: '', cf_pan: '' };
      else map[vid].vm_confirmed = true;
    }
    fetchedAt = await writeMsmeCM(map, fetchedAt, nonMsme);
    console.log(`[msme-cm] Fetched ${fetched}/${missing.length} vendor contacts (${failed} failed); MSME vendors with MSME Sector: ${withSector}, unrecognised: ${unrecognized}`);
  } else {
    for (const vid of vmVids) {
      if (!map[vid]) map[vid] = { msme_type: '', vendor_name: '', major_activity_zoho: null, vm_confirmed: true, udyam_reg_no: '', cf_pan: '' };
      else map[vid].vm_confirmed = true;
    }
  }
  return { map, fetched_at: fetchedAt || 'none' };
}

function _msmeQRKey(fy, q)  { return `msme_qr_${fy}_${q}`; }
function _msmeQRFile(fy, q) {
  _ensureSyncDir2();
  return path.join(__dirname, 'sync_data', `msme_qr_${fy.replace(/[^a-z0-9]/gi, '_')}_${q}.json`);
}

async function readMsmeQR(fy, q, billsSyncHash) {
  const p = await db.readJSON(_msmeQRKey(fy, q), _msmeQRFile(fy, q), null);
  if (p && p.bills_sync_hash === billsSyncHash && p.result) return p.result;
  return null;
}

async function writeMsmeQR(fy, q, result, billsSyncHash) {
  await db.writeJSON(_msmeQRKey(fy, q), _msmeQRFile(fy, q), { result, bills_sync_hash: billsSyncHash });
}

async function invalidateMsmeQR() {
  const fys = ['2024-25', '2025-26', '2026-27', '2027-28'];
  const qs  = ['Q1', 'Q2', 'Q3', 'Q4'];
  for (const fy of fys) {
    for (const q of qs) {
      try { await db.writeJSON(_msmeQRKey(fy, q), _msmeQRFile(fy, q), { result: null, bills_sync_hash: 'INVALIDATED' }); } catch (_) {}
    }
  }
}

function msmeIRQuarterDates(fy, q) {
  const y = parseInt((fy || '2026-27').split('-')[0], 10);
  const map = {
    Q1: { start: `${y}-04-01`,   end: `${y}-06-30` },
    Q2: { start: `${y}-07-01`,   end: `${y}-09-30` },
    Q3: { start: `${y}-10-01`,   end: `${y}-12-31` },
    Q4: { start: `${y+1}-01-01`, end: `${y+1}-03-31` },
  };
  return map[q] || null;
}

function msmeNormAct(val) {
  if (!val) return null;
  const v = String(val).trim().toLowerCase();
  if (/manufactur|menufactur/.test(v)) return 'Manufacturing';
  if (/service/.test(v))               return 'Services';
  if (/trading|trade/.test(v))         return 'Trading';
  return String(val).trim();
}

// ── Zoho Vendor custom field "MSME Sector" → Major Activity ──────────────────
// Verified against live Zoho response (contacts/{id}.custom_fields[]):
//   { customfield_id: '1714732000062008039', api_name: 'cf_msme_sector', label: 'MSME Sector',
//     data_type: 'dropdown', value: 'Services' | 'Trader' | 'Manufacturing' }
// Also mirrored at top level as contact.cf_msme_sector. NOT returned by the /contacts list API.
const MSME_SECTOR_CF_ID       = '1714732000062008039';
const MSME_SECTOR_CF_API_NAME = 'cf_msme_sector';
const MSME_SECTOR_ALIASES = {
  manufacturing: 'Manufacturing', manufacturer: 'Manufacturing',
  services: 'Services', service: 'Services',
  trading: 'Trading', trader: 'Trading', trade: 'Trading',
};
// Bump when the contact-map entry shape changes — entries with an older version are re-fetched.
const MSME_CM_SCHEMA = 2;

function extractMsmeSector(contact) {
  const cfs = Array.isArray(contact?.custom_fields) ? contact.custom_fields : [];
  const field = cfs.find(f => String(f.customfield_id || f.field_id || '') === MSME_SECTOR_CF_ID)
             || cfs.find(f => f.api_name === MSME_SECTOR_CF_API_NAME)
             || cfs.find(f => (f.label || '').trim().toLowerCase() === 'msme sector');
  let raw = field ? (field.value_formatted ?? field.value) : undefined;
  if ((raw == null || raw === '') && contact?.[MSME_SECTOR_CF_API_NAME]) raw = contact[MSME_SECTOR_CF_API_NAME];
  raw = raw == null ? '' : String(raw).trim();
  const known = MSME_SECTOR_ALIASES[raw.toLowerCase()];
  return {
    cf_found:   !!field,
    raw:        raw || null,
    normalized: raw ? (known || raw) : null,   // unknown values preserved as-is
    unrecognized: !!raw && !known,             // flagged for review
  };
}

function buildMsmeCMEntry(c, isVm) {
  const sector = extractMsmeSector(c);
  return {
    _v: MSME_CM_SCHEMA,
    msme_type:    (c.msme_type || '').trim(),
    vendor_name:  c.contact_name,
    major_activity_zoho:  sector.normalized,
    msme_sector_raw:      sector.raw,
    msme_sector_cf_found: sector.cf_found,
    msme_sector_unrecognized: sector.unrecognized,
    vm_confirmed: isVm,
    udyam_reg_no: (c.udyam_reg_no || '').trim(),
    cf_pan: c.cf_pan || c.cf_PAN || '',
    zoho_last_modified: c.last_modified_time || null,
  };
}

// Contact-map entry needs (re)fetching from Zoho: absent, failed stub, or older schema
function msmeCMNeedsFetch(entry) {
  return !entry || !entry.vendor_name || entry._v !== MSME_CM_SCHEMA;
}

function msmeIntApplicable(enterpriseType, majorAct) {
  const a = (majorAct || '').toLowerCase().trim();
  const e = (enterpriseType || '').toLowerCase().trim();
  if (a === 'trading') return false;
  if (e.includes('medium')) return false;
  if (!a || !e) return null;
  if (a !== 'manufacturing' && a !== 'services') return null; // unrecognised activity → review, no auto-interest
  return true;
}

function computeQuarterBills(allBills, msmeMap, vendorMaster, regByZohoId, quarterCloseDate, settings) {
  const qcDate       = new Date(quarterCloseDate);
  const simpleRate   = settings.bank_rate * settings.multiplier;
  const effectiveRate = Math.pow(1 + simpleRate / 12, 12) - 1;
  const defaultCredit = settings.credit_period_agreement || 45;

  return allBills
    .filter(b => {
      if (!b.date) return false;
      const msme = msmeMap[b.vendor_id];
      if (!msme) return false;
      // Exclude explicitly Medium enterprises; all others (including blank type on vm_confirmed vendors) pass
      const t = (msme.msme_type || '').toLowerCase();
      if (t.includes('medium')) return false;
      return new Date(b.date) <= qcDate && (b.balance || 0) > 0;
    })
    .map(bill => {
      const vid  = bill.vendor_id;
      const msme = msmeMap[vid] || {};
      const enterpriseType = msme.msme_type || null;

      // 1. Zoho Books Vendor custom field "MSME Sector" (authoritative)
      let majorActivity = msme.major_activity_zoho || null;
      let majorActivitySource = majorActivity ? 'zoho' : null;
      // 2. Manual override — only used when Zoho MSME Sector is blank
      if (!majorActivity && vendorMaster[vid]?.major_activity) {
        majorActivity = vendorMaster[vid].major_activity;
        majorActivitySource = 'manual';
      }
      // 3. Vendor registration form data
      if (!majorActivity) {
        const rd = regByZohoId[vid];
        if (rd?.msmeSector) { majorActivity = msmeNormAct(rd.msmeSector); majorActivitySource = 'vendor_reg'; }
      }
      const creditDays  = vendorMaster[vid]?.credit_period || defaultCredit;
      const pd          = new Date(bill.date);
      const ageingDays  = Math.max(0, Math.floor((qcDate - pd) / 86400000));
      const interestDays = Math.max(0, ageingDays - creditDays);
      const maxDays     = Math.min(interestDays, 365);
      const balanceDue  = bill.balance || 0;
      const billAmount  = bill.total   || 0;
      const amountPaid  = billAmount - balanceDue;
      const rate        = interestDays > 365 ? effectiveRate : simpleRate;
      const applicable  = msmeIntApplicable(enterpriseType, majorActivity);
      const interestAmt = applicable === true && interestDays > 0 ? balanceDue * rate * maxDays / 365 : 0;
      const itrDisallow = interestAmt > 0 ? balanceDue : 0;
      const exceptions  = [];
      if (!enterpriseType) exceptions.push('enterprise_type_missing');
      if (!majorActivity)  exceptions.push('major_activity_missing');
      else if (majorActivitySource === 'zoho' && msme.msme_sector_unrecognized) exceptions.push('major_activity_unrecognized');

      return {
        bill_id: bill.bill_id, bill_number: bill.bill_number || '',
        date: bill.date, posting_date: bill.date,
        vendor_id: vid, vendor_name: bill.vendor_name || msme.vendor_name || '',
        enterprise_type: enterpriseType, major_activity: majorActivity, major_activity_source: majorActivitySource,
        status: bill.status || '',
        bill_amount: billAmount, balance_due: balanceDue, amount_paid: amountPaid,
        ageing_days: ageingDays, interest_days: interestDays, max_days: maxDays,
        applicable_rate: rate, interest_amount: interestAmt, itr_disallowed: itrDisallow,
        msme_applicable: applicable, credit_days_used: creditDays, exceptions,
      };
    });
}

function buildMsmeIRSummary(bills) {
  const applicable = bills.filter(b => b.msme_applicable === true && b.interest_days > 0);
  return {
    total_msme_bills:     bills.length,
    total_bill_amount:    bills.reduce((s, b) => s + b.bill_amount, 0),
    total_outstanding:    bills.reduce((s, b) => s + b.balance_due, 0),
    total_overdue_amount: applicable.reduce((s, b) => s + b.balance_due, 0),
    total_interest:       bills.reduce((s, b) => s + b.interest_amount, 0),
    total_itr_disallowed: bills.reduce((s, b) => s + b.itr_disallowed, 0),
    applicable_vendors:   new Set(applicable.map(b => b.vendor_id)).size,
    overdue_bills:        applicable.length,
    exceptions_count:     bills.filter(b => b.exceptions.length > 0).length,
  };
}

app.get('/api/msme-interest/settings', authMiddleware, async (req, res) => {
  try {
    const d = await readMsmeIR();
    const s = d.settings;
    res.json({ ...s, simple_rate: s.bank_rate * s.multiplier, effective_rate: Math.pow(1 + s.bank_rate * s.multiplier / 12, 12) - 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/msme-interest/settings', authMiddleware, adminOnly, async (req, res) => {
  try {
    const d = await readMsmeIR();
    const user = req.user?.username || req.user?.name || 'admin';
    const { bank_rate, multiplier, credit_period_agreement, credit_period_no_agreement } = req.body;
    const prev = { ...d.settings };
    if (bank_rate != null)                  d.settings.bank_rate = parseFloat(bank_rate);
    if (multiplier != null)                 d.settings.multiplier = parseFloat(multiplier);
    if (credit_period_agreement != null)    d.settings.credit_period_agreement = parseInt(credit_period_agreement, 10);
    if (credit_period_no_agreement != null) d.settings.credit_period_no_agreement = parseInt(credit_period_no_agreement, 10);
    d.settings.updated_at = new Date().toISOString();
    d.settings.updated_by = user;
    d.audit_trail = (d.audit_trail || []).concat({ action: 'settings_update', user, timestamp: d.settings.updated_at, prev, next: { ...d.settings } });
    await writeMsmeIR(d);
    cache.keys().filter(k => k.startsWith('msme-ir-')).forEach(k => cache.del(k));
    // Settings affect interest calculation → invalidate all persistent quarter result caches
    background(invalidateMsmeQR().catch(() => {}));
    const s = d.settings;
    res.json({ ...s, simple_rate: s.bank_rate * s.multiplier, effective_rate: Math.pow(1 + s.bank_rate * s.multiplier / 12, 12) - 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/msme-interest/vendor-master', authMiddleware, async (req, res) => {
  try {
    const d = await readMsmeIR();
    res.json(d.vendor_master || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/msme-interest/vendor-master/:vid', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { vid } = req.params;
    const { major_activity, credit_period } = req.body;
    const d = await readMsmeIR();
    const user = req.user?.username || req.user?.name || 'admin';
    const prev = d.vendor_master[vid];
    d.vendor_master[vid] = {
      ...(d.vendor_master[vid] || {}),
      ...(major_activity != null ? { major_activity: msmeNormAct(major_activity) } : {}),
      ...(credit_period  != null ? { credit_period: parseInt(credit_period, 10) }  : {}),
    };
    d.audit_trail = (d.audit_trail || []).concat({ action: 'vendor_master_update', vendor_id: vid, user, timestamp: new Date().toISOString(), prev, next: d.vendor_master[vid] });
    await writeMsmeIR(d);
    cache.keys().filter(k => k.startsWith('msme-ir-')).forEach(k => cache.del(k));
    // vendor_master change affects this vendor's MSME classification → re-read only this vendor
    // from Zoho (not the whole contact map) + recompute all quarter results. Awaited so the page's
    // reload right after this response can't write the old entry back.
    await forgetMsmeCMVendor(vid).catch(() => {});
    background(invalidateMsmeQR().catch(() => {}));
    res.json({ ok: true, vid, data: d.vendor_master[vid] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/msme-interest/quarter', authMiddleware, async (req, res) => {
  const { fy = '2026-27', q = 'Q1' } = req.query;
  try {
    const d = await readMsmeIR();
    const frozenKey = `${fy}:${q}`;
    if (d.frozen_quarters?.[frozenKey]) {
      return res.json({ fy, quarter: q, status: 'frozen', ...d.frozen_quarters[frozenKey] });
    }
    const cacheKey = `msme-ir-${fy}-${q}`;
    const hit = cache.get(cacheKey);
    if (hit) return res.json(hit);

    const qDates = msmeIRQuarterDates(fy, q);
    if (!qDates) return res.status(400).json({ error: 'Invalid FY or quarter' });

    const [openResult2, overdueResult2] = await Promise.all([
      syncEngine.getSyncedOrFetch('bills_open',    () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Open' },    {})),
      syncEngine.getSyncedOrFetch('bills_overdue', () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Overdue' }, {})),
    ]);
    const billMap = {};
    for (const b of [...openResult2.data, ...overdueResult2.data]) billMap[b.bill_id] = b;
    const allBills = Object.values(billMap);

    // ── Layer 1: Persistent quarter result cache ───────────────────────────────
    // Keyed to bills sync timestamps AND the vendor contact map timestamp, so a
    // re-sync of either bills or Vendor Master (e.g. MSME Sector changed) recomputes.
    const cmMeta = await readMsmeCMMeta();
    const billsHashBase = `${openResult2.synced_at || 'live'}|${overdueResult2.synced_at || 'live'}`;
    if (cmMeta) {
      const cachedQR = await readMsmeQR(fy, q, `${billsHashBase}|cm:${cmMeta.fetched_at}`);
      if (cachedQR) {
        cache.set(cacheKey, cachedQR, 60);
        return res.json(cachedQR);
      }
    }

    // Collect vendor IDs: outstanding bill vendors + vendor_master (admin-confirmed MSME vendors)
    const vmVids = Object.keys(d.vendor_master || {});
    const billVids = [...new Set(allBills.map(b => b.vendor_id).filter(Boolean))];

    // ── Layer 2: Persistent contact map cache (4h TTL) ─────────────────────────
    const { map: msmeMap, fetched_at: cmStamp } = await loadMsmeContactMap(billVids, vmVids, cmMeta);
    const billsSyncHash = `${billsHashBase}|cm:${cmStamp}`;

    let vendorRegs = [];
    try { vendorRegs = (await readVendorRegs()) || []; } catch (_) {}
    const regByZohoId = {};
    for (const vr of vendorRegs) {
      if (vr.zohoContactId && vr.data) regByZohoId[vr.zohoContactId] = vr.data;
    }

    const bills   = computeQuarterBills(allBills, msmeMap, d.vendor_master || {}, regByZohoId, qDates.end, d.settings);
    const summary = buildMsmeIRSummary(bills);
    const s = d.settings;
    const simpleRate   = s.bank_rate * s.multiplier;
    const effectiveRate = Math.pow(1 + simpleRate / 12, 12) - 1;

    const result = {
      fy, quarter: q, status: 'live',
      quarter_close_date: qDates.end, quarter_start_date: qDates.start,
      bills, summary,
      rate_settings: { bank_rate: s.bank_rate, multiplier: s.multiplier, simple_rate: simpleRate, effective_rate: effectiveRate, credit_days: s.credit_period_agreement || 45 },
      last_synced: new Date().toISOString(),
      _data_source: openResult2.source,
    };
    // Persist quarter result — survives server restarts, keyed to bills sync hash
    await writeMsmeQR(fy, q, result, billsSyncHash);
    cache.set(cacheKey, result, 60);
    res.json(result);
  } catch (e) {
    console.error('msme-interest-quarter:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── MSME Vendor Master re-sync (MSME Sector → Major Activity) ─────────────────
// Discards the contact map and re-reads every MSME-relevant vendor from Zoho
// (vendors on open/overdue bills + vendor_master). Frozen quarters are served from
// their snapshot and are never touched. Runs after every sync-engine syncAll.
async function resyncMsmeVendorMaster(trigger = 'manual', { full = false } = {}) {
  const [openR, overdueR] = await Promise.all([
    syncEngine.getSyncedOrFetch('bills_open',    () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Open' },    {})),
    syncEngine.getSyncedOrFetch('bills_overdue', () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Overdue' }, {})),
  ]);
  const billVids = [...new Set([...openR.data, ...overdueR.data].map(b => b.vendor_id).filter(Boolean))];
  const d = await readMsmeIR();
  const vmVids = Object.keys(d.vendor_master || {});
  let base = null, changed = null;
  if (!full) {
    // Incremental: vendor list (~16 paged calls) gives last_modified_time for every vendor;
    // re-read contact details only for vendors edited in Zoho since they were cached.
    const prev = await readMsmeCMMeta({ ignoreTTL: true });
    if (prev) {
      // Vendors — All (stage-1 sync entity) already holds every vendor's last_modified_time;
      // fall back to the Zoho vendor list only if that cache is missing.
      const vc = await syncEngine.readSyncedData('vendors_all').catch(() => null);
      const vendors = vc?.data?.length ? vc.data : await zohoGetAll('/contacts', 'contacts', { contact_type: 'vendor' }, {});
      const lmt = {};
      for (const v of vendors) lmt[v.contact_id] = v.last_modified_time || '';
      const data = { ...prev.data }, nonMsme = { ...prev.non_msme };
      changed = 0;
      for (const [vid, e] of Object.entries(data)) {
        if (!e || e.zoho_last_modified == null || lmt[vid] !== e.zoho_last_modified) { delete data[vid]; changed++; }
      }
      for (const [vid, t] of Object.entries(nonMsme)) {
        if (!t || lmt[vid] !== t) { delete nonMsme[vid]; changed++; }
      }
      // Keep the stamp when nothing changed so quarter-result caches stay valid
      base = { data, non_msme: nonMsme, fetched_at: changed ? undefined : prev.fetched_at };
    }
  }
  const { map, fetched_at } = await loadMsmeContactMap(billVids, vmVids, base);
  await markMsmeCMChecked();
  cache.keys().filter(k => k.startsWith('msme-ir-') || k === 'pur-msme-report').forEach(k => cache.del(k));
  const entries = Object.values(map).filter(e => e.vendor_name);
  const summary = {
    trigger, mode: base ? 'incremental' : 'full', changed_in_zoho: changed, fetched_at,
    msme_vendors: entries.length,
    with_msme_sector: entries.filter(e => e.major_activity_zoho).length,
    blank_msme_sector: entries.filter(e => !e.major_activity_zoho).length,
    // Zoho has an MSME Sector value but the cache holds none (target: 0)
    sector_in_zoho_but_blank: entries.filter(e => e.msme_sector_raw && !e.major_activity_zoho && !e.msme_sector_unrecognized).length,
    unrecognised: entries.filter(e => e.msme_sector_unrecognized).map(e => ({ vendor_name: e.vendor_name, value: e.msme_sector_raw })),
  };
  console.log(`[msme-cm] Vendor Master re-sync (${trigger}): ${summary.msme_vendors} MSME vendors, ${summary.with_msme_sector} with MSME Sector, ${summary.blank_msme_sector} blank`);
  return summary;
}

// Registered as the stage-4 sync entity "Vendor MSME Master" — runs after Vendors — All and
// Bills — Open/Overdue so Major Activity follows Zoho's MSME Sector without re-downloading bills.
// Normal/Recheck: incremental (only vendors whose Zoho last_modified_time changed).
// Full Sync / Full Refresh / first sync: every MSME-relevant vendor re-read from Zoho.
// Frozen MSME quarters and Form-1 halves are snapshots and are never modified.
syncEngine.registerEntity('vendor_msme_master', {
  label: 'Vendor MSME Master', stage: 4, kind: 'derived',
  path: '/contacts/{id}',
  description: 'MSME vendors: MSME Sector → Major Activity, Enterprise Type, Udyam no. Keyed by vendor ID.',
  run: async ({ mode, trigger, isInitial, ctx }) => {
    const full = isInitial || mode === 'full' || mode === 'full_refresh';
    const before = (await readMsmeCMMeta({ ignoreTTL: true }))?.data || {};
    const s = await resyncMsmeVendorMaster(trigger, { full });
    ctx.fetched = s.msme_vendors;
    // Real diff of the MSME fields per vendor ID (before vs after this sync)
    const after = (await readMsmeCMMeta({ ignoreTTL: true }))?.data || {};
    const sig = e => [e.msme_type, e.major_activity_zoho, e.msme_sector_raw, e.udyam_reg_no, e.vendor_name].join('|');
    const live = o => Object.entries(o).filter(([, e]) => e && e.vendor_name);
    const bMap = new Map(live(before)), aMap = new Map(live(after));
    let added = 0, updated = 0, removed = 0;
    for (const [vid, e] of aMap) { const p = bMap.get(vid); if (!p) added++; else if (sig(p) !== sig(e)) updated++; }
    for (const vid of bMap.keys()) if (!aMap.has(vid)) removed++;
    const extra = {
      mode: s.mode, msme_vendors: s.msme_vendors, with_msme_sector: s.with_msme_sector,
      blank_msme_sector: s.blank_msme_sector, unrecognised: s.unrecognised,
      sector_in_zoho_but_blank: s.sector_in_zoho_but_blank,
    };
    return {
      record_count: s.msme_vendors,
      strategy: s.mode,
      stats: {
        checked: s.mode === 'full' ? s.msme_vendors : (s.changed_in_zoho || 0),
        added, updated, removed,
        unchanged: Math.max(0, s.msme_vendors - added - updated),
      },
      extra,
    };
  },
});

app.post('/api/msme-interest/resync-vendors', authMiddleware, adminOnly, async (req, res) => {
  try { res.json(await resyncMsmeVendorMaster('manual', { full: req.query.full !== '0' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnostics / reconciliation: traces MSME Sector through every layer per vendor
//   Zoho API (live) → custom-field extraction → local contact map → dashboard Major Activity
// GET /api/msme-interest/major-activity-diagnostics?fy=2026-27&q=Q2[&vendor_id=...]
app.get('/api/msme-interest/major-activity-diagnostics', authMiddleware, adminOnly, async (req, res) => {
  const { fy = '2026-27', q = 'Q2', vendor_id } = req.query;
  try {
    const d = await readMsmeIR();
    const frozen = d.frozen_quarters?.[`${fy}:${q}`];
    const cm = (await readMsmeCM()) || {};
    let dashBills;
    if (frozen) {
      dashBills = frozen.bills || [];
    } else {
      const qDates = msmeIRQuarterDates(fy, q);
      if (!qDates) return res.status(400).json({ error: 'Invalid FY or quarter' });
      const [openR, overdueR] = await Promise.all([
        syncEngine.getSyncedOrFetch('bills_open',    () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Open' },    {})),
        syncEngine.getSyncedOrFetch('bills_overdue', () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Overdue' }, {})),
      ]);
      const billMap = {};
      for (const b of [...openR.data, ...overdueR.data]) billMap[b.bill_id] = b;
      let vendorRegs = [];
      try { vendorRegs = (await readVendorRegs()) || []; } catch (_) {}
      const regByZohoId = {};
      for (const vr of vendorRegs) if (vr.zohoContactId && vr.data) regByZohoId[vr.zohoContactId] = vr.data;
      dashBills = computeQuarterBills(Object.values(billMap), cm, d.vendor_master || {}, regByZohoId, qDates.end, d.settings);
    }
    const dashByVid = {};
    for (const b of dashBills) if (!dashByVid[b.vendor_id]) dashByVid[b.vendor_id] = b;

    const vids = vendor_id ? [vendor_id] : Object.keys(cm).filter(v => cm[v].vendor_name);
    const rows = [];
    for (let i = 0; i < vids.length; i += 10) {
      const batch = vids.slice(i, i + 10);
      const contacts = await Promise.all(batch.map(v => zohoGet(`/contacts/${v}`).then(r => r.contact || null).catch(() => null)));
      batch.forEach((vid, j) => {
        const c = contacts[j];
        const z = c ? extractMsmeSector(c) : null;
        const local = cm[vid];
        const dash = dashByVid[vid];
        const zohoVal = z?.normalized || null;
        const dashVal = dash ? (dash.major_activity || null) : undefined;
        rows.push({
          vendor_name: c?.contact_name || local?.vendor_name || '',
          vendor_id: vid,
          zoho_api_found: !!c,
          custom_fields_found: !!(c && Array.isArray(c.custom_fields) && c.custom_fields.length),
          msme_sector_cf_found: !!z?.cf_found,
          msme_sector_raw: z?.raw ?? null,
          msme_sector_normalized: zohoVal,
          saved_in_local_vendor_master: !!(local && local._v === MSME_CM_SCHEMA),
          local_value: local?.major_activity_zoho ?? null,
          in_quarter: !!dash,
          dashboard_major_activity: dashVal ?? null,
          dashboard_source: dash?.major_activity_source || null,
          manual_override: d.vendor_master?.[vid]?.major_activity || null,
          match: !dash ? null : (zohoVal ? zohoVal === dashVal : null),
        });
      });
      if (i + 10 < vids.length) await new Promise(r => setTimeout(r, 50));
    }
    const inQ = rows.filter(r => r.in_quarter);
    res.json({
      fy, quarter: q, status: frozen ? 'frozen' : 'live',
      reconciliation: {
        total_msme_vendors:            rows.length,
        fetched_from_zoho:             rows.filter(r => r.zoho_api_found).length,
        with_msme_sector_in_zoho:      rows.filter(r => r.msme_sector_normalized).length,
        blank_msme_sector_in_zoho:     rows.filter(r => r.zoho_api_found && !r.msme_sector_normalized).length,
        vendors_in_quarter:            inQ.length,
        zoho_has_sector_dashboard_blank: inQ.filter(r => r.msme_sector_normalized && !r.dashboard_major_activity).length,
        zoho_vs_dashboard_mismatch:    inQ.filter(r => r.msme_sector_normalized && r.dashboard_major_activity && r.match === false).length,
        without_valid_vendor_id:       rows.filter(r => !r.zoho_api_found).length,
        local_cache_stale_vs_zoho:     rows.filter(r => r.zoho_api_found && r.local_value !== r.msme_sector_normalized).length,
      },
      rows,
    });
  } catch (e) {
    console.error('msme-major-activity-diagnostics:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/msme-interest/freeze', authMiddleware, adminOnly, async (req, res) => {
  const { fy, quarter, frozen_by, quarter_data } = req.body;
  if (!fy || !quarter || !quarter_data) return res.status(400).json({ error: 'fy, quarter, and quarter_data required' });
  try {
    const d = await readMsmeIR();
    const frozenKey = `${fy}:${quarter}`;
    const user = frozen_by || req.user?.username || req.user?.name || 'admin';
    const now  = new Date().toISOString();
    d.frozen_quarters = d.frozen_quarters || {};
    d.frozen_quarters[frozenKey] = { ...quarter_data, status: 'frozen', frozen_at: now, frozen_by: user };
    d.audit_trail = (d.audit_trail || []).concat({ action: 'freeze_quarter', fy, quarter, user, timestamp: now, summary: quarter_data.summary });
    await writeMsmeIR(d);
    cache.del(`msme-ir-${fy}-${quarter}`);
    res.json({ ok: true, frozen_at: now, frozen_by: user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/msme-interest/unfreeze', authMiddleware, adminOnly, async (req, res) => {
  const { fy, quarter, reason, unfrozen_by } = req.body;
  if (!fy || !quarter) return res.status(400).json({ error: 'fy and quarter required' });
  try {
    const d = await readMsmeIR();
    const frozenKey = `${fy}:${quarter}`;
    if (!d.frozen_quarters?.[frozenKey]) return res.status(404).json({ error: 'Quarter not frozen' });
    const user = unfrozen_by || req.user?.username || req.user?.name || 'admin';
    const now  = new Date().toISOString();
    delete d.frozen_quarters[frozenKey];
    d.audit_trail = (d.audit_trail || []).concat({ action: 'unfreeze_quarter', fy, quarter, user, timestamp: now, reason: reason || '' });
    await writeMsmeIR(d);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/msme-interest/audit', authMiddleware, adminOnly, async (req, res) => {
  try {
    const d = await readMsmeIR();
    res.json((d.audit_trail || []).slice().reverse().slice(0, 100));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/msme-interest/export', authMiddleware, express.json({ limit: '10mb' }), async (req, res) => {
  const { fy, quarter, bills = [], summary = {}, quarter_close_date, status } = req.body;
  try {
    const rows = bills.map((b, i) => ({
      '#': i + 1,
      'Bill Date':               b.date,
      'Transaction Posting Date':b.posting_date,
      'Bill #':                  b.bill_number,
      'Vendor Name':             b.vendor_name,
      'Enterprise Type':         b.enterprise_type || '—',
      'Major Activity':          b.major_activity  || '—',
      'Status':                  b.status,
      'Bill Amount (₹)':         b.bill_amount,
      'Balance Due (₹)':         b.balance_due,
      'Amount Paid (₹)':         b.amount_paid,
      'Overdue / Ageing Days':   b.ageing_days,
      'Days for Interest Cal.':  b.interest_days,
      'Max Due Days':            b.max_days,
      'Applicable Rate (%)':     parseFloat(((b.applicable_rate || 0) * 100).toFixed(4)),
      'Interest Amount (₹)':     parseFloat(b.interest_amount.toFixed(2)),
      'Amount Disallowed in ITR (₹)': parseFloat(b.itr_disallowed.toFixed(2)),
      'MSME Applicable':         b.msme_applicable === true ? 'Yes' : b.msme_applicable === false ? 'No' : 'Unknown',
      'Exceptions':              (b.exceptions || []).join(', '),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), `${quarter} ${fy}`);
    if (summary) {
      const sumRows = [
        [`MSME Interest Report — ${quarter} ${fy}`],
        ['Quarter Close Date:', quarter_close_date], ['Status:', status], [],
        ['Metric', 'Value'],
        ['Total MSME Bills',        summary.total_msme_bills],
        ['Total Bill Amount (₹)',    (summary.total_bill_amount  || 0).toFixed(2)],
        ['Total Outstanding (₹)',    (summary.total_outstanding  || 0).toFixed(2)],
        ['Total Overdue Amount (₹)', (summary.total_overdue_amount || 0).toFixed(2)],
        ['Total MSME Interest (₹)',  (summary.total_interest     || 0).toFixed(2)],
        ['Total ITR Disallowed (₹)', (summary.total_itr_disallowed || 0).toFixed(2)],
        ['Applicable Vendors',       summary.applicable_vendors],
        ['Overdue Bills',            summary.overdue_bills],
        ['Bills with Exceptions',    summary.exceptions_count],
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sumRows), 'Summary');
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="MSME_Interest_${fy}_${quarter}.xlsx"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── MSME Form-1 Report ───────────────────────────────────────────────────────
// Half-yearly statutory filing under Section 22 of the MSMED Act.
// H1: Apr–Sep  |  H2: Oct–Mar (Indian FY)
// Covers ALL Micro + Small enterprises (Manufacturing, Services, Trading).

const MSME_F1_DATA_FILE = path.join(__dirname, 'msme_form1_data.json');

async function readMsmeF1() {
  const def = { frozen_halves: {}, reasons: {}, audit_trail: [] };
  const d = await db.readJSON('msme_form1_data', MSME_F1_DATA_FILE, def);
  return { ...def, ...d };
}
async function writeMsmeF1(d) { await db.writeJSON('msme_form1_data', MSME_F1_DATA_FILE, d); }

function msmeF1HalfDates(fy, half) {
  const y = parseInt((fy || '2026-27').split('-')[0], 10);
  if (half === 'H1') return { start: `${y}-04-01`,   end: `${y}-09-30`,   label: `Apr–Sep ${y}` };
  if (half === 'H2') return { start: `${y}-10-01`,   end: `${y+1}-03-31`, label: `Oct ${y}–Mar ${y+1}` };
  return null;
}

// Micro or Small = eligible for Form-1. Medium = excluded.
// vm_confirmed = true means admin explicitly registered this vendor in the MSME Interest Report
// vendor_master; include them unless Zoho explicitly says they are Medium.
function isMseVendor(msme_type, vm_confirmed = false) {
  const t = (msme_type || '').toLowerCase().trim();
  if (t.includes('medium')) return false;
  if (t.includes('micro') || t.includes('small')) return true;
  // Admin-confirmed MSME vendor with unrecognised or blank Zoho msme_type — include it.
  return vm_confirmed === true;
}

function daysBetweenDates(d1Str, d2Str) {
  try {
    const d1 = new Date(d1Str), d2 = new Date(d2Str);
    const ms = Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate()) -
               Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate());
    return Math.max(0, Math.floor(ms / 86400000));
  } catch { return 0; }
}

// ── Form-1 source data ────────────────────────────────────────────────────────
// Zoho's /bills list never returns a payment date (last_payment_date is absent), so the
// half-year position is rebuilt from settlement transactions, all read from the central sync:
//   Vendors — All, Bills — FY All / Open / Overdue, Vendor Payments — FY, Vendor Credits — All,
//   Vendor MSME Master (msme_contact_map), and the stage-4 entity "MSME Form-1 Settlements"
//   (below), which adds what the list APIs lack: each payment's / credit's bill allocation,
//   older payments still holding an unapplied balance, and the MSE bill snapshot that is kept
//   after the FY window rolls over (H2 is filed in April).
const MSME_F1_SETTLE_KEY  = 'msme_form1_settlements';
const MSME_F1_SETTLE_FILE = path.join(__dirname, 'sync_data', 'msme_form1_settlements.json');
const MSME_F1_SETTLE_V    = 1;
const MSME_F1_SKIP        = new Set(['void', 'draft']);
const MSME_F1_EPS         = 0.005;
const MSME_F1_SOURCES     = ['bills_fy', 'bills_open', 'bills_overdue', 'vendor_payments_fy', 'vendor_credits_all', 'vendors_all'];
const f1r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const f1Inr = n => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function readMsmeF1Settle() {
  const s = await db.readJSON(MSME_F1_SETTLE_KEY, MSME_F1_SETTLE_FILE, null);
  return s && s.v === MSME_F1_SETTLE_V ? s : null;
}
async function writeMsmeF1Settle(s) {
  _ensureSyncDir2();
  s.updated_at = new Date().toISOString();
  await db.writeJSON(MSME_F1_SETTLE_KEY, MSME_F1_SETTLE_FILE, s);
}

async function msmeF1Central() {
  const got = await Promise.all(MSME_F1_SOURCES.map(k => syncEngine.readSyncedData(k).catch(() => null)));
  const c = Object.fromEntries(MSME_F1_SOURCES.map((k, i) => [k, got[i]]));
  const all = k => (c[k] ? [...(c[k].data || []), ...(c[k].future || [])] : []);
  return {
    billsFy: all('bills_fy'), billsOpen: all('bills_open'), billsOverdue: all('bills_overdue'),
    payments: all('vendor_payments_fy'), credits: all('vendor_credits_all'), vendors: c.vendors_all?.data || [],
    pay_window_from:  c.vendor_payments_fy?.window_from || null,
    bill_window_from: c.bills_fy?.window_from || null,
    synced_at: Object.fromEntries(MSME_F1_SOURCES.map(k => [k, c[k]?.synced_at || null])),
    missing: MSME_F1_SOURCES.filter(k => !c[k]),
  };
}
// Oldest sync time of the transaction caches (an overlay newer than this is still current)
function msmeF1CentralAt(central) {
  return Math.min(...MSME_F1_SOURCES.slice(0, 5).map(k => Date.parse(central.synced_at[k] || 0) || 0));
}

function msmeF1BillRec(b) {
  return {
    bill_id: b.bill_id, vendor_id: b.vendor_id, vendor_name: b.vendor_name || '',
    bill_number: b.bill_number || '', date: b.date || '', due_date: b.due_date || '',
    total: Number(b.total) || 0, balance: Number(b.balance) || 0, status: b.status || '',
    tds: Number(b.tds_total ?? b.tds_amount) || 0, // TDS deducted on the bill (list: tds_total, detail: tds_amount)
    lmt: b.last_modified_time || '',
  };
}
// /vendorpayments/{id}.bills[] → amount settled per bill (applied + TDS withheld on payment).
// Settlement is dated on the payment date, as the Zoho vendor statement shows it; apply_date
// (when an excess payment was later applied) is kept for reference only.
function msmeF1PayAlloc(p) {
  return (p.bills || []).map(b => ({
    bill_id: b.bill_id, bill_number: b.bill_number || '', bill_date: b.date || '',
    bill_total: Number(b.total) || 0, apply_date: b.apply_date || '',
    amount: (Number(b.amount_applied) || 0) + (Number(b.tax_amount_withheld) || 0),
  })).filter(a => a.bill_id && a.amount > MSME_F1_EPS);
}
// /vendorcredits/{id}.bills_credited[] → amount credited per bill (date = when applied)
function msmeF1CreditAlloc(c) {
  return (c.bills_credited || []).map(b => ({
    bill_id: b.bill_id, bill_number: b.bill_number || '', date: b.date || '',
    amount: Number(b.amount) || 0,
  })).filter(a => a.bill_id && a.amount > MSME_F1_EPS);
}
// /journals/{id} → the vendor's Accounts Payable lines. credit = payable (like a bill), debit =
// reduces the payable (like an advance). journal_credits = credits applied to this journal;
// bills_credited = this journal's debit applied to bills. null when no AP line for the vendor.
// Bump when the parsed journal record changes — stored records of an older version are re-read.
// v2: bills_credited amount is Zoho's `credited_amount` (v1 read a non-existent `amount` → 0).
const MSME_F1_JOURNAL_V = 2;
function msmeF1JournalRec(j, vid) {
  const ap = (j.line_items || []).filter(l => l.customer_id === vid && /^accounts payable$/i.test((l.account_name || '').trim()));
  if (!ap.length || MSME_F1_SKIP.has(j.status)) return null;
  const amt = l => Number(l.bcy_amount ?? l.amount) || 0;
  return {
    _v: MSME_F1_JOURNAL_V,
    journal_id: j.journal_id, entry_number: j.entry_number || '', date: j.journal_date || '', lmt: j.last_modified_time || '',
    credit: f1r2(ap.filter(l => l.debit_or_credit === 'credit').reduce((s, l) => s + amt(l), 0)),
    debit:  f1r2(ap.filter(l => l.debit_or_credit === 'debit').reduce((s, l) => s + amt(l), 0)),
    journal_credits: (j.journal_credits || []).map(c => ({ date: c.date || '', amount: Number(c.amount) || 0, ref: c.credit_number || c.payment_number || c.entry_number || '' })),
    bills_credited: (j.bills_credited || []).map(b => ({ bill_id: b.bill_id, amount: Number(b.credited_amount ?? b.amount) || 0 })),
  };
}

// Rate-limit / auth / daily-limit errors stop the run (progress is saved); others skip the record
function msmeF1Fatal(e) {
  const st = e?.response?.status;
  return st === 429 || st === 401 || /ZOHO_DAILY_LIMIT/.test(e?.message || '');
}
async function msmeF1PageAll(p, key, params) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const d = await rptZohoGet(p, { ...params, page, per_page: 200 });
    out.push(...(d[key] || []));
    if (!d.page_context?.has_more_page) return out;
  }
  throw new Error(`${p}: more than 50 pages — stopped instead of truncating`);
}

// A vendor is reported when its Zoho contact carries a Udyam registration number (udyam_reg_no)
// or an Enterprise Type (Micro / Small / Medium), or it is admin-confirmed in vendor_master.
// Medium enterprises are reported too and flagged on the row (notes.medium_enterprise).
function msmeF1UdyamNo(e) { return String(e?.udyam_reg_no || '').replace(/\s+/g, '').toUpperCase(); }
function msmeF1IsMse(e, isVm) {
  if (msmeF1UdyamNo(e)) return true;
  if (/micro|small|medium/.test((e?.msme_type || '').toLowerCase())) return true;
  return !!(e?.vm_confirmed || isVm);
}
function msmeF1MseSet(cm, vmSet) {
  const s = new Set();
  for (const [v, e] of Object.entries(cm)) if (msmeF1IsMse(e, vmSet.has(v))) s.add(v);
  for (const v of vmSet) if (!cm[v]) s.add(v);
  return s;
}

// Form-1 vendor register: Enterprise Type and Udyam number of every vendor with activity in the
// central caches. Zoho's vendor list carries neither field, so each vendor is read once from
// /contacts/{id} (same fields the Vendor MSME Master reads) and again only when its
// last_modified_time in Vendors — All changes. Kept in the Form-1 store: the shared Vendor MSME
// Master is rebuilt from open/overdue vendors only and must not decide who appears in Form-1.
function msmeF1VendorRec(e, c) {
  return {
    msme_type: e.msme_type || '', vendor_name: e.vendor_name || '',
    udyam_reg_no: (e.udyam_reg_no || c?.msme_reg_no || '').trim(),
    msme_sector_raw: e.msme_sector_raw || null, major_activity_zoho: e.major_activity_zoho || null,
    zoho_last_modified: e.zoho_last_modified || null,
  };
}
// Register entries win over the shared map (same Zoho fields, kept current by last_modified_time)
function msmeF1VendorView(store, cmData) {
  return { ...(cmData || {}), ...(store?.vendors || {}) };
}
async function msmeF1RefreshVendors(store, central, vids, vmSet, { force = false, onFetch } = {}) {
  store.vendors = store.vendors || {};
  const lmt = new Map(central.vendors.map(v => [v.contact_id, v.last_modified_time || '']));
  // Seed from the shared Vendor MSME Master where it holds the current Zoho version (no call)
  const cm = (await readMsmeCMMeta({ ignoreTTL: true }))?.data || {};
  for (const [vid, e] of Object.entries(cm)) {
    if (e?.vendor_name && e.zoho_last_modified && e.zoho_last_modified === lmt.get(vid) &&
        store.vendors[vid]?.zoho_last_modified !== e.zoho_last_modified) store.vendors[vid] = msmeF1VendorRec(e);
  }
  const need = [...new Set([...vids, ...vmSet])].filter(v => v &&
    (force || !store.vendors[v] || (lmt.has(v) && store.vendors[v].zoho_last_modified !== lmt.get(v))));
  let checked = 0, failed = 0;
  for (const vid of need) {
    let c = null;
    try { c = (await rptZohoGet(`/contacts/${vid}`)).contact || null; }
    catch (e) { if (msmeF1Fatal(e)) { store.vendor_register = { checked_at: new Date().toISOString(), pending: need.length - checked - failed }; throw e; } failed++; continue; }
    if (!c) { failed++; continue; }
    store.vendors[vid] = msmeF1VendorRec(buildMsmeCMEntry(c, vmSet.has(vid)), c);
    checked++;
    if (onFetch) await onFetch();
  }
  store.vendor_register = { checked_at: new Date().toISOString(), pending: need.length - checked, failed };
  return { checked, failed, pending: need.length - checked - failed, total: Object.keys(store.vendors).length };
}

// ── Sync entity: MSME Form-1 Settlements ──────────────────────────────────────
// Reads only what changed: payment / credit detail is re-fetched when Zoho's
// last_modified_time moves. Paced through the shared Zoho queue (rptZohoGet).
async function runMsmeF1Settlements({ mode = 'normal', isInitial = false, ctx = { fetched: 0 } } = {}) {
  const central = await msmeF1Central();
  if (central.missing.length) throw new Error(`Central sync data missing: ${central.missing.join(', ')}`);
  const full = isInitial || mode === 'full' || mode === 'full_refresh';
  const store = (await readMsmeF1Settle()) ||
    { v: MSME_F1_SETTLE_V, coverage_from: central.pay_window_from, payments: {}, credits: {}, prior: {}, bills: {}, overlay: {} };
  if (!store.coverage_from || central.pay_window_from < store.coverage_from) store.coverage_from = central.pay_window_from;
  store.overlay = store.overlay || {};
  const ir = await readMsmeIR();
  const vmSet = new Set(Object.keys(ir.vendor_master || {}));
  const stats = { checked: 0, added: 0, updated: 0, removed: 0, unchanged: 0, failed: 0 };
  let vs = null, mse = new Set(), sinceSave = 0, complete = false;
  const fetched = async () => {
    ctx.fetched++;
    if (ctx.prog) ctx.prog.fetched = ctx.fetched;
    if (++sinceSave >= 40) { sinceSave = 0; await writeMsmeF1Settle(store); }
  };

  try {
    // 1. Enterprise Type / Udyam number for every vendor with activity in the central caches
    const activity = [...central.billsFy, ...central.billsOpen, ...central.billsOverdue, ...central.payments, ...central.credits]
      .map(r => r.vendor_id);
    vs = await msmeF1RefreshVendors(store, central, activity, vmSet, { force: mode === 'full_refresh', onFetch: fetched });
    stats.failed += vs.failed;
    mse = msmeF1MseSet(msmeF1VendorView(store, (await readMsmeCMMeta({ ignoreTTL: true }))?.data), vmSet);

    // 2. Vendor payments (central FY window) → bill allocation
    const seenP = new Set();
    for (const p of central.payments) {
      if (!mse.has(p.vendor_id) || !p.payment_id) continue;
      seenP.add(p.payment_id);
      stats.checked++;
      const old = store.payments[p.payment_id];
      const lmt = p.last_modified_time || '';
      const rec = {
        vendor_id: p.vendor_id, payment_number: p.payment_number || '', date: p.date || '',
        amount: Number(p.amount) || 0, balance: Number(p.balance) || 0, lmt,
        alloc: old?.alloc ?? null, detail_lmt: old?.detail_lmt ?? null,
      };
      if (rec.amount - rec.balance <= MSME_F1_EPS) { rec.alloc = []; rec.detail_lmt = lmt; }
      else if (full || rec.detail_lmt !== lmt || !Array.isArray(rec.alloc)) {
        try {
          rec.alloc = msmeF1PayAlloc((await rptZohoGet(`/vendorpayments/${p.payment_id}`)).vendorpayment || {});
          rec.detail_lmt = lmt;
          store.payments[p.payment_id] = rec;
          await fetched();
        } catch (e) { if (msmeF1Fatal(e)) throw e; stats.failed++; }
      }
      if (!old) stats.added++;
      else if (old.lmt !== lmt || old.detail_lmt !== rec.detail_lmt) stats.updated++;
      else stats.unchanged++;
      store.payments[p.payment_id] = rec;
    }
    // Gone from the central window → deleted in Zoho. Older ones are kept for halves before it.
    for (const [id, r] of Object.entries(store.payments)) {
      if (seenP.has(id)) continue;
      if (!central.pay_window_from || r.date >= central.pay_window_from) { delete store.payments[id]; stats.removed++; }
    }

    // 3. Vendor credits (central, all time) → bills credited
    const seenC = new Set();
    for (const c of central.credits) {
      if (!mse.has(c.vendor_id) || !c.vendor_credit_id || MSME_F1_SKIP.has(c.status)) continue;
      seenC.add(c.vendor_credit_id);
      stats.checked++;
      const old = store.credits[c.vendor_credit_id];
      const lmt = c.last_modified_time || '';
      const rec = {
        vendor_id: c.vendor_id, number: c.vendor_credit_number || '', date: c.date || '',
        total: Number(c.total) || 0, balance: Number(c.balance) || 0, status: c.status || '', lmt,
        alloc: old?.alloc ?? null, detail_lmt: old?.detail_lmt ?? null,
        tds: old?.tds ?? null, tds_lmt: old?.tds_lmt ?? null, // TDS reversed by the debit note (detail only)
      };
      if (rec.total - rec.balance <= MSME_F1_EPS) { rec.alloc = []; rec.detail_lmt = lmt; }
      const needAlloc = rec.total - rec.balance > MSME_F1_EPS && (full || rec.detail_lmt !== lmt || !Array.isArray(rec.alloc));
      if (needAlloc || full || rec.tds_lmt !== lmt) {
        try {
          const vc = (await rptZohoGet(`/vendorcredits/${c.vendor_credit_id}`)).vendor_credit || {};
          if (needAlloc) { rec.alloc = msmeF1CreditAlloc(vc); rec.detail_lmt = lmt; }
          rec.tds = Number(vc.tds_amount) || 0; rec.tds_lmt = lmt;
          store.credits[c.vendor_credit_id] = rec;
          await fetched();
        } catch (e) { if (msmeF1Fatal(e)) throw e; stats.failed++; }
      }
      if (!old) stats.added++;
      else if (old.lmt !== lmt || old.detail_lmt !== rec.detail_lmt) stats.updated++;
      else stats.unchanged++;
      store.credits[c.vendor_credit_id] = rec;
    }
    for (const id of Object.keys(store.credits)) if (!seenC.has(id)) { delete store.credits[id]; stats.removed++; }

    // 4. Older payments still holding an unapplied balance (e.g. an advance carried into the FY).
    //    Re-read per vendor when any of its bills changed, or daily.
    const billLmt = {};
    for (const b of [...central.billsFy, ...central.billsOpen, ...central.billsOverdue]) {
      const t = syncEngine.lmtMs(b.last_modified_time);
      if (t > (billLmt[b.vendor_id] || 0)) billLmt[b.vendor_id] = t;
    }
    for (const vid of mse) {
      const pr = store.prior[vid];
      if (pr && !full && syncEngine.isFresh(pr.checked_at, 24) && (billLmt[vid] || 0) <= Date.parse(pr.checked_at)) continue;
      try {
        const list = await msmeF1PageAll('/vendorpayments', 'vendorpayments', { vendor_id: vid });
        store.prior[vid] = {
          checked_at: new Date().toISOString(),
          items: list
            .filter(p => p.vendor_id === vid && p.date && p.date < central.pay_window_from && (Number(p.balance) || 0) > MSME_F1_EPS)
            .map(p => ({ payment_id: p.payment_id, payment_number: p.payment_number || '', date: p.date,
                         amount: Number(p.amount) || 0, balance: Number(p.balance) || 0 })),
        };
        await fetched();
      } catch (e) { if (msmeF1Fatal(e)) throw e; stats.failed++; }
    }

    // 4b. Accounts Payable journals tagged to the vendor (Zoho counts them in the vendor balance).
    //     /journals honours vendor_id; detail is re-read only when last_modified_time moves.
    store.journals = store.journals || {};
    for (const vid of mse) {
      try {
        const list = (await msmeF1PageAll('/journals', 'journals', { vendor_id: vid })).filter(j => j.status !== 'draft');
        await fetched();
        const prevJ = new Map((store.journals[vid]?.items || []).map(j => [j.journal_id, j]));
        const items = [];
        for (const j of list) {
          const old = prevJ.get(j.journal_id);
          if (old && !full && old.lmt === (j.last_modified_time || '') && old._v === MSME_F1_JOURNAL_V) { items.push(old); continue; }
          const det = (await rptZohoGet(`/journals/${j.journal_id}`)).journal || {};
          await fetched();
          const rec = msmeF1JournalRec(det, vid);
          if (rec) items.push(rec);
        }
        store.journals[vid] = { checked_at: new Date().toISOString(), items };
      } catch (e) { if (msmeF1Fatal(e)) throw e; stats.failed++; }
    }

    // 5. MSE bill snapshot. pre_settled = settled by payments older than the payment data.
    const alloced = {};
    for (const r of [...Object.values(store.payments), ...Object.values(store.credits)])
      for (const a of r.alloc || []) alloced[a.bill_id] = (alloced[a.bill_id] || 0) + a.amount;
    const cb = new Map();
    for (const b of [...central.billsFy, ...central.billsOpen, ...central.billsOverdue]) if (mse.has(b.vendor_id)) cb.set(b.bill_id, b);
    for (const [id, b] of cb) {
      if (MSME_F1_SKIP.has(b.status)) { delete store.bills[id]; continue; }
      const rec = msmeF1BillRec(b);
      rec.pre_settled = f1r2(rec.total - rec.balance - (alloced[id] || 0));
      store.bills[id] = rec;
    }
    for (const [id, r] of Object.entries(store.bills)) {
      if (cb.has(id)) continue;
      if (!central.bill_window_from || r.date >= central.bill_window_from) delete store.bills[id]; // deleted / voided
    }
    // Bills paid from the window but dated before it (e.g. March bills paid in April)
    const owner = {};
    for (const r of [...Object.values(store.payments), ...Object.values(store.credits)])
      for (const a of r.alloc || []) if (!store.bills[a.bill_id]) owner[a.bill_id] = { vendor_id: r.vendor_id, a };
    // Kept bills that left Open/Overdue without a settlement we know of → confirm once a day
    const now = new Date().toISOString();
    for (const [id, r] of Object.entries(store.bills)) {
      if (cb.has(id)) continue;
      const out = r.total - (r.pre_settled || 0) - (alloced[id] || 0);
      if (out > 0.5 && !(r.verified_at && syncEngine.isFresh(r.verified_at, 24))) owner[id] = { vendor_id: r.vendor_id, verify: true };
    }
    for (const [id, o] of Object.entries(owner)) {
      const a = o.a;
      if (a && a.bill_total > 0 && a.bill_date) {
        store.bills[id] = {
          bill_id: id, vendor_id: o.vendor_id, vendor_name: '', bill_number: a.bill_number, date: a.bill_date, due_date: '',
          total: a.bill_total, balance: 0, status: 'paid', lmt: '', pre_settled: f1r2(a.bill_total - (alloced[id] || 0)),
        };
        continue;
      }
      try {
        const bill = (await rptZohoGet(`/bills/${id}`)).bill;
        await fetched();
        if (!bill || MSME_F1_SKIP.has(bill.status)) { delete store.bills[id]; continue; }
        const rec = msmeF1BillRec(bill);
        rec.pre_settled = f1r2(rec.total - rec.balance - (alloced[id] || 0));
        rec.verified_at = now;
        store.bills[id] = rec;
      } catch (e) {
        if (e.response?.status === 404) { delete store.bills[id]; continue; }
        if (msmeF1Fatal(e)) throw e;
        stats.failed++;
      }
    }

    // 6. "Recheck vendor" overlays end once every central cache has synced after them
    const centralAt = msmeF1CentralAt(central);
    for (const [vid, o] of Object.entries(store.overlay)) if ((Date.parse(o.fetched_at) || 0) <= centralAt) delete store.overlay[vid];
    complete = true;
  } finally {
    store.window_from = central.pay_window_from;
    if (complete) store.complete_at = new Date().toISOString();
    await writeMsmeF1Settle(store);
    cache.keys().filter(k => k.startsWith('msme-f1-')).forEach(k => cache.del(k));
  }

  const pending = Object.values(store.payments).filter(p => p.alloc == null).length +
                  Object.values(store.credits).filter(c => c.alloc == null).length;
  return {
    record_count: Object.keys(store.payments).length + Object.keys(store.credits).length,
    strategy: full ? 'full' : 'incremental',
    stats,
    extra: {
      mse_vendors: mse.size, payments: Object.keys(store.payments).length, credits: Object.keys(store.credits).length,
      bills: Object.keys(store.bills).length, allocation_pending: pending, vendor_status: vs, coverage_from: store.coverage_from,
    },
  };
}

// Stage 4, registered after Vendor MSME Master so it runs once vendors, bills, payments and
// credits are current. Frozen Form-1 halves are snapshots and are never touched.
syncEngine.registerEntity('msme_form1_settlements', {
  label: 'MSME Form-1 Settlements', stage: 4, kind: 'derived',
  path: '/vendorpayments/{id}',
  description: 'Micro/Small vendors: bill allocation of each vendor payment and vendor credit, older unapplied payments, and the bill snapshot MSME Form-1 H1/H2 is rebuilt from.',
  run: ({ mode, isInitial, ctx }) => runMsmeF1Settlements({ mode, isInitial, ctx }),
});
// vendor_msme_master too: a vendor-only sync (Vendors — All → Sync Now) must also refresh the
// Form-1 vendor register, which re-reads only vendors whose last_modified_time changed.
// bills_fy: the Form-1 store keeps its own MSE bill snapshot; a bill deleted in Zoho leaves it
// only when the settlements entity runs after the bill cache changed.
for (const k of ['bills_fy', 'vendor_payments_fy', 'vendor_credits_all', 'vendor_msme_master']) {
  const def = syncEngine.ENTITY_DEFS[k];
  if (def) def.dependents = [...new Set([...(def.dependents || []), 'msme_form1_settlements'])];
}

// ── MSME companies: one sync engine each ──────────────────────────────────────
// Same list entities the MSME reports read, the same two derived MSME entities (same run code,
// executed in the company context) and the same dependency chain as DevX.
const MSME_COMPANY_ENTITIES = ['vendors_all', 'bills_fy', 'vendor_credits_all', 'vendor_payments_fy', 'bills_open', 'bills_overdue'];
for (const co of Object.keys(companyCtx.COMPANIES)) {
  const eng = companyCtx.loadCompanyEngine(co, { baseDb: _db, entities: MSME_COMPANY_ENTITIES });
  for (const k of ['vendor_msme_master', 'msme_form1_settlements']) eng.registerEntity(k, { ..._devxSyncEngine.ENTITY_DEFS[k] });
  for (const [k, def] of Object.entries(eng.ENTITY_DEFS)) {
    def.dependents = (_devxSyncEngine.ENTITY_DEFS[k]?.dependents || []).filter(d => eng.ENTITY_DEFS[d]);
  }
  _companyEngines[co] = eng;
}

// ── Form-1 dataset & calculation ──────────────────────────────────────────────
// Per-vendor inputs, keyed by Zoho vendor ID. Central caches first; a vendor rechecked from
// Zoho after the last central sync uses that live read instead (store.overlay).
function msmeF1Dataset({ central, store, cm, vmSet, useOverlay = true }) {
  const mse = msmeF1MseSet(cm, vmSet);
  const centralAt = msmeF1CentralAt(central);
  const ov = {};
  if (useOverlay) {
    for (const [vid, o] of Object.entries(store?.overlay || {})) {
      if (mse.has(vid) && (Date.parse(o.fetched_at) || 0) > centralAt) ov[vid] = o;
    }
  }
  const V = {};
  const vget = vid => V[vid] || (V[vid] = { bills: new Map(), pays: [], credits: [], prior: [] });

  // Bills: kept snapshot, then the central caches (current balances) on top
  for (const [id, b] of Object.entries(store?.bills || {})) {
    if (mse.has(b.vendor_id) && !ov[b.vendor_id]) vget(b.vendor_id).bills.set(id, { ...b, bill_id: id, retained: true });
  }
  for (const b of [...central.billsFy, ...central.billsOpen, ...central.billsOverdue]) {
    if (!mse.has(b.vendor_id) || ov[b.vendor_id]) continue;
    if (MSME_F1_SKIP.has(b.status)) { V[b.vendor_id]?.bills.delete(b.bill_id); continue; }
    vget(b.vendor_id).bills.set(b.bill_id, msmeF1BillRec(b));
  }

  // Payments: central list (amount / unapplied balance) + allocation from the store when current
  const payIds = new Set();
  for (const p of central.payments) {
    if (!mse.has(p.vendor_id) || ov[p.vendor_id] || !p.payment_id) continue;
    payIds.add(p.payment_id);
    const s = store?.payments?.[p.payment_id];
    const amount = Number(p.amount) || 0, balance = Number(p.balance) || 0, lmt = p.last_modified_time || '';
    const alloc = amount - balance <= MSME_F1_EPS ? []
      : (s && s.detail_lmt === lmt && Array.isArray(s.alloc) ? s.alloc : null);
    vget(p.vendor_id).pays.push({ id: p.payment_id, ref: p.payment_number || '', date: p.date || '', amount, balance, alloc });
  }
  for (const [id, s] of Object.entries(store?.payments || {})) {
    if (payIds.has(id) || !mse.has(s.vendor_id) || ov[s.vendor_id]) continue;
    if (central.pay_window_from && s.date >= central.pay_window_from) continue;
    vget(s.vendor_id).pays.push({ id, ref: s.payment_number, date: s.date, amount: s.amount, balance: s.balance, alloc: s.alloc });
  }
  for (const [vid, pr] of Object.entries(store?.prior || {})) {
    if (!mse.has(vid) || ov[vid]) continue;
    const have = new Set(vget(vid).pays.map(p => p.id));
    for (const it of pr.items || []) {
      if (!have.has(it.payment_id)) vget(vid).prior.push({ id: it.payment_id, ref: it.payment_number, date: it.date, amount: it.amount, balance: it.balance });
    }
  }

  // Vendor credits
  for (const c of central.credits) {
    if (!mse.has(c.vendor_id) || ov[c.vendor_id] || MSME_F1_SKIP.has(c.status)) continue;
    const s = store?.credits?.[c.vendor_credit_id];
    const total = Number(c.total) || 0, balance = Number(c.balance) || 0, lmt = c.last_modified_time || '';
    const alloc = total - balance <= MSME_F1_EPS ? []
      : (s && s.detail_lmt === lmt && Array.isArray(s.alloc) ? s.alloc : null);
    vget(c.vendor_id).credits.push({ id: c.vendor_credit_id, ref: c.vendor_credit_number || '', date: c.date || '', total, balance, alloc, tds: s?.tds ?? null });
  }

  // Accounts Payable journals tagged to the vendor
  for (const [vid, jr] of Object.entries(store?.journals || {})) {
    if (mse.has(vid) && !ov[vid] && jr.items?.length) vget(vid).journals = jr.items;
  }

  for (const [vid, o] of Object.entries(ov)) {
    const v = vget(vid);
    for (const b of o.bills || []) v.bills.set(b.bill_id, b);
    v.pays.push(...(o.payments || []));
    v.prior.push(...(o.prior || []));
    v.credits.push(...(o.credits || []));
    if (o.journals) v.journals = o.journals;
  }
  return { mse, V, overlays: Object.keys(ov), coverage_from: store?.coverage_from || null };
}

// Rebuilds one vendor's bill settlements as at the cut-off.
//   settlements = payment allocations + vendor credit allocations + amounts settled before the
//   payment data begins (residual, effective on the bill date); each is effective on
//   max(settlement date, bill date). Unapplied vendor payments / open vendor credits dated on or
//   before the cut-off are then knocked off against the oldest outstanding bills (FIFO), the
//   same netting the Zoho vendor statement shows.
function msmeF1VendorSettle(v, cutoffStr, coverageFrom) {
  const sets = new Map();
  const add = (id, s) => { if (!sets.has(id)) sets.set(id, []); sets.get(id).push(s); };
  const warn = new Set();
  // AP journals: a credit is a payable dated on the journal (credits applied to it settle it);
  // a debit applied to bills settles them on the journal date, its unapplied rest nets like an advance
  const bills = new Map(v.bills);
  const jPool = [];
  const payRefs = new Set([...v.pays, ...v.prior].map(p => p.ref).filter(Boolean));
  for (const j of v.journals || []) {
    if (j.credit > MSME_F1_EPS) {
      const id = `JR:${j.journal_id}`;
      const applied = (j.journal_credits || []).reduce((s, c) => s + c.amount, 0);
      bills.set(id, { bill_id: id, bill_number: j.entry_number, date: j.date, due_date: '', total: j.credit,
                      balance: Math.max(0, j.credit - applied), source: 'journal' });
      for (const c of j.journal_credits || []) add(id, { date: c.date || j.date, amount: c.amount, kind: payRefs.has(c.ref) ? 'payment' : 'credit', ref: c.ref || j.entry_number });
    }
    if (j.debit > MSME_F1_EPS) {
      let used = 0;
      for (const b of j.bills_credited || []) { add(b.bill_id, { date: j.date, amount: b.amount, kind: 'journal', ref: j.entry_number }); used += b.amount; }
      if (j.debit - used > MSME_F1_EPS) jPool.push({ date: j.date, amount: j.debit - used, kind: 'unapplied_journal', ref: j.entry_number });
    }
  }
  for (const p of v.pays) {
    if (p.alloc == null) { warn.add('allocation_pending'); continue; }
    for (const a of p.alloc) add(a.bill_id, { date: p.date, amount: a.amount, kind: 'payment', ref: p.ref });
  }
  for (const c of v.credits) {
    if (c.alloc == null) { warn.add('allocation_pending'); continue; }
    for (const a of c.alloc) add(a.bill_id, { date: a.date || c.date, amount: a.amount, kind: 'credit', ref: c.ref });
  }
  for (const id of sets.keys()) if (!bills.has(id)) warn.add('settled_bill_not_found');
  for (const b of bills.values()) {
    const known = (sets.get(b.bill_id) || []).reduce((s, x) => s + x.amount, 0);
    const resid = b.retained && b.pre_settled != null ? b.pre_settled : b.total - b.balance - known;
    if (resid > MSME_F1_EPS) add(b.bill_id, { date: b.date, amount: resid, kind: 'earlier', ref: `Settled before ${coverageFrom || 'payment data'}` });
    else if (resid < -0.5) warn.add('settlement_mismatch');
  }

  const pool = [];
  for (const p of [...v.pays, ...v.prior]) {
    if (p.date && p.date <= cutoffStr && p.balance > MSME_F1_EPS) pool.push({ date: p.date, amount: p.balance, kind: 'unapplied_payment', ref: p.ref });
  }
  for (const c of v.credits) {
    if (!c.date || c.date > cutoffStr) continue;
    const later = (c.alloc || []).filter(a => (a.date || c.date) > cutoffStr).reduce((s, a) => s + a.amount, 0);
    if (c.balance + later > MSME_F1_EPS) pool.push({ date: c.date, amount: c.balance + later, kind: 'unapplied_credit', ref: c.ref });
  }
  for (const j of jPool) if (j.date && j.date <= cutoffStr) pool.push({ ...j });
  pool.sort((a, b) => a.date.localeCompare(b.date));

  const eff = (s, b) => (s.date > b.date ? s.date : b.date);
  const inScope = [...bills.values()].filter(b => b.date && b.date <= cutoffStr && b.total > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.bill_number).localeCompare(String(b.bill_number), undefined, { numeric: true }));
  const outC = new Map();
  for (const b of inScope) {
    const settled = (sets.get(b.bill_id) || []).filter(s => eff(s, b) <= cutoffStr).reduce((s, x) => s + x.amount, 0);
    outC.set(b.bill_id, b.total - settled);
  }
  let pi = 0, knocked = 0;
  for (const b of inScope) {
    let out = outC.get(b.bill_id);
    while (out > MSME_F1_EPS && pi < pool.length) {
      const take = Math.min(out, pool[pi].amount);
      add(b.bill_id, { date: pool[pi].date, amount: take, kind: pool[pi].kind, ref: pool[pi].ref });
      out -= take; pool[pi].amount -= take; knocked += take;
      if (pool[pi].amount <= MSME_F1_EPS) pi++;
    }
    outC.set(b.bill_id, out);
  }
  const advance = pool.slice(pi).reduce((s, p) => s + Math.max(0, p.amount), 0);
  return { sets, inScope, outC, eff, warn, knocked, advance };
}

// Form-1 classification is unchanged: paid = settled inside the half (one entry per bill,
// days = bill date → last settlement in the half); outstanding = unsettled at the cut-off
// (days = bill date → cut-off). ≤45 / >45 days as before.
// Debit notes (vendor credits) and AP journal adjustments are not payments: they reduce the bill
// (user decision 2026-10-27), so they are left out of paid and of the payment date. Outstanding
// is unchanged — they still settle the bill.
const MSME_F1_BILL_REDUCTION = new Set(['credit', 'unapplied_credit', 'journal', 'unapplied_journal']);
function computeForm1HalfYear(ds, ctxInfo, halfStart, cutoffStr, reasons, halfKey) {
  const { cm, vendorsById } = ctxInfo;
  const rows = [];
  let knockedTotal = 0, pendingVendors = 0, billsSeen = 0;
  for (const [vid, v] of Object.entries(ds.V)) {
    const r = msmeF1VendorSettle(v, cutoffStr, ds.coverage_from);
    billsSeen += r.inScope.length;
    const msme = cm[vid] || {};
    const vrec = vendorsById.get(vid);
    const gst = vrec?.gst_no || '';
    const pan = (vrec?.pan_no || msme.cf_pan || '').trim() || (gst.length >= 12 ? gst.slice(2, 12) : '');
    const row = {
      vendor_id: vid,
      vendor_name: vrec?.contact_name || msme.vendor_name || r.inScope[0]?.vendor_name || '',
      pan, msme_type: msme.msme_type || '', udyam_number: msme.udyam_reg_no || '',
      // Zoho vendor custom field "MSME Sector" as entered (Manufacturer / Services / Trader)
      major_activity: msme.msme_sector_raw || msme.major_activity_zoho || '',
      reason: reasons[`${halfKey}:${vid}`] || '',
      paid_within45_count: 0, paid_within45_amount: 0,
      paid_after45_count:  0, paid_after45_amount:  0,
      out_within45_count:  0, out_within45_amount:  0,
      out_after45_count:   0, out_after45_amount:   0,
      bills_paid: [], bills_outstanding: [], warnings: [], notes: {},
    };
    for (const b of r.inScope) {
      const ss = r.sets.get(b.bill_id) || [];
      const inH = ss.filter(s => { const e = r.eff(s, b); return e >= halfStart && e <= cutoffStr && !MSME_F1_BILL_REDUCTION.has(s.kind); });
      const paid = inH.reduce((s, x) => s + x.amount, 0);
      const out = r.outC.get(b.bill_id);
      // Debit notes / journal adjustments on this bill up to the cut-off (reduce the bill, not paid)
      const reducedBy = ss.filter(s => MSME_F1_BILL_REDUCTION.has(s.kind) && r.eff(s, b) <= cutoffStr);
      const reduction = reducedBy.reduce((s, x) => s + x.amount, 0);
      const reductionInfo = reduction > MSME_F1_EPS
        ? { reduced_by: f1r2(reduction), reductions: reducedBy.map(s => ({ kind: s.kind, ref: s.ref, date: r.eff(s, b), amount: f1r2(s.amount) })) } : {};
      if (paid > MSME_F1_EPS) {
        const payDate = inH.reduce((m, s) => (r.eff(s, b) > m ? r.eff(s, b) : m), '');
        const days = daysBetweenDates(b.date, payDate);
        const within = days <= 45;
        row.bills_paid.push({
          bill_id: b.bill_id, bill_number: b.bill_number, bill_date: b.date, due_date: b.due_date || '', ...(b.source ? { source: b.source } : {}),
          original_amount: b.total, paid_amount: f1r2(paid), outstanding_amount: f1r2(Math.max(0, out)),
          payment_date: payDate, days, classification: within ? 'paid_within45' : 'paid_after45',
          settled_via: inH.map(s => ({ kind: s.kind, ref: s.ref, date: r.eff(s, b), amount: f1r2(s.amount) })),
          ...reductionInfo,
        });
        if (within) { row.paid_within45_count++; row.paid_within45_amount += paid; }
        else        { row.paid_after45_count++;  row.paid_after45_amount  += paid; }
      }
      if (out > MSME_F1_EPS) {
        const days = daysBetweenDates(b.date, cutoffStr);
        const within = days <= 45;
        const last = ss.filter(s => r.eff(s, b) <= cutoffStr).reduce((m, s) => (r.eff(s, b) > m ? r.eff(s, b) : m), '');
        row.bills_outstanding.push({
          bill_id: b.bill_id, bill_number: b.bill_number, bill_date: b.date, due_date: b.due_date || '', ...(b.source ? { source: b.source } : {}),
          original_amount: b.total, paid_amount: f1r2(b.total - out - reduction), outstanding_amount: f1r2(out),
          payment_date: last, days, classification: within ? 'out_within45' : 'out_after45',
          ...reductionInfo,
        });
        if (within) { row.out_within45_count++; row.out_within45_amount += out; }
        else        { row.out_after45_count++;  row.out_after45_amount  += out; }
      }
    }
    // TDS deducted on the vendor's bills dated in the half, less TDS reversed by its debit notes dated
    // in the half, counts as paid within 45 days — amount only, no bill count (user decision
    // 2026-10-27). Bill amounts and outstanding are unchanged (Zoho bill totals are net of TDS).
    const inHalfDate = x => x.date && x.date >= halfStart && x.date <= cutoffStr;
    const tdsBills = [...v.bills.values()].filter(b => inHalfDate(b) && b.total > 0).reduce((s, b) => s + (b.tds || 0), 0);
    const halfCredits = v.credits.filter(inHalfDate);
    const tdsReversed = halfCredits.reduce((s, c) => s + (c.tds || 0), 0);
    if (halfCredits.some(c => c.tds == null)) r.warn.add('tds_pending');
    const tdsPaid = Math.max(0, tdsBills - tdsReversed);
    if (tdsPaid > MSME_F1_EPS) {
      row.paid_within45_amount += tdsPaid;
      row.notes.tds_in_paid_within45 = f1r2(tdsPaid);
      if (tdsReversed > MSME_F1_EPS) Object.assign(row.notes, { tds_on_bills: f1r2(tdsBills), tds_reversed_by_debit_notes: f1r2(tdsReversed) });
    }
    if (!row.bills_paid.length && !row.bills_outstanding.length && tdsPaid <= MSME_F1_EPS) {
      // Paid in the half but no bill on or before the cut-off (advance) — listed with nil amounts
      // so every MSE vendor active in the half appears; nothing is due, so all columns stay zero.
      // Debit notes are not payments (they reduce bills), so only payments count here.
      const inHalf = x => x.date && x.date >= halfStart && x.date <= cutoffStr;
      const adv = [...v.pays, ...v.prior].filter(inHalf).reduce((s, p) => s + (p.amount || 0), 0);
      if (adv <= MSME_F1_EPS) continue;
      row.notes.advance_only_in_half = f1r2(adv);
    }
    for (const k of ['paid_within45_amount', 'paid_after45_amount', 'out_within45_amount', 'out_after45_amount']) row[k] = f1r2(row[k]);
    if (!pan) r.warn.add('pan_missing');
    if (!row.msme_type && msmeF1UdyamNo(msme)) r.warn.add('enterprise_type_blank');
    if (/medium/i.test(row.msme_type)) row.notes.medium_enterprise = true;
    row.warnings = [...r.warn];
    if (r.knocked > MSME_F1_EPS) row.notes.unapplied_knocked_off = f1r2(r.knocked);
    if (r.advance > 0.5) row.notes.vendor_advance_after_knock_off = f1r2(r.advance);
    if (ds.overlays.includes(vid)) row.notes.rechecked_live = true;
    if (r.warn.has('allocation_pending')) pendingVendors++;
    knockedTotal += r.knocked;
    rows.push(row);
  }
  rows.sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));

  const totals = rows.reduce((s, r) => ({
    paid_within45_count:  s.paid_within45_count  + r.paid_within45_count,
    paid_within45_amount: s.paid_within45_amount + r.paid_within45_amount,
    paid_after45_count:   s.paid_after45_count   + r.paid_after45_count,
    paid_after45_amount:  s.paid_after45_amount  + r.paid_after45_amount,
    out_within45_count:   s.out_within45_count   + r.out_within45_count,
    out_within45_amount:  s.out_within45_amount  + r.out_within45_amount,
    out_after45_count:    s.out_after45_count    + r.out_after45_count,
    out_after45_amount:   s.out_after45_amount   + r.out_after45_amount,
  }), { paid_within45_count:0, paid_within45_amount:0, paid_after45_count:0, paid_after45_amount:0,
        out_within45_count:0, out_within45_amount:0, out_after45_count:0, out_after45_amount:0 });
  for (const k of Object.keys(totals)) if (k.endsWith('_amount')) totals[k] = f1r2(totals[k]);

  return { rows, totals, vendor_count: rows.length,
           stats: { knocked_off: f1r2(knockedTotal), allocation_pending_vendors: pendingVendors, bills_considered: billsSeen } };
}

const MSME_F1_EMPTY_TOTALS = {
  paid_within45_count: 0, paid_within45_amount: 0,
  paid_after45_count: 0,  paid_after45_amount: 0,
  out_within45_count: 0,  out_within45_amount: 0,
  out_after45_count: 0,   out_after45_amount: 0,
};

// One LIVE half-year from the central caches. `inputs` lets callers reuse already-read data.
async function msmeF1Build(fy, half, d, { useOverlay = true, inputs = null } = {}) {
  const hDates = msmeF1HalfDates(fy, half);
  const halfKey = `${fy}:${half}`;
  const base = { fy, half, half_label: hDates.label, half_start: hDates.start, half_end: hDates.end };
  const today = new Date();
  const halfStart = new Date(hDates.start);
  const halfEnd   = new Date(hDates.end);

  // Period not started yet → "upcoming" placeholder (no data)
  if (today < halfStart) {
    return { ...base, status: 'upcoming', cutoff_date: hDates.start, rows: [], totals: { ...MSME_F1_EMPTY_TOTALS },
             vendor_count: 0, last_synced: new Date().toISOString() };
  }
  // Cut-off = MIN(today, half-year end)
  const cutoffStr = localDate(today < halfEnd ? today : halfEnd);

  const inp = inputs || await msmeF1Inputs();
  const { central, store, cmMeta, vmSet } = inp;
  const stamps = [...MSME_F1_SOURCES.map(k => central.synced_at[k]), store?.updated_at].filter(Boolean).sort();
  const lastSynced = stamps[0] || null;
  const empty = { ...base, cutoff_date: cutoffStr, rows: [], totals: { ...MSME_F1_EMPTY_TOTALS }, vendor_count: 0, last_synced: lastSynced };

  if (central.missing.length) {
    return { ...empty, status: 'pending', notice: `Central sync data missing (${central.missing.join(', ')}). Run Sync Data in the Sync Monitor.` };
  }
  // Usable only after one complete build — a run stopped by a rate limit never shows partial figures
  if (!store?.complete_at) {
    syncEngine.startRun({ mode: 'normal', trigger: 'entity', entities: ['msme_form1_settlements'] });
    return { ...empty, status: 'pending',
             notice: 'Building MSME Form-1 settlement data from the central sync (Sync Monitor → MSME Form-1 Settlements). The first build takes several minutes — refresh shortly.' };
  }
  if (hDates.start < store.coverage_from) {
    return { ...empty, status: 'unavailable',
             notice: `Not available live: the central sync holds settlement data from ${store.coverage_from}. Halves before that can only be shown from a frozen snapshot.` };
  }

  const cm = msmeF1VendorView(store, cmMeta?.data);
  const ds = msmeF1Dataset({ central, store, cm, vmSet, useOverlay });
  const vendorsById = new Map(central.vendors.map(v => [v.contact_id, v]));
  const { rows, totals, vendor_count, stats } = computeForm1HalfYear(ds, { cm, vendorsById }, hDates.start, cutoffStr, d.reasons || {}, halfKey);

  const pendingIds = Object.values(store.payments || {}).filter(p => p.alloc == null).length +
                     Object.values(store.credits || {}).filter(c => c.alloc == null).length;
  return {
    ...base, status: 'live', cutoff_date: cutoffStr,
    rows, totals, vendor_count, last_synced: lastSynced,
    ...(store.vendor_register?.pending > 0 ? { notice: `MSME registration of ${store.vendor_register.pending} vendor(s) not yet read from Zoho — they will be added after the next sync.` } : {}),
    ...(stats.allocation_pending_vendors ? { notice: `${stats.allocation_pending_vendors} vendor(s) have payments or credits whose bill allocation has not been read from Zoho yet — their figures may change after the next sync.` } : {}),
    sources: { ...central.synced_at, msme_form1_settlements: store.updated_at || null, vendor_msme_master: cmMeta?.fetched_at || null },
    debug: {
      outstanding_bills: stats.bills_considered,
      paid_bills: rows.reduce((s, r) => s + r.bills_paid.length, 0),
      contacts_fetched: Object.keys(cm).length,
      mse_eligible_vendors: ds.mse.size,
      vm_confirmed_vendors: vmSet.size,
      unapplied_knocked_off: stats.knocked_off,
      allocation_pending: pendingIds,
      coverage_from: store.coverage_from,
      rechecked_vendors: ds.overlays,
    },
  };
}

async function msmeF1Inputs() {
  const [central, store, cmMeta, ir] = await Promise.all([
    msmeF1Central(), readMsmeF1Settle(), readMsmeCMMeta({ ignoreTTL: true }), readMsmeIR(),
  ]);
  return { central, store, cmMeta, vmSet: new Set(Object.keys(ir.vendor_master || {})) };
}

// ── Form-1 manual classification (dashboard-side only — never written to Zoho) ─────────────
// Stored in msme_form1_data.class_overrides[vendor_id] = { msme_type?, major_activity?, … }, which
// no sync touches. Applied per field after the Form-1 calculation, for display and filtering only:
// final = manual ?? Zoho ?? "Not Updated". MSE eligibility, bills and totals are not affected.
const MSME_F1_CLASS_TYPES = ['micro', 'small', 'medium'];
const MSME_F1_CLASS_ACTS  = ['Manufacturing', 'Trader', 'Service'];
function msmeF1ApplyClassOverrides(rows, overrides = {}) {
  for (const r of rows || []) {
    r.zoho_msme_type = r.msme_type;
    r.zoho_major_activity = r.major_activity;
    const o = overrides[r.vendor_id];
    if (!o) continue;
    if (o.msme_type) r.msme_type = o.msme_type;
    if (o.major_activity) r.major_activity = o.major_activity;
    r.class_manual = { msme_type: !!o.msme_type, major_activity: !!o.major_activity, updated_at: o.updated_at, updated_by: o.updated_by };
  }
}

app.get('/api/msme-form1/half-year', authMiddleware, async (req, res) => {
  const { fy = '2026-27', half = 'H1', refresh } = req.query;
  const halfKey = `${fy}:${half}`;
  try {
    const d = await readMsmeF1();
    if (d.frozen_halves?.[halfKey]) {
      return res.json({ fy, half, status: 'frozen', ...d.frozen_halves[halfKey] });
    }
    if (!msmeF1HalfDates(fy, half)) return res.status(400).json({ error: 'Invalid FY or half' });

    const cacheKey = `msme-f1-${fy}-${half}`;
    if (refresh) cache.del(cacheKey);
    const hit = cache.get(cacheKey);
    if (hit) return res.json(hit);

    const result = await msmeF1Build(fy, half, d);
    msmeF1ApplyClassOverrides(result.rows, d.class_overrides);
    if (result.status === 'live') {
      console.log(`[MSME-F1] ${fy} ${half} — vendors:${result.vendor_count} mse:${result.debug.mse_eligible_vendors} knocked-off:${result.debug.unapplied_knocked_off} pending:${result.debug.allocation_pending}`);
      cache.set(cacheKey, result, 300);
    }
    res.json(result);
  } catch (e) {
    console.error('msme-form1:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Recheck vendor / reconciliation (Form-1 only) ─────────────────────────────
// Live read of one vendor (paced): contact, all bills, payments, vendor credits, and the bill
// allocation of payments / credits whose last_modified_time differs from the store (deep: all).
async function msmeF1LiveVendor(vid, store, { deep = false } = {}) {
  const cov = store.coverage_from;
  // Zoho list filters (verified): /bills honours vendor_id only without filter_by (all statuses
  // are returned); /vendorpayments honours vendor_id; /vendorcredits ignores it → read all, filter by ID.
  const contact = (await rptZohoGet(`/contacts/${vid}`)).contact || null;
  const bills   = (await msmeF1PageAll('/bills', 'bills', { vendor_id: vid })).filter(b => b.vendor_id === vid);
  const pays    = (await msmeF1PageAll('/vendorpayments', 'vendorpayments', { vendor_id: vid })).filter(p => p.vendor_id === vid);
  const credits = (await msmeF1PageAll('/vendorcredits', 'vendor_credits', { filter_by: 'Status.All' })).filter(c => c.vendor_id === vid);
  let detailCalls = 0;

  const payRecs = [], prior = [];
  for (const p of pays) {
    const amount = Number(p.amount) || 0, balance = Number(p.balance) || 0, lmt = p.last_modified_time || '';
    if (!p.date || p.date < cov) {
      if (balance > MSME_F1_EPS) prior.push({ id: p.payment_id, ref: p.payment_number || '', date: p.date || '', amount, balance });
      continue;
    }
    let alloc = [];
    if (amount - balance > MSME_F1_EPS) {
      const s = store.payments?.[p.payment_id];
      if (!deep && s && s.detail_lmt === lmt && Array.isArray(s.alloc)) alloc = s.alloc;
      else { alloc = msmeF1PayAlloc((await rptZohoGet(`/vendorpayments/${p.payment_id}`)).vendorpayment || {}); detailCalls++; }
    }
    payRecs.push({ id: p.payment_id, ref: p.payment_number || '', date: p.date, amount, balance, alloc, lmt });
  }
  const creditRecs = [];
  for (const c of credits) {
    if (MSME_F1_SKIP.has(c.status)) continue;
    const total = Number(c.total) || 0, balance = Number(c.balance) || 0, lmt = c.last_modified_time || '';
    const s = store.credits?.[c.vendor_credit_id];
    let alloc = [], tds = !deep && s && s.tds_lmt === lmt ? s.tds : null;
    const needAlloc = total - balance > MSME_F1_EPS && !(!deep && s && s.detail_lmt === lmt && Array.isArray(s.alloc));
    if (total - balance > MSME_F1_EPS && !needAlloc) alloc = s.alloc;
    if (needAlloc || tds == null) {
      const vc = (await rptZohoGet(`/vendorcredits/${c.vendor_credit_id}`)).vendor_credit || {};
      detailCalls++;
      if (needAlloc) alloc = msmeF1CreditAlloc(vc);
      tds = Number(vc.tds_amount) || 0;
    }
    creditRecs.push({ id: c.vendor_credit_id, ref: c.vendor_credit_number || '', date: c.date || '', total, balance, alloc, lmt, status: c.status || '', tds });
  }
  const journals = [];
  for (const j of (await msmeF1PageAll('/journals', 'journals', { vendor_id: vid })).filter(x => x.status !== 'draft')) {
    const s = (store.journals?.[vid]?.items || []).find(x => x.journal_id === j.journal_id);
    if (!deep && s && s.lmt === (j.last_modified_time || '') && s._v === MSME_F1_JOURNAL_V) { journals.push(s); continue; }
    const rec = msmeF1JournalRec((await rptZohoGet(`/journals/${j.journal_id}`)).journal || {}, vid);
    detailCalls++;
    if (rec) journals.push(rec);
  }
  return {
    contact, bills, pays, credits, journals, detailCalls,
    overlay: {
      fetched_at: new Date().toISOString(),
      bills: bills.filter(b => !MSME_F1_SKIP.has(b.status)).map(msmeF1BillRec),
      payments: payRecs, prior, credits: creditRecs, journals,
    },
  };
}

// Record-by-record comparison of the live Zoho read with the central caches (by Zoho ID)
function msmeF1Diff(vid, live, central) {
  const out = [];
  const pick = (r, fields) => Object.fromEntries(fields.map(f => [f, r[f] ?? null]));
  const cmp = (type, liveArr, cacheArr, idF, numF, fields, scope) => {
    const L = new Map(liveArr.filter(scope).map(r => [r[idF], r]));
    const C = new Map(cacheArr.filter(r => r.vendor_id === vid).filter(scope).map(r => [r[idF], r]));
    for (const [id, r] of L) {
      const c = C.get(id);
      if (!c) { out.push({ type, id, number: r[numF] || '', status: 'missing_in_cache', zoho: pick(r, fields), cache: null }); continue; }
      const changed = fields.filter(f => {
        const a = r[f], b = c[f];
        return typeof a === 'number' || typeof b === 'number' ? Math.abs((Number(a) || 0) - (Number(b) || 0)) > MSME_F1_EPS : String(a ?? '') !== String(b ?? '');
      });
      out.push({ type, id, number: r[numF] || '', status: changed.length ? 'changed' : 'match', fields: changed, zoho: pick(r, fields), cache: pick(c, fields) });
    }
    for (const [id, c] of C) if (!L.has(id)) out.push({ type, id, number: c[numF] || '', status: 'not_in_zoho', zoho: null, cache: pick(c, fields) });
  };
  const centralBills = [...new Map([...central.billsFy, ...central.billsOpen, ...central.billsOverdue].map(b => [b.bill_id, b])).values()];
  const billScope = b => !MSME_F1_SKIP.has(b.status) && ((b.date || '') >= (central.bill_window_from || '') || ['open', 'overdue'].includes(b.status));
  cmp('bill', live.bills, centralBills, 'bill_id', 'bill_number', ['date', 'total', 'balance'], billScope);
  cmp('payment', live.pays, central.payments, 'payment_id', 'payment_number', ['date', 'amount', 'balance'],
      p => (p.date || '') >= (central.pay_window_from || ''));
  cmp('vendor_credit', live.credits, central.credits, 'vendor_credit_id', 'vendor_credit_number', ['date', 'total', 'balance', 'status'],
      c => !MSME_F1_SKIP.has(c.status));
  return out;
}

// Vendor position "now" from a dataset entry: bill balances less unapplied payments / credits
// billScope: same bill scope as the central caches (FY window + anything still unpaid)
function msmeF1VendorNow(v, coverageFrom, billScope = () => true) {
  if (!v) return { bills: 0, bills_amount: 0, payments: 0, credits: 0, net: 0 };
  const today = localDate(new Date());
  const r = msmeF1VendorSettle(v, '9999-12-31', coverageFrom);
  const outNow = [...r.outC.values()].reduce((s, x) => s + Math.max(0, x), 0);
  const scoped = [...v.bills.values()].filter(billScope);
  return {
    bills: scoped.length,
    bills_amount: f1r2(scoped.reduce((s, b) => s + b.total, 0)),
    payments: f1r2(v.pays.filter(p => p.date <= today).reduce((s, p) => s + p.amount, 0)),
    credits: f1r2(v.credits.reduce((s, c) => s + c.total, 0)),
    net: f1r2(outNow - r.advance),
  };
}

function msmeF1RowAmounts(row) {
  if (!row) return { paid_within45: 0, paid_after45: 0, out_within45: 0, out_after45: 0, paid: 0, outstanding: 0, bills: 0 };
  return {
    paid_within45: row.paid_within45_amount, paid_after45: row.paid_after45_amount,
    out_within45: row.out_within45_amount, out_after45: row.out_after45_amount,
    paid: f1r2(row.paid_within45_amount + row.paid_after45_amount),
    outstanding: f1r2(row.out_within45_amount + row.out_after45_amount),
    counts: [row.paid_within45_count, row.paid_after45_count, row.out_within45_count, row.out_after45_count],
  };
}

// POST { vendor_id, fy, deep?, apply? } — admin. Re-reads the vendor from Zoho, reports every
// difference against the central caches, and (apply, default true) keeps the live read for
// this vendor's LIVE Form-1 halves until the next central sync is newer. Frozen halves are
// never changed: their difference is reported for authorisation instead.
app.post('/api/msme-form1/recheck-vendor', authMiddleware, adminOnly, async (req, res) => {
  const { vendor_id: vid, fy = '2026-27', deep = false, apply = true } = req.body || {};
  if (!vid) return res.status(400).json({ error: 'vendor_id required' });
  try {
    const d = await readMsmeF1();
    const inBefore = await msmeF1Inputs();
    if (!inBefore.store) return res.status(409).json({ error: 'MSME Form-1 settlement data has not been built yet — run Sync Data first.' });
    const halves = ['H1', 'H2'];
    const before = {};
    for (const h of halves) before[h] = await msmeF1Build(fy, h, d, { inputs: inBefore });

    const live = await msmeF1LiveVendor(vid, inBefore.store, { deep });
    const diffs = msmeF1Diff(vid, live, inBefore.central);
    const viewBefore = msmeF1VendorView(inBefore.store, inBefore.cmMeta?.data);
    const cmBefore = viewBefore[vid] || null;
    const isVm = inBefore.vmSet.has(vid);
    const masterDiff = [];
    if (live.contact) {
      const sector = extractMsmeSector(live.contact);
      const chk = (field, z, c) => masterDiff.push({ field, zoho: z ?? null, cache: c ?? null, status: String(z ?? '') === String(c ?? '') ? 'match' : 'changed' });
      chk('msme_type (Enterprise Type)', (live.contact.msme_type || '').trim(), cmBefore?.msme_type);
      chk('cf_msme_sector (Major Activity)', sector.raw, cmBefore?.msme_sector_raw);
      chk('udyam_reg_no', (live.contact.udyam_reg_no || live.contact.msme_reg_no || '').trim(), cmBefore?.udyam_reg_no);
      chk('contact_name', live.contact.contact_name, cmBefore?.vendor_name);
    }

    let after = before, inAfter = inBefore;
    if (apply) {
      const store = await readMsmeF1Settle();
      // Form-1 vendor register entry (Enterprise Type / Udyam number) from the live contact
      if (live.contact) { store.vendors = store.vendors || {}; store.vendors[vid] = msmeF1VendorRec(buildMsmeCMEntry(live.contact, isVm), live.contact); }
      store.overlay = store.overlay || {};
      store.overlay[vid] = live.overlay;
      store.journals = store.journals || {};
      store.journals[vid] = { checked_at: live.overlay.fetched_at, items: live.overlay.journals };
      store.prior[vid] = { checked_at: live.overlay.fetched_at,
        items: live.overlay.prior.filter(p => p.date < (inBefore.central.pay_window_from || ''))
          .map(p => ({ payment_id: p.id, payment_number: p.ref, date: p.date, amount: p.amount, balance: p.balance })) };
      // Allocation detail read now is reused by the next sync while last_modified_time is unchanged
      for (const p of live.overlay.payments) {
        if (store.payments[p.id]) Object.assign(store.payments[p.id], { alloc: p.alloc, detail_lmt: p.lmt });
      }
      for (const c of live.overlay.credits) {
        if (store.credits[c.id]) Object.assign(store.credits[c.id], { alloc: c.alloc, detail_lmt: c.lmt, tds: c.tds, tds_lmt: c.lmt });
      }
      await writeMsmeF1Settle(store);
      cache.keys().filter(k => k.startsWith('msme-f1-')).forEach(k => cache.del(k));
      inAfter = await msmeF1Inputs();
      after = {};
      for (const h of halves) after[h] = await msmeF1Build(fy, h, d, { inputs: inAfter });
    }

    const rowOf = (r, h) => r[h]?.rows?.find(x => x.vendor_id === vid) || null;
    const frozen = [];
    for (const h of halves) {
      const fz = d.frozen_halves?.[`${fy}:${h}`];
      if (!fz) continue;
      const fRow = fz.rows?.find(x => x.vendor_id === vid) || null;
      const recalc = await msmeF1Build(fy, h, { reasons: d.reasons }, { inputs: inAfter });
      const nRow = recalc.rows?.find(x => x.vendor_id === vid) || null;
      const fa = msmeF1RowAmounts(fRow), na = msmeF1RowAmounts(nRow);
      frozen.push({
        half: h, frozen_at: fz.frozen_at, frozen_by: fz.frozen_by,
        frozen: fa, recalculated: na,
        difference: Object.fromEntries(['paid_within45', 'paid_after45', 'out_within45', 'out_after45']
          .map(k => [k, f1r2((na[k] || 0) - (fa[k] || 0))])),
        reason: 'Frozen snapshot is unchanged. Recalculated from the current central data and this live recheck; unfreeze and re-freeze only with authorisation.',
      });
    }

    // Layer-by-layer reconciliation (Zoho raw → central cache → Form-1 dataset → Form-1)
    const viewAfter = msmeF1VendorView(inAfter.store, inAfter.cmMeta?.data);
    const dsAfter = msmeF1Dataset({ central: inAfter.central, store: inAfter.store, cm: viewAfter, vmSet: inAfter.vmSet });
    const dsCentral = msmeF1Dataset({ central: inBefore.central, store: inBefore.store, cm: viewBefore, vmSet: inBefore.vmSet, useOverlay: false });
    const nowLive = live.contact ? f1r2((live.contact.outstanding_payable_amount || 0) - (live.contact.unused_credits_payable_amount || 0)) : null;
    const cacheVendor = inBefore.central.vendors.find(v => v.contact_id === vid);
    const cBills = [...new Map([...inBefore.central.billsFy, ...inBefore.central.billsOpen, ...inBefore.central.billsOverdue]
      .filter(b => b.vendor_id === vid && !MSME_F1_SKIP.has(b.status)).map(b => [b.bill_id, b])).values()];
    const nowCentral = msmeF1VendorNow(dsCentral.V[vid], inBefore.store.coverage_from);
    const inSyncScope = b => (b.date || '') >= (inBefore.central.bill_window_from || '') || (b.balance || 0) > MSME_F1_EPS;
    const nowAfter = msmeF1VendorNow(dsAfter.V[vid], inAfter.store.coverage_from, inSyncScope);
    const winFrom = inBefore.central.pay_window_from || '';
    const liveScopeBills = live.bills.filter(b => !MSME_F1_SKIP.has(b.status) && inSyncScope(b));
    const table = [
      { item: 'Vendor ID', zoho: live.contact?.contact_id || null, central: cacheVendor ? vid : null, dataset: dsAfter.mse.has(vid) ? vid : 'not Micro/Small', form1: halves.some(h => rowOf(after, h)) ? vid : 'no rows' },
      { item: 'Enterprise Type', zoho: live.contact?.msme_type || '', central: cmBefore?.msme_type || '', dataset: (viewAfter[vid] || {}).msme_type || '', form1: rowOf(after, 'H1')?.msme_type ?? rowOf(after, 'H2')?.msme_type ?? '' },
      { item: 'Udyam Reg No', zoho: live.contact ? (live.contact.udyam_reg_no || live.contact.msme_reg_no || '').trim() : null, central: cmBefore?.udyam_reg_no || '', dataset: (viewAfter[vid] || {}).udyam_reg_no || '', form1: rowOf(after, 'H1')?.udyam_number ?? rowOf(after, 'H2')?.udyam_number ?? '' },
      { item: 'MSME Sector', zoho: live.contact ? extractMsmeSector(live.contact).raw : null, central: cmBefore?.msme_sector_raw || null, dataset: (viewAfter[vid] || {}).major_activity_zoho || null, form1: 'n/a (not a Form-1 column)' },
      { item: 'Bills Count (sync scope)', zoho: liveScopeBills.length, central: cBills.length, dataset: nowAfter.bills, form1: null },
      { item: 'Bills Amount (sync scope)', zoho: f1r2(liveScopeBills.reduce((s, b) => s + (Number(b.total) || 0), 0)), central: f1r2(cBills.reduce((s, b) => s + (Number(b.total) || 0), 0)), dataset: nowAfter.bills_amount, form1: null },
      { item: `Payments since ${winFrom}`, zoho: f1r2(live.pays.filter(p => (p.date || '') >= winFrom).reduce((s, p) => s + (Number(p.amount) || 0), 0)), central: f1r2(inBefore.central.payments.filter(p => p.vendor_id === vid).reduce((s, p) => s + (Number(p.amount) || 0), 0)), dataset: nowAfter.payments, form1: null },
      { item: 'Vendor Credits', zoho: f1r2(live.credits.filter(c => !MSME_F1_SKIP.has(c.status)).reduce((s, c) => s + (Number(c.total) || 0), 0)), central: f1r2(inBefore.central.credits.filter(c => c.vendor_id === vid && !MSME_F1_SKIP.has(c.status)).reduce((s, c) => s + (Number(c.total) || 0), 0)), dataset: nowAfter.credits, form1: null },
      { item: 'Net payable now (bills − unapplied)', zoho: nowLive, central: nowCentral.net, dataset: nowAfter.net, form1: null },
      ...halves.map(h => ({ item: `${h} paid / outstanding (cut-off ${after[h]?.cutoff_date || '—'})`, zoho: null, central: null, dataset: null,
        form1: after[h]?.status === 'live' ? `paid ₹${f1Inr(msmeF1RowAmounts(rowOf(after, h)).paid)} / outstanding ₹${f1Inr(msmeF1RowAmounts(rowOf(after, h)).outstanding)}` : after[h]?.status })),
    ];
    const txnMismatch = diffs.filter(x => x.status !== 'match');
    const firstMismatch = masterDiff.some(m => m.status !== 'match') || txnMismatch.length ? 'central_cache'
      : nowLive != null && Math.abs(nowLive - nowCentral.net) > 1 ? 'msme_dataset'
      : 'none';

    res.json({
      vendor_id: vid, vendor_name: live.contact?.contact_name || cmBefore?.vendor_name || '',
      fy, applied: !!apply, live_detail_calls: live.detailCalls,
      first_mismatch: firstMismatch,
      master: masterDiff,
      differences: { total: diffs.length, mismatched: txnMismatch.length, items: diffs },
      reconciliation: table,
      before: Object.fromEntries(halves.map(h => [h, { status: before[h].status, ...msmeF1RowAmounts(rowOf(before, h)) }])),
      after:  Object.fromEntries(halves.map(h => [h, { status: after[h].status,  ...msmeF1RowAmounts(rowOf(after, h)) }])),
      frozen_differences: frozen,
    });
  } catch (e) {
    console.error('msme-form1 recheck:', e.message);
    res.status(e.response?.status === 429 ? 429 : 500).json({ error: e.response?.data?.message || e.message });
  }
});

// GET ?fy&half[&live=1] — admin. Classifies every Micro/Small vendor:
// MATCH · MISMATCH · MISSING SOURCE DATA · MISSING MASTER DATA · DUPLICATE · NEEDS REVIEW.
// live=1 compares each vendor's net payable with Zoho (one paced /contacts/{id} per vendor).
app.get('/api/msme-form1/reconcile', authMiddleware, adminOnly, async (req, res) => {
  const { fy = '2026-27', half = 'H1', live } = req.query;
  try {
    const d = await readMsmeF1();
    const inp = await msmeF1Inputs();
    if (!inp.store) return res.status(409).json({ error: 'MSME Form-1 settlement data has not been built yet — run Sync Data first.' });
    const report = await msmeF1Build(fy, half, d, { inputs: inp });
    const cm = msmeF1VendorView(inp.store, inp.cmMeta?.data);
    const ds = msmeF1Dataset({ central: inp.central, store: inp.store, cm, vmSet: inp.vmSet });
    const vendorsById = new Map(inp.central.vendors.map(v => [v.contact_id, v]));
    const out = [];
    for (const vid of ds.mse) {
      const v = ds.V[vid];
      const row = report.rows?.find(r => r.vendor_id === vid) || null;
      const vrec = vendorsById.get(vid);
      const flags = [];
      if (!(cm[vid]?.msme_type)) flags.push('MISSING MASTER DATA: Enterprise Type blank in Zoho');
      if (!msmeF1UdyamNo(cm[vid])) flags.push('MISSING MASTER DATA: Udyam number blank in Zoho');
      if (row && !row.pan) flags.push('MISSING MASTER DATA: PAN');
      if (row?.warnings?.includes('allocation_pending')) flags.push('MISSING SOURCE DATA: payment/credit allocation not read');
      if (row?.warnings?.includes('settled_bill_not_found')) flags.push('MISSING SOURCE DATA: settled bill not in data');
      if (row?.warnings?.includes('settlement_mismatch')) flags.push('NEEDS REVIEW: settlements exceed bill total');
      const nums = {};
      for (const b of v?.bills.values() || []) if (b.bill_number) nums[b.bill_number] = (nums[b.bill_number] || 0) + 1;
      const dups = Object.entries(nums).filter(([, n]) => n > 1).map(([k]) => k);
      if (dups.length) flags.push(`DUPLICATE: bill number(s) ${dups.join(', ')}`);
      const now = msmeF1VendorNow(v, inp.store.coverage_from);
      let zohoNet = null;
      if (live) {
        try {
          const c = (await rptZohoGet(`/contacts/${vid}`)).contact || {};
          zohoNet = f1r2((c.outstanding_payable_amount || 0) - (c.unused_credits_payable_amount || 0));
          if (Math.abs(zohoNet - now.net) > 1) flags.unshift(`MISMATCH: Zoho net payable ${zohoNet} vs data ${now.net}`);
        } catch (e) {
          if (msmeF1Fatal(e)) { flags.push('NEEDS REVIEW: Zoho rate limit — live check stopped'); }
          else flags.push(`NEEDS REVIEW: live read failed (${e.message})`);
        }
      }
      const order = ['MISMATCH', 'DUPLICATE', 'MISSING SOURCE DATA', 'MISSING MASTER DATA', 'NEEDS REVIEW'];
      const cls = order.find(o => flags.some(f => f.startsWith(o))) || 'MATCH';
      out.push({
        vendor_id: vid, vendor_name: vrec?.contact_name || cm[vid]?.vendor_name || '',
        class: cls, flags, in_report: !!row, net_payable_now: now.net, zoho_net_payable_now: zohoNet,
        form1: msmeF1RowAmounts(row), notes: row?.notes || {},
      });
    }
    out.sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));
    const count = c => out.filter(x => x.class === c).length;
    res.json({
      fy, half, cutoff_date: report.cutoff_date, live: !!live,
      summary: {
        total_msme_vendors: out.length, matched: count('MATCH'), mismatched: count('MISMATCH'),
        missing_source_data: count('MISSING SOURCE DATA'), missing_master_data: count('MISSING MASTER DATA'),
        duplicates: count('DUPLICATE'), needs_review: count('NEEDS REVIEW'),
      },
      vendors: out,
    });
  } catch (e) {
    console.error('msme-form1 reconcile:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET ?fy&half — admin. Vendor coverage: every vendor whose Zoho contact carries a Udyam number
// and that had activity in the half (bill, payment or credit dated in it, or a bill still unpaid
// at its start) against the vendors Form-1 reports, with the reason for each one not reported.
app.get('/api/msme-form1/vendor-coverage', authMiddleware, adminOnly, async (req, res) => {
  const { fy = '2026-27', half = 'H1' } = req.query;
  try {
    const d = await readMsmeF1();
    const inp = await msmeF1Inputs();
    if (!inp.store?.complete_at) return res.status(409).json({ error: 'MSME Form-1 settlement data has not been built yet — run Sync Data first.' });
    const hD = msmeF1HalfDates(fy, half);
    if (!hD) return res.status(400).json({ error: 'Invalid FY or half' });
    const report = await msmeF1Build(fy, half, d, { inputs: inp });
    const S = hD.start, C = report.cutoff_date || hD.end;
    const { central, store, vmSet } = inp;
    const view = msmeF1VendorView(store, inp.cmMeta?.data);
    const ds = msmeF1Dataset({ central, store, cm: view, vmSet });
    const inH = dt => dt && dt >= S && dt <= C;
    const act = {};
    const mark = (vid, k) => { if (vid) (act[vid] = act[vid] || new Set()).add(k); };
    const bills = new Map([...Object.entries(store.bills || {}).map(([id, b]) => [id, b]),
      ...[...central.billsFy, ...central.billsOpen, ...central.billsOverdue].map(b => [b.bill_id, b])]);
    // Unpaid at the half start = still due after unapplied payments / credits are netted (as the
    // Zoho vendor statement shows it); bill-level balance is used only for vendors outside Form-1
    const dayBefore = localDate(new Date(new Date(S).getTime() - 86400000));
    const dueAtStart = new Set();
    for (const [vid, v] of Object.entries(ds.V)) {
      const r = msmeF1VendorSettle(v, dayBefore, ds.coverage_from);
      if ([...r.outC.values()].some(x => x > MSME_F1_EPS)) dueAtStart.add(vid);
    }
    for (const b of bills.values()) {
      if (MSME_F1_SKIP.has(b.status)) continue;
      if (inH(b.date)) mark(b.vendor_id, 'bill_in_half');
      else if (b.date && b.date < S && (ds.V[b.vendor_id] ? dueAtStart.has(b.vendor_id) : (Number(b.balance) || 0) > MSME_F1_EPS)) mark(b.vendor_id, 'unpaid_bill_from_before');
    }
    for (const p of central.payments) if (inH(p.date)) mark(p.vendor_id, 'payment_in_half');
    for (const c of central.credits) if (!MSME_F1_SKIP.has(c.status) && inH(c.date)) mark(c.vendor_id, 'credit_in_half');

    const rows = new Map((report.rows || []).map(r => [r.vendor_id, r]));
    const name = vid => central.vendors.find(v => v.contact_id === vid)?.contact_name || view[vid]?.vendor_name || vid;
    const udyamOwners = {};
    const zohoRef = [], notReported = [], medium = [], reportedWithoutUdyam = [];
    for (const [vid, e] of Object.entries(view)) {
      const u = msmeF1UdyamNo(e);
      if (!u) continue;
      (udyamOwners[u] = udyamOwners[u] || []).push(vid);
      if (!act[vid]) continue;
      const entry = { vendor_id: vid, vendor_name: name(vid), udyam_reg_no: e.udyam_reg_no, enterprise_type: e.msme_type || '',
                      activity: [...act[vid]], udyam_format_ok: /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(u) };
      zohoRef.push(entry);
      if ((e.msme_type || '').toLowerCase().includes('medium')) medium.push(entry);
      if (rows.has(vid)) continue;
      // Why an eligible vendor has no Form-1 line in this half
      const v = ds.V[vid];
      let reason = 'not in Form-1 data (check Recheck vendor)';
      if (v) {
        const r = msmeF1VendorSettle(v, C, ds.coverage_from);
        const anyBill = r.inScope.length > 0;
        if (!anyBill) reason = 'no bills dated on or before the cut-off — only payments / credits (advance) in the half';
        else reason = 'no amount paid in the half and nothing outstanding at the cut-off (bills settled before the half or by advance)';
      }
      notReported.push({ ...entry, reason });
    }
    for (const r of report.rows || []) if (!msmeF1UdyamNo(view[r.vendor_id])) reportedWithoutUdyam.push({ vendor_id: r.vendor_id, vendor_name: r.vendor_name, enterprise_type: r.msme_type });
    const duplicates = Object.entries(udyamOwners).filter(([, ids]) => ids.length > 1)
      .map(([u, ids]) => ({ udyam_reg_no: u, vendors: ids.map(id => ({ vendor_id: id, vendor_name: name(id), in_report: rows.has(id) })) }));
    const registerPending = store.vendor_register?.pending || 0;
    res.json({
      fy, half, period: { start: S, cutoff: C },
      summary: {
        zoho_udyam_vendors_with_activity: zohoRef.length,
        medium_enterprises_included: medium.length,
        eligible_vendors: zohoRef.length,
        reported_in_form1: report.vendor_count || 0,
        reported_with_udyam: (report.rows || []).length - reportedWithoutUdyam.length,
        reported_without_udyam: reportedWithoutUdyam.length,
        eligible_not_reported: notReported.length,
        duplicate_udyam_numbers: duplicates.length,
        vendor_register_size: Object.keys(store.vendors || {}).length,
        vendor_register_pending: registerPending,
      },
      not_reported: notReported.sort((a, b) => a.vendor_name.localeCompare(b.vendor_name)),
      medium_enterprises: medium.sort((a, b) => a.vendor_name.localeCompare(b.vendor_name)),
      reported_without_udyam: reportedWithoutUdyam,
      duplicates,
      zoho_reference: zohoRef.sort((a, b) => a.vendor_name.localeCompare(b.vendor_name)),
    });
  } catch (e) {
    console.error('msme-form1 coverage:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET ?fy&half — admin. Independent check of every MSME vendor against Zoho's own reports as at
// the cut-off: Vendor Balances (closing balance = bills + AP journals − unapplied payments/credits)
// and AP Aging Summary (bill date basis, bill-level ≤45 / >45 days). Read-only; nothing is changed.
//   CLOSING   : Form-1 (f)+(g) must equal Zoho closing balance (nil when the vendor is in advance)
//   AGEING    : with no unapplied payments / journals, (f) / (g) must equal Zoho's buckets exactly;
//               otherwise the difference must equal the unapplied amount knocked off (oldest first)
//               plus AP journals, which Zoho's bill-level ageing does not net.
async function msmeF1ZohoReport(p, params, key) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const d = await rptZohoGet(p, { ...params, page, per_page: 500 });
    out.push(d);
    if (!d.page_context?.has_more_page) return out;
  }
  throw new Error(`${p}: more than 50 pages`);
}

app.get('/api/msme-form1/zoho-check', authMiddleware, adminOnly, async (req, res) => {
  const { fy = '2026-27', half = 'H1' } = req.query;
  try {
    const d = await readMsmeF1();
    const inp = await msmeF1Inputs();
    if (!inp.store?.complete_at) return res.status(409).json({ error: 'MSME Form-1 settlement data has not been built yet — run Sync Data first.' });
    const report = await msmeF1Build(fy, half, d, { inputs: inp });
    if (report.status !== 'live') return res.status(409).json({ error: `Half is ${report.status}` });
    const C = report.cutoff_date;

    const balances = new Map();
    for (const pg of await msmeF1ZohoReport('/reports/vendorbalances', { to_date: C }, 'vendorbalances')) {
      for (const r of pg.vendorbalances || []) balances.set(r.vendor_id, r);
    }
    const ageing = new Map();
    for (const pg of await msmeF1ZohoReport('/reports/apagingsummary', { to_date: C, group_by: 'vendor' }, 'bills')) {
      for (const top of pg.bills?.group_list || []) for (const g of top.group_list || []) {
        const gt45 = (g.intervals || []).filter(i => /above-45/.test(i.interval)).reduce((s, i) => s + (Number(i.amount) || 0), 0);
        ageing.set(g.id, { total: Number(g.total) || 0, le45: f1r2((Number(g.total) || 0) - gt45), gt45: f1r2(gt45) });
      }
    }

    const view = msmeF1VendorView(inp.store, inp.cmMeta?.data);
    const ds = msmeF1Dataset({ central: inp.central, store: inp.store, cm: view, vmSet: inp.vmSet });
    const rows = new Map((report.rows || []).map(r => [r.vendor_id, r]));
    const out = [];
    for (const vid of ds.mse) {
      const row = rows.get(vid) || null;
      const zb = balances.get(vid) || null;
      const za = ageing.get(vid) || { total: 0, le45: 0, gt45: 0 };
      const zClose = zb ? f1r2(Math.max(0, Number(zb.bcy_balance) || 0)) : 0;
      if (!row && !zClose && !za.total) continue;          // nothing in Zoho or Form-1 for this vendor
      const f = row ? row.out_within45_amount : 0, g = row ? row.out_after45_amount : 0;
      const journalOut = (row?.bills_outstanding || []).filter(b => b.source === 'journal').reduce((s, b) => s + b.outstanding_amount, 0);
      const knocked = row?.notes?.unapplied_knocked_off || 0;
      const closingOk = Math.abs(f + g - zClose) <= 1;
      const exactAgeing = Math.abs(f - za.le45) <= 1 && Math.abs(g - za.gt45) <= 1;
      // Bill-level ageing + journals − amounts knocked off must give the netted Form-1 total
      const explained = Math.abs(za.total + journalOut - knocked - (f + g)) <= 1 || (zClose === 0 && f + g === 0);
      // Zoho's Vendor Balances report already reflects payments dated after to_date; its AP Aging
      // Summary is the true as-at position. Bills outstanding at the cut-off and paid after it
      // match the ageing exactly and differ from Vendor Balances by exactly those later payments.
      const v = ds.V[vid];
      const paidAfter = f1r2((v?.pays || []).filter(p => p.date > C)
        .reduce((s, p) => s + (p.alloc || []).reduce((t, a) => t + a.amount, 0), 0));
      const paidAfterOk = !closingOk && paidAfter > 0 && Math.abs(f + g - (zClose + paidAfter)) <= 1 && (exactAgeing || explained);
      const status = paidAfterOk ? 'MATCH (paid after cut-off)'
        : !closingOk ? 'MISMATCH' : exactAgeing ? 'MATCH' : explained ? 'MATCH (netted)' : 'REVIEW';
      out.push({
        vendor_id: vid, vendor_name: row?.vendor_name || view[vid]?.vendor_name || zb?.vendor_name || vid,
        enterprise_type: view[vid]?.msme_type || '', status,
        zoho: { closing_balance: zb ? Number(zb.bcy_balance) || 0 : 0, bill_balance: zb ? Number(zb.bill_balance) || 0 : 0,
                excess_payment: zb ? Number(zb.excess_payment) || 0 : 0, ageing_le45: za.le45, ageing_gt45: za.gt45 },
        form1: { out_within45: f, out_after45: g, outstanding: f1r2(f + g), knocked_off: knocked, journals: f1r2(journalOut), paid_after_cutoff: paidAfter, in_report: !!row },
      });
    }
    // Zoho vendors with a payable balance that the MSME register does not mark as MSME (information)
    const nonMsmeWithBalance = [...balances.values()].filter(b => !ds.mse.has(b.vendor_id) && (Number(b.bcy_balance) || 0) > 0).length;
    out.sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));
    const cnt = s => out.filter(x => x.status === s).length;
    res.json({
      fy, half, cutoff_date: C,
      summary: {
        vendors_checked: out.length, match: cnt('MATCH'), match_netted: cnt('MATCH (netted)'), match_paid_after_cutoff: cnt('MATCH (paid after cut-off)'), review: cnt('REVIEW'), mismatch: cnt('MISMATCH'),
        form1_outstanding: f1r2(out.reduce((s, x) => s + x.form1.outstanding, 0)),
        zoho_closing_balance: f1r2(out.reduce((s, x) => s + Math.max(0, x.zoho.closing_balance), 0)),
        non_msme_vendors_with_balance: nonMsmeWithBalance,
      },
      vendors: out,
    });
  } catch (e) {
    console.error('msme-form1 zoho-check:', e.message);
    res.status(e.response?.status === 429 ? 429 : 500).json({ error: e.response?.data?.message || e.message });
  }
});

// Save/update reason for a vendor (persists across refreshes; works even for frozen halves)
app.put('/api/msme-form1/reason', authMiddleware, async (req, res) => {
  try {
    const { fy, half, vendor_id, reason } = req.body;
    if (!fy || !half || !vendor_id) return res.status(400).json({ error: 'fy, half, vendor_id required' });
    const d = await readMsmeF1();
    const halfKey = `${fy}:${half}`;
    d.reasons = d.reasons || {};
    d.reasons[`${halfKey}:${vendor_id}`] = reason || '';
    // Also update in frozen snapshot if present
    if (d.frozen_halves?.[halfKey]) {
      const vRow = d.frozen_halves[halfKey].rows?.find(r => r.vendor_id === vendor_id);
      if (vRow) vRow.reason = reason || '';
    }
    await writeMsmeF1(d);
    cache.del(`msme-f1-${fy}-${half}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set / change / remove a vendor's manual Enterprise Type and Major Activity for Form-1.
// Per field: a value sets the override, empty clears it (Zoho value applies again); both empty =
// Reset to Zoho. Applies to every live half; frozen snapshots are not changed.
app.put('/api/msme-form1/classification', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { vendor_id, vendor_name } = req.body || {};
    if (!vendor_id) return res.status(400).json({ error: 'vendor_id required' });
    const type = req.body.msme_type ? String(req.body.msme_type).trim().toLowerCase() : null;
    const act  = req.body.major_activity ? String(req.body.major_activity).trim() : null;
    if (type && !MSME_F1_CLASS_TYPES.includes(type)) return res.status(400).json({ error: `Enterprise Type must be one of: ${MSME_F1_CLASS_TYPES.join(', ')}` });
    if (act && !MSME_F1_CLASS_ACTS.includes(act)) return res.status(400).json({ error: `Major Activity must be one of: ${MSME_F1_CLASS_ACTS.join(', ')}` });
    const d = await readMsmeF1();
    d.class_overrides = d.class_overrides || {};
    const prev = d.class_overrides[vendor_id] || null;
    const user = req.user?.username || req.user?.name || 'admin';
    const now = new Date().toISOString();
    if (type || act) {
      d.class_overrides[vendor_id] = {
        ...(type ? { msme_type: type } : {}), ...(act ? { major_activity: act } : {}),
        vendor_name: vendor_name || prev?.vendor_name || '', updated_at: now, updated_by: user,
      };
    } else delete d.class_overrides[vendor_id];
    const next = d.class_overrides[vendor_id] || null;
    d.audit_trail = (d.audit_trail || []).concat({ action: next ? 'classification_update' : 'classification_reset', vendor_id, user, timestamp: now, prev, next });
    await writeMsmeF1(d);
    cache.keys().filter(k => k.startsWith('msme-f1-')).forEach(k => cache.del(k));
    res.json({ ok: true, vendor_id, override: next });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/msme-form1/freeze', authMiddleware, adminOnly, async (req, res) => {
  const { fy, half, frozen_by, half_data } = req.body;
  if (!fy || !half || !half_data) return res.status(400).json({ error: 'fy, half, and half_data required' });
  try {
    const d = await readMsmeF1();
    const halfKey = `${fy}:${half}`;
    const user = frozen_by || req.user?.username || req.user?.name || 'admin';
    const now  = new Date().toISOString();
    d.frozen_halves = d.frozen_halves || {};
    d.frozen_halves[halfKey] = { ...half_data, status: 'frozen', frozen_at: now, frozen_by: user };
    d.audit_trail = (d.audit_trail || []).concat({
      action: 'freeze_half', fy, half, user, timestamp: now,
      totals: half_data.totals, vendor_count: half_data.vendor_count,
    });
    await writeMsmeF1(d);
    cache.del(`msme-f1-${fy}-${half}`);
    res.json({ ok: true, frozen_at: now, frozen_by: user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/msme-form1/unfreeze', authMiddleware, adminOnly, async (req, res) => {
  const { fy, half, reason, unfrozen_by } = req.body;
  if (!fy || !half) return res.status(400).json({ error: 'fy and half required' });
  try {
    const d = await readMsmeF1();
    const halfKey = `${fy}:${half}`;
    if (!d.frozen_halves?.[halfKey]) return res.status(404).json({ error: 'Half-year not frozen' });
    const user = unfrozen_by || req.user?.username || req.user?.name || 'admin';
    const now  = new Date().toISOString();
    delete d.frozen_halves[halfKey];
    d.audit_trail = (d.audit_trail || []).concat({ action: 'unfreeze_half', fy, half, user, timestamp: now, reason: reason || '' });
    await writeMsmeF1(d);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/msme-form1/audit', authMiddleware, adminOnly, async (req, res) => {
  try {
    const d = await readMsmeF1();
    res.json((d.audit_trail || []).slice().reverse().slice(0, 100));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/msme-form1/export', authMiddleware, express.json({ limit: '10mb' }), async (req, res) => {
  const { fy, half, half_label, rows = [], totals = {}, status, cutoff_date, filter_label } = req.body;
  // Zoho vendor master values as shown in the report (Enterprise Type capitalised as in Zoho's UI)
  const entType = t => { const s = String(t || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : 'Not Updated'; };
  try {
    const wb = XLSX.utils.book_new();
    const sheetData = [
      [`MSME Form-1 Report — ${half} FY ${fy} (${half_label || ''}) — Status: ${status || 'Live'} — Cut-off: ${cutoff_date || ''}` +
       (filter_label ? ` — MSME classification filter: ${filter_label}` : '')],
      [],
      ['', '', '', '', '', 'Payment', '', '', '', 'Outstanding', '', '', '', ''],
      [
        '(a) S.No.', '(b) Name of MSE Supplier', '(c) PAN of the Supplier',
        'MSME / Enterprise Type', 'Major Activity',
        '(d) Paid within 45 days — No.', '(d) Paid within 45 days — Amount (Rs.)',
        '(e) Paid after 45 days — No.',  '(e) Paid after 45 days — Amount (Rs.)',
        '(f) Outstanding ≤45 days — No.', '(f) Outstanding ≤45 days — Amount (Rs.)',
        '(g) Outstanding >45 days — No.', '(g) Outstanding >45 days — Amount (Rs.)',
        '(h) Reason for Delay / Outstanding',
      ],
      ...rows.map((r, i) => [
        i + 1, r.vendor_name, r.pan || '—',
        entType(r.msme_type), String(r.major_activity || '').trim() || 'Not Updated',
        r.paid_within45_count, r.paid_within45_amount,
        r.paid_after45_count,  r.paid_after45_amount,
        r.out_within45_count,  r.out_within45_amount,
        r.out_after45_count,   r.out_after45_amount,
        r.reason || '',
      ]),
      [],
      [
        'TOTAL', '', '', '', '',
        totals.paid_within45_count, totals.paid_within45_amount,
        totals.paid_after45_count,  totals.paid_after45_amount,
        totals.out_within45_count,  totals.out_within45_amount,
        totals.out_after45_count,   totals.out_after45_amount,
        '',
      ],
    ];

    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    ws['!cols'] = [
      { wch: 6 }, { wch: 38 }, { wch: 14 }, { wch: 14 }, { wch: 16 },
      { wch: 10 }, { wch: 20 }, { wch: 10 }, { wch: 20 },
      { wch: 10 }, { wch: 20 }, { wch: 10 }, { wch: 20 },
      { wch: 35 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, `Form-1 ${half} ${fy}`);

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="MSME_Form1_${fy}_${half}.xlsx"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GST — 180-DAY ITC REVERSAL MONITORING REPORT
// ═══════════════════════════════════════════════════════════════════════════════
// Tracks unpaid vendor bills against the GST Section 16(2) second-proviso 180-day
// payment condition. Only bills carrying a vendor GSTIN are in scope — bills from
// unregistered vendors have no ITC to reverse.
//   Report 1 — bills 0–7 days away from completing 180 days outstanding (still unpaid)
//   Report 2 — bills already outstanding beyond 180 days (still unpaid)
// ITC reversal is proportionate to the unpaid share of the bill (Rule 37):
//   GST Amount × (Balance Due ÷ Bill Amount), capped to [0, GST Amount].
// GST amount (tax_total) isn't on the Zoho bills LIST endpoint, so it's fetched once
// per bill via /bills/{id} and cached forever (bill amounts don't change after
// creation) through a rate-limited background queue (~1 call/1.2s, per Zoho's
// per-minute cap). Rows for bills not yet enriched show as "pending" rather than
// an approximated GST figure — a wrong number is worse than no number here.

const GST_DETAIL_KEY  = 'gst_bill_detail_cache';
const GST_DETAIL_FILE = path.join(__dirname, 'sync_data', 'gst_bill_detail_cache.json');
const GST_PAN_KEY     = 'gst_vendor_pan_cache';
const GST_PAN_FILE    = path.join(__dirname, 'sync_data', 'gst_vendor_pan_cache.json');

async function readGstDetailCache() {
  const c = await db.readJSON(GST_DETAIL_KEY, GST_DETAIL_FILE, null);
  return (c && c.data) ? c.data : {};
}
async function writeGstDetailCache(data) {
  _ensureSyncDir2();
  await db.writeJSON(GST_DETAIL_KEY, GST_DETAIL_FILE, { data, updated_at: new Date().toISOString() });
}
async function readGstPanCache() {
  const c = await db.readJSON(GST_PAN_KEY, GST_PAN_FILE, null);
  return (c && c.data) ? c.data : {};
}
async function writeGstPanCache(data) {
  _ensureSyncDir2();
  await db.writeJSON(GST_PAN_KEY, GST_PAN_FILE, { data, updated_at: new Date().toISOString() });
}

// ── Background enrichment queue for bill tax detail (rate-safe: ~1 call/1.2s) ──
const _gstDetailQueue = new Set();
let _gstQueueRunning = false;

function gstEnqueueDetail(billIds) {
  for (const id of billIds) _gstDetailQueue.add(id);
  if (!_gstQueueRunning) _gstProcessDetailQueue();
}

async function _gstProcessDetailQueue() {
  if (_gstQueueRunning) return;
  _gstQueueRunning = true;
  try {
    let cache = await readGstDetailCache();
    while (_gstDetailQueue.size > 0) {
      const id = _gstDetailQueue.values().next().value;
      _gstDetailQueue.delete(id);
      if (cache[id]) continue;
      try {
        const d = await zohoGet(`/bills/${id}`);
        const bill = d.bill || {};
        cache[id] = {
          sub_total:  bill.sub_total != null ? bill.sub_total : null,
          tax_total:  bill.tax_total != null ? bill.tax_total : null,
          total:      bill.total     != null ? bill.total     : null,
          bill_date:  bill.cf_vendor_bill_date_unformatted || null,
          fetched_at: new Date().toISOString(),
        };
        await writeGstDetailCache(cache);
      } catch (e) {
        console.error(`[gst] detail fetch failed for bill ${id}:`, e.response?.data?.message || e.message);
      }
      if (_gstDetailQueue.size > 0) await new Promise(r => setTimeout(r, 1200));
    }
  } finally {
    _gstQueueRunning = false;
  }
}

// ── Report computation ──────────────────────────────────────────────────────────
function gstDateToUTCms(dateStr) {
  const d = new Date(dateStr);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function gstUtcDateStr(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function gst180Status(daysOutstanding) {
  if (daysOutstanding > 180)  return 'Beyond 180 Days';
  if (daysOutstanding === 180) return '180 Days Completed';
  if (daysOutstanding >= 173) return 'Approaching 180 Days';
  return 'Within 180 Days';
}

// Bill-level GSTIN as captured by Zoho on the bill. Unregistered / overseas /
// out-of-scope treatments and blank or placeholder values ("-", "NA", …) don't qualify.
const GST_NO_GSTIN_TREATMENTS = new Set(['business_none', 'consumer', 'overseas', 'out_of_scope']);
function gstHasValidGstin(b) {
  if (GST_NO_GSTIN_TREATMENTS.has(b.gst_treatment)) return false;
  return /^\d{2}[A-Z0-9]{13}$/.test(String(b.gst_no || '').trim().toUpperCase());
}

function gstRound2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

// Proportionate ITC reversal = GST × (Balance Due ÷ Bill Amount), clamped to [0, GST].
// Returns null when the GST amount isn't known yet (bill detail still being fetched).
function gstItcReversal(gstAmount, billAmount, balanceDue) {
  if (gstAmount == null || billAmount == null) return null;
  if (billAmount <= 0 || gstAmount <= 0) return 0;
  const paid = billAmount - balanceDue;
  if (paid >= billAmount) return 0;           // nothing outstanding
  if (paid <= 0) return gstRound2(gstAmount); // wholly unpaid (or balance exceeds bill)
  return gstRound2(Math.min(gstAmount, Math.max(0, gstAmount * (balanceDue / billAmount))));
}

function buildGst180Rows(bills, detailCache, panCache, todayUTCms) {
  const rows = [];
  for (const b of bills) {
    if (!b.date || (b.balance || 0) <= 0) continue; // paid bills never appear in either report
    if (!gstHasValidGstin(b)) continue;              // no GSTIN → no ITC to monitor
    const postingUTCms    = gstDateToUTCms(b.date);
    const daysOutstanding = Math.round((todayUTCms - postingUTCms) / 86400000);
    const daysRemaining   = 180 - daysOutstanding;
    const approaching = daysRemaining >= 0 && daysRemaining <= 7;
    const overdue180  = daysOutstanding > 180;
    if (!approaching && !overdue180) continue;

    const det = detailCache[b.bill_id] || null;
    const hasDetail = !!det;
    const total = (hasDetail && det.total != null) ? det.total : (b.total || 0);
    let subTotal = null, gstAmount = null;
    if (hasDetail) {
      if (det.tax_total != null) gstAmount = det.tax_total;
      else if (det.sub_total != null) gstAmount = total - det.sub_total;
      if (det.sub_total != null) subTotal = det.sub_total;
      else if (det.tax_total != null) subTotal = total - det.tax_total;
    }

    const balanceDue  = b.balance || 0;
    const itcReversal = gstItcReversal(gstAmount, total, balanceDue);
    rows.push({
      bill_id: b.bill_id,
      vendor_id: b.vendor_id,
      vendor_name: b.vendor_name || '',
      pan: panCache[b.vendor_id]?.pan || '',
      gstin: String(b.gst_no).trim(),
      transaction_posting_date: b.date,
      bill_date: (hasDetail && det.bill_date) || b.date,
      bill_number: b.bill_number || '',
      sub_total: subTotal,
      gst_amount: gstAmount,
      bill_total: total,
      paid_amount: gstRound2(total - balanceDue),
      balance_due: balanceDue,
      outstanding_pct: total > 0 ? balanceDue / total : null,
      status: b.status || '',
      due_date_180: gstUtcDateStr(postingUTCms + 180 * 86400000),
      days_outstanding: daysOutstanding,
      days_remaining: daysRemaining,
      status180: gst180Status(daysOutstanding),
      bucket: approaching ? 'approaching' : 'overdue180',
      // Proportionate reversal on the unpaid share — shown as "Potential" in Report 1
      itc_reversal_amount: itcReversal,
      // Triggered once 180 days are completed — matches the workbook: =IF(M>=180, G×J/H, 0)
      itc_reversal_required: itcReversal == null ? null : (daysOutstanding >= 180 ? itcReversal : 0),
      pending_gst_amount: !hasDetail,
    });
  }
  return rows;
}

function buildGst180Summary(rows) {
  const approaching = rows.filter(r => r.bucket === 'approaching');
  const overdue      = rows.filter(r => r.bucket === 'overdue180');
  const sum = (arr, key) => gstRound2(arr.reduce((s, r) => s + (r[key] || 0), 0));
  return {
    total_tracked:                 rows.length,
    approaching_count:             approaching.length,
    overdue_count:                 overdue.length,
    basic_amount:                  sum(rows, 'sub_total'),
    approaching_gst_amount:        sum(approaching, 'gst_amount'),
    overdue_gst_amount:            sum(overdue, 'gst_amount'),
    potential_itc_reversal_amount: sum(approaching, 'itc_reversal_amount'),
    itc_reversal_required_amount:  sum(rows, 'itc_reversal_required'),
    pending_enrichment:            rows.filter(r => r.pending_gst_amount).length,
  };
}

// ── Excel export helpers ────────────────────────────────────────────────────────
// Real Excel date (serial number) from a YYYY-MM-DD string, so dates sort/filter in Excel
function gstExcelDate(dateStr) {
  if (!dateStr) return '';
  const ms = gstDateToUTCms(dateStr);
  return isNaN(ms) ? dateStr : (ms - Date.UTC(1899, 11, 30)) / 86400000;
}
function gstBillStatusLabel(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// One report sheet: same 17 columns, order and values as the dashboard table, plus a TOTAL row.
// Values are exported exactly as computed for the dashboard — no recalculation here.
function gst180Sheet(rows, itcHeader, itcKey) {
  const MONEY = '#,##0.00', DATE = 'dd mmm yyyy';
  // [header, value getter, number format, totalled?]
  const cols = [
    ['Vendor Name',               r => r.vendor_name],
    ['GSTIN',                     r => r.gstin],
    ['Bill #',                    r => r.bill_number],
    ['Txn Posting Date',          r => gstExcelDate(r.transaction_posting_date), DATE],
    ['Basic Invoice Amount (₹)',  r => r.sub_total,            MONEY, true],
    ['GST Amount (₹)',            r => r.gst_amount,           MONEY, true],
    ['Bill Amount (₹)',           r => r.bill_total,           MONEY, true],
    ['Paid Amount (₹)',           r => r.paid_amount,          MONEY, true],
    ['Balance Due (₹)',           r => r.balance_due,          MONEY, true],
    ['180-Day Due Date',          r => gstExcelDate(r.due_date_180), DATE],
    ['Days Outstanding',          r => r.days_outstanding],
    ['Days Remaining',            r => r.days_remaining],
    ['Status',                    r => r.status180],
    [itcHeader,                   r => r[itcKey],              MONEY, true],
    ['Outstanding %',             r => r.outstanding_pct,      '0.00%'],
    ['Vendor Bill Date',          r => gstExcelDate(r.bill_date), DATE],
    ['Zoho Bill Status',          r => gstBillStatusLabel(r.status)],
  ];
  const aoa = [cols.map(c => c[0])];
  for (const r of rows) aoa.push(cols.map(c => { const v = c[1](r); return v == null ? '' : v; }));
  aoa.push([]);
  aoa.push(cols.map((c, i) => i === 0 ? 'TOTAL' : i === 2 ? `${rows.length} bills`
    : c[3] ? gstRound2(rows.reduce((s, r) => s + (c[1](r) || 0), 0)) : ''));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let R = 1; R < aoa.length; R++) {
    cols.forEach((c, C) => {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (c[2] && cell && cell.t === 'n') cell.z = c[2];
    });
  }
  ws['!cols'] = [
    { wch: 34 }, { wch: 17 }, { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 14 },
    { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 10 },
    { wch: 20 }, { wch: 20 }, { wch: 12 }, { wch: 14 }, { wch: 14 },
  ];
  return ws;
}

app.get('/api/gst/180-report', authMiddleware, async (req, res) => {
  try {
    const [openResult, overdueResult] = await Promise.all([
      syncEngine.getSyncedOrFetch('bills_open',    () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Open' },    {})),
      syncEngine.getSyncedOrFetch('bills_overdue', () => zohoGetAll('/bills', 'bills', { filter_by: 'Status.Overdue' }, {})),
    ]);
    const billMap = {};
    for (const b of [...openResult.data, ...overdueResult.data]) billMap[b.bill_id] = b;
    const allBills = Object.values(billMap);

    const now = new Date();
    const todayUTCms = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

    // Cheap list-level pre-filter — only bills actually in scope get enriched
    const inWindow = allBills.filter(b => {
      if (!b.date || (b.balance || 0) <= 0) return false;
      const postingUTCms    = gstDateToUTCms(b.date);
      const daysOutstanding = Math.round((todayUTCms - postingUTCms) / 86400000);
      const daysRemaining   = 180 - daysOutstanding;
      return (daysRemaining >= 0 && daysRemaining <= 7) || daysOutstanding > 180;
    });
    const inScope = inWindow.filter(gstHasValidGstin);

    // Vendor PAN — fast synchronous fetch (contacts endpoint tolerates batch=15, no delay)
    const vendorIds = [...new Set(inScope.map(b => b.vendor_id).filter(Boolean))];
    const panCache  = await readGstPanCache();
    const missingVendors = vendorIds.filter(v => !panCache[v]);
    if (missingVendors.length) {
      for (let i = 0; i < missingVendors.length; i += 15) {
        const batch = missingVendors.slice(i, i + 15);
        await Promise.all(batch.map(async vid => {
          try {
            const c = await zohoGet(`/contacts/${vid}`);
            if (c.contact) panCache[vid] = { pan: (c.contact.pan_no || c.contact.cf_pan || '').trim(), vendor_name: c.contact.contact_name || '' };
          } catch (_) {}
        }));
      }
      await writeGstPanCache(panCache);
    }

    // Bill GST/tax detail — read persistent cache; queue misses for background fetch
    const detailCache = await readGstDetailCache();
    const missingDetailIds = inScope.map(b => b.bill_id).filter(id => !detailCache[id]);
    if (missingDetailIds.length) gstEnqueueDetail(missingDetailIds);

    const rows    = buildGst180Rows(inScope, detailCache, panCache, todayUTCms);
    const summary = buildGst180Summary(rows);

    res.json({
      generated_at: new Date().toISOString(),
      as_of_date:   gstUtcDateStr(todayUTCms),
      summary,
      report1: rows.filter(r => r.bucket === 'approaching').sort((a, b) => a.days_remaining - b.days_remaining),
      report2: rows.filter(r => r.bucket === 'overdue180').sort((a, b) => b.days_outstanding - a.days_outstanding),
      pending_enrichment: missingDetailIds.length,
      excluded_no_gstin: inWindow.length - inScope.length,
      data_source: openResult.source,
    });
  } catch (e) {
    console.error('gst-180-report:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/gst/export', authMiddleware, express.json({ limit: '10mb' }), async (req, res) => {
  const { report, rows = [], report1 = [], report2 = [], summary = {}, as_of_date, excluded_no_gstin } = req.body;
  try {
    const wb = XLSX.utils.book_new();
    let filename;
    if (report === 'approaching' || report === 'beyond') {
      // Single-report export — exactly the (filtered) rows currently shown in that report
      const approaching = report === 'approaching';
      const ws = approaching
        ? gst180Sheet(rows, 'Potential ITC Reversal (₹)', 'itc_reversal_amount')
        : gst180Sheet(rows, 'ITC Reversal Required (₹)', 'itc_reversal_required');
      XLSX.utils.book_append_sheet(wb, ws, approaching ? 'Approaching 180 Days' : 'Beyond 180 Days');
      filename = approaching ? 'GST_180_Day_Approaching_Report.xlsx' : 'GST_180_Day_Beyond_Report.xlsx';
    } else {
      // Full workbook — both reports + summary
      XLSX.utils.book_append_sheet(wb, gst180Sheet(report1, 'Potential ITC Reversal (₹)', 'itc_reversal_amount'), 'Approaching 180 Days');
      XLSX.utils.book_append_sheet(wb, gst180Sheet(report2, 'ITC Reversal Required (₹)', 'itc_reversal_required'), 'Beyond 180 Days');

      const sumRows = [
        [`GST Dashboard — 180-Day ITC Reversal Monitoring — As of ${as_of_date || ''}`],
        [],
        ['Metric', 'Value'],
        ['Bills Tracked (GSTIN vendors, 180-day window)',  summary.total_tracked],
        ['Invoices Approaching 180 Days',                   summary.approaching_count],
        ['Invoices Beyond 180 Days',                        summary.overdue_count],
        ['Basic Invoice Amount – All Tracked Bills (₹)',    summary.basic_amount || 0],
        ['GST Amount – Approaching 180 Days (₹)',           summary.approaching_gst_amount || 0],
        ['GST Amount – Beyond 180 Days (₹)',                summary.overdue_gst_amount || 0],
        ['Potential ITC Reversal – Approaching 180 Days (₹)', summary.potential_itc_reversal_amount || 0],
        ['ITC Reversal Required (₹)',                       summary.itc_reversal_required_amount || 0],
        ['Bills excluded – vendor without GSTIN',           excluded_no_gstin || 0],
        [],
        ['Notes'],
        ['Only bills carrying a vendor GSTIN are included. Bills from unregistered vendors or with a blank/placeholder GSTIN are excluded.'],
        ['Report 1 (ITC Reversal Review) lists unpaid invoices within 7 days of completing 180 days. Its reversal figure is indicative only — the reversal is not yet triggered.'],
        ['Report 2 (ITC Reversal Required) lists unpaid invoices outstanding beyond 180 days.'],
        ['ITC Reversal = GST Amount × (Balance Due ÷ Bill Amount), never below ₹0 or above the GST Amount. Fully paid = ₹0; fully unpaid = 100% of GST.'],
        ['Bill Amount is the Zoho Books bill total (net of TDS where TDS is deducted), so Basic Invoice Amount + GST may differ from Bill Amount.'],
        ['ITC Reversal Required includes any bill completing exactly 180 days today (listed in Report 1 with status "180 Days Completed").'],
        ['This is a live export from the GST Dashboard — figures reflect Zoho Books data as of the date above.'],
      ];
      const wsSum = XLSX.utils.aoa_to_sheet(sumRows);
      sumRows.forEach((row, R) => {
        const cell = wsSum[XLSX.utils.encode_cell({ r: R, c: 1 })];
        if (cell && cell.t === 'n' && String(row[0]).endsWith('(₹)')) cell.z = '#,##0.00';
      });
      wsSum['!cols'] = [{ wch: 52 }, { wch: 18 }];
      XLSX.utils.book_append_sheet(wb, wsSum, 'Summary');
      filename = `GST_180_Day_ITC_Reversal_Report_${as_of_date || ''}.xlsx`;
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Purchase: Project-wise PO Report ─────────────────────────────────────────
app.get('/api/purchase/po-report', cached('pur-po-report', 300, async () => {
  const pos = await zohoGetAll('/purchaseorders', 'purchaseorders', { filter_by: 'Status.All' }, {});

  const now     = new Date();
  const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

  function daysDiff(dateStr) {
    if (!dateStr) return 0;
    try {
      const d  = new Date(dateStr);
      const ms = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
      return Math.max(0, Math.floor((todayMs - ms) / 86400000));
    } catch { return 0; }
  }

  function extractProject(po) {
    const cfs = po.custom_fields || [];
    for (const cf of cfs) {
      if ((cf.label || '').toLowerCase().includes('project') && (cf.value || '').trim()) {
        return cf.value.trim();
      }
    }
    return (po.project_name || '').trim() || '';
  }

  function extractBranch(po) {
    // Try branch_name field first (some Zoho orgs support it)
    if (po.branch_name) return po.branch_name.trim();
    // Parse from PO number pattern: PO/{FY}/{BRANCH}/{NUM}
    const m = (po.purchaseorder_number || '').match(/^PO\/[\d-]+\/([A-Z]+)\//i);
    if (m) return m[1].toUpperCase();
    return '';
  }

  // Active statuses where stale PO (90+ days) warrants an alert
  const ALERT_STATUSES = new Set(['draft', 'pending_approval', 'approved', 'open', 'accepted', 'partially_billed']);
  const summary = {};

  const result = pos.map(po => {
    const status = (po.status || 'unknown').toLowerCase();
    const days   = daysDiff(po.date);
    summary[status] = (summary[status] || 0) + 1;
    const project = extractProject(po);
    const branch  = extractBranch(po);
    return {
      id:            po.purchaseorder_id,
      number:        po.purchaseorder_number || '',
      vendor_id:     po.vendor_id  || '',
      vendor_name:   po.vendor_name || '',
      status,
      date:          po.date || '',
      delivery_date: po.expected_delivery_date || po.delivery_date || '',
      total:         po.total || 0,
      created_time:  po.created_time || '',
      created_by:    po.created_by_name || po.submitted_by || '',
      project:       project || branch || 'Unassigned',
      branch,
      days_since:    days,
      is_alert:      ALERT_STATUSES.has(status) && days >= 90,
    };
  });

  return {
    pos:         result,
    summary,
    alert_count: result.filter(p => p.is_alert).length,
    total_pos:   result.length,
  };
}));

// ─── Vendor Unused Credits Aging Report ───────────────────────────────────────
// Uses unused_credits_payable_amount from contacts API (exact Zoho figure) for
// totals, and LIFO-distributes across 60-day aging buckets using credit dates.
// This matches the same approach as the AP aging endpoint.
app.get('/api/purchase/vendor-credits-aging', async (req, res) => {
  try {
    const today   = localDate(new Date());
    const todayMs = new Date(today).getTime();

    const BUCKET_SIZE  = 60;
    const BUCKET_COUNT = 12;

    const getBucket = (ageDays) => {
      if (ageDays === 0) return 0;
      return Math.min(Math.ceil(ageDays / BUCKET_SIZE) - 1, BUCKET_COUNT - 1);
    };

    const bucketLabels = Array.from({ length: BUCKET_COUNT }, (_, i) => {
      const from = i * BUCKET_SIZE;
      if (i === 0) return `0-${BUCKET_SIZE}`;
      if (i === BUCKET_COUNT - 1) return `${from + 1}+`;
      return `${from + 1}-${(i + 1) * BUCKET_SIZE}`;
    });

    // Fetch vendor contacts and all vendor credit notes first.
    // unused_credits_payable_amount on the contact is the authoritative total.
    const [vendorContacts, allCredits] = await Promise.all([
      activeVendors({ maxPages: 30 }),
      syncedAll('vendor_credits_all', () => zohoGetAll('/vendorcredits', 'vendor_credits', { filter_by: 'Status.All' }, { maxPages: 50 })),
    ]);

    console.log(`[vc-aging] contacts: ${vendorContacts.length}, credits: ${allCredits.length}`);

    // Build vendor info map: vendor_id → { name, category, unusedAmt }
    const vendorInfoMap = {};
    for (const c of vendorContacts) {
      const unusedAmt = c.unused_credits_payable_amount || 0;
      const cat = (c.cf_vendor_category_unformatted || c.cf_vendor_category || '').trim() || 'Uncategorized';
      vendorInfoMap[c.contact_id] = {
        vendor_id:   c.contact_id,
        vendor_name: c.contact_name || c.vendor_name || '',
        category:    cat,
        unusedAmt,
      };
    }

    // Build vendor → credit note list (exclude void)
    const vendorCreditsMap = {};
    let totalOpenCount = 0;
    for (const cr of allCredits) {
      if (!cr.vendor_id || !cr.date) continue;
      const st = (cr.status || '').toLowerCase();
      if (st === 'void') continue;
      totalOpenCount++;
      const ageDays = Math.max(0, Math.floor((todayMs - new Date(cr.date).getTime()) / 86400000));
      if (!vendorCreditsMap[cr.vendor_id]) vendorCreditsMap[cr.vendor_id] = [];
      vendorCreditsMap[cr.vendor_id].push({ date: cr.date, total: parseFloat(cr.total || 0), ageDays, credit_number: cr.vendor_credit_number || '', status: cr.status || '' });
    }

    // Fetch vendor payments per-vendor in parallel batches (15 at a time) for vendors with
    // unused credits. A global paginated fetch would miss old payments on large orgs because
    // Zoho returns all-vendor payments sorted newest-first; older records fall off page limits.
    // Per-vendor fetch ensures complete payment history regardless of org volume.
    const vendorPaymentsMap = {};
    const vendorsNeedingPayments = Object.keys(vendorInfoMap).filter(vId => vendorInfoMap[vId].unusedAmt > 0);
    const PMT_BATCH = 15;
    for (let bi = 0; bi < vendorsNeedingPayments.length; bi += PMT_BATCH) {
      const batch = vendorsNeedingPayments.slice(bi, bi + PMT_BATCH);
      await Promise.all(batch.map(async vId => {
        try {
          // 3 pages × 200 = up to 600 payments per vendor — enough for most histories
          const pmts = await zohoGetAll('/vendorpayments', 'vendorpayments', { vendor_id: vId }, { maxPages: 3 });
          for (const pmt of pmts) {
            if (!pmt.date) continue;
            const bal = parseFloat(pmt.balance || 0);
            if (bal <= 0) continue;
            const ageDays = Math.max(0, Math.floor((todayMs - new Date(pmt.date).getTime()) / 86400000));
            if (!vendorPaymentsMap[vId]) vendorPaymentsMap[vId] = [];
            vendorPaymentsMap[vId].push({
              date: pmt.date, total: bal, ageDays,
              credit_number: pmt.payment_number || '',
              status: 'Excess Payment',
            });
          }
        } catch (e) {
          console.warn(`[vc-aging] vendorpayments failed for ${vId}: ${e.message}`);
        }
      }));
    }
    const totalPmtsFetched = Object.values(vendorPaymentsMap).reduce((s, v) => s + v.length, 0);
    console.log(`[vc-aging] excess payments with balance: ${totalPmtsFetched} across ${Object.keys(vendorPaymentsMap).length} vendors`);

    // For each vendor with unused credit amount, distribute using LIFO:
    // Newest credits are the ones still outstanding (oldest get applied first).
    const vendorMap = {};
    for (const [vId, info] of Object.entries(vendorInfoMap)) {
      if (info.unusedAmt <= 0) continue;

      // Combine credit notes + excess payments, sort newest first (LIFO)
      const credits = [
        ...(vendorCreditsMap[vId] || []),
        ...(vendorPaymentsMap[vId] || []),
      ].sort((a, b) => b.date.localeCompare(a.date));

      const buckets = new Array(BUCKET_COUNT).fill(0);
      let remaining   = info.unusedAmt;
      let creditCount = 0;
      let oldestUsedDays = 0;
      const creditDetails = [];

      for (const cr of credits) {
        if (remaining <= 0) break;
        const take = Math.min(cr.total, remaining);
        if (take <= 0) continue;
        const bi = getBucket(cr.ageDays);
        buckets[bi] += take;
        remaining -= take;
        creditCount++;
        if (cr.ageDays > oldestUsedDays) oldestUsedDays = cr.ageDays;
        creditDetails.push({ credit_number: cr.credit_number, date: cr.date, total: cr.total, attributed: take, age_days: cr.ageDays, bucket_idx: bi, status: cr.status });
      }

      // If no credit dates available, place remainder in bucket 0 (current)
      if (remaining > 0) buckets[0] += remaining;

      vendorMap[vId] = {
        vendor_id:      vId,
        vendor_name:    info.vendor_name,
        category:       info.category,
        buckets,
        total:          info.unusedAmt,
        credit_count:   creditCount || credits.length,
        oldest_days:    oldestUsedDays,
        credit_details: creditDetails,
      };
    }

    const rows = Object.values(vendorMap).sort((a, b) => b.total - a.total);

    const summaryBuckets = new Array(BUCKET_COUNT).fill(0);
    let grandTotal = 0;
    let oldestDays = 0;
    for (const r of rows) {
      r.buckets.forEach((v, i) => { summaryBuckets[i] += v; });
      grandTotal += r.total;
      if (r.oldest_days > oldestDays) oldestDays = r.oldest_days;
    }

    const categories = [...new Set(rows.map(r => r.category))].sort();

    console.log(`[vc-aging] vendors with credits: ${rows.length}, grand total: ${grandTotal}`);

    res.json({
      as_of:           today,
      total_credits:   totalOpenCount,
      total_vendors:   rows.length,
      grand_total:     grandTotal,
      oldest_days:     oldestDays,
      bucket_labels:   bucketLabels,
      summary_buckets: summaryBuckets,
      categories,
      rows,
    });
  } catch (e) {
    console.error('[vendor-credits-aging]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Vendor Payment Report ────────────────────────────────────────────────────
// Payments against bills vs advances against POs, with PO, project and categories. Synced by the
// stage-4 entity below (server/vendor-payment-report.js): its own copy of payments, POs and the
// previous FY's bills, read once and then kept up to date with only what changed in Zoho. The
// endpoints only read what it built — viewing the report or changing its period never calls Zoho.
const vprLib = require('./vendor-payment-report');
const vendorPaymentReport = vprLib.create({
  db, syncEngine, pacedGet: rptZohoGet, isFatal: msmeF1Fatal, ensureDir: _ensureSyncDir2, isVercel: IS_VERCEL,
});
syncEngine.registerEntity('vendor_payment_report', {
  label: 'Vendor Payment Report', stage: 4, kind: 'derived',
  path: '/vendorpayments, /purchaseorders, /bills (+ details)',
  description: 'Vendor payments of the previous and current FY: against bill or advance (with / without PO), PO, Project_Details, Sub-Category, Project Sub Category. Own copy of payments, POs and previous-FY bills: read once, then only changes (last_modified_time), checked against Zoho record counts and vendor balances.',
  run: args => vendorPaymentReport.run(args),
});
for (const k of ['vendors_all', 'bills_fy', 'vendor_payments_fy']) {
  const def = syncEngine.ENTITY_DEFS[k];
  if (def) def.dependents = [...new Set([...(def.dependents || []), 'vendor_payment_report'])];
}

// ?from=YYYY-MM-DD&to=YYYY-MM-DD (payment date). ready:false until the first build has published rows.
// A year of rows is ~2 MB of JSON, so it is sent gzipped when the browser accepts it.
app.get('/api/purchase/vendor-payment-report', async (req, res) => {
  try {
    const d = syncEngine.getCurrentDates();
    const [store, status] = await Promise.all([vendorPaymentReport.current(), vendorPaymentReport.status()]);
    if (!store) return res.json({ ready: false, today: d.today, status });
    const ymd = s => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null);
    const from = ymd(req.query.from) || d.fyStart;
    const to   = ymd(req.query.to) || d.today;
    // rows before complete_from wait for the previous FY's bills (first build only)
    const rows = store.rows.filter(r => r.date >= from && r.date <= to && r.date >= (store.complete_from || ''));
    const [notes, u] = await Promise.all([vendorPaymentReport.notesOf(rows), vprUser(req)]);
    const body = JSON.stringify({
      ready: true, from, to, today: d.today,
      window_from: store.window_from, window_to: store.window_to, complete_from: store.complete_from,
      built_at: store.built_at, pending: store.pending || {}, status,
      rows, notes,   // notes: bill uploads and remarks, by payment
      rights: { user_id: u?.id || null, admin: !!u?.admin, purchase: !!u?.purchase, accounts: !!u?.accounts },
    });
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      return res.send(require('zlib').gzipSync(body));
    }
    res.type('json').send(body);
  } catch (e) {
    console.error('[vendor-payment-report]', e.message);
    res.status(500).json({ error: e.message });
  }
});
// Sync state for the report's status line (polled while it builds or refreshes)
app.get('/api/purchase/vendor-payment-report/status', async (req, res) => {
  try {
    res.json(await vendorPaymentReport.status());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// Refresh button: a sync run of this report — checks Zoho only for what changed since the last sync
app.post('/api/purchase/vendor-payment-report/refresh', async (req, res) => {
  try {
    res.json(await vendorPaymentReport.refresh());
  } catch (e) {
    console.error('[vendor-payment-report] refresh:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Bill uploads and remarks. Who may change them is set per user in User Settings → Purchase &
// Payables ("Vendor Payment Report – Purchase Team / – Accounts Team"); unlike the view rights, a
// right not ticked is not granted. Admins have both.
async function vprUser(req) {
  const u = (await loadUsers()).find(x => String(x.id) === String(req.user?.id));
  if (!u || u.active === false) return null;
  const admin = u.role === 'admin';
  const p = u.permissions?.purchase;
  const on = k => admin || !!(p?.enabled && p.sections?.[k] === true);
  return { id: String(u.id), name: u.name || u.username, admin, purchase: on('vpr_purchase_team'), accounts: on('vpr_accounts_team') };
}
const VPR_UPLOADS = path.join(__dirname, 'vpr-bill-uploads');
const VPR_MAX_MB = IS_VERCEL ? 4 : 20;   // Vercel takes at most ~4.5 MB per request
const vprBillUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: VPR_MAX_MB * 1024 * 1024, files: 1 } });
const vprPaymentId = s => (/^\d{5,25}$/.test(String(s || '')) ? String(s) : null);   // Zoho IDs only (used in paths)
const vprTeamName = t => (t === 'purchase' ? 'Purchase' : 'Accounts');

app.post('/api/purchase/vendor-payment-report/bills/:id', (req, res, next) => {
  vprBillUpload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `The file must be under ${VPR_MAX_MB} MB` : err.message });
    next();
  });
}, async (req, res) => {
  try {
    const u = await vprUser(req);
    if (!u?.purchase) return res.status(403).json({ error: 'Uploading bills needs "Vendor Payment Report – Purchase Team" in User Settings' });
    const id = vprPaymentId(req.params.id);
    if (!id || !(await vendorPaymentReport.hasPayment(id))) return res.status(404).json({ error: 'Payment not found in the report' });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const type = vprLib.BILL_TYPES[ext];
    if (!type) return res.status(400).json({ error: 'Upload the bill as a PDF, an image (JPG, PNG …), Excel or Word file' });
    const base = path.basename(req.file.originalname, path.extname(req.file.originalname)).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'bill';
    const fileId = `${Date.now()}-${base}${ext}`;
    if (fileStore.enabled) await fileStore.save(`vpr-bill-uploads/${id}/${fileId}`, req.file.buffer, type);
    else {
      fs.mkdirSync(path.join(VPR_UPLOADS, id), { recursive: true });
      fs.writeFileSync(path.join(VPR_UPLOADS, id, fileId), req.file.buffer);
    }
    res.json({ note: await vendorPaymentReport.addBill(id, { id: fileId, name: req.file.originalname, size: req.file.size, type }, u) });
  } catch (e) {
    console.error('[vendor-payment-report] bill upload:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.delete('/api/purchase/vendor-payment-report/bills/:id/:fileId', async (req, res) => {
  try {
    const u = await vprUser(req);
    const id = vprPaymentId(req.params.id);
    if (!u || !id) return res.status(403).json({ error: 'Not allowed' });
    res.json({ note: await vendorPaymentReport.removeBill(id, String(req.params.fileId), u) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.put('/api/purchase/vendor-payment-report/remarks/:id', async (req, res) => {
  try {
    const team = req.body?.team;
    if (!['purchase', 'accounts'].includes(team)) return res.status(400).json({ error: 'Unknown remark column' });
    const u = await vprUser(req);
    if (!u?.[team]) return res.status(403).json({ error: `${vprTeamName(team)} Team Remarks need "Vendor Payment Report – ${vprTeamName(team)} Team" in User Settings` });
    const id = vprPaymentId(req.params.id);
    if (!id || !(await vendorPaymentReport.hasPayment(id))) return res.status(404).json({ error: 'Payment not found in the report' });
    res.json({ note: await vendorPaymentReport.setRemark(id, team, req.body?.text, u) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
// Opens an uploaded bill (…/file/… links carry the login token in the query string)
app.get('/api/purchase/vendor-payment-report/file/:id/:fileId', async (req, res) => {
  try {
    const id = vprPaymentId(req.params.id);
    const f = id && await vendorPaymentReport.billFile(id, String(req.params.fileId));
    if (!f) return res.status(404).send('Not found');
    const inline = /^(application\/pdf|image\/)/.test(f.type);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    if (fileStore.enabled) {
      if (!(await fileStore.send(res, `vpr-bill-uploads/${id}/${f.id}`))) res.status(404).send('Not found');
      return;
    }
    const fp = path.join(VPR_UPLOADS, id, f.id);
    if (!path.resolve(fp).startsWith(path.resolve(VPR_UPLOADS) + path.sep) || !fs.existsSync(fp)) return res.status(404).send('Not found');
    res.setHeader('Content-Type', f.type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(fp);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ─── Bills Missing Attachment ─────────────────────────────────────────────────
app.get('/api/purchase/bills-missing-attachment', cached('pur-bills-no-attach', 1800, async () => {
  const { start, end } = getFYRange();

  // Fetch all bills for current FY (all statuses)
  const bills = await zohoGetAll(
    '/bills', 'bills',
    { filter_by: 'Status.All' },
    { dateFrom: start, dateTo: end }
  );

  // Filter bills missing attachment; exclude Volopay and PURCHASEBILL bill numbers
  const missing = bills.filter(b => {
    if (b.has_attachment) return false;
    const num = (b.bill_number || '').trim();
    if (/^volopay/i.test(num))      return false;
    if (/^purchasebill/i.test(num)) return false;
    return true;
  });

  const mapped = missing.map(b => ({
    bill_id:      b.bill_id     || '',
    bill_number:  b.bill_number || '—',
    vendor_name:  b.vendor_name || '—',
    date:         b.date        || '',
    due_date:     b.due_date    || '',
    total:        b.total       || 0,
    balance:      b.balance     || 0,
    status:       b.status      || '',
    branch_name:  b.branch_name || '—',
    account_name: b.account_name || '—',
    // category: prefer custom field, fall back to account_name
    category: (b.cf_category_unformatted || b.cf_category || b.account_name || 'Uncategorized').trim(),
  }));

  // Group by category
  const grouped = {};
  mapped.forEach(b => {
    const cat = b.category || 'Uncategorized';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(b);
  });

  // Sort bills within each group by date descending
  Object.values(grouped).forEach(arr => arr.sort((a, b) => (b.date || '').localeCompare(a.date || '')));

  // Build category summary sorted by bill count desc
  const categories = Object.entries(grouped)
    .map(([category, catBills]) => ({
      category,
      count:        catBills.length,
      total_amount: catBills.reduce((s, b) => s + b.total, 0),
      bills:        catBills,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    total_missing:  missing.length,
    total_fetched:  bills.length,
    total_amount:   missing.reduce((s, b) => s + b.total, 0),
    categories,
    fy_range: { start, end },
  };
}));

// ─── Foreign Exchange Earnings & Outgo (live from Zoho Books) ─────────────────
// "Earned" = non-INR invoices (foreign currency billed to clients = actual inflows).
// "Outgo"  = non-INR bills    (foreign currency billed by vendors = actual outflows).
// Zoho's invoice API does not sort strictly by date and ignores date_start/date_end.
// We must fetch ALL pages and filter client-side to avoid missing data.
const FX_FY_RANGES = {
  fy2526: { start: '2025-04-01', end: '2026-03-31' },
  fy2627: { start: '2026-04-01', end: '2027-03-31' },
};
const FX_EXCLUDED_STATUSES = new Set(['void', 'draft']);
// Stop scanning pages when ALL items are older than this — covers both FY2526 and FY2627
const FX_PAGE_CUTOFF = '2025-03-01';

async function fetchAllItemsFX(endpoint, listKey, extraParams) {
  let page = 1;
  const all = [];
  while (true) {
    const data = await zohoGet(endpoint, { ...extraParams, page, per_page: 200 });
    const items = data[listKey] || [];
    if (items.length === 0) break;
    all.push(...items);
    if (items.every(i => !i.date || i.date < FX_PAGE_CUTOFF)) break;
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

// Build a Set of invoice_ids that have had a credit note applied to them
async function fetchCreditNotedInvoiceIds() {
  const excluded = new Set();
  let page = 1;
  while (true) {
    const data = await zohoGet('/creditnotes', { per_page: 200, page });
    const items = data.creditnotes || [];
    if (!items.length) break;
    // Only process non-INR credit notes (only those affect our FX invoices)
    const nonInr = items.filter(cn => (cn.currency_code || 'INR').toUpperCase() !== 'INR');
    for (const cn of nonInr) {
      try {
        const detail = await zohoGet('/creditnotes/' + cn.creditnote_id);
        const d = detail.creditnote;
        if (!d) continue;
        // invoices_credited = array of invoices this credit note was applied to
        if (Array.isArray(d.invoices_credited)) {
          for (const inv of d.invoices_credited) {
            if (inv.invoice_id) excluded.add(inv.invoice_id);
          }
        }
        // Also exclude the source invoice the credit note was raised against
        if (d.invoice_id) excluded.add(d.invoice_id);
      } catch (_) {}
    }
    if (items.every(i => !i.date || i.date < FX_PAGE_CUTOFF)) break;
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return excluded;
}

function groupFXByFY(items, dateStart, dateEnd, excludedIds) {
  const groups = {};
  for (const item of items) {
    const d = item.date;
    if (!d || d < dateStart || d > dateEnd) continue;
    if (FX_EXCLUDED_STATUSES.has((item.status || '').toLowerCase())) continue;
    if (excludedIds && excludedIds.has(item.invoice_id || item.bill_id)) continue;
    const cc = (item.currency_code || 'INR').toUpperCase();
    if (cc === 'INR') continue;
    groups[cc] = Math.round(((groups[cc] || 0) + (Number(item.total) || 0)) * 100) / 100;
  }
  return groups;
}

app.get('/api/forex/live', cached('forex-live', 3600, async () => {
  // Fetch all invoice/bill pages and credit-noted invoice IDs in parallel
  const [allInvoices, allBills, excludedInvoiceIds] = await Promise.all([
    fetchAllItemsFX('/invoices', 'invoices', {}).catch(() => []),
    fetchAllItemsFX('/bills',    'bills',    { filter_by: 'Status.All' }).catch(() => []),
    fetchCreditNotedInvoiceIds().catch(() => new Set()),
  ]);

  const result = {};
  for (const [fy, { start, end }] of Object.entries(FX_FY_RANGES)) {
    result[fy] = {
      earned: groupFXByFY(allInvoices, start, end, excludedInvoiceIds),
      outgo:  groupFXByFY(allBills,    start, end, new Set()),
    };
  }
  return result;
}));

// ─── Operational Data (FY 2026-27 quarterly + YTD, live from Zoho) ───────────
// Seat snapshot = invoice line-item cf_no_of_seat for last month of each quarter.
// Future quarters with no invoices return null (frontend shows "—").
app.get('/api/kpi/operational-data', cached('operational-data', 3600, async () => {
  const { totalSeats, totalArea } = readBranchConfig();
  const today  = localDate(new Date());
  const fyEnd  = '2027-03-31';
  const fetchEnd = today <= fyEnd ? today : fyEnd;

  // All FY 2026-27 invoice summaries
  const allInv = await syncedRange('invoices_fy', '2026-04-01', fetchEnd, () => zohoGetAll('/invoices', 'invoices',
    { filter_by: 'Status.All' },
    { dateFrom: '2026-04-01', dateTo: fetchEnd }
  ));

  // Seat snapshot for a calendar month (only if invoices exist for that month)
  async function seatSnapshot(monthPrefix) {
    const monthInv = allInv.filter(inv => inv.date && inv.date.startsWith(monthPrefix));
    if (monthInv.length === 0) return null;
    let occupied = 0;
    const BATCH = 10;
    for (let i = 0; i < monthInv.length; i += BATCH) {
      let fetched = false;
      await Promise.all(monthInv.slice(i, i + BATCH).map(async inv => {
        const s = await invoiceSeats(inv);
        if (!s) return;
        if (s.fetched) fetched = true;
        occupied += s.seats;
      }));
      if (fetched && i + BATCH < monthInv.length) await new Promise(r => setTimeout(r, 1000));
    }
    return Math.round(occupied);
  }

  // Fetch seat snapshots only for quarter-end months already in the past
  await loadInvoiceSeats();
  const [q1Seats, q2Seats, q3Seats, q4Seats] = await Promise.all([
    today >= '2026-06-01' ? seatSnapshot('2026-06') : null,
    today >= '2026-09-01' ? seatSnapshot('2026-09') : null,
    today >= '2026-12-01' ? seatSnapshot('2026-12') : null,
    today >= '2027-03-01' ? seatSnapshot('2027-03') : null,
  ]);
  await saveInvoiceSeats();

  // Latest available quarter-end seat count for YTD
  const ytdSeats = q4Seats ?? q3Seats ?? q2Seats ?? q1Seats ?? null;

  function calcPeriod(start, end, seats) {
    const inv = allInv.filter(i => i.date >= start && i.date <= end);
    if (inv.length === 0) return null; // future quarter — no data yet
    const clients = new Set(), managed = new Set(), cowork = new Set();
    for (const i of inv) {
      const name = i.customer_name || 'Unknown';
      const cat  = (i.cf_invoice_category || '').toLowerCase();
      clients.add(name);
      if (cat.includes('managed'))                          managed.add(name);
      else if (cat.includes('co') || cat.includes('work')) cowork.add(name);
    }
    return {
      total_clients:    clients.size,
      managed_offices:  managed.size,
      coworking_spaces: cowork.size,
      occupied_seats:   seats,
      occupancy_pct:    (seats != null && totalSeats > 0)
        ? Math.round((seats / totalSeats) * 10000) / 100
        : null,
      built_up_area:    totalArea,
    };
  }

  return {
    periods: {
      q1:  calcPeriod('2026-04-01', '2026-06-30', q1Seats),
      q2:  calcPeriod('2026-07-01', '2026-09-30', q2Seats),
      q3:  calcPeriod('2026-10-01', '2026-12-31', q3Seats),
      q4:  calcPeriod('2027-01-01', '2027-03-31', q4Seats),
      ytd: calcPeriod('2026-04-01', fetchEnd,      ytdSeats),
    },
    total_seats: totalSeats,
    total_area:  totalArea,
  };
}));

// ─── Payroll Dashboard ─────────────────────────────────────────────────────────
// Source: single consolidated workbook "Group Salary Sheet_24-09-26.xlsx".
//   - "Group Salary Sheet_F.Y. 2026-27" sheet → all reports except Captive
//   - "Captive F.Y. 2026-27" sheet            → Captive Billing report
const PAYROLL_BASE     = path.join(__dirname, '..', 'Compliance & Payroll');
const PAYROLL_WORKBOOK = path.join(PAYROLL_BASE, 'Group Salary Sheet_24-09-26.xlsx');
const GROUP_SHEET_NAME = 'Group Salary Sheet_F.Y. 2026-27';
const CAPTIVE_SHEET_NAME = 'Captive F.Y. 2026-27';

const COMPANY_NORMALIZE = {
  'devx':    'Dev Accelerator Limited',
  'neddle':  'Neddle And Thread Designs LLP',
  'saasjoy': 'Saasjoy Solutions Pvt Ltd',
  'eezily':  'Eezily Network Pvt Ltd',
};
function normalizeCompany(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return COMPANY_NORMALIZE[key] || String(raw || '').trim();
}

// ── Main payroll data: one row per employee per payroll month ─────────────────
function readGroupSalaryData() {
  if (db.USE_DB ? !workbooks.stored('payroll') : !fs.existsSync(PAYROLL_WORKBOOK)) return [];
  const wb = workbooks.read('payroll', PAYROLL_WORKBOOK);
  const ws = wb.Sheets[GROUP_SHEET_NAME];
  if (!ws) return [];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  // Find header row (row containing "Employee Number")
  let hi = -1;
  for (let r = 0; r < Math.min(raw.length, 10); r++) {
    if (raw[r] && raw[r].some(c => c && String(c).trim() === 'Employee Number')) { hi = r; break; }
  }
  if (hi === -1) return [];

  const colMap = {};
  raw[hi].forEach((h, i) => { if (h) colMap[String(h).trim()] = i; });

  const get = (row, key) => {
    const idx = colMap[key] ?? -1;
    if (idx < 0 || row[idx] == null) return '';
    return String(row[idx]).trim();
  };
  const getNum = (row, key) => {
    const idx = colMap[key] ?? -1;
    if (idx < 0 || row[idx] == null) return 0;
    const v = row[idx];
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  };

  const allRows = [];
  for (let r = hi + 1; r < raw.length; r++) {
    const row = raw[r];
    const empNum  = get(row, 'Employee Number');
    const empName = get(row, 'Employee Name');
    if (!empNum || !empName || empNum.toLowerCase().startsWith('generated')) continue;

    // "Payroll Month" is an Excel date serial — first-of-month
    const pmIdx = colMap['Payroll Month'];
    const pmRaw = pmIdx != null ? row[pmIdx] : null;
    if (typeof pmRaw !== 'number') continue;
    const d = XLSX.SSF.parse_date_code(pmRaw);
    if (!d || !d.y) continue;
    const monthKey = `${d.y}-${String(d.m).padStart(2, '0')}`;

    const basic        = getNum(row, 'Basic');
    const pf_employer  = getNum(row, 'PF - Employer');
    const esi_employer = getNum(row, 'ESI Employer');
    const pf_employee  = getNum(row, 'PF Employee');
    const esi_employee = getNum(row, 'ESI Employee');
    const professional_tax = getNum(row, 'Professional Tax');
    // EPS (AC-10) = 8.33% of basic, capped at ₹1,250 (only when PF is applicable)
    const eps          = pf_employer > 0 ? Math.min(Math.round(basic * 0.0833), 1250) : 0;
    const epf_employer = Math.max(0, pf_employer - eps);   // AC-1 (actual EPF)

    allRows.push({
      company: normalizeCompany(get(row, 'Company Name')),
      month: monthKey,
      emp_number:    empNum,
      emp_name:      empName,
      category:      get(row, 'Category( Promoter/ KMP/SMP/Relative)'),
      branch:        get(row, 'Branch ') || get(row, 'Branch'),
      captive:       get(row, 'Captive (Y/N)').toLowerCase() === 'yes' ? 'Yes' : 'No', // collapses stray "0"/blank into a clean No
      department:    get(row, 'Department'),
      job_title:     get(row, 'Job Title'),
      gross:         getNum(row, 'Gross(A)'),
      net_pay:       getNum(row, 'Net Pay(A-B-C)'),
      total_net_pay: getNum(row, 'Total Net Pay(A-B-C+D+E+F)'),
      basic, pf_employer, esi_employer, pf_employee, esi_employee,
      professional_tax, eps, epf_employer,
    });
  }
  return allRows;
}

// ── Captive salary: one row per captive employee, wide month-by-month layout ──
// Layout: Sr No | Employee ID | Employee Name | DOJ | DOE | Designation | Department
//         | <12 month gross cols> | Total | <12mo % block per company> x N companies | ...
// The 12-month % blocks are verified against the sheet's own "Total_<Company>" labels
// and cross-checked (gross × % sums back to the sheet's own quarterly subtotal row).
function readCaptiveSalaryData() {
  if (db.USE_DB ? !workbooks.stored('payroll') : !fs.existsSync(PAYROLL_WORKBOOK)) return { employees: [], monthKeys: [], companyOrder: [] };
  const wb = workbooks.read('payroll', PAYROLL_WORKBOOK);
  const ws = wb.Sheets[CAPTIVE_SHEET_NAME];
  if (!ws) return { employees: [], monthKeys: [], companyOrder: [] };
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  let hi = -1;
  for (let r = 0; r < Math.min(raw.length, 10); r++) {
    if (raw[r] && raw[r].some(c => c && String(c).trim() === 'Employee ID')) { hi = r; break; }
  }
  if (hi === -1) return { employees: [], monthKeys: [], companyOrder: [] };
  const header = raw[hi];

  const totalIdx = header.findIndex(h => String(h || '').trim() === 'Total');
  if (totalIdx === -1) return { employees: [], monthKeys: [], companyOrder: [] };

  const monthCols = [];
  for (let i = 7; i < totalIdx; i++) monthCols.push(i);
  const toMonthKey = serial => {
    if (typeof serial !== 'number') return null;
    const d = XLSX.SSF.parse_date_code(serial);
    return d && d.y ? `${d.y}-${String(d.m).padStart(2, '0')}` : null;
  };
  const monthKeys = monthCols.map(i => toMonthKey(header[i]));

  // Company billing order discovered from the sheet's own "Total_<Company>" labels
  const companyOrder = [];
  for (let i = totalIdx + 1; i < header.length; i++) {
    const h = header[i];
    if (typeof h === 'string' && h.startsWith('Total_')) {
      const name = h.slice(6);
      if (!companyOrder.includes(name)) companyOrder.push(name);
    }
  }
  const pctBlockStart = totalIdx + 1;
  const pctBlocks = companyOrder.map((co, ci) => ({
    company: co,
    cols: monthCols.map((_, mi) => pctBlockStart + ci * 12 + mi),
  }));

  const employees = [];
  for (let r = hi + 1; r < raw.length; r++) {
    const row = raw[r];
    const empId = row[1];
    if (!empId) continue;
    const months = {};
    monthCols.forEach((ci, mi) => { if (monthKeys[mi]) months[monthKeys[mi]] = row[ci] || 0; });
    const pctByCompanyByMonth = {};
    pctBlocks.forEach(b => {
      pctByCompanyByMonth[b.company] = {};
      b.cols.forEach((ci, mi) => { if (monthKeys[mi]) pctByCompanyByMonth[b.company][monthKeys[mi]] = row[ci] || 0; });
    });
    employees.push({
      emp_id: String(empId).trim(),
      emp_name: row[2] || '',
      department: row[6] || '',
      designation: row[5] || '',
      months,
      total: row[totalIdx] || 0,
      pctByCompanyByMonth,
    });
  }
  return { employees, monthKeys: monthKeys.filter(Boolean), companyOrder };
}

// ── PF / ESIC / PT quarterly summary — aggregated straight from payroll rows ──
function buildPfEsicPt(rows) {
  const map = {};
  for (const r of rows) {
    const key = `${r.month}|${r.company}`;
    if (!map[key]) map[key] = { month: r.month, company: r.company, esic_employer: 0, eps_ac10: 0, epf_ac01: 0, total_pf: 0, total_esic: 0, total_pt: 0 };
    const m = map[key];
    m.esic_employer += r.esi_employer;
    m.eps_ac10      += r.eps;
    m.epf_ac01      += r.epf_employer;
    m.total_pf      += r.pf_employer + r.pf_employee;
    m.total_esic    += r.esi_employer + r.esi_employee;
    m.total_pt      += r.professional_tax;
  }
  return Object.values(map);
}

// ── Payroll password gate ──────────────────────────────────────────────────────
// A single shared password protects Payroll Dashboard data ONLY — independent of
// the normal per-user module permission system used by every other dashboard.
const PAYROLL_PASSWORD   = process.env.PAYROLL_PASSWORD; // .env (local) / Vercel settings
const PAYROLL_TOKEN_TTL  = 12 * 60 * 60 * 1000; // 12h
const PAYROLL_SECRET     = process.env.JWT_SECRET;       // required by auth.js at startup

function signPayrollToken() {
  const expiry = Date.now() + PAYROLL_TOKEN_TTL;
  const sig = crypto.createHmac('sha256', PAYROLL_SECRET).update(`payroll:${expiry}`).digest('hex');
  return `${expiry}.${sig}`;
}
function verifyPayrollToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [expiryStr, sig] = token.split('.');
  const expiry = parseInt(expiryStr, 10);
  if (!expiry || !sig || Date.now() > expiry) return false;
  const expected = crypto.createHmac('sha256', PAYROLL_SECRET).update(`payroll:${expiry}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch { return false; }
}
function payrollAuth(req, res, next) {
  if (!verifyPayrollToken(req.headers['x-payroll-token'])) {
    return res.status(401).json({ error: 'Payroll Dashboard is locked. Enter the password to continue.' });
  }
  next();
}

app.post('/api/payroll/auth', (req, res) => {
  const { password } = req.body || {};
  if (!PAYROLL_PASSWORD) return res.status(503).json({ error: 'Payroll password is not configured on the server' });
  if (password !== PAYROLL_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  res.json({ token: signPayrollToken() });
});

app.get('/api/payroll/data', payrollAuth, cached('payroll-data', 3600, async () => {
  const rows          = readGroupSalaryData();
  const captiveSalary = readCaptiveSalaryData();
  const pfEsicPt       = buildPfEsicPt(rows);
  return { rows, captiveSalary, pfEsicPt };
}));

// ─── Loan Module ─────────────────────────────────────────────────────────────
const LOAN_BASE = path.join(__dirname, '..', 'Loan Module');
const LOAN_FILE = path.join(LOAN_BASE, 'Loan Data Final (1).xlsx');

function readLoanData() {
  const filePath = LOAN_FILE;
  if (db.USE_DB ? !workbooks.stored('loans') : !fs.existsSync(filePath)) return { institutional: [], other: [] };
  const wb = workbooks.read('loans', filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

  const parseNum = v => {
    const s = String(v || '').replace(/,/g, '').replace(/-\s*$/, '').trim();
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  };
  const parseRate = v => {
    const n = parseFloat(String(v || '').replace('%', '').trim());
    return isNaN(n) ? 0 : n;
  };
  const MON_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // Normalise Excel date strings (M/D/YY, M/D/YYYY) to "Mon-YY" for client
  const normalizeDate = v => {
    const s = String(v || '').trim();
    if (!s) return '';
    // M/D/YY or M/D/YYYY format produced by Excel date cells
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      const monIdx = parseInt(m[1], 10) - 1;
      const yr     = parseInt(m[3], 10);
      const year   = yr < 100 ? 2000 + yr : yr;
      return MON_NAMES[monIdx] + '-' + String(year).slice(-2);
    }
    return s; // already "Mon-YY" text
  };

  const institutional = [];
  for (let r = 1; r <= 21; r++) {
    const row = rows[r];
    if (!row) continue;
    const name = String(row[0] || '').trim();
    if (!name || name.startsWith('Total')) continue;
    const isCC = name.toLowerCase().includes('- cc');
    institutional.push({
      id: r,
      name,
      isCC,
      amount:     parseNum(row[1]),
      emi:        parseNum(row[2]),
      principal:  parseNum(row[3]),
      totalInt:   parseNum(row[4]),
      endDateStr: normalizeDate(row[5]),
      rate:       parseRate(row[6]),
      fdAmount:   parseNum(row[7]),
    });
  }

  const other = [];
  for (let r = 25; r <= 37; r++) {
    const row = rows[r];
    if (!row) continue;
    const name = String(row[0] || '').trim();
    if (!name || name.startsWith('Total')) continue;
    const amount = parseNum(row[1]);
    if (!amount) continue;
    other.push({ id: r, name, amount, endDateStr: normalizeDate(row[5]) });
  }

  return { institutional, other };
}

app.get('/api/loans/data', cached('loans-data', 3600, async () => readLoanData()));

app.post('/api/loans/export', (req, res) => {
  try {
    const { fundCr = 0, equityCr = 0, selectedIds = [], customInstitutional = [], customOther = [] } = req.body || {};
    const loanData = readLoanData();

    const allInstitutional = [...loanData.institutional, ...customInstitutional];
    const allOther         = [...loanData.other,         ...customOther];
    const selectedSet      = new Set(selectedIds);

    const fundAmt  = Math.round(fundCr   * 1e7);
    const eqAmt    = Math.round(equityCr * 1e7);
    const totalAmt = fundAmt + eqAmt;
    const toCrN    = n => (n / 1e7).toFixed(2);

    // ── Sheet 1: Repayment Plan (summary) ──────────────────────────────────
    let totInstit = 0, totSelected = 0, totFD = 0, totIntSaved = 0, totOther = 0;
    allInstitutional.forEach(l => {
      totInstit += l.amount;
      if (selectedSet.has(l.id)) { totSelected += l.amount; totFD += l.fdAmount; totIntSaved += l.amount * (l.rate / 100); }
    });
    allOther.forEach(l => totOther += l.amount);
    const fundCost  = fundAmt * 0.10;
    const fundUsed  = Math.min(totSelected, fundAmt);
    const eqUsed    = Math.max(0, totSelected - fundAmt);
    const netSaving = totIntSaved - fundCost;

    const summaryData = [
      ['Loan Utilization Planner — Report', '', ''],
      ['Generated on', new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }), ''],
      ['', '', ''],
      ['Parameter', 'Value', 'Notes'],
      ['Fund Amount', `₹${fundCr} Cr`, 'Debt / borrowing'],
      ['Equity Amount', `₹${equityCr} Cr`, 'Equity infusion'],
      ['Total Available', `₹${toCrN(totalAmt)} Cr`, ''],
      ['', '', ''],
      ['Institutional Loans (A)', `₹${toCrN(totInstit)} Cr`, ''],
      ['Other Loans (B)',         `₹${toCrN(totOther)} Cr`, ''],
      ['Grand Total (A + B)',     `₹${toCrN(totInstit + totOther)} Cr`, ''],
      ['', '', ''],
      ['Loans Selected for Repayment', `${selectedIds.length} loans`, `₹${toCrN(totSelected)} Cr`],
      ['Fund Used for Repayment',   `₹${toCrN(fundUsed)} Cr`,  `of ₹${fundCr} Cr fund`],
      ['Equity Used for Repayment', `₹${toCrN(eqUsed)} Cr`,   `of ₹${equityCr} Cr equity`],
      ['FD to be Released',         `₹${toCrN(totFD)} Cr`,    'Lien FD unlocked'],
      ['Remaining Balance',         `₹${toCrN(Math.max(0, totalAmt - totSelected))} Cr`, 'For working capital'],
      ['', '', ''],
      ['Annual Interest Saved',     `₹${toCrN(totIntSaved)} Cr`, 'On selected loans'],
      ['Fund Annual Cost (10% p.a.)', `₹${toCrN(fundCost)} Cr`, 'Estimated fund cost'],
      ['Net Annual Saving',         `${netSaving >= 0 ? '+' : '-'}₹${toCrN(Math.abs(netSaving))} Cr`, netSaving >= 0 ? 'Net positive saving' : 'Net cost'],
    ];

    // ── Sheet 2: Institutional Loans ───────────────────────────────────────
    const instHeader = ['#', 'Lender', 'Type', 'Outstanding (Cr)', 'Monthly EMI (₹)', 'End Date', 'Rate (%)', 'FD Lien (Cr)', 'Annual Interest (Cr)', 'Priority Score', 'Selected'];
    const instRows   = [instHeader];
    allInstitutional.forEach((l, i) => {
      instRows.push([
        i + 1,
        l.name + (l.custom ? ' [Added]' : ''),
        l.isCC ? 'CC/OD' : 'Term Loan',
        +toCrN(l.amount),
        l.emi > 0 ? l.emi : '',
        l.endDateStr || '',
        l.rate > 0 ? l.rate : '',
        l.fdAmount > 0 ? +toCrN(l.fdAmount) : '',
        l.rate > 0 ? +((l.amount * l.rate / 100) / 1e7).toFixed(2) : '',
        l.priority || '',
        selectedSet.has(l.id) ? 'Yes' : 'No',
      ]);
    });
    instRows.push(['', 'TOTAL (A)', '', +toCrN(totInstit), '', '', '', '', '', '', '']);

    // ── Sheet 3: Other Loans ───────────────────────────────────────────────
    const otherHeader = ['#', 'Lender', 'Amount (Cr)', 'End Date'];
    const otherRows   = [otherHeader];
    allOther.forEach((l, i) => {
      otherRows.push([i + 1, l.name + (l.custom ? ' [Added]' : ''), +toCrN(l.amount), l.endDateStr || '']);
    });
    otherRows.push(['', 'TOTAL (B)', +toCrN(totOther), '']);

    // ── Build workbook ─────────────────────────────────────────────────────
    const wb  = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
    const ws2 = XLSX.utils.aoa_to_sheet(instRows);
    const ws3 = XLSX.utils.aoa_to_sheet(otherRows);

    ws1['!cols'] = [{ wch: 40 }, { wch: 22 }, { wch: 28 }];
    ws2['!cols'] = [{ wch: 4 }, { wch: 38 }, { wch: 12 }, { wch: 18 }, { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 20 }, { wch: 14 }, { wch: 10 }];
    ws3['!cols'] = [{ wch: 4 }, { wch: 38 }, { wch: 14 }, { wch: 12 }];

    XLSX.utils.book_append_sheet(wb, ws1, 'Repayment Plan');
    XLSX.utils.book_append_sheet(wb, ws2, 'Institutional Loans (A)');
    XLSX.utils.book_append_sheet(wb, ws3, 'Other Loans (B)');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="Loan_Report_${dateStr}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    console.error('Loan export error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Top Customer Revenue ─────────────────────────────────────────────────────
// Fetches FY 2025-26 invoices once, then slices into Q1/Q2/Q3/Q4 + YTD in memory.
// Previous 3 years are hardcoded in the frontend from audited annual report.
app.get('/api/kpi/top-customer-revenue', cached('top-customer-revenue', 3600, async () => {
  const invoices = await zohoGetAll('/invoices', 'invoices',
    { filter_by: 'Status.All' },
    { dateFrom: '2025-04-01', dateTo: '2026-03-31' }
  );

  // Build full-year customer totals to identify who meets the ≥10% annual threshold.
  // The 10% is always measured against ANNUAL revenue — same customer set for all periods.
  const annualMap = {};
  for (const inv of invoices) {
    const name = inv.customer_name || 'Unknown';
    annualMap[name] = (annualMap[name] || 0) + subTotal(inv);
  }
  const annualTotal = Object.values(annualMap).reduce((s, v) => s + v, 0);
  const qualifyingCustomers = new Set(
    Object.entries(annualMap)
      .filter(([, rev]) => annualTotal > 0 && rev / annualTotal >= 0.10)
      .map(([name]) => name)
  );

  function calcPeriod(start, end) {
    const filtered = invoices.filter(inv => inv.date >= start && inv.date <= end);
    const customerMap = {};
    for (const inv of filtered) {
      const name = inv.customer_name || 'Unknown';
      customerMap[name] = (customerMap[name] || 0) + subTotal(inv);
    }
    const total   = Object.values(customerMap).reduce((s, v) => s + v, 0);
    const entries = Object.entries(customerMap).sort((a, b) => b[1] - a[1]);
    const [topName, topRevenue] = entries[0] || ['—', 0];

    // Revenue in this period from customers that met ≥10% of the FULL-YEAR threshold
    const tenPctTotal = Object.entries(customerMap)
      .filter(([name]) => qualifyingCustomers.has(name))
      .reduce((s, [, rev]) => s + rev, 0);

    return {
      top_customer_name:    topName,
      top_customer_revenue: Math.round(topRevenue),
      ten_pct_total:        tenPctTotal > 0 ? Math.round(tenPctTotal) : null,
      total_revenue:        Math.round(total),
    };
  }

  return {
    q1:  calcPeriod('2025-04-01', '2025-06-30'),
    q2:  calcPeriod('2025-07-01', '2025-09-30'),
    q3:  calcPeriod('2025-10-01', '2025-12-31'),
    q4:  calcPeriod('2026-01-01', '2026-03-31'),
    ytd: calcPeriod('2025-04-01', '2026-03-31'),
  };
}));

// ─── Related Party Transactions (RPT) ─────────────────────────────────────────
const RPT_LOANS_FILE = path.join(__dirname, 'rpt_loans.json');

const RPT_FY_RANGES = {
  fy2425: { start: '2024-04-01', end: '2025-03-31' },
  fy2526: { start: '2025-04-01', end: '2026-03-31' },
  fy2627: { start: '2026-04-01', end: '2027-03-31' },
  fy2728: { start: '2027-04-01', end: '2028-03-31' },
};

const RPT_PARTIES = [
  { name: 'Neddle And Thread Designs LLP',       relation: 'Subsidiary', limitCr: 14,   customerId: '1714732000000103677', vendorId: '1714732000000139636' },
  { name: 'Saasjoy Solutions Private Limited',   relation: 'Subsidiary', limitCr: null, customerId: '1714732000021642475', vendorId: '1714732000043873045' },
  { name: 'Eezily Networks Private Limited',     relation: 'Associate',  limitCr: 14,   customerId: '1714732000058452991', vendorId: '1714732000054494415' },
  { name: 'Dev Information Technology Ltd.',     relation: 'Associate',  limitCr: null, customerId: null,                  vendorId: '1714732000000134431' },
  { name: 'Scaleax Advisory Private Limited',    relation: 'Associate',  limitCr: null, customerId: null,                  vendorId: null },
  { name: 'Swadesh Venture Fund LLP',            relation: 'Associate',  limitCr: 0.99, customerId: '1714732000030211575', vendorId: null },
  { name: 'Finclave Accel LLP',                  relation: 'Associate',  limitCr: 0.99, customerId: null,                  vendorId: null },
  { name: 'Las Olas Ventures LLP',               relation: 'Associate',  limitCr: 0.99, customerId: '1714732000007560670', vendorId: null },
  { name: 'Janak Urja Private Limited',          relation: 'Associate',  limitCr: 14,   customerId: null,                  vendorId: null },
  { name: 'Finex Accounting Services Pvt. Ltd.', relation: 'Other',      limitCr: 0.99, customerId: '1714732000021606596', vendorId: null },
  { name: 'Rivet Global Services LLP',           relation: 'Other',      limitCr: 0.99, customerId: '1714732000005942421', vendorId: null },
  { name: 'Growfitter Private Limited',          relation: 'Other',      limitCr: null, customerId: '1714732000007543459', vendorId: null },
  { name: 'Fractoprop One Private Limited',      relation: 'Other',      limitCr: null, customerId: null,                  vendorId: '1714732000003777866' },
  { name: 'Dhyey Consulting Services Pvt. Ltd.', relation: 'Other',      limitCr: null, customerId: '1714732000006089564', vendorId: null },
  { name: 'Ausil Enterprice Pvt. Ltd.',          relation: 'Associate',  limitCr: null, customerId: null,                  vendorId: null },
];

async function readRptLoans() {
  return await db.readJSON('rpt_loans', RPT_LOANS_FILE, {});
}
async function writeRptLoans(d) {
  await db.writeJSON('rpt_loans', RPT_LOANS_FILE, d);
}

// Fetch ALL invoices for a customer across all time (customer_id filter works for invoices)
async function fetchPartyInvoices(customerId) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await zohoGet('/invoices', { customer_id: customerId, filter_by: 'Status.All', per_page: 200, page });
    const items = data.invoices || [];
    if (!items.length) break;
    all.push(...items);
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

// Fetch bills for a given FY date range (vendor_id filter broken — must scan pages)
async function fetchFYBills(fyStart, fyEnd) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await zohoGet('/bills', { per_page: 200, page, filter_by: 'Status.All' });
    const items = data.bills || [];
    if (!items.length) break;
    all.push(...items.filter(b => b.date >= fyStart && b.date <= fyEnd &&
      !['void', 'draft'].includes((b.status || '').toLowerCase())));
    if (items.every(b => !b.date || b.date < fyStart)) break;
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

// Fetch ALL customer payments for a party (all time — caller filters by date)
async function fetchAllPartyPayments(customerId) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await zohoGet('/customerpayments', { customer_id: customerId, per_page: 200, page });
    const items = data.customerpayments || [];
    if (!items.length) break;
    all.push(...items);
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

// Fetch ALL INR credit notes for a customer.
// The customer_id filter param on /creditnotes is broken in Zoho (returns nothing),
// so we scan all pages and match by customer_id in the response — same pattern as bills.
async function fetchAllPartyCreditNotes(customerId) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await zohoGet('/creditnotes', { per_page: 200, page });
    const items = data.creditnotes || [];
    if (!items.length) break;
    all.push(...items.filter(cn =>
      cn.customer_id === customerId &&
      (cn.currency_code || 'INR').toUpperCase() === 'INR' &&
      (cn.status || '').toLowerCase() !== 'void'
    ));
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

// Return party config list + supported FY keys
app.get('/api/rpt/parties', (req, res) => {
  res.json({
    parties: RPT_PARTIES.map(p => ({
      name: p.name, relation: p.relation, limitCr: p.limitCr,
      hasCustomer: !!p.customerId, hasVendor: !!p.vendorId || !!p.zohoVendorName,
    })),
    fyRanges: Object.keys(RPT_FY_RANGES),
  });
});

// ─── RPT Ledger Mapping ───────────────────────────────────────────────────────
// User-maintained mapping of Zoho customers (Sales), vendors (Purchase) and Chart-of-Accounts
// ledgers (Loans / Interest) to dashboard related parties. One party may have any number of
// Zoho names/ledgers per source. Saved permanently, not FY-specific, and never touched by sync.
// Every RPT figure is computed from this mapping by Zoho ID — no name matching.
const RPT_MAPPING_FILE  = path.join(__dirname, 'rpt_ledger_mapping.json');
const RPT_DETAILS_FILE  = path.join(__dirname, 'rpt_doc_details.json');
const RPT_LEDGER_FILE   = path.join(__dirname, 'rpt_ledger_txns.json');
const RPT_OPTIONS_FILE  = path.join(__dirname, 'rpt_zoho_options.json');
const RPT_SOURCES       = ['sales', 'purchase', 'loan'];
// Nature of a mapped COA ledger → how its postings are treated.
//   bucket  loans → Loans Given tab + card "Loans" (counts in Used); interest → Interest Income tab
//   normal  side on which the ledger grows (the transaction amount); null = from the account type
//   flow    repayment → postings are shown as repaid (reduce the balance, never count in Used)
const RPT_NATURES = {
  loan_given:         { label: 'Loan Given',         bucket: 'loans',    normal: 'debit' },
  loan_received:      { label: 'Loan Received',      bucket: 'loans',    normal: 'credit' },
  advance_given:      { label: 'Advance Given',      bucket: 'loans',    normal: 'debit' },
  advance_received:   { label: 'Advance Received',   bucket: 'loans',    normal: 'credit' },
  repayment_received: { label: 'Repayment Received', bucket: 'loans',    normal: 'credit', flow: 'repayment' },
  repayment_made:     { label: 'Repayment Made',     bucket: 'loans',    normal: 'debit',  flow: 'repayment' },
  interest_income:    { label: 'Interest Income',    bucket: 'interest', normal: 'credit' },
  interest_expense:   { label: 'Interest Expense',   bucket: 'interest', normal: 'debit' },
  deposit_given:      { label: 'Deposit Given',      bucket: 'loans',    normal: 'debit' },
  deposit_received:   { label: 'Deposit Received',   bucket: 'loans',    normal: 'credit' },
  investment:         { label: 'Investment',         bucket: 'loans',    normal: 'debit' },
  other_rpt:          { label: 'Other RPT',          bucket: 'loans',    normal: null },
};
const RPT_LEGACY_NATURE = { loan: 'loan_given', interest: 'interest_income' };
const RPT_SKIP_STATUS   = new Set(['void', 'draft']);
const RPT_LEDGER_TTL_H  = 4;   // ledger transactions reused for 4 h (Refresh forces a refetch)
const RPT_OPTIONS_TTL_H = 24;  // customer / vendor / COA pick-lists
const rptR2 = n => Math.round((Number(n) || 0) * 100) / 100;

// Every RPT Zoho call goes through one pacer (≈65 calls/min in total) so parallel Sales /
// Purchase / Loans loads never trip Zoho's per-minute block
let _rptNextSlot = 0;
async function rptZohoGet(p, params) {
  const now = Date.now();
  const slot = Math.max(now, _rptNextSlot);
  _rptNextSlot = slot + 900;
  if (slot > now) await new Promise(r => setTimeout(r, slot - now));
  return zohoGet(p, params);
}

function rptNewId() { return require('crypto').randomBytes(8).toString('hex'); }

// First read seeds the store from the Zoho IDs previously configured on RPT_PARTIES (and the
// old exact-name vendor match) so current figures carry over; afterwards the saved mapping is
// the only source.
async function rptSeedMappings() {
  const now = new Date().toISOString();
  const names = { sales: {}, purchase: {} };
  try { for (const i of (await syncEngine.readSyncedData('invoices_fy'))?.data || []) names.sales[i.customer_id] = i.customer_name; } catch (_) {}
  try { for (const c of (await syncEngine.readSyncedData('vendors_all'))?.data || []) names.purchase[c.contact_id] = c.contact_name; } catch (_) {}
  const mappings = [];
  const add = (source, zohoId, party) => mappings.push({
    id: rptNewId(), source, zohoId, zohoName: names[source][zohoId] || party, party, status: 'mapped', createdAt: now, updatedAt: now,
  });
  for (const p of RPT_PARTIES) {
    if (p.customerId) add('sales', p.customerId, p.name);
    if (p.vendorId) add('purchase', p.vendorId, p.name);
    else {
      const key = p.name.trim().toLowerCase();
      for (const [id, nm] of Object.entries(names.purchase)) {
        if ((nm || '').trim().toLowerCase() === key) add('purchase', id, p.name);
      }
    }
  }
  return { mappings, ignored: [], seededAt: now };
}

// Older rows: 'loan'/'interest' natures and no status
function rptNormalizeMapping(x) {
  const out = { status: 'mapped', ...x };
  if (x.source === 'loan') out.nature = RPT_LEGACY_NATURE[x.nature] || (RPT_NATURES[x.nature] ? x.nature : 'loan_given');
  return out;
}

async function readRptMapping() {
  const m = await db.readJSON('rpt_ledger_mapping', RPT_MAPPING_FILE, null);
  if (m && Array.isArray(m.mappings)) return { ignored: [], ...m, mappings: m.mappings.map(rptNormalizeMapping) };
  const seeded = await rptSeedMappings();
  await writeRptMapping(seeded);
  return seeded;
}
async function writeRptMapping(d) {
  await db.writeJSON('rpt_ledger_mapping', RPT_MAPPING_FILE, d);
}

// Persistent keyed stores (document details, ledger transactions, pick-lists), loaded once
function rptStore(key, file) {
  if (!rptStore._m) rptStore._m = {};
  if (!rptStore._m[key]) rptStore._m[key] = db.readJSON(key, file, null).then(v => v || {});
  return rptStore._m[key];
}
async function rptStoreSave(key, file) {
  await db.writeJSON(key, file, await rptStore(key, file));
}

// Computed results are memoised per FY; a mapping change bumps the generation so an
// in-flight computation started under the old mapping is never cached.
const _rptInflight = new Map();
let _rptGen = 0;
function rptMemo(key, fn, ttl = 600) {
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  if (_rptInflight.has(key)) return _rptInflight.get(key);
  const gen = _rptGen;
  const p = fn()
    .then(v => { if (gen === _rptGen) cache.set(key, v, ttl); return v; })
    .finally(() => { if (_rptInflight.get(key) === p) _rptInflight.delete(key); });
  _rptInflight.set(key, p);
  return p;
}
function rptInvalidate() {
  _rptGen++;
  _rptInflight.clear();
  cache.keys().filter(k => /^rpt-(sales|purchase|loans)-/.test(k)).forEach(k => cache.del(k));
}
async function rptCached(key, fn, ttl = 1800) {
  const hit = cache.get(key);
  if (hit) return hit;
  const v = await fn();
  cache.set(key, v, ttl);
  return v;
}

// Synced entity rows when fresh and covering fyStart, else null (caller goes live)
async function rptSynced(entity, fyStart) {
  try {
    const c = await syncEngine.readSyncedData(entity);
    if (c && Array.isArray(c.data) && syncEngine.isFresh(c.synced_at) && (!c.window_from || fyStart >= c.window_from)) {
      return [...c.data, ...(c.future || [])];
    }
  } catch (_) {}
  return null;
}

function rptIdsByParty(mappings, source) {
  const out = {};
  for (const m of mappings) {
    if (m.source !== source) continue;
    (out[m.party] = out[m.party] || []).push(m);
  }
  return out;
}

const RPT_DOC_KINDS = {
  invoice:       { path: '/invoices/',      key: 'invoice' },
  creditnote:    { path: '/creditnotes/',   key: 'creditnote' },
  bill:          { path: '/bills/',         key: 'bill' },
  vendor_credit: { path: '/vendorcredits/', key: 'vendor_credit' },
};

// Basic / GST split needs the document detail (list APIs carry only the total). Details are kept
// permanently per document and refetched only when Zoho's last_modified_time changes, so a
// mapping change or FY switch never re-downloads documents already seen.
async function rptDocDetails(kind, docs, idField) {
  const store = await rptStore('rpt_doc_details', RPT_DETAILS_FILE);
  const missing = docs.filter(d => {
    const s = store[d[idField]];
    return !s || (d.last_modified_time && s.lmt && s.lmt !== d.last_modified_time);
  });
  const BATCH = 3;
  let changed = false, blocked = false;
  for (let i = 0; i < missing.length && !blocked; i += BATCH) {
    await Promise.all(missing.slice(i, i + BATCH).map(async d => {
      if (blocked) return;
      try {
        const det = (await rptZohoGet(RPT_DOC_KINDS[kind].path + d[idField]))[RPT_DOC_KINDS[kind].key] || {};
        store[d[idField]] = {
          lmt: d.last_modified_time || det.last_modified_time || null,
          basic: rptR2(det.sub_total), gst: rptR2(det.tax_total), total: rptR2(det.total),
        };
        changed = true;
      } catch (e) {
        if (e.response?.status === 429 || /LIMIT/.test(e.message)) blocked = true;
        console.warn(`[rpt] ${kind} ${d[idField]} detail failed:`, e.message);
      }
    }));
  }
  if (changed) await rptStoreSave('rpt_doc_details', RPT_DETAILS_FILE);
  return id => store[id] || null;
}

// One row per Zoho document, amounts in INR, credit documents negative
function rptDocRow(doc, det, o) {
  const fx   = Number(doc.exchange_rate) || 1;
  const sign = o.credit ? -1 : 1;
  return {
    [o.idKey]: doc[o.idField], [o.noKey]: doc[o.noField],
    date: doc.date, status: doc.status, doc_type: o.type, zoho_name: doc[o.nameField],
    basic:   sign * rptR2((det ? det.basic : 0) * fx),
    gst:     sign * rptR2((det ? det.gst : 0) * fx),
    total:   sign * rptR2((det?.total || Number(doc.total) || 0) * fx),
    balance: sign * rptR2((Number(doc.balance) || 0) * fx),
    detail_missing: !det || undefined,
  };
}

async function rptFetchFYListLive(pathName, listKey, start, end) {
  const all = [];
  let page = 1;
  while (page <= 100) {
    const d = await rptZohoGet(pathName, { per_page: 200, page, filter_by: 'Status.All', sort_column: 'date', sort_order: 'D' });
    const items = d[listKey] || [];
    all.push(...items.filter(x => x.date >= start && x.date <= end));
    if (!items.length || items.every(x => x.date < start) || !d.page_context?.has_more_page) break;
    page++;
  }
  return all;
}

// Sales = invoices − credit notes of every mapped customer
async function rptComputeSales(fyKey) {
  const { start, end } = RPT_FY_RANGES[fyKey];
  const { mappings } = await readRptMapping();
  const byParty = rptIdsByParty(mappings, 'sales');
  const ids = [...new Set(Object.values(byParty).flat().map(m => m.zohoId))];
  const inFY = x => x.date >= start && x.date <= end && !RPT_SKIP_STATUS.has((x.status || '').toLowerCase());

  const perCust = {};
  const [sInv, sCn, sPay, sUnpaid] = await Promise.all([
    rptSynced('invoices_fy', start), rptSynced('credit_notes_fy', start),
    rptSynced('customer_payments_fy', start), rptSynced('invoices_unpaid', start),
  ]);
  if (sInv && sCn && sPay && sUnpaid) {
    const idSet = new Set(ids);
    for (const id of ids) perCust[id] = { invoices: [], creditNotes: [], payFY: 0, closing: 0 };
    for (const i of sInv) if (idSet.has(i.customer_id) && inFY(i)) perCust[i.customer_id].invoices.push(i);
    for (const c of sCn) if (idSet.has(c.customer_id) && inFY(c)) perCust[c.customer_id].creditNotes.push(c);
    for (const p of sPay) if (idSet.has(p.customer_id) && p.date >= start && p.date <= end) perCust[p.customer_id].payFY += Number(p.amount) || 0;
    // Current AR = Σ open balances; nothing can be paid after the current FY yet
    for (const i of sUnpaid) {
      if (idSet.has(i.customer_id) && !RPT_SKIP_STATUS.has((i.status || '').toLowerCase())) perCust[i.customer_id].closing += Number(i.balance) || 0;
    }
  } else if (ids.length) {
    const fyCn = await rptCached(`rpt-cn-live-${fyKey}`, () => rptFetchFYListLive('/creditnotes', 'creditnotes', start, end));
    for (const id of ids) {
      const [all, pays] = await Promise.all([
        rptCached(`rpt-cust-inv-${id}`, () => fetchPartyInvoices(id)).catch(() => []),
        rptCached(`rpt-cust-pay-${id}`, () => fetchAllPartyPayments(id)).catch(() => []),
      ]);
      // Closing = current AR + cash received after FY end (every payment/credit since is reflected in balances)
      const currentAR = all.filter(i => !RPT_SKIP_STATUS.has((i.status || '').toLowerCase())).reduce((s, i) => s + (Number(i.balance) || 0), 0);
      const postFY    = pays.filter(p => p.date > end).reduce((s, p) => s + (Number(p.amount) || 0), 0);
      perCust[id] = {
        invoices:    all.filter(inFY),
        creditNotes: fyCn.filter(c => c.customer_id === id && inFY(c)),
        payFY:       pays.filter(p => p.date >= start && p.date <= end).reduce((s, p) => s + (Number(p.amount) || 0), 0),
        closing:     currentAR + postFY,
      };
    }
  }

  const allInv = Object.values(perCust).flatMap(c => c.invoices);
  const allCn  = Object.values(perCust).flatMap(c => c.creditNotes);
  const invDet = await rptDocDetails('invoice', allInv, 'invoice_id');
  const cnDet  = await rptDocDetails('creditnote', allCn, 'creditnote_id');

  const result = {};
  for (const party of RPT_PARTIES) {
    const custIds = [...new Set((byParty[party.name] || []).map(m => m.zohoId))];
    const rows = new Map(); // dedup by Zoho document ID
    let payFY = 0, closing = 0;
    for (const id of custIds) {
      const c = perCust[id];
      if (!c) continue;
      payFY += c.payFY; closing += c.closing;
      for (const i of c.invoices) rows.set(i.invoice_id, rptDocRow(i, invDet(i.invoice_id), {
        idKey: 'invoice_id', noKey: 'invoice_number', idField: 'invoice_id', noField: 'invoice_number', nameField: 'customer_name', type: 'Invoice' }));
      for (const cn of c.creditNotes) rows.set(cn.creditnote_id, rptDocRow(cn, cnDet(cn.creditnote_id), {
        idKey: 'invoice_id', noKey: 'invoice_number', idField: 'creditnote_id', noField: 'creditnote_number', nameField: 'customer_name', type: 'Credit Note', credit: true }));
    }
    const invoices    = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
    const periodTotal = invoices.reduce((s, r) => s + r.total, 0);
    const closingBal  = rptR2(closing);
    // Opening = Closing + FY cash received − FY net billing (keeps the ledger table internally consistent)
    const openingBal  = rptR2(closingBal + payFY - periodTotal);
    result[party.name] = { openingBal, invoices, paymentsTotal: rptR2(payFY), closingBal: rptR2(openingBal + periodTotal - payFY) };
  }
  return result;
}

// Purchase = bills − vendor credits of every mapped vendor
async function rptComputePurchase(fyKey) {
  const { start, end } = RPT_FY_RANGES[fyKey];
  const { mappings } = await readRptMapping();
  const byParty = rptIdsByParty(mappings, 'purchase');
  const idSet = new Set(Object.values(byParty).flat().map(m => m.zohoId));
  const inFY = x => x.date >= start && x.date <= end && !RPT_SKIP_STATUS.has((x.status || '').toLowerCase());

  let bills = [], vcs = [];
  if (idSet.size) {
    bills = (await rptSynced('bills_fy', start))
      || await rptCached(`rpt-bills-live-${fyKey}`, () => fetchFYBills(start, end));
    vcs = (await rptSynced('vendor_credits_all', start))
      || await rptCached(`rpt-vc-live-${fyKey}`, () => rptFetchFYListLive('/vendorcredits', 'vendor_credits', start, end));
    bills = bills.filter(b => idSet.has(b.vendor_id) && inFY(b));
    vcs   = vcs.filter(v => idSet.has(v.vendor_id) && inFY(v));
  }
  const billDet = await rptDocDetails('bill', bills, 'bill_id');
  const vcDet   = await rptDocDetails('vendor_credit', vcs, 'vendor_credit_id');

  const result = {};
  for (const party of RPT_PARTIES) {
    const vIds = new Set((byParty[party.name] || []).map(m => m.zohoId));
    const rows = new Map();
    for (const b of bills) if (vIds.has(b.vendor_id)) rows.set(b.bill_id, rptDocRow(b, billDet(b.bill_id), {
      idKey: 'bill_id', noKey: 'bill_number', idField: 'bill_id', noField: 'bill_number', nameField: 'vendor_name', type: 'Bill' }));
    for (const v of vcs) if (vIds.has(v.vendor_id)) rows.set(v.vendor_credit_id, rptDocRow(v, vcDet(v.vendor_credit_id), {
      idKey: 'bill_id', noKey: 'bill_number', idField: 'vendor_credit_id', noField: 'vendor_credit_number', nameField: 'vendor_name', type: 'Vendor Credit', credit: true }));
    const list = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
    result[party.name] = { openingBal: 0, bills: list, closingBal: rptR2(list.reduce((s, b) => s + b.balance, 0)) };
  }
  return result;
}

// Every transaction posted to one COA ledger (journals, bank txns, expenses, payments, …)
async function rptLedgerTxns(accountId, force) {
  const store = await rptStore('rpt_ledger_txns', RPT_LEDGER_FILE);
  const hit = store[accountId];
  if (hit && !force && syncEngine.isFresh(hit.fetched_at, RPT_LEDGER_TTL_H)) return { txns: hit.txns };
  try {
    const rows = [], seen = new Set();
    const toYear = new Date().getFullYear() + 2;
    let page = 1;
    while (page <= 50) {
      const d = await rptZohoGet('/chartofaccounts/transactions', {
        account_id: accountId, 'date.start': '2015-04-01', 'date.end': `${toYear}-03-31`, per_page: 200, page,
      });
      for (const t of d.transactions || []) {
        const k = t.categorized_transaction_id || `${t.transaction_id}|${t.transaction_date}|${t.debit_amount}|${t.credit_amount}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({
          id: t.transaction_id, type: t.transaction_type, typeLabel: t.transaction_type_formatted,
          date: t.transaction_date, entry: t.entry_number, ref: t.reference_number,
          dr: rptR2(t.debit_amount), cr: rptR2(t.credit_amount),
        });
      }
      if (!d.page_context?.has_more_page) break;
      page++;
    }
    store[accountId] = { fetched_at: new Date().toISOString(), txns: rows };
    await rptStoreSave('rpt_ledger_txns', RPT_LEDGER_FILE);
    return { txns: rows };
  } catch (e) {
    console.warn(`[rpt] ledger ${accountId} fetch failed:`, e.message);
    return { txns: hit?.txns || [], error: e.message, stale: !!hit };
  }
}

// Asset/expense ledgers grow on debit (loan given); liability/equity/income grow on credit
function rptDebitNormal(accountType) {
  return !accountType || /asset|bank|cash|receivable|expense|cost_of_goods|stock|input_tax/.test(accountType);
}
const RPT_DOC_TXN_TYPES = new Set(['invoice', 'bill', 'creditnote', 'credit_note', 'vendor_credit', 'vendor_credits', 'credit_notes']);

// Loans / Interest per party from the mapped ledgers. Parties without ledger mappings keep
// the manual entries from rpt_loans.json.
async function rptComputeLoans(fyKey, force) {
  const { start, end } = RPT_FY_RANGES[fyKey];
  const { mappings } = await readRptMapping();
  const manual = await readRptLoans();
  const out = { loans: { ...(manual.loans || {}) }, interest: { ...(manual.interest || {}) }, warnings: [] };
  const loanMaps = mappings.filter(m => m.source === 'loan');
  if (!loanMaps.length) return out;

  const coa = {};
  for (const a of (await rptStore('rpt_zoho_options', RPT_OPTIONS_FILE)).loan?.items || []) coa[a.id] = a;

  const ledgers = {};
  for (const id of [...new Set(loanMaps.map(m => m.zohoId))]) {
    ledgers[id] = await rptLedgerTxns(id, force);
    if (ledgers[id].error) {
      const nm = coa[id]?.name || loanMaps.find(m => m.zohoId === id)?.zohoName || id;
      out.warnings.push(`${nm}: ${ledgers[id].stale ? 'showing last fetched data — ' : ''}${ledgers[id].error}`);
    }
  }

  // Documents already counted in Sales/Purchase are skipped if a mapped ledger also carries them
  let docIds = null;
  if (Object.values(ledgers).some(l => l.txns.some(t => RPT_DOC_TXN_TYPES.has(t.type)))) {
    const [s, p] = await Promise.all([rptGetSales(fyKey), rptGetPurchase(fyKey)]);
    docIds = {};
    for (const party of RPT_PARTIES) {
      docIds[party.name] = new Set([
        ...(s[party.name]?.invoices || []).map(r => r.invoice_id),
        ...(p[party.name]?.bills || []).map(r => r.bill_id),
      ]);
    }
  }

  // Ledger names follow the latest Zoho COA list (an account renamed in Zoho shows its new name)
  const ledgerName = m => coa[m.zohoId]?.name || m.zohoName;

  const groups = {};
  for (const m of loanMaps) {
    const bucket = (RPT_NATURES[m.nature] || RPT_NATURES.loan_given).bucket;
    ((groups[m.party] = groups[m.party] || {})[bucket] = groups[m.party][bucket] || []).push(m);
  }

  for (const [party, byBucket] of Object.entries(groups)) {
    for (const [bucket, maps] of Object.entries(byBucket)) {
      // One entry per Zoho transaction ID: a journal touching two mapped ledgers of the same
      // party is netted, so internal reclassifications / set-offs are not counted twice.
      const txns = new Map();
      for (const m of maps) {
        const nat = RPT_NATURES[m.nature] || RPT_NATURES.loan_given;
        const debitSide = nat.normal ? nat.normal === 'debit' : rptDebitNormal(m.accountType || coa[m.zohoId]?.type);
        const sign = nat.flow === 'repayment' ? -1 : 1;
        for (const t of ledgers[m.zohoId]?.txns || []) {
          if (docIds?.[party]?.has(t.id)) continue;
          const key = t.id || `${m.zohoId}|${t.date}|${t.entry}`;
          const g = txns.get(key) || { date: t.date, net: 0, ledgers: new Set(), natures: new Set(), voucher: t.entry || t.ref || '', type: t.typeLabel || t.type, txn_id: t.id };
          g.net += sign * (debitSide ? t.dr - t.cr : t.cr - t.dr);
          g.ledgers.add(ledgerName(m));
          g.natures.add(nat.label);
          txns.set(key, g);
        }
      }
      let openingBal = 0;
      const entries = [];
      for (const g of txns.values()) {
        const net = rptR2(g.net);
        if (!net || !g.date) continue;
        if (g.date < start) { openingBal += net; continue; }
        if (g.date > end) continue;
        entries.push({
          date: g.date, given: net > 0 ? net : 0, repaid: net < 0 ? -net : 0,
          voucher: g.voucher, type: g.type, nature: [...g.natures].join(', '),
          ledger: [...g.ledgers].join(', '), txn_id: g.txn_id,
        });
      }
      entries.sort((a, b) => a.date.localeCompare(b.date));
      out[bucket][party] = { openingBal: rptR2(openingBal), entries, source: 'ledger' };
    }
  }
  return out;
}

const rptGetSales    = fy => rptMemo(`rpt-sales-${fy}`, () => rptComputeSales(fy));
const rptGetPurchase = fy => rptMemo(`rpt-purchase-${fy}`, () => rptComputePurchase(fy));
const rptGetLoans    = (fy, force) => {
  if (force) cache.del(`rpt-loans-${fy}`);
  return rptMemo(`rpt-loans-${fy}`, () => rptComputeLoans(fy, force));
};

// Sales (invoices − credit notes) per related party — ?fy=fy2627 (defaults to fy2627)
app.get('/api/rpt/sales', async (req, res) => {
  const fyKey = RPT_FY_RANGES[req.query.fy] ? req.query.fy : 'fy2627';
  try { res.json(await rptGetSales(fyKey)); }
  catch (e) { console.error(e.response?.data || e.message); res.status(500).json({ error: e.message }); }
});

// Purchase (bills − vendor credits) per related party — ?fy=fy2627 (defaults to fy2627)
app.get('/api/rpt/purchase', async (req, res) => {
  const fyKey = RPT_FY_RANGES[req.query.fy] ? req.query.fy : 'fy2627';
  try { res.json(await rptGetPurchase(fyKey)); }
  catch (e) { console.error(e.response?.data || e.message); res.status(500).json({ error: e.message }); }
});

// Paged Zoho list fetch (paced via rptZohoGet)
async function rptPaged(pathName, listKey, params) {
  const all = [];
  for (let page = 1; page <= 100; page++) {
    const d = await rptZohoGet(pathName, { ...params, per_page: 200, page });
    all.push(...(d[listKey] || []));
    if (!d.page_context?.has_more_page) break;
  }
  return all;
}

// Customer / vendor / COA pick-lists for the mapping box (concurrent callers share one fetch)
const _rptOptInflight = new Map();
async function rptOptions(source, refresh) {
  // A saved list older than 24 h is returned at once and refreshed in the background;
  // only Reload Zoho lists (refresh) waits for Zoho
  if (!refresh && !_rptOptInflight.has(source)) {
    const hit = (await rptStore('rpt_zoho_options', RPT_OPTIONS_FILE))[source];
    if (hit?.items?.length && !syncEngine.isFresh(hit.fetched_at, RPT_OPTIONS_TTL_H)) {
      background(rptOptionsFetch(source, true).catch(() => {}));
      return { items: hit.items, stale: true };
    }
  }
  return rptOptionsFetch(source, refresh);
}
function rptOptionsFetch(source, refresh) {
  if (_rptOptInflight.has(source)) return _rptOptInflight.get(source);
  const p = rptOptionsLoad(source, refresh).finally(() => _rptOptInflight.delete(source));
  _rptOptInflight.set(source, p);
  return p;
}
async function rptOptionsLoad(source, refresh) {
  const store = await rptStore('rpt_zoho_options', RPT_OPTIONS_FILE);
  const hit = store[source];
  if (hit && !refresh && syncEngine.isFresh(hit.fetched_at, RPT_OPTIONS_TTL_H)) return { items: hit.items };
  let items = null, error = null;
  try {
    if (source === 'sales') {
      const rows = await rptPaged('/contacts', 'contacts', { contact_type: 'customer', sort_column: 'contact_name' });
      items = rows.map(c => ({ id: c.contact_id, name: c.contact_name, info: c.company_name && c.company_name !== c.contact_name ? c.company_name : '' }));
    } else if (source === 'purchase') {
      const rows = await syncedAll('vendors_all', () => rptPaged('/contacts', 'contacts', { contact_type: 'vendor', sort_column: 'contact_name' }));
      items = rows.map(c => ({ id: c.contact_id, name: c.contact_name, info: c.company_name && c.company_name !== c.contact_name ? c.company_name : '' }));
    } else {
      // Full COA incl. inactive accounts (older loans may sit in closed ledgers).
      // sort_column=account_name is required — without it Zoho's COA pages overlap and skip accounts.
      let rows;
      try {
        rows = await rptPaged('/chartofaccounts', 'chartofaccounts', { filter_by: 'AccountType.All', sort_column: 'account_name' });
      } catch (e) {
        if (e.response?.status !== 400) throw e;
        rows = await rptPaged('/chartofaccounts', 'chartofaccounts', { sort_column: 'account_name' });
      }
      const byId = new Map(rows.map(a => [a.account_id, a]));
      items = [...byId.values()].map(a => ({
        id: a.account_id, name: a.account_name, code: a.account_code || '', type: a.account_type,
        typeLabel: String(a.account_type || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        parent: a.parent_account_name || '', active: a.is_active !== false,
        info: a.parent_account_name ? `under ${a.parent_account_name}` : '',
      }));
    }
  } catch (e) {
    error = e.message;
    console.warn(`[rpt] ${source} options fetch failed:`, e.message);
  }
  if (items?.length) {
    store[source] = { fetched_at: new Date().toISOString(), items };
    await rptStoreSave('rpt_zoho_options', RPT_OPTIONS_FILE);
  } else {
    items = hit?.items || [];
  }
  // Contacts seen in synced transactions stay selectable even when the contact list is unavailable
  if (source !== 'loan') {
    const byId = new Map(items.map(i => [i.id, i]));
    const entities = source === 'sales' ? ['invoices_fy', 'invoices_unpaid', 'credit_notes_fy'] : ['bills_fy', 'vendor_credits_all'];
    const [idF, nmF] = source === 'sales' ? ['customer_id', 'customer_name'] : ['vendor_id', 'vendor_name'];
    for (const ent of entities) {
      try {
        for (const r of (await syncEngine.readSyncedData(ent))?.data || []) {
          if (r[idF] && !byId.has(r[idF])) byId.set(r[idF], { id: r[idF], name: r[nmF], info: '' });
        }
      } catch (_) {}
    }
    items = [...byId.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  return { items, error: items.length ? null : error };
}

// Distinctive word of a party name (legal suffixes dropped), used only to suggest unmapped items
const RPT_NAME_STOPWORDS = new Set(['m', 's', 'ms', 'the', 'private', 'pvt', 'limited', 'ltd', 'llp', 'and', 'of', 'co', 'company', 'india']);
// Default Nature offered for an unmapped ledger (the user can change it before mapping)
function rptSuggestNature(name, type) {
  const n = String(name || '').toLowerCase(), t = String(type || '');
  const asset = /asset|bank|cash|receivable/.test(t), liab = /liability|payable|credit_card/.test(t);
  if (/interest/.test(n)) return /income/.test(t) ? 'interest_income' : /expense/.test(t) ? 'interest_expense' : 'other_rpt';
  if (/deposit/.test(n)) return liab ? 'deposit_received' : 'deposit_given';
  if (/advance/.test(n)) return liab ? 'advance_received' : 'advance_given';
  if (/loan|icd|borrow/.test(n)) return liab ? 'loan_received' : 'loan_given';
  if (/investment|capital a\/?c|current a\/?c/.test(n) && asset) return 'investment';
  return asset ? 'loan_given' : liab ? 'loan_received' : 'other_rpt';
}

// A short first word (e.g. 'dev') also needs the next word's stem, to avoid matching unrelated names
function rptPartyRegex(name) {
  const toks = String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter(t => t && !RPT_NAME_STOPWORDS.has(t));
  const i = toks.findIndex(t => t.length >= 3);
  if (i < 0) return null;
  const next = toks[i].length < 5 && toks[i + 1] ? `(?=.*\\b${toks[i + 1].slice(0, 4)})` : '';
  return new RegExp(`^${next}.*\\b${toks[i]}\\b`, 'i');
}

app.get('/api/rpt/mapping', async (req, res) => {
  try {
    const m = await readRptMapping();
    res.json({
      mappings: m.mappings, ignored: m.ignored || [], parties: RPT_PARTIES.map(p => p.name),
      natures: Object.entries(RPT_NATURES).map(([key, v]) => ({ key, label: v.label, bucket: v.bucket, normal: v.normal })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/rpt/mapping/options', async (req, res) => {
  const source = RPT_SOURCES.includes(req.query.source) ? req.query.source : null;
  if (!source) return res.status(400).json({ error: 'source must be sales, purchase or loan' });
  try { res.json(await rptOptions(source, req.query.refresh === '1')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Zoho customers / vendors / ledgers whose name looks like a related party but are not mapped
app.get('/api/rpt/mapping/unmapped', async (req, res) => {
  try {
    const m = await readRptMapping();
    const skip = new Set([...m.mappings, ...(m.ignored || [])].map(x => `${x.source}|${x.zohoId}`));
    const kws = RPT_PARTIES.map(p => ({ party: p.name, re: rptPartyRegex(p.name) })).filter(k => k.re);
    const out = [], errors = {};
    for (const source of RPT_SOURCES) {
      const { items, error } = await rptOptions(source, false);
      if (error) errors[source] = error;
      for (const it of items) {
        if (skip.has(`${source}|${it.id}`)) continue;
        const hit = kws.find(k => k.re.test(it.name || ''));
        if (!hit) continue;
        out.push({
          source, zohoId: it.id, zohoName: it.name, info: it.info || '', accountType: it.type || null,
          accountCode: it.code || '', typeLabel: it.typeLabel || '',
          suggestedParty: hit.party, nature: source === 'loan' ? rptSuggestNature(it.name, it.type) : null,
        });
      }
    }
    res.json({ items: out, errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upsert one or more mappings: { rows: [{ id?, source, zohoId, zohoName, party, nature?, accountType? }] }
app.post('/api/rpt/mapping', authMiddleware, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'No mapping rows supplied' });
    const partyNames = new Set(RPT_PARTIES.map(p => p.name));
    const m = await readRptMapping();
    const next = [...m.mappings];
    const now = new Date().toISOString();
    const label = { sales: 'Customer', purchase: 'Vendor', loan: 'Ledger' };
    for (const r of rows) {
      const source = r.source, zohoId = String(r.zohoId || '').trim();
      if (!RPT_SOURCES.includes(source)) return res.status(400).json({ error: `Invalid source type "${source}"` });
      if (!zohoId) return res.status(400).json({ error: 'Select a Zoho name / ledger' });
      if (!partyNames.has(r.party)) return res.status(400).json({ error: `Unknown related party "${r.party}"` });
      // A Zoho customer/vendor/ledger may belong to only one party, otherwise it would be counted twice
      const dup = next.find(x => x.source === source && x.zohoId === zohoId && x.id !== r.id);
      if (dup) return res.status(409).json({ error: `${label[source]} "${dup.zohoName}" is already mapped to ${dup.party}` });
      // Ledger mappings are keyed on the Zoho Account ID; name / code / type are kept for display
      const fields = {
        source, zohoId, zohoName: String(r.zohoName || zohoId), party: r.party, status: 'mapped',
        ...(source === 'loan' ? {
          nature: RPT_NATURES[r.nature] ? r.nature : (RPT_LEGACY_NATURE[r.nature] || 'loan_given'),
          accountType: r.accountType || null, accountCode: r.accountCode || '',
        } : {}),
      };
      if (r.id) {
        const idx = next.findIndex(x => x.id === r.id);
        if (idx < 0) return res.status(404).json({ error: 'Mapping not found — it may have been deleted' });
        const { nature, accountType, accountCode, ...base } = next[idx];
        next[idx] = { ...(source === 'loan' ? next[idx] : base), ...fields, updatedAt: now };
      } else {
        next.push({ id: rptNewId(), ...fields, createdAt: now, updatedAt: now });
      }
    }
    const saved = { ...m, mappings: next, ignored: (m.ignored || []).filter(i => !rows.some(r => r.source === i.source && String(r.zohoId) === i.zohoId)) };
    await writeRptMapping(saved);
    rptInvalidate();
    res.json({ ok: true, mappings: next });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/rpt/mapping/:id', authMiddleware, async (req, res) => {
  try {
    const m = await readRptMapping();
    const next = m.mappings.filter(x => x.id !== req.params.id);
    if (next.length === m.mappings.length) return res.status(404).json({ error: 'Mapping not found' });
    await writeRptMapping({ ...m, mappings: next });
    rptInvalidate();
    res.json({ ok: true, mappings: next });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hide an item from the Unmapped list: { source, zohoId, zohoName }
app.post('/api/rpt/mapping/ignore', authMiddleware, async (req, res) => {
  try {
    const { source, zohoId, zohoName } = req.body || {};
    if (!RPT_SOURCES.includes(source) || !zohoId) return res.status(400).json({ error: 'source and zohoId required' });
    const m = await readRptMapping();
    const ignored = (m.ignored || []).filter(i => !(i.source === source && i.zohoId === String(zohoId)));
    ignored.push({ source, zohoId: String(zohoId), zohoName: zohoName || '' });
    await writeRptMapping({ ...m, ignored });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnostic: test Zoho contact statement endpoint
app.get('/api/rpt/debug-statement', async (req, res) => {
  const contactId = req.query.contact_id;
  const fromDate  = req.query.from || '2025-04-01';
  const toDate    = req.query.to   || '2026-03-31';
  if (!contactId) return res.status(400).json({ error: 'contact_id required' });
  try {
    const data = await zohoGet(`/contacts/${contactId}/statements`, { from_date: fromDate, to_date: toDate });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message, response: e.response?.data }); }
});

// Diagnostic: inspect credit notes, payments, and invoice currencies for a customer
app.get('/api/rpt/debug-customer', async (req, res) => {
  const customerId = req.query.customer_id;
  if (!customerId) return res.status(400).json({ error: 'customer_id required' });
  try {
    // Credit notes
    const cnData = await zohoGet('/creditnotes', { customer_id: customerId, per_page: 200, page: 1 });
    const creditNotes = (cnData.creditnotes || []).map(cn => ({
      id: cn.creditnote_id, number: cn.creditnote_number,
      date: cn.date, status: cn.status, currency: cn.currency_code, total: cn.total,
    }));

    // Payments (first 2 pages)
    const payData = await zohoGet('/customerpayments', { customer_id: customerId, per_page: 200, page: 1 });
    const payments = (payData.customerpayments || []).slice(0, 10).map(p => ({
      id: p.payment_id, date: p.date, amount: p.amount, currency: p.currency_code,
    }));

    // Invoice list sample — show first few with currency info
    const invData = await zohoGet('/invoices', { customer_id: customerId, filter_by: 'Status.All', per_page: 20, page: 1 });
    const invoices = (invData.invoices || []).map(i => ({
      id: i.invoice_id, number: i.invoice_number, date: i.date,
      currency: i.currency_code, total: i.total, balance: i.balance, bcy_total: i.bcy_total,
    }));

    res.json({ creditNotes, payments_sample: payments, invoices_sample: invoices });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnostic: returns all unique vendor names + vendor_ids from the first N pages of bills
app.get('/api/rpt/debug-vendors', async (req, res) => {
  try {
    const pages = parseInt(req.query.pages) || 3;
    const map = {};
    for (let page = 1; page <= pages; page++) {
      const data = await zohoGet('/bills', { per_page: 200, page, filter_by: 'Status.All' });
      for (const b of data.bills || []) {
        const key = b.vendor_id || '?';
        if (!map[key]) map[key] = { vendor_name: b.vendor_name, vendor_id: b.vendor_id, count: 0 };
        map[key].count++;
      }
      if (!data.page_context?.has_more_page) break;
    }
    res.json(Object.values(map).sort((a, b) => a.vendor_name?.localeCompare(b.vendor_name)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Loans & Interest — from the mapped Zoho ledgers (?fy=fy2627, &refresh=1 refetches ledgers);
// parties with no ledger mapping keep their manual entries from rpt_loans.json
app.get('/api/rpt/loans', async (req, res) => {
  const fyKey = RPT_FY_RANGES[req.query.fy] ? req.query.fy : 'fy2627';
  try { res.json(await rptGetLoans(fyKey, req.query.refresh === '1')); }
  catch (e) { console.error(e.response?.data || e.message); res.status(500).json({ error: e.message }); }
});

app.post('/api/rpt/loans', express.json(), async (req, res) => {
  try {
    await writeRptLoans(req.body);
    rptInvalidate();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Vendor Registration ───────────────────────────────────────────────────────
const VENDOR_UPLOADS_DIR = path.join(__dirname, 'vendor-uploads');
const VENDOR_REG_FILE    = path.join(__dirname, 'vendor_registrations.json');

try { fs.mkdirSync(VENDOR_UPLOADS_DIR, { recursive: true }); } catch (_) {} // read-only disk on Vercel

async function readVendorRegs() {
  return await db.readJSON('vendor_registrations', VENDOR_REG_FILE, []);
}
async function writeVendorRegs(data) {
  await db.writeJSON('vendor_registrations', VENDOR_REG_FILE, data);
}
function genVendorId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

// ── Uploads on Vercel ─────────────────────────────────────────────────────────
// Vercel accepts at most ~4.5 MB per request, so its screens send attachments first, one per
// request (upload-session → upload-file), then submit the form without them. Files go to
// private Blob storage (file-store.js). The office PC keeps receiving files with the form.
const stagedUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });
const uploadToken = (kind, sid) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(`upload:${kind}:${sid}`).digest('hex');
function validUploadToken(kind, sid, token) {
  if (!sid || !token || !/^[a-z0-9]+$/.test(String(sid))) return false;
  const a = Buffer.from(String(token)), b = Buffer.from(uploadToken(kind, String(sid)));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
function stagedFileMiddleware(req, res, next) {
  stagedUpload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be under 4 MB' : err.message });
    next();
  });
}

const vendorStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!req.vendorSubmissionId) req.vendorSubmissionId = genVendorId();
    const dir = path.join(VENDOR_UPLOADS_DIR, req.vendorSubmissionId);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return cb(e); } // e.g. read-only disk on Vercel
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.fieldname + path.extname(file.originalname)),
});
const vendorUpload = multer({ storage: fileStore.enabled ? multer.memoryStorage() : vendorStorage, limits: { fileSize: 20 * 1024 * 1024 } });

const VENDOR_FILE_FIELDS = [
  { name: 'regOfficeGstCertificate',    maxCount: 1 },
  { name: 'gstCertificateForBill',      maxCount: 1 },
  { name: 'orgRegistrationProof',       maxCount: 1 },
  { name: 'orgPanCard',                 maxCount: 1 },
  { name: 'tanCertificate',             maxCount: 1 },
  { name: 'additionalTanCertificates',  maxCount: 10 },
  { name: 'msmeCertificate',            maxCount: 1 },
  { name: 'ptCertificate',              maxCount: 1 },
  { name: 'pfCertificate',              maxCount: 1 },
  { name: 'esiCertificate',             maxCount: 1 },
  { name: 'boardResolution',            maxCount: 1 },
  { name: 'signatoryAadharCard',        maxCount: 1 },
  { name: 'signatoryPanCard',           maxCount: 1 },
  { name: 'cancelledCheque',            maxCount: 1 },
  { name: 'esignAadharPdf',             maxCount: 1 },
  // New fields
  { name: 'brochureFile',               maxCount: 1 },
  { name: 'shopsEstCertificate',        maxCount: 1 },
  { name: 'additionalGstCert_0',        maxCount: 1 },
  { name: 'additionalGstCert_1',        maxCount: 1 },
  { name: 'additionalGstCert_2',        maxCount: 1 },
  { name: 'additionalGstCert_3',        maxCount: 1 },
  { name: 'additionalGstCert_4',        maxCount: 1 },
];

const VENDOR_FIELD_NAMES = new Set(VENDOR_FILE_FIELDS.map(f => f.name));

// Vercel only (public, used by the vendor form): one attachment per request into Blob storage
app.post('/api/vendor-registration/upload-session', (req, res) => {
  if (!fileStore.enabled) return res.json({ staged: false });
  const sid = genVendorId();
  res.json({ staged: true, sid, token: uploadToken('vendor', sid) });
});
app.post('/api/vendor-registration/upload-file', stagedFileMiddleware, async (req, res) => {
  const sid = String(req.headers['x-upload-session'] || '');
  if (!fileStore.enabled || !validUploadToken('vendor', sid, req.headers['x-upload-token'])) {
    return res.status(403).json({ error: 'Upload session not valid' });
  }
  const field = String(req.body?.field || '');
  if (!VENDOR_FIELD_NAMES.has(field)) return res.status(400).json({ error: `Unknown attachment: ${field}` });
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  try {
    const filename = field + path.extname(req.file.originalname);
    await fileStore.save(`vendor-uploads/${sid}/${filename}`, req.file.buffer, req.file.mimetype);
    res.json({ field, filename });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vendor-registration/submit — public endpoint
app.post('/api/vendor-registration/submit',
  (req, res, next) => { req.vendorSubmissionId = genVendorId(); next(); },
  vendorUpload.fields(VENDOR_FILE_FIELDS),
  async (req, res) => {
    try {
      let id = req.vendorSubmissionId;
      const body = req.body || {};
      const fileMap = {};
      if (fileStore.enabled) {
        // Vercel: attachments uploaded beforehand, one per request …
        if (body.uploadSession) {
          if (!validUploadToken('vendor', body.uploadSession, body.uploadToken)) {
            return res.status(403).json({ error: 'Upload session not valid — please submit again' });
          }
          id = body.uploadSession;
          for (const [field, filename] of Object.entries(parseJSON(body.uploadedFiles, {}))) {
            if (VENDOR_FIELD_NAMES.has(field) && filename === field + path.extname(filename)) fileMap[field] = filename;
          }
        }
        // … or sent with the form (small submissions): into Blob storage
        for (const [field, arr] of Object.entries(req.files || {})) {
          const f = arr[0];
          if (!f) continue;
          const filename = field + path.extname(f.originalname);
          await fileStore.save(`vendor-uploads/${id}/${filename}`, f.buffer, f.mimetype);
          fileMap[field] = filename;
        }
      } else {
        for (const [field, arr] of Object.entries(req.files || {})) {
          fileMap[field] = arr[0]?.filename || null;
        }
      }
      const record = {
        id,
        submittedAt: new Date().toISOString(),
        status: 'pending_legal',
        legalReviewedAt: null, legalReviewedBy: null, legalNote: null,
        accountsReviewedAt: null, accountsReviewedBy: null, accountsNote: null,
        zohoContactId: null,
        existingZohoContactId: body.existingZohoContactId || null,
        data: {
          // Vendor Details
          vendorLegalName:        body.vendorLegalName || '',
          tradeName:              body.tradeName || '',
          dateOfRegistration:     body.dateOfRegistration || '',
          typeOfVendor:           body.typeOfVendor || '',
          typeOfOrganization:     body.typeOfOrganization || '',
          companyIndustry:        body.companyIndustry || '',
          companySector:          body.companySector || '',
          noOfEmployees:          body.noOfEmployees || '',
          descriptionOfServices:  body.descriptionOfServices || '',
          vendorCriteria:         body.vendorCriteria || '',
          websiteUrl:             body.websiteUrl || '',
          hasBrochure:            body.hasBrochure || '',
          // Geographic
          regOfficeAddress1: body.regOfficeAddress1 || '',
          regOfficeAddress2: body.regOfficeAddress2 || '',
          regCity:           body.regCity || '',
          regState:          body.regState || '',
          regPinCode:        body.regPinCode || '',
          regCountry:        body.regCountry || 'India',
          // Invoicing
          hasGstNumber:                body.hasGstNumber || '',
          gstRegistrationStatus:       body.gstRegistrationStatus || '',
          gstNumberRegOffice:          body.gstNumberRegOffice || '',
          headOfficeGstNumber:         body.headOfficeGstNumber || '',
          gstNumberForBill:            body.gstNumberForBill || '',
          additionalGstRegistrations:  (() => { try { return JSON.parse(body.additionalGstRegistrations || '[]'); } catch (_) { return []; } })(),
          turnoverPreviousFY:          body.turnoverPreviousFY || '',
          turnoverCurrentFY:           body.turnoverCurrentFY || '',
          billingInfoSameAsReg:     body.billingInfoSameAsReg || '',
          billingAddress1:          body.billingAddress1 || '',
          billingAddress2:          body.billingAddress2 || '',
          billingCity:              body.billingCity || '',
          billingState:             body.billingState || '',
          billingPinCode:           body.billingPinCode || '',
          billingCountry:           body.billingCountry || 'India',
          // Statutory
          orgRegistrationNumber: body.orgRegistrationNumber || '',
          hasTanNumber:          body.hasTanNumber || '',
          tanNumber:             body.tanNumber || '',
          hasMultipleTanNumbers: body.hasMultipleTanNumbers || '',
          additionalTanNumbers:  (() => { try { return JSON.parse(body.additionalTanNumbers || '[]'); } catch (_) { return []; } })(),
          registerUnderMsme:     body.registerUnderMsme || '',
          msmeUdyamNumber:       body.msmeUdyamNumber || '',
          msmeCategory:          body.msmeCategory || '',
          msmeSector:            body.msmeSector || '',
          msmeFY:                body.msmeFY || '',
          hasProfessionalTax:    body.hasProfessionalTax || '',
          ptNumber:              body.ptNumber || '',
          hasProvidentFund:      body.hasProvidentFund || '',
          pfNumber:              body.pfNumber || '',
          hasEsi:                body.hasEsi || '',
          esiNumber:             body.esiNumber || '',
          shopsEstLicenseNumber: body.shopsEstLicenseNumber || '',
          shopsEstState:         body.shopsEstState || '',
          orgPan:                body.orgPan || '',
          // Authorized Signatory
          signatoryName:            body.signatoryName || '',
          signatoryDesignation:     body.signatoryDesignation || '',
          signatoryMobile:          body.signatoryMobile || '',
          signatoryAlternateMobile: body.signatoryAlternateMobile || '',
          signatoryEmail:           body.signatoryEmail || '',
          signatoryAadharNumber:    body.signatoryAadharNumber || '',
          signatoryPanSameAsOrg:    body.signatoryPanSameAsOrg || '',
          signatoryPanNumber:       body.signatoryPanNumber || '',
          signatoryDIN:             body.signatoryDIN || '',
          // Finance Team
          primaryFinanceContactName:  body.primaryFinanceContactName || '',
          primaryFinanceDesignation:  body.primaryFinanceDesignation || '',
          primaryFinanceMobile:       body.primaryFinanceMobile || '',
          primaryFinanceEmail:        body.primaryFinanceEmail || '',
          secondaryFinanceContactName: body.secondaryFinanceContactName || '',
          secondaryFinanceDesignation: body.secondaryFinanceDesignation || '',
          secondaryFinanceMobile:      body.secondaryFinanceMobile || '',
          secondaryFinanceEmail:       body.secondaryFinanceEmail || '',
          // Bank
          bankName:      body.bankName || '',
          ifscCode:      body.ifscCode || '',
          branchName:    body.branchName || '',
          swiftCode:     body.swiftCode || '',
          accountType:   body.accountType || '',
          micrCode:      body.micrCode || '',
          accountNumber: body.accountNumber || '',
          // E-Sign
          esignSignerName:  body.esignSignerName || '',
          esignSignerEmail: body.esignSignerEmail || '',
          // Terms
          suggestions: body.suggestions || '',
        },
        files: fileMap,
      };
      const regs = await readVendorRegs();
      regs.unshift(record);
      await writeVendorRegs(regs);
      res.json({ ok: true, id });
    } catch (e) {
      console.error('Vendor registration submit error:', e);
      res.status(500).json({ error: e.message });
    }
  }
);

// GET /api/vendor-registration/public-url — returns the configured public URL for the vendor form
app.get('/api/vendor-registration/public-url', (req, res) => {
  const publicUrl = process.env.VENDOR_FORM_PUBLIC_URL || null;
  res.json({ publicUrl });
});

// GET /api/vendor-registrations/zoho-search?q= — search Zoho Books vendor contacts for linking
app.get('/api/vendor-registrations/zoho-search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ vendors: [] });
    const qLower = q.toLowerCase();
    const data = await zohoGet('/contacts', {
      contact_type: 'vendor',
      contact_name_contains: q,
      per_page: 25,
    });
    // Post-filter server-side: only contacts whose name or company actually contains the query
    const all = (data.contacts || []);
    const filtered = all.filter(c => {
      const name = (c.contact_name || c.company_name || '').toLowerCase();
      const company = (c.company_name || '').toLowerCase();
      return name.includes(qLower) || company.includes(qLower);
    });
    // If Zoho didn't filter at all, fall back to returning all (so results still show)
    const result = filtered.length > 0 ? filtered : all.slice(0, 10);
    const vendors = result.slice(0, 15).map(c => ({
      contact_id: c.contact_id,
      contact_name: c.contact_name || c.company_name || c.display_name || '',
      company_name: c.company_name || '',
      email: c.email || '',
    }));
    res.json({ vendors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vendor-registrations — list all (for dashboard)
app.get('/api/vendor-registrations', async (req, res) => {
  const regs = await readVendorRegs();
  // Return summary list (without deep file paths)
  res.json(regs.map(r => ({
    id: r.id,
    submittedAt: r.submittedAt,
    status: r.status,
    vendorLegalName: r.data?.vendorLegalName || '',
    typeOfVendor: r.data?.typeOfVendor || '',
    typeOfOrganization: r.data?.typeOfOrganization || '',
    companySector: r.data?.companySector || '',
    legalNote: r.legalNote,
    accountsNote: r.accountsNote,
    zohoContactId: r.zohoContactId,
    legalReviewedAt: r.legalReviewedAt,
    accountsReviewedAt: r.accountsReviewedAt,
  })));
});

// GET /api/vendor-registrations/:id — full detail
app.get('/api/vendor-registrations/:id', async (req, res) => {
  const regs = await readVendorRegs();
  const rec = regs.find(r => r.id === req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  res.json(rec);
});

// PATCH /api/vendor-registrations/:id/legal — legal team approve or reject
app.patch('/api/vendor-registrations/:id/legal', express.json(), async (req, res) => {
  try {
    const { action, note, reviewedBy } = req.body;
    const regs = await readVendorRegs();
    const idx = regs.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    if (regs[idx].status !== 'pending_legal') return res.status(400).json({ error: 'Not in pending_legal state' });
    regs[idx].status = action === 'approve' ? 'pending_accounts' : 'legal_rejected';
    regs[idx].legalReviewedAt = new Date().toISOString();
    regs[idx].legalReviewedBy = reviewedBy || 'Legal Team';
    regs[idx].legalNote = note || null;
    await writeVendorRegs(regs);
    res.json({ ok: true, status: regs[idx].status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/vendor-registrations/:id/accounts — accounts team approve or reject
app.patch('/api/vendor-registrations/:id/accounts', express.json(), async (req, res) => {
  try {
    const { action, note, reviewedBy, existingZohoContactId } = req.body;
    const regs = await readVendorRegs();
    const idx = regs.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    if (regs[idx].status !== 'pending_accounts') return res.status(400).json({ error: 'Not in pending_accounts state' });

    if (action === 'reject') {
      regs[idx].status = 'accounts_rejected';
      regs[idx].accountsReviewedAt = new Date().toISOString();
      regs[idx].accountsReviewedBy = reviewedBy || 'Accounts Team';
      regs[idx].accountsNote = note || null;
      await writeVendorRegs(regs);
      return res.json({ ok: true, status: 'accounts_rejected' });
    }

    // Approve → create or update in Zoho Books
    const d = regs[idx].data;
    const zohoId = existingZohoContactId || regs[idx].existingZohoContactId;
    const billingAddr = d.billingInfoSameAsReg === 'Yes' ? {
      address: d.regOfficeAddress1 + (d.regOfficeAddress2 ? ', ' + d.regOfficeAddress2 : ''),
      city: d.regCity, state: d.regState, zip: d.regPinCode, country: d.regCountry,
    } : {
      address: d.billingAddress1 + (d.billingAddress2 ? ', ' + d.billingAddress2 : ''),
      city: d.billingCity, state: d.billingState, zip: d.billingPinCode, country: d.billingCountry,
    };

    const taxTreatment = (() => {
      if (d.hasGstNumber !== 'Yes') return 'gst_unregistered';
      const s = d.gstRegistrationStatus || '';
      if (s === 'Composition')    return 'gst_registered_composition';
      if (s === 'SEZ Unit')       return 'gst_registered_sez';
      if (s === 'SEZ Developer')  return 'gst_registered_sez_developer';
      return 'gst_registered_regular';
    })();

    const splitName = (full = '') => {
      const parts = full.trim().split(/\s+/);
      return { first: parts.slice(0, -1).join(' ') || parts[0] || '', last: parts.length > 1 ? parts[parts.length - 1] : '' };
    };

    // Use label format — Zoho reliably updates string custom fields by label on PUT
    // Dropdown fields (Type of Org, Company Sector/Industry, Vendor Criteria, Account Type, MSME Sector)
    // are excluded because our form values won't match Zoho's dropdown options exactly.
    const cfVal = (label, value) =>
      (value !== '' && value !== null && value !== undefined && value !== false)
        ? { label, value }
        : null;

    const customFields = [
      cfVal('Date of Registration',                        d.dateOfRegistration || ''),
      cfVal('Please Enter GST Number of Billing Address',  d.gstNumberForBill || ''),
      cfVal('Organization Registration Number',            d.orgRegistrationNumber || ''),
      cfVal('Organization TAN Number',                     d.tanNumber || ''),
      cfVal('FY of the Latest MSME Certificate',           d.msmeFY || ''),
      cfVal("Organization's Professional Tax number",      d.ptNumber || ''),
      cfVal("Organization's Provident Fund number",        d.pfNumber || ''),
      cfVal("Organization's ESI number",                   d.esiNumber || ''),
      cfVal('Bank Name',                                   d.bankName || ''),
      cfVal('Branch Name',                                 d.branchName || ''),
      cfVal('IFSC Code',                                   d.ifscCode || ''),
      cfVal('SWIFT Code',                                  d.swiftCode || ''),
      cfVal('MICR Code',                                   d.micrCode || ''),
      cfVal('Account Number',                              d.accountNumber || ''),
      cfVal('Shops & Est. License Number',                 d.shopsEstLicenseNumber || ''),
    ].filter(Boolean);

    const sigName = splitName(d.signatoryName);
    const priName = splitName(d.primaryFinanceContactName);
    const secName = splitName(d.secondaryFinanceContactName);

    const contactPersons = [
      {
        salutation: '',
        first_name: sigName.first,
        last_name:  sigName.last,
        designation: d.signatoryDesignation || '',
        mobile: d.signatoryMobile || '',
        phone:  d.signatoryAlternateMobile || '',
        email:  d.signatoryEmail || '',
      },
      ...(d.primaryFinanceContactName ? [{
        first_name:  priName.first,
        last_name:   priName.last,
        designation: d.primaryFinanceDesignation || '',
        mobile: d.primaryFinanceMobile || '',
        email:  d.primaryFinanceEmail || '',
      }] : []),
      ...(d.secondaryFinanceContactName ? [{
        first_name:  secName.first,
        last_name:   secName.last,
        designation: d.secondaryFinanceDesignation || '',
        mobile: d.secondaryFinanceMobile || '',
        email:  d.secondaryFinanceEmail || '',
      }] : []),
    ];

    // Base payload safe for both PUT (update) and POST (create)
    const zohoPayloadBase = {
      contact_name: d.vendorLegalName,
      company_name: d.vendorLegalName,
      website:      d.websiteUrl || '',
      email:        d.signatoryEmail || d.primaryFinanceEmail || '',
      pan_no:       d.orgPan || '',
      gst_no:       d.gstNumberRegOffice || d.gstNumberForBill || '',
      notes:        d.descriptionOfServices || '',
      billing_address: billingAddr,
      shipping_address: {
        address: d.regOfficeAddress1 + (d.regOfficeAddress2 ? ', ' + d.regOfficeAddress2 : ''),
        city: d.regCity, state: d.regState, zip: d.regPinCode, country: d.regCountry,
      },
      contact_persons: contactPersons,
      custom_fields: customFields,
    };

    // Fields only safe/needed on POST (creating new contact)
    const zohoPayloadCreate = {
      ...zohoPayloadBase,
      contact_type:  'vendor',
      tax_treatment: taxTreatment,
    };

    let zohoContactId = null;
    let zohoSyncError = null;
    try {
      if (zohoId) {
        const result = await zohoPut(`/contacts/${zohoId}`, zohoPayloadBase);
        if (result?.code !== undefined && result.code !== 0) {
          zohoSyncError = `Zoho error ${result.code}: ${result.message || 'Unknown error'}`;
        } else {
          zohoContactId = zohoId;
        }
      } else {
        const created = await zohoPost('/contacts', zohoPayloadCreate);
        if (created?.code !== undefined && created.code !== 0) {
          zohoSyncError = `Zoho error ${created.code}: ${created.message || 'Unknown error'}`;
        } else {
          zohoContactId = created?.contact?.contact_id || null;
        }
      }
    } catch (zohoErr) {
      const errData = zohoErr?.response?.data;
      zohoSyncError = errData
        ? `Zoho ${zohoErr.response.status}: ${errData.message || JSON.stringify(errData)}`
        : zohoErr.message;
      console.error('Zoho Books vendor sync error:', zohoSyncError);
    }

    regs[idx].status = 'completed';
    regs[idx].accountsReviewedAt = new Date().toISOString();
    regs[idx].accountsReviewedBy = reviewedBy || 'Accounts Team';
    regs[idx].accountsNote = note || null;
    regs[idx].zohoContactId = zohoContactId;
    regs[idx].zohoSyncError = zohoSyncError || null;
    if (existingZohoContactId) regs[idx].existingZohoContactId = existingZohoContactId;
    await writeVendorRegs(regs);
    res.json({ ok: true, status: 'completed', zohoContactId, zohoSyncError });
  } catch (e) {
    console.error('Accounts review error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/vendor-registrations/:id/zoho-retry — re-push data to Zoho Books
app.post('/api/vendor-registrations/:id/zoho-retry', express.json(), async (req, res) => {
  try {
    const regs = await readVendorRegs();
    const idx  = regs.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const reg = regs[idx];
    const zohoId = req.body.zohoContactId || reg.zohoContactId || reg.existingZohoContactId;
    if (!zohoId) return res.status(400).json({ error: 'No Zoho Contact ID on record — cannot retry.' });

    const d = reg.data;
    const billingAddr = d.billingInfoSameAsReg === 'Yes' ? {
      address: d.regOfficeAddress1 + (d.regOfficeAddress2 ? ', ' + d.regOfficeAddress2 : ''),
      city: d.regCity, state: d.regState, zip: d.regPinCode, country: d.regCountry,
    } : {
      address: (d.billingAddress1 || '') + (d.billingAddress2 ? ', ' + d.billingAddress2 : ''),
      city: d.billingCity, state: d.billingState, zip: d.billingPinCode, country: d.billingCountry,
    };

    const taxTreatment = (() => {
      if (d.hasGstNumber !== 'Yes') return 'gst_unregistered';
      const s = d.gstRegistrationStatus || '';
      if (s === 'Composition')  return 'gst_registered_composition';
      if (s === 'SEZ Unit')     return 'gst_registered_sez';
      if (s === 'SEZ Developer') return 'gst_registered_sez_developer';
      return 'gst_registered_regular';
    })();

    const splitName = (full = '') => {
      const parts = full.trim().split(/\s+/);
      return { first: parts.slice(0, -1).join(' ') || parts[0] || '', last: parts.length > 1 ? parts[parts.length - 1] : '' };
    };

    const cfVal = (label, value) =>
      (value !== '' && value !== null && value !== undefined && value !== false)
        ? { label, value } : null;

    const customFields = [
      cfVal('Date of Registration',                        d.dateOfRegistration || ''),
      cfVal('Please Enter GST Number of Billing Address',  d.gstNumberForBill || ''),
      cfVal('Organization Registration Number',            d.orgRegistrationNumber || ''),
      cfVal('Organization TAN Number',                     d.tanNumber || ''),
      cfVal('FY of the Latest MSME Certificate',           d.msmeFY || ''),
      cfVal("Organization's Professional Tax number",      d.ptNumber || ''),
      cfVal("Organization's Provident Fund number",        d.pfNumber || ''),
      cfVal("Organization's ESI number",                   d.esiNumber || ''),
      cfVal('Bank Name',                                   d.bankName || ''),
      cfVal('Branch Name',                                 d.branchName || ''),
      cfVal('IFSC Code',                                   d.ifscCode || ''),
      cfVal('SWIFT Code',                                  d.swiftCode || ''),
      cfVal('MICR Code',                                   d.micrCode || ''),
      cfVal('Account Number',                              d.accountNumber || ''),
      cfVal('Shops & Est. License Number',                 d.shopsEstLicenseNumber || ''),
    ].filter(Boolean);

    const sigName = splitName(d.signatoryName);
    const priName = splitName(d.primaryFinanceContactName);
    const secName = splitName(d.secondaryFinanceContactName);

    // Retry is always a PUT (update existing) — omit contact_type and tax_treatment
    const zohoPayload = {
      contact_name: d.vendorLegalName,
      company_name: d.vendorLegalName,
      website:      d.websiteUrl || '',
      email:        d.signatoryEmail || d.primaryFinanceEmail || '',
      pan_no:       d.orgPan || '',
      gst_no:       d.gstNumberRegOffice || d.gstNumberForBill || '',
      notes:        d.descriptionOfServices || '',
      billing_address: billingAddr,
      shipping_address: {
        address: d.regOfficeAddress1 + (d.regOfficeAddress2 ? ', ' + d.regOfficeAddress2 : ''),
        city: d.regCity, state: d.regState, zip: d.regPinCode, country: d.regCountry,
      },
      contact_persons: [
        { salutation: '', first_name: sigName.first, last_name: sigName.last,
          designation: d.signatoryDesignation || '', mobile: d.signatoryMobile || '',
          phone: d.signatoryAlternateMobile || '', email: d.signatoryEmail || '' },
        ...(d.primaryFinanceContactName ? [{ first_name: priName.first, last_name: priName.last,
          designation: d.primaryFinanceDesignation || '', mobile: d.primaryFinanceMobile || '',
          email: d.primaryFinanceEmail || '' }] : []),
        ...(d.secondaryFinanceContactName ? [{ first_name: secName.first, last_name: secName.last,
          designation: d.secondaryFinanceDesignation || '', mobile: d.secondaryFinanceMobile || '',
          email: d.secondaryFinanceEmail || '' }] : []),
      ],
      custom_fields: customFields,
    };

    let zohoSyncError = null;
    try {
      const result = await zohoPut(`/contacts/${zohoId}`, zohoPayload);
      if (result?.code !== undefined && result.code !== 0) {
        zohoSyncError = `Zoho error ${result.code}: ${result.message || 'Unknown error'}`;
      }
    } catch (zohoErr) {
      const errData = zohoErr?.response?.data;
      zohoSyncError = errData
        ? `Zoho ${zohoErr.response.status}: ${errData.message || JSON.stringify(errData)}`
        : zohoErr.message;
    }

    regs[idx].zohoSyncError = zohoSyncError || null;
    if (!zohoSyncError) regs[idx].zohoContactId = zohoId;
    await writeVendorRegs(regs);
    res.json({ ok: true, zohoSyncError });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/vendor-registrations/:id/file/:field — serve an uploaded file
app.get('/api/vendor-registrations/:id/file/:field', async (req, res) => {
  const regs = await readVendorRegs();
  const rec = regs.find(r => r.id === req.params.id);
  if (!rec) return res.status(404).send('Not found');
  const filename = rec.files?.[req.params.field];
  if (!filename) return res.status(404).send('File not found');
  if (fileStore.enabled) {
    if (!(await fileStore.send(res, `vendor-uploads/${rec.id}/${filename}`))) res.status(404).send('File missing in storage');
    return;
  }
  const filePath = path.join(VENDOR_UPLOADS_DIR, req.params.id, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File missing on disk');
  res.sendFile(filePath);
});

// ─── Cache bust ────────────────────────────────────────────────────────────────
app.post('/api/cache/clear', (req, res) => {
  cache.flushAll();
  res.json({ message: 'Cache cleared' });
});

// ─── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ─── Auth & User Management ───────────────────────────────────────────────────

// Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const users = await loadUsers();
  const user  = users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.active !== false);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Invalid username or password' });
  const token = signToken(user);
  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role, permissions: user.permissions } });
});

// Current user info
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const users = await loadUsers();
  const user  = users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, name: user.name, role: user.role, permissions: user.permissions });
});

// Module definitions (for admin UI)
app.get('/api/auth/modules', authMiddleware, adminOnly, (req, res) => res.json(MODULES));

// List users
app.get('/api/auth/users', authMiddleware, adminOnly, async (req, res) => {
  const users = (await loadUsers()).map(({ password: _, ...u }) => u);
  res.json(users);
});

// Create user
app.post('/api/auth/users', authMiddleware, adminOnly, async (req, res) => {
  const { username, name, password, role, permissions } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const users = await loadUsers();
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase()))
    return res.status(409).json({ error: 'Username already exists' });
  const newUser = {
    id: Date.now().toString(),
    username: username.trim(),
    name: (name || username).trim(),
    password: bcrypt.hashSync(password, 10),
    role: role || 'user',
    active: true,
    permissions: permissions || allPerms(),
  };
  users.push(newUser);
  await saveUsers(users);
  const { password: _, ...safe } = newUser;
  res.status(201).json(safe);
});

// Update user
app.put('/api/auth/users/:id', authMiddleware, adminOnly, async (req, res) => {
  const users = await loadUsers();
  const idx   = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const { name, password, role, active, permissions } = req.body || {};
  if (name)        users[idx].name        = name.trim();
  if (role)        users[idx].role        = role;
  if (active !== undefined) users[idx].active = !!active;
  if (permissions) users[idx].permissions = permissions;
  if (password)    users[idx].password    = bcrypt.hashSync(password, 10);
  // Admin always keeps full permissions
  if (users[idx].role === 'admin') users[idx].permissions = allPerms();
  await saveUsers(users);
  const { password: _, ...safe } = users[idx];
  res.json(safe);
});

// Delete user
app.delete('/api/auth/users/:id', authMiddleware, adminOnly, async (req, res) => {
  const users = await loadUsers();
  const user  = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role === 'admin' && users.filter(u => u.role === 'admin').length === 1)
    return res.status(400).json({ error: 'Cannot delete the last admin' });
  await saveUsers(users.filter(u => u.id !== req.params.id));
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TDS PAYABLE DASHBOARD — API Routes
// ═══════════════════════════════════════════════════════════════════════════════

const {
  computeMonthlyReport,
  extractTDSFromBill,
  SECTION_META,
} = require('./tds/tdsService');

// ─── Balance Sheet: TDS Payable extractor ─────────────────────────────────────
//
// Zoho Books Balance Sheet response has a hierarchy:
//   "TDS Payable" (parent account, e.g. 7,51,035)
//     ├─ TDS 193     (-1,68,245.14)
//     ├─ TDS 194A    (9,14,889.58)
//     └─ ...
//   Total for TDS Payable = SUM of parent + all sub-accounts = 69,52,141.74
//
// We must NOT just take the parent closing_balance — we need the GROUP TOTAL.
// Strategy:
//   1. Find the "TDS Payable" group node (exact name match).
//   2. If the node itself has a pre-computed `total` field → use it.
//   3. If it has sub-accounts → sum parent balance + sub-account balances (signed).
//   4. If neither → use closing_balance (API already rolled up the total).
// ──────────────────────────────────────────────────────────────────────────────

function balNum(node) {
  if (!node || typeof node !== 'object') return 0;
  const raw = node.closing_balance ?? node.balance ?? node.bcy_total ?? node.amount ?? node.total;
  return raw !== undefined && raw !== null ? Number(raw) : 0;
}

function tdsGroupTotal(groupNode) {
  // Pre-computed group total provided by the API (e.g. in a `total` field that
  // differs from `closing_balance` when sub-accounts exist).
  if (groupNode.total !== undefined && groupNode.total !== null
      && groupNode.closing_balance !== undefined
      && Number(groupNode.total) !== Number(groupNode.closing_balance)) {
    // API returned both: `total` is the group aggregate, `closing_balance` is parent-only.
    return Math.round(Math.abs(Number(groupNode.total)) * 100) / 100;
  }

  // Check for sub-accounts under various possible key names.
  const subs =
    groupNode.sub_accounts ||
    groupNode.children     ||
    groupNode.sub_account  ||
    [];

  if (Array.isArray(subs) && subs.length > 0) {
    // Sum parent balance + each sub-account balance (signed, to respect negative balances).
    const parentBal = Number(groupNode.closing_balance ?? groupNode.balance ?? 0);
    const subSum    = subs.reduce((acc, sa) => acc + balNum(sa), 0);
    return Math.round(Math.abs(parentBal + subSum) * 100) / 100;
  }

  // No sub-accounts: the API has already aggregated everything into closing_balance.
  const val = balNum(groupNode);
  return val !== 0 ? Math.round(Math.abs(val) * 100) / 100 : null;
}

function extractTDSPayableAmount(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = extractTDSPayableAmount(item);
      if (r !== null) return r;
    }
    return null;
  }

  const name = String(node.account_name || node.name || '').toLowerCase().trim();

  // Exact match on "tds payable" (the parent group account).
  if (name === 'tds payable' || name === 'tds_payable') {
    const total = tdsGroupTotal(node);
    if (total !== null) return total;
  }

  for (const key of Object.keys(node)) {
    const r = extractTDSPayableAmount(node[key]);
    if (r !== null) return r;
  }
  return null;
}

// Fetch Zoho Books Balance Sheet for a given month and return the TDS Payable amount.
// Uses the last day of the month as the "as of" date so the closing balance reflects
// all transactions within the selected month.
async function fetchTDSPayableFromBS(month) {
  const [y, m] = month.split('-').map(Number);
  const start   = `${month}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end     = `${month}-${String(lastDay).padStart(2, '0')}`;
  const data    = await zohoGet('/reports/balancesheet', { from_date: start, to_date: end });
  const amount  = extractTDSPayableAmount(data?.balancesheet || data);
  return { amount, raw: data };
}

/**
 * GET /api/tds-payable/monthly?month=YYYY-MM
 *
 * Returns the full TDS Payable report for one month.
 * Fetches bills + vendor payments from Zoho and passes them to the service.
 *
 * month defaults to the current calendar month.
 * Cache TTL: 5 minutes, keyed per month so different months cache independently.
 */
app.get('/api/tds-payable/monthly', async (req, res) => {
  try {
    const month = req.query.month
      ? String(req.query.month).trim()
      : new Date().toISOString().substring(0, 7);

    if (!/^\d{4}-\d{2}$/.test(month))
      return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM.' });

    const [y, m] = month.split('-').map(Number);
    if (m < 1 || m > 12)
      return res.status(400).json({ error: 'Month must be 01–12.' });

    // Dynamic cache key per month
    const cacheKey = `tds-pay-monthly-${month}`;
    const hit = cache.get(cacheKey);
    if (hit) return res.json(hit);

    const start   = `${month}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const end     = `${month}-${String(lastDay).padStart(2, '0')}`;

    // Step 1: Fetch bill list + vendor payments in parallel
    const [billList, vendorPayments] = await Promise.all([
      zohoGetAll('/bills', 'bills', { filter_by: 'Status.All' }, { dateFrom: start, dateTo: end }),
      syncedRange('vendor_payments_fy', start, end, () => zohoGetAll('/vendorpayments', 'vendorpayments', { date_start: start, date_end: end }, { dateFrom: start, dateTo: end })),
    ]);

    // Step 2: Only fetch DETAIL for bills that have tds_total > 0 in the list API.
    // The list API returns tds_total (amount) but not tds_summary[] (with section code).
    // Fetching detail for only TDS-eligible bills cuts API calls significantly.
    const tdsEligible  = billList.filter(b => Number(b.tds_total || 0) > 0 && b.bill_id);
    const tdsIneligible= billList.filter(b => !Number(b.tds_total || 0) || !b.bill_id);

    const detailedBills = [];
    for (let i = 0; i < tdsEligible.length; i += 15) {
      const batch = tdsEligible.slice(i, i + 15);
      const results = await Promise.all(
        batch.map(async (b) => {
          try {
            const d = await zohoGet(`/bills/${b.bill_id}`);
            return d.bill || b;
          } catch (_) {
            return b; // fall back to list data on error
          }
        })
      );
      detailedBills.push(...results);
    }

    const allBills = [...detailedBills, ...tdsIneligible];
    const report   = computeMonthlyReport(allBills, vendorPayments, month);

    // Step 3: Fetch authoritative TDS Payable from Balance Sheet → Month Wise report.
    // This is the "Total for TDS Payable" figure shown in Zoho Books B/S and is the
    // source of truth per Phase 1 requirements. Falls back to bill-calculated total
    // only if the Balance Sheet API call fails.
    let bsAmount = null;
    try {
      const bsResult = await fetchTDSPayableFromBS(month);
      if (bsResult.amount !== null && !isNaN(bsResult.amount)) {
        bsAmount = bsResult.amount;
      } else {
        console.warn(`[TDS Payable] Balance Sheet returned no TDS Payable entry for ${month}. Raw response logged below.`);
        console.warn(JSON.stringify(bsResult.raw, null, 2));
      }
    } catch (bsErr) {
      console.warn(`[TDS Payable] Balance Sheet fetch failed for ${month}:`, bsErr.response?.data || bsErr.message);
    }

    const finalPayable = bsAmount !== null ? bsAmount : report.summary.total_payable;
    const finalPending = Math.max(0, finalPayable - report.summary.total_paid);

    const finalReport = {
      ...report,
      summary: {
        ...report.summary,
        total_payable:      finalPayable,
        pending:            finalPending,
        bs_total_payable:   bsAmount,                                  // raw BS value for diagnostics
        calc_total_payable: report.summary.total_payable,              // bill-summed value for diagnostics
        payable_source:     bsAmount !== null ? 'balance_sheet' : 'bills_calculated',
      },
    };

    cache.set(cacheKey, finalReport, 1800);
    res.json(finalReport);
  } catch (e) {
    console.error('[TDS Payable]', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/tds-payable/discover?month=YYYY-MM
 *
 * Diagnostic endpoint: shows how TDS data is structured in the first 5 bills.
 * Use this to verify the detection logic is picking up the right fields.
 */
app.get('/api/tds-payable/discover', async (req, res) => {
  try {
    const month = (req.query.month || new Date().toISOString().substring(0, 7));
    const [y, m] = month.split('-').map(Number);
    const start  = `${month}-01`;
    const end    = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;

    // List API — limited fields
    const bills = await zohoGetAll('/bills', 'bills', { filter_by: 'Status.All' }, { dateFrom: start, dateTo: end });

    // Also fetch DETAIL for first 3 bills (detail API has withholding_tax and custom_fields)
    const detailSample = await Promise.all(
      bills.slice(0, 3).map(async (b) => {
        try {
          const d = await zohoGet(`/bills/${b.bill_id}`);
          const det = d.bill || {};
          return {
            bill_number:             det.bill_number,
            vendor_name:             det.vendor_name,
            date:                    det.date,
            created_time:            det.created_time,
            total:                   det.total,
            sub_total:               det.sub_total,
            withholding_tax_total:   det.withholding_tax_total,
            withholding_tax_details: det.withholding_tax_details,
            tds_summary:             det.tds_summary,
            custom_fields:           det.custom_fields,
            line_items_cf_sample:    (det.line_items || []).slice(0, 2).map(li => ({
              name:               li.name,
              withholding_tax:    li.withholding_tax,
              tds_amount:         li.tds_amount,
              item_custom_fields: li.item_custom_fields,
            })),
            extracted_tds:           extractTDSFromBill(det),
          };
        } catch (_) {
          return { bill_number: b.bill_number, error: 'Could not fetch detail' };
        }
      })
    );

    res.json({
      month,
      total_bills_in_month:   bills.length,
      list_api_fields_sample: bills.slice(0, 3).map(b => ({
        bill_number:           b.bill_number,
        bill_id:               b.bill_id,
        vendor_name:           b.vendor_name,
        withholding_tax_total: b.withholding_tax_total,
        tds_total:             b.tds_total,
        custom_fields:         b.custom_fields,
        all_keys:              Object.keys(b).filter(k => k.toLowerCase().includes('tds') || k.toLowerCase().includes('withhold') || k.toLowerCase().includes('tax')),
      })),
      detail_api_sample: detailSample,
      section_catalogue: SECTION_META,
      note: 'detail_api_sample shows data from GET /bills/{id} which includes withholding_tax & custom_fields. Use this to identify the correct field names for TDS in your Zoho org.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tds-payable/debug-extract
 * Temporary: test extractTDSFromBill with a known tds_summary object
 */
/**
 * GET /api/tds-payable/sections
 *
 * Static: returns the TDS section catalogue (used by the UI for labels/colours).
 */
app.get('/api/tds-payable/sections', (_req, res) => {
  res.json(SECTION_META);
});

/**
 * GET /api/tds-payable/bs-debug?month=YYYY-MM
 *
 * Diagnostic: returns the raw Zoho Balance Sheet response for the given month
 * alongside the extracted TDS Payable amount and the bill-calculated amount.
 * Use this to verify that the Balance Sheet integration is reading the correct value.
 */
app.get('/api/tds-payable/bs-debug', async (req, res) => {
  try {
    const month = (req.query.month || new Date().toISOString().substring(0, 7)).trim();
    if (!/^\d{4}-\d{2}$/.test(month))
      return res.status(400).json({ error: 'month must be YYYY-MM' });

    const { amount, raw } = await fetchTDSPayableFromBS(month);

    // Extract the TDS Payable group node for diagnostic display
    function findGroupNode(node) {
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) { for (const i of node) { const r = findGroupNode(i); if (r) return r; } return null; }
      const name = String(node.account_name || node.name || '').toLowerCase().trim();
      if (name === 'tds payable' || name === 'tds_payable') return node;
      for (const k of Object.keys(node)) { const r = findGroupNode(node[k]); if (r) return r; }
      return null;
    }
    const groupNode  = findGroupNode(raw?.balancesheet || raw);
    const subAccounts = groupNode
      ? (groupNode.sub_accounts || groupNode.children || groupNode.sub_account || [])
      : [];

    res.json({
      month,
      extracted_tds_payable: amount,
      status: amount !== null ? 'OK — Balance Sheet value will be used in dashboard' : 'NOT FOUND — bill-calculated value will be used instead',
      tds_payable_group: groupNode ? {
        account_name:    groupNode.account_name || groupNode.name,
        closing_balance: groupNode.closing_balance ?? groupNode.balance,
        total:           groupNode.total,
        sub_account_count: subAccounts.length,
        sub_accounts: subAccounts.map(s => ({
          name:    s.account_name || s.name,
          balance: s.closing_balance ?? s.balance ?? s.bcy_total,
        })),
      } : null,
      note: amount !== null
        ? 'extracted_tds_payable is the "Total for TDS Payable" including all sub-accounts. Verify it matches Zoho Books Balance Sheet.'
        : 'Check raw_balance_sheet to see the actual structure returned by Zoho Books and share it to fix the parser.',
      raw_balance_sheet: raw,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, response_data: e.response?.data });
  }
});

/**
 * GET /api/tds-payable/books-export?quarter=Q1&fy=2025-26
 *
 * Returns TDS-deducted bills in BooksRecord format for a quarter + FY.
 * Used by the TDS Reconciler Pro to fetch Books data for reconciliation.
 */
function getMonthsForQuarter(quarter, fy) {
  const year1 = parseInt(fy.split('-')[0]);
  const year2 = year1 + 1;
  const qm = {
    'Q1':       [[year1,4],[year1,5],[year1,6]],
    'Q2':       [[year1,7],[year1,8],[year1,9]],
    'Q3':       [[year1,10],[year1,11],[year1,12]],
    'Q4':       [[year2,1],[year2,2],[year2,3]],
    'Q1+Q2':    [[year1,4],[year1,5],[year1,6],[year1,7],[year1,8],[year1,9]],
    'Q1+Q2+Q3': [[year1,4],[year1,5],[year1,6],[year1,7],[year1,8],[year1,9],[year1,10],[year1,11],[year1,12]],
    'Full FY':  [[year1,4],[year1,5],[year1,6],[year1,7],[year1,8],[year1,9],[year1,10],[year1,11],[year1,12],[year2,1],[year2,2],[year2,3]],
  };
  return (qm[quarter] || []).map(([y, m]) => `${y}-${String(m).padStart(2,'0')}`);
}

function monthToTDSQuarter(yyyymm) {
  const m = parseInt(yyyymm.split('-')[1]);
  if (m >= 4 && m <= 6) return 'Q1';
  if (m >= 7 && m <= 9) return 'Q2';
  if (m >= 10 && m <= 12) return 'Q3';
  return 'Q4';
}

app.get('/api/tds-payable/books-export', async (req, res) => {
  try {
    const quarter = (req.query.quarter || 'Q1').trim();
    const fy      = (req.query.fy || '').trim();
    if (!fy || !/^\d{4}-\d{2}$/.test(fy))
      return res.status(400).json({ error: 'fy must be YYYY-YY format e.g. 2025-26' });

    const months = getMonthsForQuarter(quarter, fy);
    if (!months.length)
      return res.status(400).json({ error: `Unknown quarter "${quarter}"` });

    const cacheKey = `tds-books-export-${quarter}-${fy}`;
    const hit = cache.get(cacheKey);
    if (hit) return res.json(hit);

    // Collect all TDS-eligible bills across months
    const allEligibleBills = [];
    for (const month of months) {
      const [y, m] = month.split('-').map(Number);
      const start   = `${month}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      const end     = `${month}-${String(lastDay).padStart(2,'0')}`;
      const billList = await zohoGetAll('/bills', 'bills', { filter_by: 'Status.All' }, { dateFrom: start, dateTo: end });
      const eligible = billList.filter(b => Number(b.tds_total || 0) > 0 && b.bill_id)
        .map(b => ({ ...b, _month: month }));
      allEligibleBills.push(...eligible);
    }

    if (!allEligibleBills.length) return res.json([]);

    // Fetch bill detail for TDS section info
    const detailedBills = [];
    for (let i = 0; i < allEligibleBills.length; i += 15) {
      const batch = allEligibleBills.slice(i, i + 15);
      const results = await Promise.all(batch.map(async (b) => {
        try {
          const d = await zohoGet(`/bills/${b.bill_id}`);
          return { ...(d.bill || b), _month: b._month };
        } catch (_) { return b; }
      }));
      detailedBills.push(...results);
    }

    // Fetch vendor PAN numbers in batches
    const vendorIds = [...new Set(detailedBills.map(b => b.vendor_id).filter(Boolean))];
    const panMap = {};
    for (let i = 0; i < vendorIds.length; i += 15) {
      const batch = vendorIds.slice(i, i + 15);
      await Promise.all(batch.map(async (vid) => {
        try {
          const c = await zohoGet(`/contacts/${vid}`);
          if (c.contact && c.contact.pan_no) panMap[vid] = c.contact.pan_no.trim();
        } catch (_) {}
      }));
    }

    // Build BooksRecord[]
    const records = detailedBills.map(bill => {
      const tdsInfo = extractTDSFromBill(bill);
      if (!tdsInfo || tdsInfo.amount <= 0) return null;
      const rawDate = bill.date || '';
      const fmtDate = rawDate.includes('-')
        ? rawDate.split('-').reverse().join('/')
        : rawDate;
      return {
        pan:           panMap[bill.vendor_id] || '',
        partyName:     bill.vendor_name || '',
        section:       tdsInfo.section || '194J',
        quarter:       monthToTDSQuarter(bill._month || ''),
        invoiceNo:     bill.bill_number || '',
        taxableAmount: Number(bill.sub_total || bill.total || 0),
        tdsAmount:     tdsInfo.amount,
        date:          fmtDate,
        form:          '26Q',
        remarks:       bill.bill_number || '',
      };
    }).filter(Boolean);

    cache.set(cacheKey, records, 1800);
    res.json(records);
  } catch (e) {
    console.error('[TDS Books Export]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── POCM Dashboard (Needle And Thread Designs LLP) ──────────────────────────
const NT_ORG_ID = '60007894213';
const POCM_PROJECTS_FILE = path.join(__dirname, 'pocm_projects.json');
const POCM_MAPPING_FILE  = path.join(__dirname, 'pocm_mapping.json');

async function readPocmProjects() {
  return await db.readJSON('pocm_projects', POCM_PROJECTS_FILE, []);
}
async function savePocmProjects(d) {
  await db.writeJSON('pocm_projects', POCM_PROJECTS_FILE, d);
}

async function readPocmMapping() {
  const def = { projectCost: [], salaries: [], marketing: [], travelling: [], other: [] };
  const data = await db.readJSON('pocm_mapping', POCM_MAPPING_FILE, null);
  return data ? { ...def, ...data } : def;
}
async function savePocmMapping(d) {
  await db.writeJSON('pocm_mapping', POCM_MAPPING_FILE, d);
}

app.get('/api/pocm/projects', async (req, res) => res.json(await readPocmProjects()));

app.post('/api/pocm/projects', async (req, res) => {
  const projects = await readPocmProjects();
  const proj = { ...req.body };
  if (!proj.id) proj.id = 'proj_' + Date.now();
  const idx = projects.findIndex(p => p.id === proj.id);
  if (idx >= 0) projects[idx] = proj; else projects.push(proj);
  await savePocmProjects(projects);
  res.json({ ok: true, project: proj });
});

app.delete('/api/pocm/projects/:id', async (req, res) => {
  await savePocmProjects((await readPocmProjects()).filter(p => p.id !== req.params.id));
  res.json({ ok: true });
});

// ── Quarterly Project Value / Cost estimates ─────────────────────────────────
// One snapshot per (project, FY, quarter). Snapshots are never overwritten by a
// later quarter's update — computePOCM on the client resolves, for each month,
// the snapshot whose quarter contains (or most recently precedes) that month,
// so revising Q3's estimate can never silently rewrite Q1/Q2 historical figures.
const POCM_QE_FILE = path.join(__dirname, 'pocm_quarterly_estimates.json');

async function readPocmQE() {
  const def = { snapshots: {}, audit_trail: [] };
  const d = await db.readJSON('pocm_quarterly_estimates', POCM_QE_FILE, def);
  return { ...def, ...d };
}
async function writePocmQE(d) { await db.writeJSON('pocm_quarterly_estimates', POCM_QE_FILE, d); }

function pocmQEKey(projectId, fy, quarter) { return `${projectId}:${fy}:Q${quarter}`; }
function pocmQESortKey(fy, quarter) { return fy * 10 + quarter; }
function pocmQuarterEndDate(fy, quarter) {
  const fyNum = parseInt(fy, 10);
  return { 1: `${fyNum}-06-30`, 2: `${fyNum}-09-30`, 3: `${fyNum}-12-31`, 4: `${fyNum + 1}-03-31` }[parseInt(quarter, 10)];
}
// Latest snapshot strictly BEFORE the given (fy, quarter); falls back to the
// project's opening value/cost when no earlier snapshot exists.
function pocmFindPrevEstimate(qe, projectId, fy, quarter, project) {
  const targetKey = pocmQESortKey(fy, quarter);
  let best = null, bestKey = -1;
  for (const snap of Object.values(qe.snapshots)) {
    if (snap.projectId !== projectId) continue;
    const k = pocmQESortKey(snap.fy, snap.quarter);
    if (k < targetKey && k > bestKey) { best = snap; bestKey = k; }
  }
  if (best) return { projectValue: best.projectValue, projectCost: best.projectCost };
  return { projectValue: parseFloat(project.value) || 0, projectCost: parseFloat(project.estimatedCost) || 0 };
}

app.get('/api/pocm/quarterly-estimates', async (req, res) => {
  const qe = await readPocmQE();
  res.json(Object.values(qe.snapshots));
});

app.post('/api/pocm/quarterly-estimates', authMiddleware, async (req, res) => {
  try {
    const { projectId, fy, quarter, updateType, projectValue, projectCost } = req.body;
    if (!projectId || !fy || !quarter) return res.status(400).json({ error: 'projectId, fy and quarter are required' });
    if (!['Updated', 'Same as Previous Quarter'].includes(updateType)) return res.status(400).json({ error: 'updateType must be "Updated" or "Same as Previous Quarter"' });

    const projects = await readPocmProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const qe = await readPocmQE();
    const key = pocmQEKey(projectId, fy, quarter);
    const existing = qe.snapshots[key];
    const isAdmin = req.user?.role === 'admin';
    if (existing && !isAdmin) return res.status(409).json({ error: 'This quarter has already been updated.' });

    const prev = pocmFindPrevEstimate(qe, projectId, fy, quarter, project);

    let finalValue, finalCost;
    if (updateType === 'Same as Previous Quarter') {
      finalValue = prev.projectValue;
      finalCost  = prev.projectCost;
    } else {
      finalValue = parseFloat(projectValue);
      finalCost  = parseFloat(projectCost);
      if (!finalValue || isNaN(finalValue)) return res.status(400).json({ error: 'Revised Project Value is required and must be a number.' });
      if (!finalCost || isNaN(finalCost))  return res.status(400).json({ error: 'Revised Project Cost is required and must be a number.' });
    }

    const estimatedProfit    = finalValue - finalCost;
    const estimatedProfitPct = finalValue > 0 ? (estimatedProfit / finalValue) * 100 : 0;
    const user = req.user?.username || req.user?.name || 'unknown';
    const now  = new Date().toISOString();

    const snapshot = {
      projectId, projectName: project.name, fy: parseInt(fy, 10), quarter: parseInt(quarter, 10),
      quarterEndDate: pocmQuarterEndDate(fy, quarter),
      projectValue: finalValue, projectCost: finalCost,
      estimatedProfit, estimatedProfitPct, updateType,
      previousProjectValue: prev.projectValue, previousProjectCost: prev.projectCost,
      updatedBy: user, updatedAt: now,
    };

    qe.audit_trail = qe.audit_trail || [];
    qe.audit_trail.push({
      action: existing ? 'quarterly_amend' : 'quarterly_create',
      projectId, projectName: project.name, fy: snapshot.fy, quarter: snapshot.quarter,
      prev: existing || null, next: snapshot, user, timestamp: now,
    });
    qe.snapshots[key] = snapshot;
    await writePocmQE(qe);
    res.json({ ok: true, snapshot });
  } catch (e) {
    console.error('[POCM quarterly-estimates] save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/pocm/quarterly-estimates/audit', authMiddleware, adminOnly, async (req, res) => {
  const qe = await readPocmQE();
  const { projectId } = req.query;
  let trail = (qe.audit_trail || []).slice().reverse();
  if (projectId) trail = trail.filter(a => a.projectId === projectId);
  res.json(trail.slice(0, 200));
});

app.get('/api/pocm/mapping', async (req, res) => res.json(await readPocmMapping()));

app.post('/api/pocm/mapping', async (req, res) => {
  await savePocmMapping(req.body);
  cache.flushAll();
  res.json({ ok: true });
});

// List Zoho Books projects from NT org (for project linking)
app.get('/api/pocm/zoho-projects', cached('pocm-nt-projects-v2', 3600, async () => {
  try {
    const data = await zohoGet('/projects', { organization_id: NT_ORG_ID, per_page: 200 });
    return (data.projects || []).map(p => ({
      id: p.project_id,
      name: p.project_name,
      status: p.status,
      customer_name: p.customer_name || '',
    })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (_) { return []; }
}));

// Chart of accounts from NT org (for mapping setup)
app.get('/api/pocm/accounts', cached('pocm-nt-accounts', 86400, async () => {
  const data = await zohoGet('/chartofaccounts', { organization_id: NT_ORG_ID, showbalance: false });
  return (data.chartofaccounts || [])
    .map(a => ({ id: a.account_id, name: a.account_name, type: a.account_type, code: a.account_code || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}));

// ── Shared POCM data helpers ─────────────────────────────────────────────────
const pocmInFlight = new Map();

// ── POCM disk-persistence helpers ─────────────────────────────────────────
// node-cache is in-memory only — every server restart wipes pre-warmed data.
// We mirror bill/invoice caches to JSON files and reload them at startup.
const POCM_DISK_CACHE_DIR = path.join(__dirname, 'pocm_disk_cache');
try { fs.mkdirSync(POCM_DISK_CACHE_DIR, { recursive: true }); } catch (_) {} // read-only disk on Vercel

// Neon mode (Vercel): the same store lives in kv_store via pocm-sync (pocmSync.ensureLoaded)
function diskCacheSave(key, data) {
  if (db.USE_DB) return pocmSync.writeDiskCache(key, data);
  try {
    fs.writeFileSync(path.join(POCM_DISK_CACHE_DIR, `${key}.json`), JSON.stringify(data), 'utf8');
    console.log(`[POCM disk-cache] saved ${key} (${data.length} entries)`);
  } catch (e) {
    console.warn(`[POCM disk-cache] save failed for ${key}: ${e.message}`);
  }
}

function diskCacheLoad(key, ttl) {
  if (db.USE_DB) {
    const data = pocmSync.readDiskCache(key);
    if (data) cache.set(key, data, ttl);
    return data;
  }
  try {
    const file = path.join(POCM_DISK_CACHE_DIR, `${key}.json`);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache.set(key, data, ttl);
    console.log(`[POCM disk-cache] loaded ${key} (${data.length} entries) → node-cache`);
    return data;
  } catch (e) {
    console.warn(`[POCM disk-cache] load failed for ${key}: ${e.message}`);
    return null;
  }
}

function preloadPocmDiskCache() {
  try {
    const files = fs.readdirSync(POCM_DISK_CACHE_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const key = file.replace(/\.json$/, '');
      diskCacheLoad(key, 86400);
    }
    if (files.length > 0) console.log(`[POCM disk-cache] preloaded ${files.length} file(s) at startup`);
  } catch (e) {
    console.warn(`[POCM disk-cache] preload error: ${e.message}`);
  }
}

// Resolves mapping account IDs → lowercase account names via COA (cached 24h).
// Returns { lowerCaseName → category } for all mapped overhead accounts.
async function getPocmNameCategoryMap() {
  const key = 'pocm-name-cat-map';
  const hit = cache.get(key);
  if (hit) return hit;

  // Fetch COA from NT org
  const data = await zohoGet('/chartofaccounts', { organization_id: NT_ORG_ID, showbalance: false });
  const id2name = {};
  for (const a of (data.chartofaccounts || [])) {
    id2name[String(a.account_id)] = (a.account_name || '').toLowerCase().trim();
  }

  // Build name → category map from pocm_mapping.json
  const mapping = await readPocmMapping();
  const nameToCategory = {};
  for (const [cat, ids] of Object.entries(mapping)) {
    if (cat === 'projectCost') continue; // COGS matched by keyword, not mapping
    for (const id of (ids || [])) {
      const name = id2name[String(id)];
      if (name) nameToCategory[name] = cat;
    }
  }

  cache.set(key, nameToCategory, 86400);
  console.log(`[POCM COA] name→category map built: ${Object.keys(nameToCategory).length} overhead accounts`);
  return nameToCategory;
}

// PRIMARY STRATEGY: Read COGS from Journal Entries + Expenses.
// Journals include line_items in the LIST response → zero individual detail/bill calls.
// When Zoho Books posts a bill with COGS line items it auto-creates a journal entry
// (DR Cost of Goods Sold / CR Accounts Payable). We harvest that entry directly.
// Total API calls: 2–8 regardless of how many bills exist.  Previous approach: 500+.
async function getPocmAllBills(fromDate) {
  const fyYear = parseInt(fromDate.substring(0, 4));
  const toDate  = `${fyYear + 1}-03-31`;
  const key = `pocm-bills-v8-${fromDate}`;

  const hit = cache.get(key) || diskCacheLoad(key, 86400);
  if (hit) return hit;
  if (pocmInFlight.has(key)) return pocmInFlight.get(key);

  const promise = (async () => {
    // Resolve mapping IDs → account names via COA (bill line items only have account_name, not account_id)
    const nameToCategory = await getPocmNameCategoryMap();
    const isCOGS         = (name) => (name || '').toLowerCase().includes('cost of goods sold');
    const overheadCatFor = (name) => nameToCategory[(name || '').toLowerCase().trim()] || null;
    const allEntries = [];

    // ── 1. Bill detail calls (sequential, 1200ms gap → ~50/min, stays under Zoho's cap)
    // No artificial cap: a partial fetch here would silently understate cost for
    // whichever bills got cut off (this bit the dashboard before — bills sorted
    // newest-first meant the OLDEST months in the FY were the ones dropped).
    // Safe because callers pre-warm this same cache via /api/pocm/bills-tranche
    // in small batches first; this full-fetch path only runs if that wasn't done.
    console.log(`[POCM bills] fetching bill list ${fromDate}→${toDate}`);
    const billList = await zohoGetAll('/bills', 'bills',
      { organization_id: NT_ORG_ID, date_start: fromDate, date_end: toDate, sort_column: 'date', sort_order: 'D' },
      { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 20 });

    const active = billList.filter(b => (b.status || '').toLowerCase() !== 'void');
    const cap = active.length;
    console.log(`[POCM bills] ${active.length} active bills → fetching details for all ${cap} sequentially`);

    for (let i = 0; i < cap; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 1200)); // ~50/min, stays under Zoho's per-minute cap
      const b = active[i];
      try {
        const d = await zohoGet(`/bills/${b.bill_id}`, { organization_id: NT_ORG_ID });
        const bill = d.bill || {};
        const billProject = (bill.project_name || '').trim();

        for (const li of (bill.line_items || [])) {
          const isCOGSItem  = isCOGS(li.account_name);
          const overheadCat = overheadCatFor(li.account_name);

          if (!isCOGSItem && !overheadCat) continue;

          const liProject = (li.project_name || '').trim();
          const effectiveProject = liProject || billProject;
          const amount = parseFloat(li.item_total) || 0;
          if (amount <= 0) continue;

          allEntries.push({
            bill_id:      b.bill_id,
            bill_number:  bill.bill_number || b.bill_number || b.bill_id,
            vendor:       bill.vendor_name || b.vendor_name || '',
            date:         bill.date || b.date || '',
            bill_project: effectiveProject,
            _category:    isCOGSItem ? 'projectCost' : overheadCat,
            line_items: [{
              account_name:            li.account_name,
              project_name:            effectiveProject,
              item_total:              amount,
              description:             li.description || li.name || '',
              quantity:                li.quantity || 0,
              rate:                    li.rate || 0,
              cf_project_sub_category: li.cf_project_sub_category || '',
            }],
          });
        }
      } catch (err) {
        if (err.message?.startsWith('ZOHO_DAILY_LIMIT')) throw err;
        console.warn(`[POCM bills] detail failed for bill ${b.bill_id}: ${err.message}`);
      }
      if ((i + 1) % 20 === 0) console.log(`[POCM bills] ${i + 1}/${cap} bills done`);
    }
    console.log(`[POCM bills] ${allEntries.length} mapped line items (COGS+overhead) from ${cap} bills`);

    // ── 2. Direct Expenses (list has account_name; match by name via COA-resolved map) ──
    const expenses = await zohoGetAll('/expenses', 'expenses',
      { organization_id: NT_ORG_ID, date_start: fromDate, date_end: toDate, sort_column: 'date', sort_order: 'D' },
      { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 10 });

    for (const exp of expenses) {
      const isCOGSExp   = isCOGS(exp.account_name);
      const overheadCat = overheadCatFor(exp.account_name);

      if (!isCOGSExp && !overheadCat) continue;

      const amount = parseFloat(exp.total) || parseFloat(exp.amount) || 0;
      if (amount <= 0) continue;

      allEntries.push({
        bill_id:      exp.expense_id,
        bill_number:  exp.expense_id,
        vendor:       exp.vendor_name || exp.paid_through_account_name || '',
        date:         exp.date || '',
        bill_project: (exp.project_name || '').trim(),
        _category:    isCOGSExp ? 'projectCost' : overheadCat,
        line_items: [{
          account_name: exp.account_name,
          project_name: (exp.project_name || '').trim(),
          item_total:   amount,
          description:  exp.description || '',
          quantity:     1,
          rate:         amount,
        }],
      });
    }

    console.log(`[POCM bills] total entries (bills+expenses, all mapped): ${allEntries.length}`);
    cache.set(key, allEntries, 86400);
    diskCacheSave(key, allEntries);
    return allEntries;
  })();

  pocmInFlight.set(key, promise);
  promise.catch(() => {}).finally(() => pocmInFlight.delete(key));
  return promise;
}

// Vendor Credits / Purchase Credit Notes — must be netted against Purchase Bills
// to get the true "Cost This Month" (a credit note reduces what was actually
// spent, e.g. a return or a billing correction). We fetch these SEPARATELY from
// bills and subtract at aggregation time in /monthly-expenses — we never touch
// bill.line_items[].item_total itself (that stays the original, unadjusted bill
// amount), so a credit is never double-counted via "the bill already reflects
// it" AND "we subtracted it again": the bill side is always gross, the credit
// side is always its own line items, and net = gross - credit, computed once.
async function getPocmAllVendorCredits(fromDate) {
  const fyYear = parseInt(fromDate.substring(0, 4));
  const toDate  = `${fyYear + 1}-03-31`;
  const key = `pocm-vendorcredits-v1-${fromDate}`;

  const hit = cache.get(key) || diskCacheLoad(key, 86400);
  if (hit) return hit;
  if (pocmInFlight.has(key)) return pocmInFlight.get(key);

  const promise = (async () => {
    const nameToCategory = await getPocmNameCategoryMap();
    const isCOGS         = (name) => (name || '').toLowerCase().includes('cost of goods sold');
    const overheadCatFor = (name) => nameToCategory[(name || '').toLowerCase().trim()] || null;
    const allEntries = [];

    console.log(`[POCM vendor credits] fetching list ${fromDate}→${toDate}`);
    const creditList = await zohoGetAll('/vendorcredits', 'vendor_credits',
      { organization_id: NT_ORG_ID, date_start: fromDate, date_end: toDate, sort_column: 'date', sort_order: 'D' },
      { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 10 });

    const active = creditList.filter(c => (c.status || '').toLowerCase() !== 'void');
    console.log(`[POCM vendor credits] ${active.length} active credits → fetching details`);

    for (let i = 0; i < active.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 1200)); // same rate-limit budget as bill details
      const c = active[i];
      try {
        const d  = await zohoGet(`/vendorcredits/${c.vendor_credit_id}`, { organization_id: NT_ORG_ID });
        const vc = d.vendor_credit || {};
        // Fallback only — every credit inspected so far carries project_name on
        // each line item directly (same as bills), but a header-level custom
        // field ("Project") is the safety net if a line item ever lacks one.
        const headerProject = (vc.custom_field_hash?.cf_project_formatted || vc.custom_field_hash?.cf_project || '').trim();
        const appliedBills = (vc.bills_credited || []).map(b => b.bill_number).filter(Boolean).join(', ') || vc.bill_number || '';

        for (const li of (vc.line_items || [])) {
          const isCOGSItem  = isCOGS(li.account_name);
          const overheadCat = overheadCatFor(li.account_name);
          if (!isCOGSItem && !overheadCat) continue;

          const liProject = (li.project_name || '').trim();
          const effectiveProject = liProject || headerProject;
          const amount = parseFloat(li.item_total) || 0; // pre-tax, same basis as bill item_total
          if (amount <= 0) continue;

          allEntries.push({
            credit_id:      c.vendor_credit_id,
            credit_number:  vc.vendor_credit_number || c.vendor_credit_number,
            vendor:         vc.vendor_name || c.vendor_name || '',
            date:           vc.date || c.date || '',
            credit_project: effectiveProject,
            applied_bills:  appliedBills,
            _category:      isCOGSItem ? 'projectCost' : overheadCat,
            line_items: [{
              account_name: li.account_name,
              project_name: effectiveProject,
              item_total:   amount,
              description:  li.description || li.name || '',
              quantity:     li.quantity || 0,
              rate:         li.rate || 0,
            }],
          });
        }
      } catch (err) {
        if (err.message?.startsWith('ZOHO_DAILY_LIMIT')) throw err;
        console.warn(`[POCM vendor credits] detail failed for credit ${c.vendor_credit_id}: ${err.message}`);
      }
    }

    console.log(`[POCM vendor credits] ${allEntries.length} mapped line items (COGS+overhead) from ${active.length} credits`);
    cache.set(key, allEntries, 86400);
    diskCacheSave(key, allEntries);
    return allEntries;
  })();

  pocmInFlight.set(key, promise);
  promise.catch(() => {}).finally(() => pocmInFlight.delete(key));
  return promise;
}

// ── Tranche-based bill detail fetch ──────────────────────────────────────────
// getPocmAllBills() above does its ~500 sequential bill-detail calls inside one
// request — for a full FY that's ~8-10 minutes of Zoho calls and reliably trips
// the client's 600s timeout. This lets the client fetch details in small batches
// across repeated short requests instead, with visible progress, then writes the
// SAME final cache key getPocmAllBills() reads — so once tranching completes,
// every existing endpoint (monthly-expenses, monthly-overhead, ...) just gets an
// instant cache hit as before. No artificial 500-bill cap: since no single
// request has to finish the whole list, we process every active bill found.
const pocmBillTrancheState = new Map(); // fromDate -> { active, entries, processedCount, total, nameToCategory, toDate }
const pocmTrancheLock = new Set(); // fromDate currently being processed — prevents two concurrent requests
                                    // from reading the same stale processedCount and racing (which caused
                                    // duplicate + dropped entries when tested with overlapping requests)

async function getOrInitPocmBillTrancheState(fromDate) {
  let state = pocmBillTrancheState.get(fromDate);
  if (state) return state;

  const fyYear = parseInt(fromDate.substring(0, 4));
  const toDate = `${fyYear + 1}-03-31`;
  const nameToCategory = await getPocmNameCategoryMap();

  const billList = await zohoGetAll('/bills', 'bills',
    { organization_id: NT_ORG_ID, date_start: fromDate, date_end: toDate, sort_column: 'date', sort_order: 'D' },
    { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 15 }); // up to ~3000 bills

  const active = billList.filter(b => (b.status || '').toLowerCase() !== 'void').slice(0, 3000);
  state = { active, entries: [], processedCount: 0, total: active.length, nameToCategory, toDate };
  pocmBillTrancheState.set(fromDate, state);
  return state;
}

app.get('/api/pocm/bills-tranche', async (req, res) => {
  const { fromDate } = req.query;
  const batchSize = Math.min(parseInt(req.query.batchSize, 10) || 40, 100);
  if (!fromDate) return res.status(400).json({ error: 'fromDate required' });

  const finalKey = `pocm-bills-v8-${fromDate}`;
  const already = cache.get(finalKey) || diskCacheLoad(finalKey, 86400);
  if (already) return res.json({ done: 1, total: 1, complete: true });

  if (pocmTrancheLock.has(fromDate)) {
    // Another request is mid-batch for this fromDate — tell the client to wait
    // and ask again rather than reading the same processedCount concurrently.
    return res.json({ done: 0, total: 1, complete: false, busy: true });
  }
  pocmTrancheLock.add(fromDate);

  try {
    const state = await getOrInitPocmBillTrancheState(fromDate);
    const isCOGS         = (name) => (name || '').toLowerCase().includes('cost of goods sold');
    const overheadCatFor = (name) => state.nameToCategory[(name || '').toLowerCase().trim()] || null;

    const start = state.processedCount;
    const end   = Math.min(start + batchSize, state.total);
    let retryAfterSecs = null;

    let i = start;
    for (; i < end; i++) {
      if (i > start) await new Promise(r => setTimeout(r, 1200)); // ~50/min, stays under Zoho's per-minute cap
      const b = state.active[i];
      try {
        const d = await zohoGet(`/bills/${b.bill_id}`, { organization_id: NT_ORG_ID });
        const bill = d.bill || {};
        const billProject = (bill.project_name || '').trim();

        for (const li of (bill.line_items || [])) {
          const isCOGSItem  = isCOGS(li.account_name);
          const overheadCat = overheadCatFor(li.account_name);
          if (!isCOGSItem && !overheadCat) continue;

          const liProject = (li.project_name || '').trim();
          const effectiveProject = liProject || billProject;
          const amount = parseFloat(li.item_total) || 0;
          if (amount <= 0) continue;

          state.entries.push({
            bill_id:      b.bill_id,
            bill_number:  bill.bill_number || b.bill_number || b.bill_id,
            vendor:       bill.vendor_name || b.vendor_name || '',
            date:         bill.date || b.date || '',
            bill_project: effectiveProject,
            _category:    isCOGSItem ? 'projectCost' : overheadCat,
            line_items: [{
              account_name:            li.account_name,
              project_name:            effectiveProject,
              item_total:              amount,
              description:             li.description || li.name || '',
              quantity:                li.quantity || 0,
              rate:                    li.rate || 0,
              cf_project_sub_category: li.cf_project_sub_category || '',
            }],
          });
        }
      } catch (err) {
        if (err.message?.startsWith('ZOHO_DAILY_LIMIT')) throw err;
        if (err.response?.status === 429) {
          // A long block (retry-after > 60s, e.g. per-minute cap tripped) — zohoGet
          // already gave up retrying internally. Stop this tranche WITHOUT advancing
          // past this bill, so the next tranche call retries it instead of silently
          // losing its data. The client backs off before calling again.
          retryAfterSecs = parseInt(err.response.headers['retry-after'] || '65', 10);
          console.warn(`[POCM bills-tranche] rate-limited at bill ${i}/${state.total} — pausing tranche, retry after ${retryAfterSecs}s`);
          break;
        }
        console.warn(`[POCM bills-tranche] detail failed for bill ${b.bill_id}: ${err.message}`);
      }
    }
    state.processedCount = retryAfterSecs != null ? i : end; // don't advance past a rate-limited bill
    const complete = !retryAfterSecs && state.processedCount >= state.total;

    if (complete) {
      // Fold in direct Expenses too (list-only, fast) — matches getPocmAllBills's step 2
      const expenses = await zohoGetAll('/expenses', 'expenses',
        { organization_id: NT_ORG_ID, date_start: fromDate, date_end: state.toDate, sort_column: 'date', sort_order: 'D' },
        { dateField: 'date', dateFrom: fromDate, dateTo: state.toDate, maxPages: 10 });
      for (const exp of expenses) {
        const isCOGSExp   = isCOGS(exp.account_name);
        const overheadCat = overheadCatFor(exp.account_name);
        if (!isCOGSExp && !overheadCat) continue;
        const amount = parseFloat(exp.total) || parseFloat(exp.amount) || 0;
        if (amount <= 0) continue;
        state.entries.push({
          bill_id:      exp.expense_id,
          bill_number:  exp.expense_id,
          vendor:       exp.vendor_name || exp.paid_through_account_name || '',
          date:         exp.date || '',
          bill_project: (exp.project_name || '').trim(),
          _category:    isCOGSExp ? 'projectCost' : overheadCat,
          line_items: [{
            account_name: exp.account_name,
            project_name: (exp.project_name || '').trim(),
            item_total:   amount,
            description:  exp.description || '',
            quantity:     1,
            rate:         amount,
          }],
        });
      }
      cache.set(finalKey, state.entries, 86400);
      diskCacheSave(finalKey, state.entries);
      pocmBillTrancheState.delete(fromDate);
      console.log(`[POCM bills-tranche] complete: ${state.entries.length} mapped entries from ${state.total} bills`);
    }

    res.json({ done: state.processedCount, total: state.total, complete, retryAfterSecs: retryAfterSecs || undefined });
  } catch (e) {
    if (e.message?.startsWith('ZOHO_DAILY_LIMIT')) {
      pocmBillTrancheState.delete(fromDate);
      return res.status(429).json({ error: e.message });
    }
    console.error('[POCM bills-tranche]', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    pocmTrancheLock.delete(fromDate);
  }
});

async function getPocmAllInvoices(fromDate) {
  const fyYear = parseInt(fromDate.substring(0, 4));
  const toDate  = `${fyYear + 1}-03-31`;
  const key = `pocm-invoices-v5-${fromDate}`;

  const hit = cache.get(key) || diskCacheLoad(key, 86400);
  if (hit) return hit;
  if (pocmInFlight.has(key)) return pocmInFlight.get(key);

  const promise = (async () => {
    // List-only approach — ZERO detail calls.
    // Invoice list already contains project_name, date, sub_total, total at header level.
    console.log(`[POCM invoices] fetching list (NO detail calls) ${fromDate}→${toDate}`);
    const invoices = await zohoGetAll('/invoices', 'invoices',
      { organization_id: NT_ORG_ID, date_start: fromDate, date_end: toDate, sort_column: 'date', sort_order: 'D' },
      { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 10 });

    const active = invoices.filter(inv => !['void','draft'].includes((inv.status || '').toLowerCase()));
    console.log(`[POCM invoices] total=${invoices.length} active=${active.length}`);
    if (active.length > 0) console.log('[POCM invoices] list keys:', Object.keys(active[0]).join(', '));

    // Build one synthetic line_item per invoice using header-level data (no detail call)
    const allDetails = active.map(inv => ({
      invoice_id:     inv.invoice_id,
      invoice_number: inv.invoice_number || inv.invoice_id,
      customer:       inv.customer_name || '',
      date:           inv.date || '',
      inv_project:    (inv.project_name || '').trim(),
      line_items: [{
        project_name: (inv.project_name || '').trim(),
        item_total:   parseFloat(inv.sub_total || inv.total) || 0, // sub_total = pre-tax
        description:  inv.reference_number || '',
        quantity:     1,
        rate:         parseFloat(inv.sub_total || inv.total) || 0,
      }],
    }));

    console.log(`[POCM invoices] ${allDetails.length} invoices ready (list-only, 0 detail calls)`);
    cache.set(key, allDetails, 86400);
    diskCacheSave(key, allDetails);
    return allDetails;
  })();

  pocmInFlight.set(key, promise);
  promise.catch(() => {}).finally(() => pocmInFlight.delete(key));
  return promise;
}

// ── Debug: sample bill & journal fields from NT org ─────────────────────────
app.get('/api/pocm/debug-fields', async (req, res) => {
  try {
    const fromDate = req.query.fromDate || '2026-04-01';
    const toDate   = req.query.toDate   || '2027-03-31';

    // Fetch first page of bills
    const billsData = await zohoGet('/bills', {
      organization_id: NT_ORG_ID, date_start: fromDate, date_end: toDate,
      sort_column: 'date', sort_order: 'D', per_page: 5, page: 1,
    });
    const bills = billsData.bills || [];

    // Fetch first page of journals
    const jData = await zohoGet('/journals', {
      organization_id: NT_ORG_ID, date_start: fromDate, date_end: toDate,
      sort_column: 'journal_date', sort_order: 'D', per_page: 5, page: 1,
    });
    const journals = jData.journals || [];

    // Fetch detail for first 5 bills to see project_name usage
    let billDetail = null;
    const billDetailSurvey = [];
    for (const b of bills.slice(0, 5)) {
      try {
        const d = await zohoGet(`/bills/${b.bill_id}`, { organization_id: NT_ORG_ID });
        const bd = d.bill || {};
        if (!billDetail) billDetail = bd;
        billDetailSurvey.push({
          bill_id: b.bill_id,
          bill_number: b.bill_number,
          vendor: b.vendor_name,
          date: b.date,
          header_project_name: bd.project_name || '',
          cogs_line_items: (bd.line_items || [])
            .filter(li => (li.account_name || '').toLowerCase().includes('cost of goods sold'))
            .map(li => ({ account_name: li.account_name, project_name: li.project_name || '', item_total: li.item_total, description: li.description })),
          all_line_item_projects: (bd.line_items || []).map(li => li.project_name || '').filter(p => p),
        });
        await new Promise(r => setTimeout(r, 300)); // avoid rate limiting
      } catch (_) {}
    }

    res.json({
      bill_count: bills.length,
      bill_list_fields: bills.length > 0 ? Object.keys(bills[0]) : [],
      bill_list_sample: bills.slice(0, 2),
      bill_detail_survey: billDetailSurvey,
      bill_detail_fields: billDetail ? Object.keys(billDetail) : [],
      bill_detail_project_name: billDetail?.project_name,
      bill_detail_custom_fields: billDetail?.custom_fields || [],
      bill_detail_custom_field_hash: billDetail?.custom_field_hash || {},
      bill_detail_line_item_sample: (billDetail?.line_items || []).slice(0, 3).map(li => ({
        account_name: li.account_name,
        project_id: li.project_id,
        project_name: li.project_name,
        customer_name: li.customer_name,
        customer_id: li.customer_id,
        item_total: li.item_total,
        description: li.description,
        cf_project_sub_category: li.cf_project_sub_category,
        item_custom_fields: li.item_custom_fields,
      })),
      journal_count: journals.length,
      journal_fields: journals.length > 0 ? Object.keys(journals[0]) : [],
      journal_line_item_fields: (journals[0]?.line_items?.length > 0) ? Object.keys(journals[0].line_items[0]) : [],
      journal_sample: journals.slice(0, 2),
      // Invoice sampling
      invoice_sample: await (async () => {
        try {
          const invData = await zohoGet('/invoices', {
            organization_id: NT_ORG_ID, date_start: fromDate, date_end: toDate,
            sort_column: 'date', sort_order: 'D', per_page: 10, page: 1,
          });
          const invs = (invData.invoices || []).filter(i => !['void','draft'].includes((i.status||'').toLowerCase()));
          return invs.slice(0, 5).map(inv => ({
            invoice_number: inv.invoice_number,
            customer: inv.customer_name,
            date: inv.date,
            status: inv.status,
            project_name: inv.project_name || '',
            sub_total: inv.sub_total,
            total: inv.total,
            all_keys_with_project: Object.keys(inv).filter(k => k.includes('project')),
          }));
        } catch { return []; }
      })(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message, detail: e.response?.data });
  }
});

// ── Monthly COGS breakdown ────────────────────────────────────────────────────
app.get('/api/pocm/monthly-expenses', async (req, res) => {
  const { fromDate, toDate, zohoProjectName } = req.query;
  if (!fromDate || !toDate) return res.status(400).json({ error: 'fromDate and toDate required' });
  if (!zohoProjectName) return res.status(400).json({ error: 'zohoProjectName is required — set the Zoho Project Name on the POCM project' });

  const cacheKey = `pocm-monthly-v10-${fromDate}-${zohoProjectName}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json(hit);

  const result = {
    hasMapping: !!zohoProjectName,
    byMonth:       {},
    details:       {}, // Purchase Bill line items (gross), per month
    creditDetails: {}, // Vendor Credit / Credit Note line items, per month — reduces cost
    totals:        { projectCost: 0, grossBillCost: 0, vendorCreditAmount: 0 },
    billCount:  0,
    lineCount:  0,
  };

  try {
    // Shared org-wide caches (bills, vendor credits, invoices), each fetched once per FY.
    // Invoices are fetched here too so that "Load Data" in Monthly Working warms the
    // invoice cache used by the Project-wise P&L report.
    const [allBills, allCredits] = await Promise.all([
      getPocmAllBills(fromDate),
      getPocmAllVendorCredits(fromDate),
      getPocmAllInvoices(fromDate),  // warm invoice cache as a side-effect
    ]);
    const COGS_KEYWORDS = ['cost of goods sold'];
    const grossByMonth  = {};
    const creditByMonth = {};

    for (const d of allBills) {
      const month = (d.date || '').substring(0, 7);
      if (!month || month < fromDate.substring(0, 7) || month > toDate.substring(0, 7)) continue;

      const billProject = d.bill_project || '';
      for (const li of d.line_items) {
        const acctName = (li.account_name || '').toLowerCase();
        if (!COGS_KEYWORDS.some(k => acctName.includes(k))) continue;

        const liProject = (li.project_name || '').trim();
        const effectiveProject = liProject || billProject;
        if (zohoProjectName && effectiveProject !== zohoProjectName.trim()) continue;

        const amount = parseFloat(li.item_total) || 0;
        grossByMonth[month] = (grossByMonth[month] || 0) + amount;
        result.totals.grossBillCost += amount;
        result.billCount++;
        result.lineCount++;

        if (!result.details[month]) result.details[month] = [];
        result.details[month].push({
          bill_number:  d.bill_number,
          vendor:       d.vendor,
          date:         d.date,
          description:  li.description || li.name || '',
          account:      li.account_name || '',
          project:      li.project_name || '',
          sub_category: li.cf_project_sub_category || '',
          quantity:     li.quantity || 0,
          rate:         li.rate || 0,
          amount,
        });
      }
    }

    // Vendor Credits / Credit Notes reduce the same project's cost, allocated
    // to the month of the CREDIT's own date (not retrospectively rewriting the
    // original bill's month) — matches the credit-note date shown in Zoho Books.
    for (const c of allCredits) {
      const month = (c.date || '').substring(0, 7);
      if (!month || month < fromDate.substring(0, 7) || month > toDate.substring(0, 7)) continue;

      const creditProject = c.credit_project || '';
      for (const li of c.line_items) {
        const acctName = (li.account_name || '').toLowerCase();
        if (!COGS_KEYWORDS.some(k => acctName.includes(k))) continue;

        const liProject = (li.project_name || '').trim();
        const effectiveProject = liProject || creditProject;
        if (zohoProjectName && effectiveProject !== zohoProjectName.trim()) continue;

        const amount = parseFloat(li.item_total) || 0;
        creditByMonth[month] = (creditByMonth[month] || 0) + amount;
        result.totals.vendorCreditAmount += amount;

        if (!result.creditDetails[month]) result.creditDetails[month] = [];
        result.creditDetails[month].push({
          credit_number: c.credit_number,
          vendor:        c.vendor,
          date:          c.date,
          applied_bills: c.applied_bills || '',
          description:   li.description || li.name || '',
          account:       li.account_name || '',
          project:       li.project_name || '',
          amount,
        });
      }
    }

    const allMonths = new Set([...Object.keys(grossByMonth), ...Object.keys(creditByMonth)]);
    for (const month of allMonths) {
      const gross  = grossByMonth[month]  || 0;
      const credit = creditByMonth[month] || 0;
      result.byMonth[month] = { projectCost: gross - credit, grossBillCost: gross, vendorCreditAmount: credit };
    }
    result.totals.projectCost = result.totals.grossBillCost - result.totals.vendorCreditAmount;

    for (const m of Object.keys(result.details)) {
      result.details[m].sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : b.amount - a.amount));
    }
    for (const m of Object.keys(result.creditDetails)) {
      result.creditDetails[m].sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : b.amount - a.amount));
    }

    console.log(`[POCM expenses] ${zohoProjectName}: gross ₹${Math.round(result.totals.grossBillCost).toLocaleString('en-IN')}, credits ₹${Math.round(result.totals.vendorCreditAmount).toLocaleString('en-IN')}, net ₹${Math.round(result.totals.projectCost).toLocaleString('en-IN')}`);
    cache.set(cacheKey, result, 86400);
    res.json(result);
  } catch (e) {
    console.error('[POCM monthly-expenses]', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// Actual revenue from Zoho Books invoices for a specific project
app.get('/api/pocm/monthly-revenue', async (req, res) => {
  const { fromDate, toDate, zohoProjectName, customerName } = req.query;
  if (!fromDate || !toDate || !zohoProjectName) return res.status(400).json({ error: 'fromDate, toDate, zohoProjectName required' });

  // customer name for fallback matching (normalised, lower-case)
  const custNorm = (customerName || '').toLowerCase().trim();
  const custKey  = custNorm.substring(0, 15).replace(/\s+/g, '_');
  const cacheKey = `pocm-revenue-v9-${fromDate}-${zohoProjectName}-${custKey}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json(hit);

  const result = {
    byMonth:       {},
    details:       {},
    totals:        { actualRevenue: 0 },
    invoiceCount:  0,
    lineCount:     0,
  };

  try {
    // Use shared invoices cache (fetches ALL org invoices once, all projects filter from memory)
    const allInvoices = await getPocmAllInvoices(fromDate);
    console.log(`[POCM revenue] allInvoices=${allInvoices.length} project=${zohoProjectName} custNorm="${custNorm}"`);

    for (const inv of allInvoices) {
      const month = (inv.date || '').substring(0, 7);
      if (!month || month < fromDate.substring(0, 7) || month > toDate.substring(0, 7)) continue;

      const invProject  = (inv.inv_project || '').trim();
      const invCustomer = (inv.customer   || '').toLowerCase().trim();

      // Determine if this invoice belongs to the project:
      // 1. If line_items have project_name → exact match on zohoProjectName
      // 2. If inv_project (header) is set → exact match on zohoProjectName
      // 3. Fallback: customer name contains the configured client name (case-insensitive partial match)
      let invoiceMatches = false;
      for (const li of inv.line_items) {
        const liProject = (li.project_name || '').trim();
        const effective  = liProject || invProject;
        if (effective && effective === zohoProjectName.trim()) { invoiceMatches = true; break; }
      }
      if (!invoiceMatches && custNorm && invCustomer && invCustomer.includes(custNorm.substring(0, Math.min(custNorm.length, 20)))) {
        invoiceMatches = true;
      }
      if (!invoiceMatches) continue;

      for (const li of inv.line_items) {
        const amount = parseFloat(li.item_total) || 0;
        if (amount === 0) continue;

        if (!result.byMonth[month]) result.byMonth[month] = { actualRevenue: 0 };
        result.byMonth[month].actualRevenue += amount;
        result.totals.actualRevenue += amount;
        result.invoiceCount++;
        result.lineCount++;

        if (!result.details[month]) result.details[month] = [];
        result.details[month].push({
          invoice_number: inv.invoice_number,
          customer:       inv.customer,
          date:           inv.date,
          description:    li.description || li.name || '',
          project:        li.project_name || invProject || '',
          quantity:       li.quantity || 0,
          rate:           li.rate || 0,
          amount,
        });
      }
    }

    for (const m of Object.keys(result.details)) {
      result.details[m].sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : b.amount - a.amount));
    }

    console.log(`[POCM revenue] ${zohoProjectName}: ${result.lineCount} invoice lines, ₹${Math.round(result.totals.actualRevenue).toLocaleString('en-IN')}`);
    cache.set(cacheKey, result, 86400);
    res.json(result);
  } catch (e) {
    console.error('[POCM monthly-revenue]', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// Company-wide overhead from NT org — salary (journals+expenses+bills) + travelling/marketing/other (bills+expenses).
// All amounts are company-wide totals; the client allocates each project's share via salaryRatio.
app.get('/api/pocm/monthly-overhead', async (req, res) => {
  const { fromDate, toDate } = req.query;
  if (!fromDate || !toDate) return res.status(400).json({ error: 'fromDate and toDate required' });

  const cacheKey = `pocm-overhead-v6-${fromDate}-${toDate}`;
  const hit = cache.get(cacheKey) || diskCacheLoad(cacheKey, 86400);
  if (hit) return res.json(hit);

  // Read mapping to get account IDs per category
  const mapping = await readPocmMapping();
  const salaryIds    = new Set((mapping.salaries   || []).map(String));
  const travelIds    = new Set((mapping.travelling || []).map(String));
  const marketIds    = new Set((mapping.marketing  || []).map(String));
  const otherIds     = new Set((mapping.other      || []).map(String));

  const CATS = ['salary', 'travelling', 'marketing', 'other'];
  const result = {
    byMonth: {},
    totals:  { salary: 0, travelling: 0, marketing: 0, other: 0 },
    details: {},
    sources: { journals: 0, bills: 0, expenses: 0 },
  };

  const addEntry = (cat, month, amount, detail) => {
    if (!cat || !month || amount <= 0) return;
    if (!result.byMonth[month]) result.byMonth[month] = { salary: 0, travelling: 0, marketing: 0, other: 0 };
    result.byMonth[month][cat] = (result.byMonth[month][cat] || 0) + amount;
    result.totals[cat] = (result.totals[cat] || 0) + amount;
    if (!result.details[month]) result.details[month] = [];
    result.details[month].push({ ...detail, _cat: cat });
  };

  const inWindow = (dateStr) => {
    const m = (dateStr || '').substring(0, 7);
    return m && m >= fromDate.substring(0, 7) && m <= toDate.substring(0, 7);
  };

  try {
    // ── 1. Bills + Expenses (from shared getPocmAllBills cache) ───────────────
    // getPocmAllBills now captures COGS + overhead items; here we use overhead only.
    try {
      const allBills = await getPocmAllBills(fromDate);
      let billSalary = 0, billTravel = 0, billMarket = 0, billOther = 0;
      for (const entry of allBills) {
        const cat = entry._category;
        if (!cat || cat === 'projectCost') continue; // skip COGS, skip untagged
        if (!inWindow(entry.date)) continue;

        const normalized = cat === 'salaries' ? 'salary' : cat; // 'salaries'→'salary'
        for (const li of (entry.line_items || [])) {
          const amount = parseFloat(li.item_total) || 0;
          if (amount <= 0) continue;
          result.sources.bills++;
          addEntry(normalized, entry.date.substring(0, 7), amount, {
            bill_number: entry.bill_number,
            vendor:      entry.vendor,
            date:        entry.date,
            account:     li.account_name || '',
            description: li.description || '',
            quantity:    li.quantity || 0,
            rate:        li.rate || 0,
            amount,
          });
          if (normalized === 'salary')     billSalary += amount;
          if (normalized === 'travelling') billTravel += amount;
          if (normalized === 'marketing')  billMarket += amount;
          if (normalized === 'other')      billOther  += amount;
        }
      }
      console.log(`[POCM overhead] from bills/expenses cache: salary=${Math.round(billSalary).toLocaleString('en-IN')} travel=${Math.round(billTravel).toLocaleString('en-IN')} mkt=${Math.round(billMarket).toLocaleString('en-IN')} other=${Math.round(billOther).toLocaleString('en-IN')}`);
    } catch (e) {
      console.warn('[POCM overhead] bills cache error:', e.message);
    }

    // ── 2. Journal Entries — classify EVERY journal's line items strictly by the
    // account mapping (pocm_mapping.json), same as bills. Previously this
    // pre-filtered journals by guessing from notes/reference text ("salary",
    // "payroll", ...) BEFORE checking the mapping — a journal whose notes
    // didn't happen to contain those words was skipped even if its line items
    // were correctly mapped to a salary account, which is why Salary silently
    // came back ₹0 for Jul/Aug/Sep. The mapping is the source of truth; there
    // is no need to guess from free-text notes when we already know the exact
    // account IDs. Only ~150 journals/FY, so fetching every detail is cheap.
    try {
      const allJournals = await zohoGetAll('/journals', 'journals',
        { organization_id: NT_ORG_ID, date_start: fromDate, date_end: toDate, sort_column: 'journal_date', sort_order: 'D' },
        { dateField: 'journal_date', dateFrom: fromDate, dateTo: toDate, maxPages: 10 });

      console.log(`[POCM overhead] ${allJournals.length} journals total → fetching all details (classified by mapping)`);

      for (let i = 0; i < allJournals.length; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 1200)); // same rate-limit budget as bill details
        const j = allJournals[i];
        try {
          const d = await zohoGet(`/journals/${j.journal_id}`, { organization_id: NT_ORG_ID });
          const jd = d.journal || {};
          const month = (jd.journal_date || j.journal_date || '').substring(0, 7);
          if (!inWindow(jd.journal_date || j.journal_date)) continue;
          const nameToCategory = await getPocmNameCategoryMap();
          for (const li of (jd.line_items || [])) {
            const liAccId   = String(li.account_id || '');
            const liAccName = (li.account_name || '').toLowerCase().trim();
            let cat = null;
            // Match by account_id (journals have it); fallback to account_name via COA map
            if (salaryIds.has(liAccId))    cat = 'salary';
            else if (travelIds.has(liAccId))  cat = 'travelling';
            else if (marketIds.has(liAccId))  cat = 'marketing';
            else if (otherIds.has(liAccId))   cat = 'other';
            else cat = nameToCategory[liAccName] === 'salaries' ? 'salary'
                     : nameToCategory[liAccName] || null;
            if (!cat) continue;
            const amount = parseFloat(li.debit_amount || li.debit || li.amount) || 0;
            if (amount <= 0) continue;
            result.sources.journals++;
            addEntry(cat, month, amount, {
              bill_number: jd.journal_number || j.entry_number || j.journal_id,
              vendor:      'Journal Entry',
              date:        jd.journal_date || j.journal_date,
              account:     li.account_name || '',
              description: li.description || jd.notes || j.notes || '',
              quantity:    0, rate: 0, amount,
            });
          }
        } catch (e) {
          if (e.message?.startsWith('ZOHO_DAILY_LIMIT')) throw e;
          console.warn(`[POCM overhead] journal detail ${j.journal_id} failed: ${e.message}`);
        }
      }
      console.log(`[POCM overhead] ${result.sources.journals} entries from journals`);
    } catch (e) {
      console.warn('[POCM overhead] journals fetch failed:', e.message);
    }

    // Sort details per month
    for (const m of Object.keys(result.details)) {
      result.details[m].sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : b.amount - a.amount));
    }

    const fmt = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
    console.log(`[POCM overhead] TOTALS → salary:${fmt(result.totals.salary)} travel:${fmt(result.totals.travelling)} mkt:${fmt(result.totals.marketing)} other:${fmt(result.totals.other)} | journals:${result.sources.journals} bills/exp:${result.sources.bills}`);
    cache.set(cacheKey, result, 86400);
    diskCacheSave(cacheKey, result);
    res.json(result);
  } catch (e) {
    console.error('[POCM monthly-overhead]', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── POCM Reports ─────────────────────────────────────────────────────────────

// Purchase Orders (draft / approved-issued)
// draft group:    pending_approval, approval_overdue, draft
// approved group: open, approved, issued, received, to_be_received, to_be_billed
app.get('/api/pocm/reports/purchase-orders', async (req, res) => {
  const { status, fromDate, toDate } = req.query;
  const cacheKey = `pocm-rpt-po2-${status || 'all'}-${fromDate}-${toDate}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json(hit);
  try {
    const allPos = await zohoGetAll('/purchaseorders', 'purchaseorders',
      { organization_id: NT_ORG_ID },
      { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 20 });
    const DRAFT_STATUSES    = new Set(['draft','pending_approval','approval_overdue','rejected']);
    const APPROVED_STATUSES = new Set(['open','approved','issued','received','to_be_received','to_be_billed','partially_billed','billed','billed_not_received']);
    const today = new Date();
    const result = allPos
      .filter(po => {
        if (!status) return true;
        if (status === 'draft')    return DRAFT_STATUSES.has(po.status);
        if (status === 'open')     return APPROVED_STATUSES.has(po.status);
        return po.status === status;
      })
      .map(po => ({
        ...po,
        project_name: po.cf_project_name_1 || '',
        daysInStatus: po.date ? Math.floor((today - new Date(po.date)) / 86400000) : 0,
      }));
    console.log(`[POCM reports] purchase-orders status=${status} ${fromDate}→${toDate}: total=${allPos.length} filtered=${result.length}`);
    cache.set(cacheKey, { purchaseOrders: result }, 1800);
    res.json({ purchaseOrders: result });
  } catch (e) {
    console.error('[POCM reports] purchase-orders error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Vendor Payments / Bill Payment Tracker
// - payments: direct vendor payment records (for Advance Payment Report)
// - bills: ALL bills (any status) with total/paid/balance (for Payment Report)
app.get('/api/pocm/reports/vendor-payments', async (req, res) => {
  const { fromDate, toDate } = req.query;
  const cacheKey = `pocm-rpt-vpay5-${fromDate}-${toDate}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json(hit);
  try {
    // 1. Direct vendor payments from NT org only (60007894213)
    const vpNT = await zohoGetAll('/vendorpayments', 'vendorpayments',
      { organization_id: NT_ORG_ID, date_start: fromDate, date_end: toDate },
      { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 20 }).catch(() => []);
    const mapVP = (p) => {
      const cfProject = p.cf_project_name_1
        || (p.custom_fields || []).find(cf => /project_name/i.test(cf.api_name || ''))?.value
        || '';
      return { ...p, project_name: p.project_name || cfProject };
    };
    const directPayments = vpNT.map(mapVP);

    // 2. ALL bills from NT org (fallback when no vendor payment records exist)
    const rawBills = await zohoGetAll('/bills', 'bills',
      { organization_id: NT_ORG_ID },
      { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 15 }).catch(() => []);
    const bills = rawBills
      .filter(b => (b.status || '').toLowerCase() !== 'void')
      .sort((a, b) => (a.date > b.date ? -1 : 1))
      .map(b => ({
        bill_id:      b.bill_id,
        bill_number:  b.bill_number,
        date:         b.date,
        due_date:     b.due_date,
        vendor_name:  b.vendor_name,
        project_name: b.project_name || b.cf_project_name_1 || '',
        total:        parseFloat(b.total) || 0,
        payment_made: parseFloat(b.payment_made) || 0,
        balance:      parseFloat(b.balance) || 0,
        status:       b.status,
      }));

    console.log(`[POCM reports] vendor-payments ${fromDate}→${toDate}: directPayments=${directPayments.length} allBills=${bills.length}`);
    cache.set(cacheKey, { payments: directPayments, bills, _directCount: directPayments.length, _billCount: bills.length }, 1800);
    res.json({ payments: directPayments, bills, _directCount: directPayments.length, _billCount: bills.length });
  } catch (e) {
    console.error('[POCM reports] vendor-payments error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Outstanding Bills (open + partial)
app.get('/api/pocm/reports/outstanding-bills', async (req, res) => {
  const { fromDate, toDate } = req.query;
  const cacheKey = `pocm-rpt-outbills-${fromDate}-${toDate}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json(hit);
  try {
    const today = new Date();
    // Try shared bills disk cache first (avoids duplicate Zoho calls)
    const sharedBills = cache.get(`pocm-bills-v8-${fromDate}`) || diskCacheLoad(`pocm-bills-v8-${fromDate}`, 86400);
    if (sharedBills) {
      const OPEN_STATUSES = new Set(['open', 'partiallypaid', 'partially_paid', 'overdue', 'partially paid']);
      const bills = sharedBills
        .filter(b => b._category === 'projectCost' || b._category === 'salaries' || b._category === 'travelling' || b._category === 'marketing' || b._category === 'other' || !b._category)
        .filter(b => { const s = (b.bill_status || b.status || '').toLowerCase().replace(/[_\s]/g, ''); return OPEN_STATUSES.has(s); })
        .filter(b => { const d = b.date || ''; return (!fromDate || d >= fromDate) && (!toDate || d <= toDate); })
        .sort((a, b) => (a.date < b.date ? 1 : -1))
        .map(b => ({ ...b, daysOutstanding: b.due_date ? Math.max(0, Math.floor((today - new Date(b.due_date)) / 86400000)) : 0 }));
      console.log(`[POCM reports] outstanding-bills (from shared cache): ${bills.length}`);
      cache.set(cacheKey, { bills }, 86400);
      return res.json({ bills });
    }
    // Fallback: fetch from Zoho (cache was cold — first time for this FY)
    const [openBills, partialBills] = await Promise.all([
      zohoGetAll('/bills', 'bills', { organization_id: NT_ORG_ID, filter_by: 'Status.Open' },
        { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 10 }),
      zohoGetAll('/bills', 'bills', { organization_id: NT_ORG_ID, filter_by: 'Status.PartiallyPaid' },
        { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 10 }),
    ]);
    const bills = [...openBills, ...partialBills]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map(b => ({ ...b, daysOutstanding: b.due_date ? Math.max(0, Math.floor((today - new Date(b.due_date)) / 86400000)) : 0 }));
    console.log(`[POCM reports] outstanding-bills (Zoho fallback) ${fromDate}→${toDate}: open=${openBills.length} partial=${partialBills.length}`);
    cache.set(cacheKey, { bills }, 3600);
    res.json({ bills });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Client Invoices + Customer Payments — invoices from shared disk cache, payments from Zoho
app.get('/api/pocm/reports/client-invoices', async (req, res) => {
  const { fromDate, toDate } = req.query;
  const cacheKey = `pocm-rpt-clinv-${fromDate}-${toDate}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json(hit);
  try {
    // Use shared invoices disk cache (keyed by FY start) — avoids duplicate Zoho invoice calls
    const sharedInvoices = cache.get(`pocm-invoices-v5-${fromDate}`) || diskCacheLoad(`pocm-invoices-v5-${fromDate}`, 86400);
    let allInvoices;
    if (sharedInvoices) {
      // Filter to date range
      allInvoices = sharedInvoices.filter(inv => {
        if (!inv.date) return false;
        return inv.date >= fromDate && inv.date <= toDate;
      });
      console.log(`[POCM reports] client-invoices (shared cache): ${allInvoices.length} for ${fromDate}→${toDate}`);
    } else {
      allInvoices = await zohoGetAll('/invoices', 'invoices',
        { organization_id: NT_ORG_ID, date_start: fromDate, date_end: toDate },
        { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 10 });
      console.log(`[POCM reports] client-invoices (Zoho fallback): ${allInvoices.length}`);
    }
    // Payments are not in shared cache — fetch from Zoho
    const payments = await zohoGetAll('/customerpayments', 'customerpayments',
      { organization_id: NT_ORG_ID, date_start: fromDate, date_end: toDate },
      { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 10 });
    const invoices = allInvoices.filter(i => i.status !== 'draft');
    console.log(`[POCM reports] client-invoices: invoices=${invoices.length} payments=${payments.length}`);
    cache.set(cacheKey, { invoices, payments }, 86400);
    res.json({ invoices, payments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Draft Invoices — scan all cached FYs first, fall back to live Zoho if no cache
app.get('/api/pocm/reports/draft-invoices', async (req, res) => {
  const cacheKey = 'pocm-rpt-draftinv';
  const hit = cache.get(cacheKey);
  if (hit) return res.json(hit);
  try {
    const today = new Date();
    // Collect draft invoices from all cached FY invoice files
    const currentFY = today.getMonth() + 1 >= 4 ? today.getFullYear() : today.getFullYear() - 1;
    const fysToCheck = [currentFY, currentFY - 1, currentFY + 1]; // check current ± 1 FY
    const DRAFT_STATUSES = new Set(['draft']);
    let fromCache = [];
    for (const fy of fysToCheck) {
      const fyFrom = `${fy}-04-01`;
      const cached = cache.get(`pocm-invoices-v5-${fyFrom}`) || diskCacheLoad(`pocm-invoices-v5-${fyFrom}`, 86400);
      if (cached) {
        const drafts = cached.filter(inv => DRAFT_STATUSES.has((inv.status || '').toLowerCase()));
        fromCache.push(...drafts);
      }
    }
    if (fromCache.length > 0 || fysToCheck.every(fy => cache.get(`pocm-invoices-v5-${fy}-04-01`) || diskCacheLoad(`pocm-invoices-v5-${fy}-04-01`, 86400))) {
      const result = fromCache.map(inv => ({
        ...inv,
        daysInDraft: inv.date ? Math.floor((today - new Date(inv.date)) / 86400000) : 0,
      }));
      console.log(`[POCM reports] draft-invoices (from shared cache): ${result.length}`);
      cache.set(cacheKey, { invoices: result }, 86400);
      return res.json({ invoices: result });
    }
    // Fallback: fetch from Zoho
    const invoices = await zohoGetAll('/invoices', 'invoices',
      { organization_id: NT_ORG_ID, filter_by: 'Status.Draft' }, { maxPages: 5 });
    const result = invoices.map(inv => ({
      ...inv,
      daysInDraft: inv.date ? Math.floor((today - new Date(inv.date)) / 86400000) : 0,
    }));
    console.log(`[POCM reports] draft-invoices (Zoho fallback): ${result.length}`);
    cache.set(cacheKey, { invoices: result }, 3600);
    res.json({ invoices: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resolve QE snapshot in effect for (fy, quarter) — picks latest snapshot with key ≤ target
function pocmResolveEst(qe, projectId, fy, quarter, project) {
  const targetKey = pocmQESortKey(fy, quarter);
  let best = null, bestKey = -1;
  for (const snap of Object.values(qe.snapshots || {})) {
    if (snap.projectId !== projectId) continue;
    const k = pocmQESortKey(snap.fy, snap.quarter);
    if (k <= targetKey && k > bestKey) { best = snap; bestKey = k; }
  }
  if (best) return { value: parseFloat(best.projectValue) || 0, estCost: parseFloat(best.projectCost) || 0 };
  return { value: parseFloat(project.value) || 0, estCost: parseFloat(project.estimatedCost) || 0 };
}

// "Utilised by Project" — cash paid to vendors against each Zoho project up to the as-on date.
//  A. Vendor-payment amounts applied to bills, counted from the apply date (payment date
//     when Zoho has none) and split over the bill's line projects — bills cache first,
//     else the bill detail kept in the vendor-payment store.
//  B. The part of each payment still unapplied at the as-on date (advance), less refunds
//     made by then, mapped to the project of its PO Number, else its "Project Name-".
// A payment's amount lands in A or B exactly once (B = amount − applied − refunded), and
// each bill allocation is keyed by payment + bill payment id so it can't be added twice.
// Pass `detailFor` (Zoho project name) to also get that project's transaction rows.
function pocmUtilisation(targetDate, detailFor = null) {
  const store = pocmSync.getVendorPayments();
  if (!store) return null;
  const projById = {};
  for (const z of store.projects || []) projById[z.project_id] = z.project_name;

  // Bill → { project name: line amount } from every cached bills FY (read without warming node-cache)
  const cachedShares = {};
  const curFY = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  for (let y = parseInt((store.window_from || '2022-04-01').slice(0, 4)); y <= curFY; y++) {
    const key = `pocm-bills-v8-${y}-04-01`;
    let entries = cache.get(key);
    if (!entries) {
      try { entries = db.USE_DB ? (pocmSync.readDiskCache(key) || []) : JSON.parse(fs.readFileSync(path.join(POCM_DISK_CACHE_DIR, `${key}.json`), 'utf8')); }
      catch (_) { entries = []; }
    }
    for (const e of entries) {
      const m = cachedShares[e.bill_id] = cachedShares[e.bill_id] || {};
      for (const li of (e.line_items || [])) {
        const name = (li.project_name || e.bill_project || '').trim();
        m[name] = (m[name] || 0) + (parseFloat(li.item_total) || 0);
      }
    }
  }
  const billShares = (billId) => {
    if (cachedShares[billId]) return cachedShares[billId];
    const d = store.bill_details?.[billId];
    if (!d?.lines) return null;
    const m = {};
    for (const l of d.lines) m[l.project_name] = (m[l.project_name] || 0) + l.amount;
    return m;
  };

  const byName = {};
  const add = (name, field, amt) => { const r = byName[name] = byName[name] || { bills: 0, advances: 0 }; r[field] += amt; };
  const sectionA = [], sectionB = [], mismatches = [], unmapped = [], pending = [];
  const stats = {
    billAllocations: 0, advancePayments: 0, viaPO: 0, viaProjectName: 0, mismatches: 0, unmapped: 0,
    duplicateAllocationsPrevented: 0, duplicatePaymentsDropped: store.stats?.duplicates_dropped || 0,
    advancesLaterAdjusted: 0, pendingAmount: 0, pendingCount: 0,
  };
  const seen = new Set();

  for (const p of store.payments || []) {
    if (!p.date || p.date > targetDate) continue;
    if (!p.allocations) {
      stats.pendingAmount += p.amount; stats.pendingCount++;
      pending.push({ payment_date: p.date, vendor: p.vendor_name, payment_number: p.payment_number, amount: p.amount, reason: 'Payment detail not synced yet' });
      continue;
    }

    // A — applied to bills by the as-on date
    let applied = 0;
    for (const a of p.allocations) {
      const when = a.apply_date || p.date;
      if (when > targetDate) continue;   // still an advance at the as-on date
      const key = `${p.payment_id}|${a.bill_payment_id || a.bill_id}`;
      if (seen.has(key)) { stats.duplicateAllocationsPrevented++; continue; }
      seen.add(key);
      applied += a.applied;
      stats.billAllocations++;
      if (a.apply_date && a.apply_date > p.date) stats.advancesLaterAdjusted++;
      const sh  = billShares(a.bill_id);
      const tot = sh ? Object.values(sh).reduce((s, v) => s + v, 0) : 0;
      if (!sh || tot <= 0) {
        stats.pendingAmount += a.applied; stats.pendingCount++;
        pending.push({ payment_date: p.date, vendor: p.vendor_name, payment_number: p.payment_number, bill_number: a.bill_number, amount: a.applied,
          reason: store.bill_details?.[a.bill_id]?.error ? 'Bill not found in Zoho' : 'Bill project not synced yet' });
        continue;
      }
      for (const [name, v] of Object.entries(sh)) {
        const amt = a.applied * v / tot;
        if (name) add(name, 'bills', amt);
        if (detailFor && name === detailFor) {
          sectionA.push({ payment_date: p.date, apply_date: a.apply_date || '', vendor: p.vendor_name, payment_number: p.payment_number,
            bill_number: a.bill_number, bill_date: a.bill_date || store.bills?.[a.bill_id]?.date || '', amount: amt,
            bill_share: Object.keys(sh).length > 1 ? v / tot : 1, project: name });
        }
      }
    }

    // B — still unapplied at the as-on date
    let refunded = 0;
    for (const r of (p.refunds || [])) if (r.date && r.date <= targetDate) refunded += r.amount;
    const advance = p.amount - applied - refunded;
    if (advance < 0.01) continue;
    stats.advancePayments++;

    const po        = p.po_id ? store.pos?.[p.po_id] : null;
    const poProjId  = po?.project_id || '';
    const poProject = po ? (projById[po.project_id] || po.project_name || '') : '';
    const cfProject = projById[p.project_id] || p.project_name || '';
    let project = '', source = '', note = '';
    if (p.po_id && poProjId) { project = poProject; source = 'PO'; }
    else if (cfProject) { project = cfProject; source = 'Project Name-'; if (p.po_id) note = po ? 'PO has no project' : 'PO not found in Zoho'; }
    const row = {
      payment_date: p.date, vendor: p.vendor_name, payment_number: p.payment_number, reference_number: p.reference_number || '',
      amount: advance, po_number: p.po_number || po?.po_number || '', po_project: poProject, cf_project: cfProject,
      source, project, note,
    };
    if (!project) {
      stats.unmapped++;
      unmapped.push({ ...row, reason: p.po_id ? (po ? 'PO has no project, and no Project Name-' : 'PO not found in Zoho, and no Project Name-') : 'No PO Number and no Project Name-' });
      continue;
    }
    const differs = p.project_id && poProjId ? p.project_id !== poProjId : poProject !== cfProject;
    if (p.po_id && poProjId && cfProject && differs) {
      stats.mismatches++;
      mismatches.push({ ...row, status: 'PO Project ≠ Selected Project' });
    }
    if (source === 'PO') stats.viaPO++; else stats.viaProjectName++;
    add(project, 'advances', advance);
    if (detailFor && project === detailFor) sectionB.push(row);
  }

  return {
    byName, sectionA, sectionB, mismatches, unmapped, pending, stats,
    syncedAt: store.synced_at || null,
    pendingBillDetails: store.stats?.pending_bill_details || 0,
  };
}

// Sales Team / Purchase Team columns of the Project-wise P&L, keyed by POCM project id.
// Reads only already-synced data; the P&L totals are computed separately and not touched.
//  • Project Value / Est. Project Cost: the estimate in effect at the as-on date
//    (pocmResolveEst, the same one the POCM % uses)
//  • Utilised by Project: vendor payments applied to the project's bills + its unapplied
//    advances, up to the as-on date (pocmUtilisation)
//  • Amount Recd. Till Date: customer receipts dated ≤ as-on date, cash + client TDS.
//    Applied amounts follow the invoice's Zoho project; unapplied advances, refunds and
//    untagged invoices go to the client's project only when the client has exactly one
//    Zoho project, otherwise they stay unallocated for that client.
function pocmTeamColumns({ projectList, qe, targetDate }) {
  const m  = parseInt(targetDate.slice(5, 7));
  const fy = m >= 4 ? parseInt(targetDate.slice(0, 4)) : parseInt(targetDate.slice(0, 4)) - 1;
  const q  = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 ? 3 : 4;

  const util = pocmUtilisation(targetDate);

  // Amount received — from the synced customer-payment store
  const store = pocmSync.getCustomerPayments();
  const recd = {};      // Zoho project name → { cash, tds }
  const unalloc = {};   // customer_id → { customer, cash, tds }
  const zohoByName = {};
  if (store) {
    const custProjects = {};
    for (const z of store.projects || []) {
      zohoByName[z.project_name] = z;
      (custProjects[z.customer_id] = custProjects[z.customer_id] || []).push(z.project_name);
    }
    const soleProject = (cid) => (custProjects[cid] || []).length === 1 ? custProjects[cid][0] : null;

    // Invoice → Zoho project from every cached invoice FY ('' = untagged). Disk fallback
    // is read directly so node-cache (which the P&L totals read) is left as it was.
    const invByNum = {}, invById = {};
    const firstPay = (store.payments || []).reduce((mn, p) => (p.date && (!mn || p.date < mn) ? p.date : mn), null);
    const firstFY  = firstPay ? (parseInt(firstPay.slice(5, 7)) >= 4 ? parseInt(firstPay.slice(0, 4)) : parseInt(firstPay.slice(0, 4)) - 1) : fy;
    for (let y = firstFY; y <= fy; y++) {
      const key = `pocm-invoices-v5-${y}-04-01`;
      let invoices = cache.get(key);
      if (!invoices) {
        try { invoices = db.USE_DB ? (pocmSync.readDiskCache(key) || []) : JSON.parse(fs.readFileSync(path.join(POCM_DISK_CACHE_DIR, `${key}.json`), 'utf8')); }
        catch (_) { invoices = []; }
      }
      for (const inv of invoices) {
        invByNum[inv.invoice_number] = inv.inv_project || '';
        invById[inv.invoice_id]      = inv.inv_project || '';
      }
    }
    const invProject = (p, invId, invNum) => {
      const tag = (invId && invById[invId] !== undefined) ? invById[invId] : invByNum[invNum];
      return tag || soleProject(p.customer_id);
    };
    const credit = (proj, p, cash, tds) => {
      if (proj) {
        const r = recd[proj] = recd[proj] || { cash: 0, tds: 0 };
        r.cash += cash; r.tds += tds;
      } else {
        const u = unalloc[p.customer_id] = unalloc[p.customer_id] || { customer: p.customer_name, cash: 0, tds: 0 };
        u.cash += cash; u.tds += tds;
      }
    };

    for (const p of store.payments || []) {
      if (!p.date || p.date > targetDate) continue;
      const appliedTotal = p.amount - p.unused - p.refunded;
      let allocs;
      if (p.allocations) {
        allocs = p.allocations.map(a => ({ project: invProject(p, a.invoice_id, a.invoice_number), applied: a.applied, tds: a.tds }));
      } else if (p.invoice_numbers.length === 1) {
        allocs = [{ project: invProject(p, null, p.invoice_numbers[0]), applied: appliedTotal, tds: p.tds }];
      } else if (p.invoice_numbers.length > 1) {
        // Split unknown (detail not synced) — attribute only if every invoice is the same project
        const projs = new Set(p.invoice_numbers.map(n => invProject(p, null, n)));
        const only  = projs.size === 1 ? [...projs][0] : null;
        allocs = [{ project: only, applied: appliedTotal, tds: p.tds }];
      } else {
        allocs = [];
      }
      let appliedCash = 0, appliedTds = 0;
      for (const a of allocs) {
        credit(a.project, p, a.applied, a.tds);
        appliedCash += a.applied; appliedTds += a.tds;
      }
      // Unapplied remainder (advance / later-refunded), less refunds made by the as-on date
      let poolCash = p.amount - appliedCash;
      if (p.refunds) { for (const r of p.refunds) if (r.date && r.date <= targetDate) poolCash -= r.amount; }
      else poolCash -= p.refunded;   // refund date unknown — treat as already refunded
      const poolTds = p.tds - appliedTds;
      if (Math.abs(poolCash) >= 0.01 || Math.abs(poolTds) >= 0.01) credit(soleProject(p.customer_id), p, poolCash, poolTds);
    }
  }

  const byProject = {};
  for (const project of projectList) {
    const zohoName = (project.zohoProjectName || project.name || '').trim();
    const est      = pocmResolveEst(qe, project.id, fy, q, project);
    const paid     = util ? (util.byName[zohoName] || { bills: 0, advances: 0 }) : null;
    const utilised = paid ? paid.bills + paid.advances : null;
    const r        = recd[zohoName] || { cash: 0, tds: 0 };
    const u        = store && zohoByName[zohoName] ? unalloc[zohoByName[zohoName].customer_id] : null;
    const amountRecd = store ? r.cash + r.tds : null;
    byProject[project.id] = {
      projectValue:      est.value,
      amountRecd,
      amountRecdCash:    store ? r.cash : null,
      amountRecdTds:     store ? r.tds  : null,
      balanceReceivable: store ? est.value - amountRecd : null,
      estProjectCost:    est.estCost,
      utilised,
      utilisedBills:     paid ? paid.bills : null,
      utilisedAdvances:  paid ? paid.advances : null,
      balanceToPay:      utilised != null ? est.estCost - utilised : null,
      // Client receipts that could not be tied to one project (client has several Zoho projects)
      clientUnallocated: u ? u.cash + u.tds : 0,
    };
  }
  return {
    byProject,
    collectionsSyncedAt: store ? store.synced_at : null,
    utilisation: util ? {
      syncedAt: util.syncedAt, stats: util.stats, pendingBillDetails: util.pendingBillDetails,
      mismatchCount: util.mismatches.length, unmappedCount: util.unmapped.length,
    } : null,
  };
}

// Project-wise P&L — cross-FY cumulative POCM (does NOT reset balances at April 1)
app.get('/api/pocm/reports/project-pl', async (req, res) => {
  const { asOnDate, projectIds: rawIds } = req.query;
  const targetDate = (asOnDate && /^\d{4}-\d{2}-\d{2}$/.test(asOnDate)) ? asOnDate : new Date().toISOString().slice(0, 10);
  const targetYM   = targetDate.slice(0, 7);

  try {
    const allProjects = await readPocmProjects();
    const qe          = await readPocmQE();

    const idSet = rawIds ? new Set(rawIds.split(',').map(s => s.trim()).filter(Boolean)) : null;
    const projectList = allProjects.filter(p => p.startDate && (!idSet || idSet.has(String(p.id))));
    if (!projectList.length) return res.json({ rows: [], asOnDate: targetDate, warnings: [], fyCoverage: '' });

    const dateToFY = (d) => { const m = parseInt(d.slice(5, 7)); const y = parseInt(d.slice(0, 4)); return m >= 4 ? y : y - 1; };
    const fyQ     = (ym) => { const m = parseInt(ym.slice(5, 7)); if (m >= 4 && m <= 6) return 1; if (m >= 7 && m <= 9) return 2; if (m >= 10 && m <= 12) return 3; return 4; };

    const startFY = projectList.reduce((mn, p) => { const fy = dateToFY(p.startDate); return mn === null || fy < mn ? fy : mn; }, null);
    const endFY   = dateToFY(targetDate);
    const totalPortfolioValue = allProjects.reduce((s, p) => s + (parseFloat(p.value) || 0), 0);

    const warnings        = [];
    const overheadByMonth = {};
    const billsByFY       = {};
    const creditsByFY     = {};
    const invoicesByFY    = {};

    // Cache-key helpers (must match the keys used by getPocmAllBills / Credits / Invoices)
    const billsCacheKey   = (fyFrom) => `pocm-bills-v8-${fyFrom}`;
    const creditsCacheKey = (fyFrom) => `pocm-vendorcredits-v1-${fyFrom}`;
    const invoicesCacheKey= (fyFrom) => `pocm-invoices-v5-${fyFrom}`;

    for (let fy = startFY; fy <= endFY; fy++) {
      const fyFrom = `${fy}-04-01`;
      const fyTo   = `${fy + 1}-03-31`;
      const fyLabel = `FY ${fy}-${String(fy + 1).slice(2)}`;

      // Read from cache only — no live Zoho calls (avoids 5-min timeout).
      // Bills and invoices are checked independently: a cold invoice cache
      // should not suppress cost data from a warm bills cache.
      const cachedBills   = cache.get(billsCacheKey(fyFrom));
      const cachedCredits = cache.get(creditsCacheKey(fyFrom));
      const cachedInvoices= cache.get(invoicesCacheKey(fyFrom));

      if (!cachedBills && !cachedInvoices) {
        warnings.push(`${fyLabel}: Data not cached — open Monthly Working tab, select any project for this FY and click "Load Data" to pre-warm the cache, then re-run this report.`);
        billsByFY[fy] = []; creditsByFY[fy] = []; invoicesByFY[fy] = [];
      } else {
        if (!cachedBills) {
          warnings.push(`${fyLabel}: Cost data not cached — click "Load Data" in Monthly Working for this FY to include project costs.`);
          billsByFY[fy] = []; creditsByFY[fy] = [];
        } else {
          billsByFY[fy]   = cachedBills;
          creditsByFY[fy] = cachedCredits || [];
        }
        if (!cachedInvoices) {
          warnings.push(`${fyLabel}: Revenue data not cached — click "Load Data" in Monthly Working for this FY to include actual revenue.`);
          invoicesByFY[fy] = [];
        } else {
          invoicesByFY[fy] = cachedInvoices;
        }
      }

      // Overhead — try warm cache populated by monthly-overhead endpoint
      const ohKey    = `pocm-overhead-v6-${fyFrom}-${fyTo}`;
      const cachedOh = cache.get(ohKey);
      if (cachedOh && cachedOh.byMonth) {
        for (const [mo, oh] of Object.entries(cachedOh.byMonth)) {
          if (mo > targetYM) continue;
          if (!overheadByMonth[mo]) overheadByMonth[mo] = { salary: 0, travelling: 0, marketing: 0, other: 0 };
          overheadByMonth[mo].salary     += oh.salary     || 0;
          overheadByMonth[mo].travelling += oh.travelling || 0;
          overheadByMonth[mo].marketing  += oh.marketing  || 0;
          overheadByMonth[mo].other      += oh.other      || 0;
        }
      } else if (cachedBills) {
        // Overhead cache cold but bills warm — extract what we can from bills (no salary journals)
        warnings.push(`${fyLabel}: Salary data not cached — open Monthly Working for this FY to include salaries in overhead.`);
        for (const entry of cachedBills) {
          const cat = entry._category;
          if (!cat || cat === 'projectCost') continue;
          const mo = (entry.date || '').slice(0, 7);
          if (!mo || mo > targetYM) continue;
          const mapped = (cat === 'salaries' || cat === 'salary') ? 'salary' : (['travelling', 'marketing', 'other'].includes(cat) ? cat : null);
          if (!mapped) continue;
          if (!overheadByMonth[mo]) overheadByMonth[mo] = { salary: 0, travelling: 0, marketing: 0, other: 0 };
          for (const li of (entry.line_items || [])) {
            overheadByMonth[mo][mapped] = (overheadByMonth[mo][mapped] || 0) + (parseFloat(li.item_total) || 0);
          }
        }
      }
    }

    const rows = [];
    for (const project of projectList) {
      const zohoName    = (project.zohoProjectName || project.name || '').trim();
      const startYM     = project.startDate.slice(0, 7);
      const custNorm    = (project.client || '').toLowerCase().slice(0, 20);
      const salaryRatio = totalPortfolioValue > 0 ? (parseFloat(project.value) || 0) / totalPortfolioValue : 0;

      const byMonth = {};
      const ensure  = (mo) => { if (!byMonth[mo]) byMonth[mo] = { projectCost: 0, actualRevenue: 0 }; };

      // COGS from bills (net of vendor credits)
      // No startYM lower bound — pre-mobilisation costs incurred before the formal
      // project start date are still legitimate COGS and must be included.
      for (const bills of Object.values(billsByFY)) {
        for (const entry of bills) {
          if (entry._category !== 'projectCost') continue;
          const mo = (entry.date || '').slice(0, 7);
          if (!mo || mo > targetYM) continue;
          for (const li of (entry.line_items || [])) {
            const liProject = (li.project_name || entry.bill_project || '').trim();
            if (zohoName && liProject !== zohoName) continue;
            ensure(mo);
            byMonth[mo].projectCost += parseFloat(li.item_total) || 0;
          }
        }
      }
      for (const credits of Object.values(creditsByFY)) {
        for (const entry of credits) {
          if (entry._category !== 'projectCost') continue;
          const mo = (entry.date || '').slice(0, 7);
          if (!mo || mo > targetYM) continue;
          for (const li of (entry.line_items || [])) {
            const liProject = (li.project_name || entry.credit_project || '').trim();
            if (zohoName && liProject !== zohoName) continue;
            ensure(mo);
            byMonth[mo].projectCost -= parseFloat(li.item_total) || 0;
          }
        }
      }

      // Actual revenue from invoices
      for (const invoices of Object.values(invoicesByFY)) {
        for (const inv of invoices) {
          const mo = (inv.date || '').slice(0, 7);
          if (!mo || mo < startYM || mo > targetYM) continue;
          const invProject  = (inv.inv_project  || '').trim();
          const invCustomer = (inv.customer      || '').toLowerCase();
          if (zohoName && invProject !== zohoName && !(custNorm && invCustomer.includes(custNorm))) continue;
          for (const li of (inv.line_items || [])) {
            ensure(mo);
            byMonth[mo].actualRevenue += parseFloat(li.item_total) || 0;
          }
        }
      }

      // Overhead allocation per month
      for (const [mo, oh] of Object.entries(overheadByMonth)) {
        if (mo < startYM || mo > targetYM) continue;
        ensure(mo);
        byMonth[mo].salaries   = Math.round((oh.salary     || 0) * salaryRatio);
        byMonth[mo].travelling = Math.round((oh.travelling || 0) * salaryRatio);
        byMonth[mo].marketing  = Math.round((oh.marketing  || 0) * salaryRatio);
        byMonth[mo].other      = Math.round((oh.other      || 0) * salaryRatio);
      }

      // Cumulative POCM — no FY boundary reset (cross-FY accumulation)
      const months = Object.keys(byMonth).sort();
      let cumCost = 0, cumRevenue = 0, cumActualRevenue = 0, cumGross = 0, cumNet = 0;
      const monthRows = [];

      for (const mo of months) {
        const md  = byMonth[mo];
        const mFY = dateToFY(mo + '-01');
        const q   = fyQ(mo);
        const est = pocmResolveEst(qe, project.id, mFY, q, project);

        const projectCost   = md.projectCost   || 0;
        const salaries      = md.salaries      || 0;
        const marketing     = md.marketing     || 0;
        const travelling    = md.travelling    || 0;
        const other         = md.other         || 0;
        const actualRevenue = md.actualRevenue || 0;

        cumCost += projectCost;
        const pct          = est.estCost > 0 ? Math.min(cumCost / est.estCost, 1.0) * 100 : 0;
        const revToDate    = est.value * (pct / 100);
        const revThisMonth = revToDate - cumRevenue;
        cumRevenue         = revToDate;

        const grossProfit  = revThisMonth - projectCost;
        const overhead     = salaries + marketing + travelling + other;
        const netProfit    = grossProfit - overhead;
        cumGross          += grossProfit;
        cumNet            += netProfit;
        cumActualRevenue  += actualRevenue;

        monthRows.push({
          month: mo, projectCost, salaries, marketing, travelling, other,
          cumCost, pct, revThisMonth, cumRevenue, grossProfit, netProfit,
          overhead, cumGross, cumNet, actualRevenue, cumActualRevenue,
          revenueProvision: revThisMonth - actualRevenue,
        });
      }

      const sumOf = (f) => monthRows.reduce((s, r) => s + (r[f] || 0), 0);
      const last  = monthRows.length ? monthRows[monthRows.length - 1] : null;

      rows.push({
        project: { id: project.id, name: project.name, client: project.client || '', status: project.status || '', value: project.value || 0, startDate: project.startDate },
        salaryRatio,
        totals: last ? {
          cumCost:              last.cumCost,
          pct:                  last.pct,
          cumRecognisedRevenue: last.cumRevenue,
          cumActualRevenue:     last.cumActualRevenue,
          revenueProvision:     last.cumRevenue - last.cumActualRevenue,
          grossProfit:          last.cumGross,
          salaries:             sumOf('salaries'),
          travelling:           sumOf('travelling'),
          marketing:            sumOf('marketing'),
          other:                sumOf('other'),
          totalOverhead:        sumOf('salaries') + sumOf('travelling') + sumOf('marketing') + sumOf('other'),
          netProfit:            last.cumNet,
          gpm:                  last.cumRevenue > 0 ? (last.cumGross / last.cumRevenue) * 100 : null,
          npm:                  last.cumRevenue > 0 ? (last.cumNet   / last.cumRevenue) * 100 : null,
        } : null,
        monthRows,
      });
    }

    // Debug log for each project — helps diagnose zero-data issues
    for (const r of rows) {
      const t = r.totals;
      console.log(`[POCM project-pl] ${r.project.name} | zohoName="${(r.project.name||'')}" | monthRows=${r.monthRows.length} | cost=${t?Math.round(t.cumCost):0} | revenue=${t?Math.round(t.cumRecognisedRevenue):0} | actual=${t?Math.round(t.cumActualRevenue):0}`);
    }

    console.log(`[POCM project-pl] asOnDate=${targetDate} projects=${rows.length} warnings=${warnings.length}`);

    // Sales Team / Purchase Team columns — added to each row after the P&L totals are final
    let collectionsSyncedAt = null, utilisation = null;
    try {
      const team = pocmTeamColumns({ projectList, qe, targetDate });
      for (const r of rows) r.team = team.byProject[r.project.id] || null;
      collectionsSyncedAt = team.collectionsSyncedAt;
      utilisation = team.utilisation;
      if (!collectionsSyncedAt) warnings.push('Amount Recd. Till Date: customer receipts not synced yet — run Sync Now to include collections.');
      if (!utilisation) warnings.push('Utilised by Project: vendor payments not synced yet — run Sync Now to include them.');
      else if (utilisation.stats.pendingCount > 0) {
        warnings.push(`Utilised by Project: ₹${Math.round(utilisation.stats.pendingAmount).toLocaleString('en-IN')} across ${utilisation.stats.pendingCount} vendor payment allocation(s) is not yet included — the bill's project is still being fetched from Zoho (completes on the next sync).`);
      }
    } catch (e) {
      console.error('[POCM project-pl] team columns:', e.message);
      warnings.push(`Sales / Purchase Team columns unavailable: ${e.message}`);
    }

    // Include coverage freshness so the UI can show "Data as of" timestamp
    let syncStatus = null;
    try { syncStatus = await pocmSync.getSyncStatus(); } catch (_) {}
    const dataAsOf = syncStatus?.data_as_of || null;
    const nextSync = syncStatus?.next_run || null;

    res.json({
      rows, asOnDate: targetDate, totalPortfolioValue, warnings,
      fyCoverage: startFY != null ? `FY ${startFY}-${String(startFY + 1).slice(2)} to FY ${endFY}-${String(endFY + 1).slice(2)}` : '',
      dataAsOf,
      nextSync,
      collectionsSyncedAt,
      utilisation,
    });
  } catch (e) {
    console.error('[POCM project-pl]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const pocmAsOn = (d) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) ? d : new Date().toISOString().slice(0, 10);

// Utilised by Project — transaction rows behind one project's figure (Section A + B)
app.get('/api/pocm/reports/project-utilisation', async (req, res) => {
  const targetDate = pocmAsOn(req.query.asOnDate);
  try {
    const project = (await readPocmProjects()).find(p => String(p.id) === String(req.query.projectId));
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const zohoName = (project.zohoProjectName || project.name || '').trim();
    const util = pocmUtilisation(targetDate, zohoName);
    if (!util) return res.status(409).json({ error: 'Vendor payments not synced yet — run Sync Now.' });
    const byDate = (a, b) => (a.payment_date < b.payment_date ? 1 : -1);
    const totals = util.byName[zohoName] || { bills: 0, advances: 0 };
    res.json({
      project: { id: project.id, name: project.name, zohoProjectName: zohoName },
      asOnDate: targetDate, syncedAt: util.syncedAt,
      sectionA: util.sectionA.sort(byDate), sectionB: util.sectionB.sort(byDate),
      totals: { bills: totals.bills, advances: totals.advances, total: totals.bills + totals.advances },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Utilised by Project — PO vs "Project Name-" mismatches, unmapped advances, pending items, counts
app.get('/api/pocm/reports/utilisation-exceptions', async (req, res) => {
  const targetDate = pocmAsOn(req.query.asOnDate);
  try {
    const util = pocmUtilisation(targetDate);
    if (!util) return res.status(409).json({ error: 'Vendor payments not synced yet — run Sync Now.' });
    const byDate = (a, b) => (a.payment_date < b.payment_date ? 1 : -1);
    res.json({
      asOnDate: targetDate, syncedAt: util.syncedAt, stats: util.stats, pendingBillDetails: util.pendingBillDetails,
      mismatches: util.mismatches.sort(byDate), unmapped: util.unmapped.sort(byDate), pending: util.pending.sort(byDate),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Draft Purchase Orders (alias — status=draft)
// (covered by /purchase-orders?status=draft above)

// ─── Debug: inspect Zoho fields ───────────────────────────────────────────────
app.get('/api/debug/zoho-fields', async (req, res) => {
  const ep = req.query.ep || '/bills';
  const key = req.query.key || 'bills';
  try {
    const d = await zohoGet(ep, { per_page: 1 });
    const item = (d[key] || [])[0];
    res.json({ keys: item ? Object.keys(item) : [], sample: item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Team Activity Tracker ────────────────────────────────────────────────────

async function fetchZohoOrgUsers() {
  const c = cache.get('at-org-users');
  if (c) return c;
  try {
    const d = await zohoGet('/users', {});
    const map = {};
    for (const u of (d.users || [])) {
      if (u.user_id) map[String(u.user_id)] = u.name || u.email || u.user_id;
    }
    cache.set('at-org-users', map, 7200);
    return map;
  } catch (_) { return {}; }
}

function resolveCreator(item) {
  // Zoho Books list API returns 'created_by' as a plain name string
  return item.created_by
    || item.created_by_name
    || item.last_modified_by
    || item.last_modified_by_name
    || 'Unattributed';
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Filter records where created_time falls within [from, to]
function filterByCreatedTime(items, from, to) {
  return items.filter(item => {
    const ct = (item.created_time || '').slice(0, 10);
    return ct && ct >= from && ct <= to;
  });
}

app.get('/api/activity-tracker/summary', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to dates required' });

  // v3 cache key — invalidates old unattributed data
  const cacheKey = `at-v3-${from}-${to}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Fetch with ±30 day buffer so backdated entries entered in the period are included
    const todayStr  = new Date().toISOString().slice(0, 10);
    const fetchFrom = addDays(from, -30);
    const fetchTo   = addDays(to, 7) < todayStr ? addDays(to, 7) : todayStr;
    const baseOpts  = (df) => ({ dateField: df, dateFrom: fetchFrom, dateTo: fetchTo, maxPages: 30 });
    const dateP     = { date_start: fetchFrom, date_end: fetchTo };

    const [umR, billsR, journalsR, invoicesR, vpR, cpR, cnR, poR] = await Promise.allSettled([
      fetchZohoOrgUsers(),
      zohoGetAll('/bills',           'bills',          { ...dateP }, baseOpts('date')),
      zohoGetAll('/journals',        'journals',       { ...dateP }, baseOpts('journal_date')),
      zohoGetAll('/invoices',        'invoices',       { ...dateP }, baseOpts('date')),
      zohoGetAll('/vendorpayments',  'vendorpayments', { ...dateP }, baseOpts('date')),
      zohoGetAll('/customerpayments','customerpayments',{ ...dateP }, baseOpts('date')),
      zohoGetAll('/creditnotes',     'creditnotes',    { ...dateP }, baseOpts('date')),
      zohoGetAll('/purchaseorders',  'purchaseorders', { ...dateP }, baseOpts('date')),
    ]);

    const rc = (r) => r.status === 'fulfilled' ? r.value : [];
    // Re-filter by created_time so we track WHEN entries were entered, not their document date
    const bills    = filterByCreatedTime(rc(billsR),    from, to);
    const journals = filterByCreatedTime(rc(journalsR), from, to);
    const invoices = filterByCreatedTime(rc(invoicesR), from, to);
    const vp       = filterByCreatedTime(rc(vpR),       from, to);
    const cp       = filterByCreatedTime(rc(cpR),       from, to);
    const cn       = filterByCreatedTime(rc(cnR),       from, to);
    const po       = filterByCreatedTime(rc(poR),       from, to);

    const TYPES = ['bills','journals','invoices','vendor_payments','customer_payments','credit_notes','purchase_orders'];
    const byUser = {};

    function add(user, type, rec) {
      if (!byUser[user]) {
        byUser[user] = {};
        TYPES.forEach(t => { byUser[user][t] = []; });
      }
      byUser[user][type].push(rec);
    }

    for (const b of bills) add(resolveCreator(b), 'bills', {
      id: b.bill_id, number: b.bill_number, vendor: b.vendor_name,
      date: b.date, amount: b.total || 0, status: b.status,
      category: b.cf_category_unformatted || b.cf_category || '',
      entered_on: (b.created_time || '').slice(0, 10),
    });

    for (const j of journals) add(resolveCreator(j), 'journals', {
      id: j.journal_id, number: j.journal_number || j.entry_number || '',
      date: j.journal_date || j.date,
      notes: (j.notes || j.memo || '').slice(0, 100),
      reference: j.reference_number || '',
      amount: j.total_debit || j.debit_amount || 0,
      entered_on: (j.created_time || '').slice(0, 10),
    });

    for (const i of invoices) add(resolveCreator(i), 'invoices', {
      id: i.invoice_id, number: i.invoice_number, customer: i.customer_name,
      date: i.date, amount: i.total || 0, status: i.status,
      entered_on: (i.created_time || '').slice(0, 10),
    });

    for (const p of vp) add(resolveCreator(p), 'vendor_payments', {
      id: p.payment_id, number: p.payment_number, vendor: p.vendor_name,
      date: p.date, amount: p.amount || 0, mode: p.payment_mode || '',
      entered_on: (p.created_time || '').slice(0, 10),
    });

    for (const p of cp) add(resolveCreator(p), 'customer_payments', {
      id: p.payment_id, number: p.payment_number, customer: p.customer_name,
      date: p.date, amount: p.amount || 0, mode: p.payment_mode || '',
      entered_on: (p.created_time || '').slice(0, 10),
    });

    for (const c of cn) add(resolveCreator(c), 'credit_notes', {
      id: c.creditnote_id, number: c.creditnote_number, customer: c.customer_name,
      date: c.date, amount: c.total || 0, status: c.status,
      entered_on: (c.created_time || '').slice(0, 10),
    });

    for (const p of po) add(resolveCreator(p), 'purchase_orders', {
      id: p.purchaseorder_id, number: p.purchaseorder_number, vendor: p.vendor_name,
      date: p.date, amount: p.total || 0, status: p.status,
      entered_on: (p.created_time || '').slice(0, 10),
    });

    const summary = {};
    const totals  = { total: 0 };
    TYPES.forEach(t => { totals[t] = 0; });

    for (const [user, data] of Object.entries(byUser)) {
      summary[user] = { total: 0 };
      for (const t of TYPES) {
        const c = (data[t] || []).length;
        summary[user][t] = c;
        summary[user].total += c;
        totals[t] += c;
        totals.total += c;
      }
    }

    const today   = new Date().toISOString().slice(0, 10);
    const isToday = from === to && from === today;
    const result  = { summary, totals, drilldown: byUser, meta: { from, to, fetched_at: new Date().toISOString() } };
    cache.set(cacheKey, result, isToday ? 300 : 1800);

    res.json(result);
  } catch (e) {
    console.error('[activity-tracker] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Finance Portal (Bill & Request Submission) ────────────────────────────────
const PORTAL_FILE    = path.join(__dirname, 'portal_submissions.json');
const PORTAL_UPLOADS = path.join(__dirname, 'portal-uploads');
try { fs.mkdirSync(PORTAL_UPLOADS, { recursive: true }); } catch (_) {} // read-only disk on Vercel

async function readPortal() {
  return await db.readJSON('portal_submissions', PORTAL_FILE, []);
}
async function writePortal(data) {
  await db.writeJSON('portal_submissions', PORTAL_FILE, data);
}

async function genPortalId() {
  const list = await readPortal();
  const now  = new Date();
  const y1   = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const tag  = `${String(y1).slice(2)}-${String(y1 + 1).slice(2)}`;
  const seq  = list.filter(s => (s.id || '').includes(tag)).length + 1;
  return `FP-${tag}-${String(seq).padStart(3, '0')}`;
}

const portalStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(PORTAL_UPLOADS, req._portalId || 'tmp');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return cb(e); } // e.g. read-only disk on Vercel
    cb(null, dir);
  },
  filename(req, file, cb) { cb(null, portalFileName(file.originalname)); },
});
function portalFileName(original) {
  const ext  = path.extname(original) || '';
  const base = path.basename(original, ext).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
  return `${Date.now()}-${base}${ext}`;
}
const portalUpload = multer({ storage: fileStore.enabled ? multer.memoryStorage() : portalStorage, limits: { fileSize: 25 * 1024 * 1024 } });
const PORTAL_FILE_FIELDS = new Set(['bill_attachment', 'loi_attachment', 'statement_attachment', 'payment_attachment']);

// Vercel only: one attachment per request into Blob storage (see stagedUpload)
app.post('/api/portal/upload-session', (req, res) => {
  if (!fileStore.enabled) return res.json({ staged: false });
  const sid = 'ps' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  res.json({ staged: true, sid, token: uploadToken('portal', sid) });
});
app.post('/api/portal/upload-file', stagedFileMiddleware, async (req, res) => {
  const sid = String(req.headers['x-upload-session'] || '');
  if (!fileStore.enabled || !validUploadToken('portal', sid, req.headers['x-upload-token'])) {
    return res.status(403).json({ error: 'Upload session not valid' });
  }
  const field = String(req.body?.field || '');
  if (!PORTAL_FILE_FIELDS.has(field)) return res.status(400).json({ error: `Unknown attachment: ${field}` });
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  try {
    const filename = portalFileName(req.file.originalname);
    await fileStore.save(`portal-uploads/${sid}/${filename}`, req.file.buffer, req.file.mimetype);
    res.json({ field, filename, original: req.file.originalname, size: req.file.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const setPortalId = async (req, res, next) => {
  req._portalId = await genPortalId();
  if (!fileStore.enabled) { try { fs.mkdirSync(path.join(PORTAL_UPLOADS, req._portalId), { recursive: true }); } catch (_) {} }
  next();
};

app.post('/api/portal/submit', setPortalId, portalUpload.any(), async (req, res) => {
  try {
    const b     = req.body || {};
    let files;
    if (fileStore.enabled) {
      // Vercel: attachments uploaded beforehand (kept under their upload session) …
      files = [];
      if (b.uploadSession) {
        if (!validUploadToken('portal', b.uploadSession, b.uploadToken)) return res.status(403).json({ error: 'Upload session not valid — please submit again' });
        for (const f of parseJSON(b.uploadedFiles, [])) {
          if (PORTAL_FILE_FIELDS.has(f.field) && /^[\w.-]+$/.test(f.filename || '')) {
            files.push({ field: f.field, filename: f.filename, original: String(f.original || ''), size: Number(f.size) || 0, folder: b.uploadSession });
          }
        }
      }
      // … or sent with the form (small submissions): into Blob storage
      for (const f of req.files || []) {
        const filename = portalFileName(f.originalname);
        await fileStore.save(`portal-uploads/${req._portalId}/${filename}`, f.buffer, f.mimetype);
        files.push({ field: f.fieldname, filename, original: f.originalname, size: f.size });
      }
    } else {
      files = (req.files || []).map(f => ({
        field: f.fieldname, filename: f.filename, original: f.originalname, size: f.size,
      }));
    }
    const sub = {
      id:                req._portalId,
      submission_type:   b.submission_type   || '',
      bill_type:         b.bill_type         || '',
      recurring_type:    b.recurring_type    || '',
      others_mention:    b.others_mention    || '',
      request_type:      b.request_type      || '',
      vendor_name:       b.vendor_name       || '',
      bill_date:         b.bill_date         || '',
      bill_amount:       parseFloat(b.bill_amount)        || 0,
      project_name:      b.project_name      || '',
      broker_name:       b.broker_name       || '',
      client_name:       b.client_name       || '',
      property_city:     b.property_city     || '',
      property_address:  b.property_address  || '',
      developer_name:    b.developer_name    || '',
      sqft:              parseFloat(b.sqft)               || 0,
      months_security:   parseFloat(b.months_security)    || 0,
      month_deposit_amt: parseFloat(b.month_deposit_amt)  || 0,
      total_deposit_amt: parseFloat(b.total_deposit_amt)  || 0,
      company_name:      b.company_name      || '',
      customer_name:     b.customer_name     || '',
      refund_amount:     parseFloat(b.refund_amount)      || 0,
      expected_date:     b.expected_date     || '',
      vendor_category:   b.vendor_category   || '',
      payment_source:    b.payment_source    || '',
      zoho_doc_type:     b.zoho_doc_type     || '',
      zoho_doc_id:       b.zoho_doc_id       || '',
      zoho_doc_number:   b.zoho_doc_number   || '',
      zoho_vendor_id:    b.zoho_vendor_id    || '',
      zoho_vendor_name:  b.zoho_vendor_name  || '',
      payment_amount:    parseFloat(b.payment_amount)     || 0,
      files,
      submitted_by:      b.submitted_by      || '',
      submitted_by_name: b.submitted_by_name || '',
      submitted_at:      new Date().toISOString(),
      status:            'pending',
      assigned_to:       '',
      confirmed_by:      '',
      confirmed_by_name: '',
      confirmed_at:      '',
      notes:             '',
    };
    const list = await readPortal();
    list.unshift(sub);
    await writePortal(list);
    res.json({ ok: true, id: sub.id });
  } catch (e) {
    console.error('[portal] submit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/portal/submissions', async (req, res) => {
  try {
    let list = await readPortal();
    const { status, type } = req.query;
    if (status && status !== 'all') list = list.filter(s => s.status === status);
    if (type   && type   !== 'all') list = list.filter(s => s.submission_type === type);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/portal/pending-count', async (req, res) => {
  try { res.json({ count: (await readPortal()).filter(s => s.status === 'pending').length }); }
  catch (_) { res.json({ count: 0 }); }
});

app.patch('/api/portal/submissions/:id', async (req, res) => {
  try {
    const list = await readPortal();
    const i = list.findIndex(s => s.id === req.params.id);
    if (i === -1) return res.status(404).json({ error: 'Not found' });
    const { status, notes, confirmed_by, confirmed_by_name, assigned_to } = req.body;
    if (status            !== undefined) list[i].status            = status;
    if (notes             !== undefined) list[i].notes             = notes;
    if (confirmed_by      !== undefined) list[i].confirmed_by      = confirmed_by;
    if (confirmed_by_name !== undefined) list[i].confirmed_by_name = confirmed_by_name;
    if (assigned_to       !== undefined) list[i].assigned_to       = assigned_to;
    if (status === 'completed')          list[i].confirmed_at      = new Date().toISOString();
    await writePortal(list);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/portal/file/:id/:filename', async (req, res) => {
  if (fileStore.enabled) {
    const sub = (await readPortal()).find(s => s.id === req.params.id);
    const f = sub?.files?.find(x => x.filename === req.params.filename);
    if (!f || !(await fileStore.send(res, `portal-uploads/${f.folder || sub.id}/${f.filename}`))) res.status(404).send('Not found');
    return;
  }
  const fp = path.join(PORTAL_UPLOADS, req.params.id, req.params.filename);
  // Stay inside portal-uploads (an encoded ../ in the URL must not reach other server files)
  if (!path.resolve(fp).startsWith(path.resolve(PORTAL_UPLOADS) + path.sep)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  res.sendFile(fp);
});

app.get('/api/portal/zoho/vendors', async (req, res) => {
  try {
    const params = { contact_type: 'vendor', filter_by: 'Status.Active', per_page: 200 };
    if (req.query.q) params.search_text = req.query.q;
    const d = await zohoGet('/contacts', params);
    res.json((d.contacts || []).map(c => ({
      id: c.contact_id, name: c.contact_name,
      category: c.cf_vendor_category_unformatted || c.cf_vendor_category || '',
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/portal/zoho/purchase-orders', async (req, res) => {
  try {
    const params = { per_page: 100 };
    if (req.query.vendor_id) params.vendor_id = req.query.vendor_id;
    const d   = await zohoGet('/purchaseorders', params);
    const ok  = ['open', 'approved', 'issued', 'pending_approval'];
    const pos = (d.purchaseorders || []).filter(p => ok.includes((p.status || '').toLowerCase()));
    res.json(pos.map(p => ({ id: p.purchaseorder_id, number: p.purchaseorder_number, date: p.date, total: p.total, status: p.status })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/portal/zoho/bills', async (req, res) => {
  try {
    const params = { filter_by: 'Status.Open', per_page: 100 };
    if (req.query.vendor_id) params.vendor_id = req.query.vendor_id;
    const d = await zohoGet('/bills', params);
    res.json((d.bills || []).map(b => ({ id: b.bill_id, number: b.bill_number, date: b.date, total: b.total, balance: b.balance, status: b.status })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Financial Statements ──────────────────────────────────────────────────────
const FIN_MAPPINGS_FILE = path.join(__dirname, 'financial_mappings.json');
const FIN_DATA_FILE     = path.join(__dirname, 'financial_pl_data.json');

async function readFinMappings() {
  return await db.readJSON('financial_mappings', FIN_MAPPINGS_FILE, {});
}
async function writeFinMappings(d) {
  await db.writeJSON('financial_mappings', FIN_MAPPINGS_FILE, d);
}
async function readFinData() {
  return await db.readJSON('financial_pl_data', FIN_DATA_FILE, { periods: [], values: {} });
}
async function writeFinData(d) {
  await db.writeJSON('financial_pl_data', FIN_DATA_FILE, d);
}

// Chart of Accounts (with pagination)
app.get('/api/financials/chart-of-accounts', async (req, res) => {
  const filter   = (req.query.filter || 'all').toLowerCase();
  const cacheKey = `fin-coa-${filter}`;
  const cached   = cache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const params = { per_page: 200 };
    if (filter === 'active')   params.filter_by = 'Status.Active';
    if (filter === 'inactive') params.filter_by = 'Status.Inactive';
    let all = [], pg = 1;
    while (pg <= 15) {
      const d = await zohoGet('/chartofaccounts', { ...params, page: pg });
      const items = d.chartofaccounts || [];
      all = all.concat(items);
      if (!d.page_context?.has_more_page) break;
      pg++;
    }
    cache.set(cacheKey, all, 3600);
    res.json(all);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mappings CRUD
app.get('/api/financials/mappings', async (req, res) => {
  res.json(await readFinMappings());
});
app.post('/api/financials/mappings', async (req, res) => {
  try { await writeFinMappings(req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// P&L Data CRUD (stored values + period config)
app.get('/api/financials/pl-data', async (req, res) => {
  res.json(await readFinData());
});
app.post('/api/financials/pl-data', async (req, res) => {
  try { await writeFinData(req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Balance Sheet Data CRUD
const FIN_BS_DATA_FILE = path.join(__dirname, 'financial_bs_data.json');
async function readFinBsData() {
  return await db.readJSON('financial_bs_data', FIN_BS_DATA_FILE, { lines: {}, values: {} });
}
async function writeFinBsData(d) {
  await db.writeJSON('financial_bs_data', FIN_BS_DATA_FILE, d);
}

app.get('/api/financials/bs-data', async (req, res) => {
  res.json(await readFinBsData());
});
app.post('/api/financials/bs-data', async (req, res) => {
  try { await writeFinBsData(req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Trial Balance drill-down — query by grouping(s) and period sheet (M26 or M25)
const FIN_TB_DATA_FILE = path.join(__dirname, 'financial_tb_data.json');
let _tbDataCache = null;
async function readTbData() {
  if (!_tbDataCache) {
    _tbDataCache = await db.readJSON('financial_tb_data', FIN_TB_DATA_FILE, {});
  }
  return _tbDataCache;
}

app.get('/api/financials/tb-drill', async (req, res) => {
  const sheet = req.query.sheet; // 'M26' or 'M25'
  const raw   = req.query.groupings || '';
  const groupings = raw.split('|||').map(g => g.trim()).filter(Boolean);
  if (!sheet || !groupings.length) return res.json([]);
  const tb = await readTbData();
  const rows = (tb[sheet] || []).filter(r => groupings.includes(r.grouping));
  res.json(rows);
});

// Fetch account net amounts from Zoho for given periods by aggregating
// journal line items + bill line items + invoice line items per account.
// (Zoho report APIs /reports/profitandloss etc. require a different OAuth scope.)
app.post('/api/financials/fetch-from-zoho', async (req, res) => {
  const { periods } = req.body; // [{ key, from, to }]
  const mappings    = await readFinMappings();

  // Collect all account IDs that appear in any mapping
  const wantedAccounts = new Set();
  for (const ids of Object.values(mappings)) {
    if (Array.isArray(ids)) ids.forEach(id => wantedAccounts.add(id));
  }
  if (wantedAccounts.size === 0) return res.json({});

  // Batch-fetch detail records — 8 concurrent with 200ms delay to respect Zoho rate limits
  async function batchFetch(ids, detailFn) {
    const results = [];
    const SIZE = 8;
    for (let i = 0; i < ids.length; i += SIZE) {
      const batch = await Promise.allSettled(ids.slice(i, i + SIZE).map(detailFn));
      batch.forEach(r => { if (r.status === 'fulfilled') results.push(r.value); });
      if (i + SIZE < ids.length) await new Promise(ok => setTimeout(ok, 200));
    }
    return results;
  }

  // Build account debit/credit map for one period.
  // Fetches journals + bills + invoices IN PARALLEL (not sequentially) to halve wall time.
  // Server-side date params reduce Zoho pages returned; client-side filter is the safety net.
  async function buildAccountMap(period, wantedAccounts) {
    const acctMap = {};
    const initAccount = (aid) => {
      if (wantedAccounts.has(aid) && !acctMap[aid]) acctMap[aid] = { debit: 0, credit: 0 };
    };
    const clOpts = (df) => ({ dateField: df, dateFrom: period.from, dateTo: period.to, maxPages: 20 });

    // Zoho's bill date_start/date_end filter does not reliably filter by the bill's `date` field.
    // To capture all bills that belong to the period, fetch the entire Indian financial year
    // (Apr 1 – Mar 31) that contains this period and rely on client-side date filtering.
    const periodEndYear  = parseInt(period.to.substring(0, 4));
    const periodEndMonth = parseInt(period.to.substring(5, 7));
    const fyStart = periodEndMonth >= 4 ? `${periodEndYear}-04-01` : `${periodEndYear - 1}-04-01`;
    const fyEnd   = periodEndMonth >= 4 ? `${periodEndYear + 1}-03-31` : `${periodEndYear}-03-31`;

    // Fetch journal, bill, and invoice lists IN PARALLEL.
    const [jR, bR, iR] = await Promise.allSettled([
      (async () => {
        const list = await zohoGetAll('/journals', 'journals',
          { date_start: period.from, date_end: period.to }, clOpts('journal_date'));
        console.log(`[fin-fetch] ${period.key} journals: ${list.length}`);
        return await batchFetch(list.map(j => j.journal_id), id => zohoGet(`/journals/${id}`, {}));
      })(),
      (async () => {
        // Zoho's date_start/date_end filter for bills does not reliably scope by the `date` field.
        // The real control is the zohoGetAll stop-condition via dateFrom.
        // Use fyStart as dateFrom so we paginate past Q1 bills (which fall before period.from)
        // and capture ALL bills whose `date` falls in this period.
        // A second filter then discards bills outside [period.from, period.to] before detail calls.
        const billClOpts = { dateField: 'date', dateFrom: fyStart, dateTo: period.to, maxPages: 40 };
        const rawList = await zohoGetAll('/bills', 'bills',
          { filter_by: 'Status.All', date_start: fyStart, date_end: fyEnd }, billClOpts);
        // Keep only bills within the EXACT period (rawList has all FY bills from fyStart)
        const list = rawList.filter(b => b.date && b.date >= period.from && b.date <= period.to);
        console.log(`[fin-fetch] ${period.key} bills: ${rawList.length} raw (FY ${fyStart}), ${list.length} in period`);
        return await batchFetch(list.map(b => b.bill_id), id => zohoGet(`/bills/${id}`, {}));
      })(),
      (async () => {
        const list = await zohoGetAll('/invoices', 'invoices',
          { filter_by: 'Status.All', date_start: period.from, date_end: period.to }, clOpts('date'));
        console.log(`[fin-fetch] ${period.key} invoices: ${list.length}`);
        return await batchFetch(list.map(i => i.invoice_id), id => zohoGet(`/invoices/${id}`, {}));
      })(),
    ]);

    // Aggregate journal line items (debit_or_credit field)
    if (jR.status === 'fulfilled') {
      for (const d of jR.value) {
        for (const li of (d.journal?.line_items || [])) {
          initAccount(li.account_id);
          if (!acctMap[li.account_id]) continue;
          const amt = parseFloat(li.bcy_amount || li.amount) || 0;
          if (li.debit_or_credit === 'debit') acctMap[li.account_id].debit += amt;
          else acctMap[li.account_id].credit += amt;
        }
      }
    } else { console.error(`[fin-fetch] ${period.key} journals error:`, jR.reason?.message); }

    // Aggregate bill line items (bills debit expense accounts)
    if (bR.status === 'fulfilled') {
      for (const d of bR.value) {
        for (const li of (d.bill?.line_items || [])) {
          initAccount(li.account_id);
          if (!acctMap[li.account_id]) continue;
          acctMap[li.account_id].debit += parseFloat(li.bcy_item_total || li.item_total || li.amount) || 0;
        }
      }
    } else { console.error(`[fin-fetch] ${period.key} bills error:`, bR.reason?.message); }

    // Aggregate invoice line items (invoices credit income accounts)
    if (iR.status === 'fulfilled') {
      for (const d of iR.value) {
        for (const li of (d.invoice?.line_items || [])) {
          initAccount(li.account_id);
          if (!acctMap[li.account_id]) continue;
          acctMap[li.account_id].credit += parseFloat(li.bcy_item_total || li.item_total || li.amount) || 0;
        }
      }
    } else { console.error(`[fin-fetch] ${period.key} invoices error:`, iR.reason?.message); }

    console.log(`[fin-fetch] ${period.key}: done, ${Object.keys(acctMap).length} accounts mapped`);
    return acctMap;
  }

  const results = {};
  const LAKH = 100000;

  for (const period of (periods || [])) {
    const cacheKey = `fin-acct-${period.from}-${period.to}`;
    let acctMap = cache.get(cacheKey);

    if (!acctMap) {
      try {
        acctMap = await buildAccountMap(period, wantedAccounts);
        cache.set(cacheKey, acctMap, 3600);
      } catch (e) {
        console.error(`[fin-fetch] ${period.key} fatal:`, e.message);
        results[period.key] = { _error: e.message };
        continue;
      }
    }

    // Compute line item amounts from account totals — raw rupees → ₹ in Lakhs
    results[period.key] = {};
    for (const [lineKey, accountIds] of Object.entries(mappings)) {
      if (!Array.isArray(accountIds) || accountIds.length === 0) continue;
      let total = 0;
      for (const aid of accountIds) {
        const { debit = 0, credit = 0 } = acctMap[aid] || {};
        total += credit - debit; // positive = income, negative = expense
      }
      results[period.key][lineKey] = Math.round((total / LAKH) * 100) / 100;
    }
  }

  res.json(results);
});

// Debug: try multiple Zoho report endpoints to find what works
app.get('/api/financials/debug/report-test', async (req, res) => {
  const from = req.query.from || '2026-07-01';
  const to   = req.query.to   || '2026-09-30';
  const aid  = req.query.account_id || '';
  const results = {};

  const tryEndpoint = async (key, ep, params) => {
    try {
      const d = await zohoGet(ep, params);
      results[key] = { ok: true, keys: Object.keys(d || {}).slice(0, 15) };
    } catch (e) {
      results[key] = { ok: false, error: e.message };
    }
  };

  await tryEndpoint('pl_report',      '/reports/profitandloss',     { from_date: from, to_date: to, cash_based: false });
  await tryEndpoint('trial_balance',  '/reports/trialbalance',      { from_date: from, to_date: to });
  await tryEndpoint('balance_sheet',  '/reports/balancesheet',      { from_date: from, to_date: to });
  await tryEndpoint('general_ledger', '/reports/generalledger',     { from_date: from, to_date: to });
  if (aid) await tryEndpoint('acct_txn', '/reports/accounttransactions', { account_id: aid, from_date: from, to_date: to });
  await tryEndpoint('journals',       '/journals',                  { date_start: from, date_end: to, per_page: 1 });

  res.json(results);
});

// Debug: get single journal with line items
app.get('/api/financials/debug/journal-detail', async (req, res) => {
  const { from, to } = req.query;
  try {
    const list = await zohoGet('/journals', { date_start: from || '2026-07-01', date_end: to || '2026-09-30', per_page: 2 });
    const journals = list.journals || [];
    if (!journals.length) return res.json({ message: 'No journals found', list });
    const detail = await zohoGet(`/journals/${journals[0].journal_id}`, {});
    res.json({ list_keys: Object.keys(journals[0]), detail_keys: Object.keys(detail.journal || {}), detail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug: check what fields are in bill/invoice LIST responses (no detail calls)
app.get('/api/financials/debug/list-fields', async (req, res) => {
  const from = req.query.from || '2026-07-01';
  const to   = req.query.to   || '2026-09-30';
  try {
    const [bData, iData, jData, eData] = await Promise.all([
      zohoGet('/bills', { filter_by: 'Status.All', bill_date_start: from, bill_date_end: to, per_page: 1 }),
      zohoGet('/invoices', { filter_by: 'Status.All', date_start: from, date_end: to, per_page: 1 }),
      zohoGet('/journals', { date_start: from, date_end: to, per_page: 1 }),
      zohoGet('/expenses', { date_start: from, date_end: to, per_page: 1 }),
    ]);
    res.json({
      bill_list_keys:    Object.keys((bData.bills||[])[0] || {}),
      invoice_list_keys: Object.keys((iData.invoices||[])[0] || {}),
      journal_list_keys: Object.keys((jData.journals||[])[0] || {}),
      expense_list_keys: Object.keys((eData.expenses||[])[0] || {}),
      bill_sample:    (bData.bills||[])[0],
      invoice_sample: (iData.invoices||[])[0],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug: count journals/bills/invoices in a period WITHOUT fetching details
app.get('/api/financials/debug/count', async (req, res) => {
  const from = req.query.from || '2026-07-01';
  const to   = req.query.to   || '2026-09-30';
  const clOpts = (df) => ({ dateField: df, dateFrom: from, dateTo: to, maxPages: 20 });
  const results = {};
  const start = Date.now();
  try {
    const [jl, bl, il] = await Promise.allSettled([
      zohoGetAll('/journals', 'journals', { date_start: from, date_end: to }, clOpts('journal_date')),
      zohoGetAll('/bills', 'bills', { filter_by: 'Status.All', date_start: from, date_end: to }, clOpts('date')),
      zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.All', date_start: from, date_end: to }, clOpts('date')),
    ]);
    results.journals  = jl.status === 'fulfilled' ? jl.value.length : { error: jl.reason?.message };
    results.bills     = bl.status === 'fulfilled' ? bl.value.length : { error: bl.reason?.message };
    results.invoices  = il.status === 'fulfilled' ? il.value.length : { error: il.reason?.message };
    results.elapsed_ms = Date.now() - start;
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug: journals-only fast fetch for one period (tests if journals alone give P&L data)
app.get('/api/financials/debug/journals-only', async (req, res) => {
  const from = req.query.from || '2026-07-01';
  const to   = req.query.to   || '2026-09-30';
  const mappings = await readFinMappings();
  const wantedAccounts = new Set();
  for (const ids of Object.values(mappings)) {
    if (Array.isArray(ids)) ids.forEach(id => wantedAccounts.add(id));
  }
  if (wantedAccounts.size === 0) return res.json({ error: 'no mappings' });

  async function batchFetch(ids, fn) {
    const results = [];
    const SIZE = 8;
    for (let i = 0; i < ids.length; i += SIZE) {
      const batch = await Promise.allSettled(ids.slice(i, i + SIZE).map(fn));
      batch.forEach(r => { if (r.status === 'fulfilled') results.push(r.value); });
      if (i + SIZE < ids.length) await new Promise(ok => setTimeout(ok, 300));
    }
    return results;
  }

  const start = Date.now();
  const acctMap = {};
  const initAccount = (aid) => {
    if (wantedAccounts.has(aid) && !acctMap[aid]) acctMap[aid] = { debit: 0, credit: 0 };
  };

  const jList = await zohoGetAll('/journals', 'journals',
    { date_start: from, date_end: to },
    { dateField: 'journal_date', dateFrom: from, dateTo: to, maxPages: 20 });

  const jDetails = await batchFetch(jList.map(j => j.journal_id), id => zohoGet(`/journals/${id}`, {}));

  for (const d of jDetails) {
    for (const li of (d.journal?.line_items || [])) {
      initAccount(li.account_id);
      if (!acctMap[li.account_id]) continue;
      const amt = parseFloat(li.bcy_amount || li.amount) || 0;
      if (li.debit_or_credit === 'debit') acctMap[li.account_id].debit += amt;
      else acctMap[li.account_id].credit += amt;
    }
  }

  const LAKH = 100000;
  const lineAmounts = {};
  for (const [lineKey, accountIds] of Object.entries(mappings)) {
    if (!Array.isArray(accountIds) || accountIds.length === 0) continue;
    let total = 0;
    for (const aid of accountIds) {
      const { debit = 0, credit = 0 } = acctMap[aid] || {};
      total += credit - debit;
    }
    if (total !== 0) lineAmounts[lineKey] = Math.round((total / LAKH) * 100) / 100;
  }

  res.json({
    journals_fetched: jList.length,
    elapsed_ms: Date.now() - start,
    accounts_hit: Object.keys(acctMap).length,
    non_zero_items: lineAmounts,
  });
});

// Debug: test chart-of-accounts transactions endpoint for one account
app.get('/api/financials/debug/coa-txns', async (req, res) => {
  const { account_id, from, to } = req.query;
  if (!account_id) return res.status(400).json({ error: 'account_id required' });
  const endpoints = [
    [`/chartofaccounts/${account_id}/transactions`, { from_date: from || '2026-07-01', to_date: to || '2026-09-30', per_page: 5 }],
    [`/reports/accounttransactions`, { account_id, from_date: from || '2026-07-01', to_date: to || '2026-09-30', per_page: 5 }],
  ];
  const results = {};
  for (const [ep, params] of endpoints) {
    try {
      const d = await zohoGet(ep, params);
      results[ep] = { ok: true, keys: Object.keys(d || {}), snippet: JSON.stringify(d).slice(0, 400) };
    } catch (e) {
      results[ep] = { ok: false, error: e.message };
    }
  }
  res.json(results);
});

// Debug: find all bills in a WIDE window that touch the n3_rent account IDs
// This reveals whether date-filtering is the cause of the rent discrepancy
app.get('/api/financials/debug/rent-bills', async (req, res) => {
  const from = req.query.from || '2026-04-01'; // wide window
  const to   = req.query.to   || '2026-10-31';
  const RENT_IDS = new Set([
    '1714732000000110955', // Office Rent (parent)
    '1714732000008980488', // Pune - 2 Office rent
    '1714732000053706256', // Office Furniture Rent
    '1714732000000072256', // Mumbai House Rent
  ]);

  try {
    // Fetch bill list for the wide window
    const billList = await zohoGetAll('/bills', 'bills',
      { filter_by: 'Status.All', bill_date_start: from, bill_date_end: to },
      { dateField: 'date', dateFrom: from, dateTo: to, maxPages: 30 });

    console.log(`[rent-debug] bills in ${from}→${to}: ${billList.length}`);

    // Batch-fetch details (8 concurrent, 200ms delay)
    const SIZE = 8;
    const details = [];
    for (let i = 0; i < billList.length; i += SIZE) {
      const batch = await Promise.allSettled(
        billList.slice(i, i + SIZE).map(b => zohoGet(`/bills/${b.bill_id}`, {}))
      );
      batch.forEach(r => { if (r.status === 'fulfilled') details.push(r.value); });
      if (i + SIZE < billList.length) await new Promise(ok => setTimeout(ok, 200));
    }

    // Find bills that have rent account line items
    const rentBills = [];
    let totalDebit = 0;

    for (const d of details) {
      const bill = d.bill;
      if (!bill) continue;
      const rentLines = (bill.line_items || []).filter(li => RENT_IDS.has(li.account_id));
      if (rentLines.length === 0) continue;

      const billAmt = rentLines.reduce((sum, li) =>
        sum + (parseFloat(li.bcy_item_total || li.item_total || li.amount) || 0), 0);
      totalDebit += billAmt;

      rentBills.push({
        bill_id:       bill.bill_id,
        bill_number:   bill.bill_number,
        vendor:        bill.vendor_name,
        bill_date:     bill.date,
        status:        bill.status,
        lines: rentLines.map(li => ({
          account_id:   li.account_id,
          account_name: li.account_name,
          amount:       parseFloat(li.bcy_item_total || li.item_total || li.amount) || 0,
        })),
        total_rent_amt: billAmt,
      });
    }

    const q2Bills    = rentBills.filter(b => b.bill_date >= '2026-07-01' && b.bill_date <= '2026-09-30');
    const beforeQ2   = rentBills.filter(b => b.bill_date < '2026-07-01');
    const afterQ2    = rentBills.filter(b => b.bill_date > '2026-09-30');
    const q2Total    = q2Bills.reduce((s, b) => s + b.total_rent_amt, 0);
    const beforeTotal = beforeQ2.reduce((s, b) => s + b.total_rent_amt, 0);
    const afterTotal  = afterQ2.reduce((s, b) => s + b.total_rent_amt, 0);

    res.json({
      window: { from, to },
      total_bills_fetched: billList.length,
      rent_bills_found: rentBills.length,
      q2_bills: q2Bills.length,
      q2_total_inr:   Math.round(q2Total),
      q2_total_lakhs: Math.round(q2Total / 100000 * 100) / 100,
      before_q2_bills: beforeQ2.length,
      before_q2_total_lakhs: Math.round(beforeTotal / 100000 * 100) / 100,
      after_q2_bills: afterQ2.length,
      after_q2_total_lakhs: Math.round(afterTotal / 100000 * 100) / 100,
      grand_total_lakhs: Math.round(totalDebit / 100000 * 100) / 100,
      detail: rentBills,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Budget vs Actual ─────────────────────────────────────────────────────────

const BUDGET_DATA_FILE     = path.join(__dirname, 'budget_data.json');
const BUDGET_ACTUALS_FILE  = path.join(__dirname, 'budget_actuals.json');
const BUDGET_MAPPINGS_FILE = path.join(__dirname, 'budget_mappings.json');
const BRANCH_FY_FILE       = path.join(__dirname, 'budget_branch_fy.json');
const BILLS_CACHE_FILE     = path.join(__dirname, 'bills_cache.json');
const BRANCH_BILLS_DIR     = path.join(__dirname, 'branch_bills_cache');

async function readBudgetData()       { return await db.readJSON('budget_data',     BUDGET_DATA_FILE,    { assumptions: {}, lastFetchedAt: null }); }
async function writeBudgetData(d)     { await db.writeJSON('budget_data',     BUDGET_DATA_FILE,    d); }
async function readBudgetActuals()    { return await db.readJSON('budget_actuals',  BUDGET_ACTUALS_FILE, {}); }
async function writeBudgetActuals(d)  { await db.writeJSON('budget_actuals',  BUDGET_ACTUALS_FILE, d); }
async function readBudgetMappings()   { return await db.readJSON('budget_mappings', BUDGET_MAPPINGS_FILE, {}); }
async function writeBudgetMappings(d) { await db.writeJSON('budget_mappings', BUDGET_MAPPINGS_FILE, d); }
async function readBranchFyActuals()  { return await db.readJSON('branch_fy_actuals', BRANCH_FY_FILE, null); }
async function writeBranchFyActuals(d){ await db.writeJSON('branch_fy_actuals', BRANCH_FY_FILE, d); }
async function readBillsCache()       { return await db.readJSON('bills_cache', BILLS_CACHE_FILE, null); }
async function writeBillsCache(d)     { await db.writeJSON('bills_cache', BILLS_CACHE_FILE, d); }
async function readBranchBillsCache(branchId) {
  return await db.readBranchCache(branchId, BRANCH_BILLS_DIR);
}
async function writeBranchBillsCache(branchId, data) {
  await db.writeBranchCache(branchId, data, BRANCH_BILLS_DIR);
}

const BUDGET_BRANCHES = [
  { id: 'amd_binori_b_square_3',    name: 'Amd_Binori B Square_3',              sqft: 166600,    active: true, zohoBranchId: '1714732000007239001' },
  { id: 'amd_capital_one',          name: 'Amd_Capital One',                    sqft: 315000,    active: true, zohoBranchId: '1714732000022184187' },
  { id: 'amd_gift_city',            name: 'Amd_Gift City_Gandhinagar',          sqft: 90000,     active: true, zohoBranchId: '1714732000019141708' },
  { id: 'amd_sci_city_3rd',         name: 'Amd_Sci. City_3Rd Floor',           sqft: 10352,     active: true, zohoBranchId: '1714732000005679237' },
  { id: 'amd_the_first_10th',       name: 'Amd_The First_10Th Floor',          sqft: 25509,     active: true, zohoBranchId: '1714732000000088177' },
  { id: 'amd_the_first_11th',       name: 'Amd_The First_11Th Floor',          sqft: 25650,     active: true, zohoBranchId: '1714732000005147795' },
  { id: 'amd_the_first_a_6th',      name: 'Amd_The First_A_6th Floor',         sqft: 8600,      active: true, zohoBranchId: '1714732000026174229' },
  { id: 'amd_the_first_a03',        name: 'Amd_The First_A-03',               sqft: 12410,     active: true, zohoBranchId: '1714732000007556023' },
  { id: 'amd_the_first_c_2nd',      name: 'Amd_The First_C_2Nd Floor',        sqft: 49035,     active: true, zohoBranchId: '1714732000000080003' },
  { id: 'hyd_laxmi_pinnacle',       name: 'Hyd_Laxmi Pinnacle_Zomoto',        sqft: 21920,     active: true, zohoBranchId: '1714732000017967024' },
  { id: 'hyd_purva_summit_4th',     name: 'Hyd_Purva Summit_B_4Th Floor',     sqft: 35564,     active: true, zohoBranchId: '1714732000003534180' },
  { id: 'hyd_purva_summit_7th',     name: 'Hyd_Purva Summit_B_7Th Floor',     sqft: 17298,     active: true, zohoBranchId: '1714732000036595606' },
  { id: 'ind_nrk_busi_park',        name: 'Ind_Nrk Busi. Park_B-1_6th Floor',sqft: 19204,     active: true, zohoBranchId: '1714732000014496699' },
  { id: 'jai_fort_anand_5th',       name: 'Jai_Fort Anand_5Th Floor',         sqft: 13190,     active: true, zohoBranchId: '1714732000013684215' },
  { id: 'jai_pinkcity_8th',         name: 'Jai_Pinkcity Multiplex_8Th Floor', sqft: 30900,     active: true, zohoBranchId: '1714732000010929442' },
  { id: 'mum_215_atrium_10th',      name: 'Mum_215-Atrium_10Th Floor',        sqft: 23470,     active: true, zohoBranchId: '1714732000007556041' },
  { id: 'mum_dynasty_7th',          name: 'Mum_Dynasty_7Th Floor',            sqft: 21000,     active: true, zohoBranchId: '1714732000000587061' },
  { id: 'noi_embassy_5th',          name: 'Noi_Embassy_5th Floor',            sqft: 22948,     active: true, zohoBranchId: '1714732000020347377' },
  { id: 'noi_jask_7th',             name: 'Noi_Jask_7th Floor',               sqft: 14000,     active: true, zohoBranchId: '1714732000020510796' },
  { id: 'pun_amar_busi_13th',       name: 'Pun_Amar Busi.Zone_13Th Floor',    sqft: 18987,     active: true, zohoBranchId: '1714732000008115035' },
  { id: 'pun_mccia_6th',            name: 'Pun_Mccia_6Th Floor',              sqft: 18682,     active: true, zohoBranchId: '1714732000005572459' },
  { id: 'pun_next_gen_4th_5th',     name: 'Pun_Next Gen 4th & 5th Floor',     sqft: 28400,     active: true, zohoBranchId: '1714732000036471457' },
  { id: 'raj_om9_square',           name: 'Raj_Om 9 Square',                  sqft: 22173,     active: true, zohoBranchId: '1714732000005883511' },
  { id: 'support_branch',           name: 'Support Branch',                   sqft: 0,         active: true, zohoBranchId: '1714732000000158932' },
  { id: 'surat_stalwart_3rd',       name: 'Surat_Stalwart_3rd Floor',         sqft: 24600,     active: true, zohoBranchId: '1714732000039762162' },
  { id: 'udai_paras_prime_5th',     name: 'Udai_Paras Prime_5Th Floor',       sqft: 13333.33,  active: true, zohoBranchId: '1714732000023297270' },
  { id: 'vad_ishan_block_f',        name: 'Vad_Ishan_Block-F',                sqft: 49825,     active: true, zohoBranchId: '1714732000005147817' },
  { id: 'vad_notus_d_10th_11th',    name: 'Vad_Notus_D_10Th & 11Th Floor',   sqft: 30320,     active: true, zohoBranchId: '1714732000000088197' },
];
// Computed dynamically from active branches so toggling active:false is reflected automatically
const BUDGET_TOTAL_SQFT = BUDGET_BRANCHES.filter(b => b.active !== false).reduce((s, b) => s + b.sqft, 0);

// COA account name aliases for branches whose accounts don't use the standard branch name.
// Zoho COA was sometimes set up with abbreviations or typos that differ from BUDGET_BRANCHES.name.
// Each entry is [branchId]: [additional substrings to match in account names].
const BRANCH_COA_ALIASES = {
  'amd_binori_b_square_3':  ['Amd_Binori-3'],                              // COA uses abbreviated name
  'hyd_laxmi_pinnacle':     ['Hyd_Laxmi Pinnacale'],                       // COA has typo (Pinnacale)
  'jai_fort_anand_5th':     ['Jai_Fort Anandam'],                          // COA has typo (Anandam)
  'ind_nrk_busi_park':      ['Ind_Nrk Busi. Park_B-1_3Rd Floor',          // COA uses 3rd floor instead of 6th
                              'Ind_Nrk Busi. Park_B-1'],
  'hyd_purva_summit_4th':   ['Hyd_Purva Summit__B_4Th Floor'],             // COA has double underscore
  'hyd_purva_summit_7th':   ['Hyd_Purva Summit__B_7Th Floor'],             // COA has double underscore
};

const BUDGET_ITEMS = [
  // ── Direct Expenses ──────────────────────────────────────────────────────────
  { id: 'elec_util',    label: 'Electricity & Utilities',         section: 'direct',   mapKeys: ['n3_electricity'] },
  { id: 'hk_materials', label: 'Housekeeping Materials',          section: 'direct',   mapKeys: ['n3_cogs'] },
  { id: 'hk_service',   label: 'Housekeeping Service',            section: 'direct',   mapKeys: ['n3_hk'] },
  { id: 'internet',     label: 'Internet & Connectivity',         section: 'direct',   mapKeys: [] },
  { id: 'office_rent',  label: 'Office Rent',                     section: 'direct',   mapKeys: ['n3_rent'] },
  { id: 'pantry',       label: 'Pantry & Vending',                section: 'direct',   mapKeys: [] },
  { id: 'prop_maint',   label: 'Property Maintenance',            section: 'direct',   mapKeys: ['n3_property'] },
  { id: 'repairs',      label: 'Repairs & Maintenance',           section: 'direct',   mapKeys: ['n7_repairs'] },
  { id: 'security',     label: 'Security Services',               section: 'direct',   mapKeys: [] },
  { id: 'tea_coffee',   label: 'Tea & Coffee',                    section: 'direct',   mapKeys: [] },
  // ── Indirect Expenses ────────────────────────────────────────────────────────
  { id: 'brokerage',    label: 'Brokerage Charges',               section: 'indirect', mapKeys: ['n7_brokerage'] },
  { id: 'emp_sal',      label: 'Employee Salaries & Benefits',    section: 'indirect', mapKeys: ['n4_salary','n4_pf','n4_gratuity','n4_welfare'] },
  { id: 'mkt_promo',    label: 'Marketing & Promotion',           section: 'indirect', mapKeys: ['n7_marketing'] },
  { id: 'other_ind',    label: 'Other Indirect Expenses',         section: 'indirect', mapKeys: ['n7_general','n7_sundry'] },
  { id: 'prof_fees',    label: 'Professional Fees & Consultancy', section: 'indirect', mapKeys: ['n7_legal'] },
  { id: 'prop_tax',     label: 'Property Tax',                    section: 'indirect', mapKeys: ['n7_rates'] },
  { id: 'reimb',        label: 'Reimbursement Expenses',          section: 'indirect', mapKeys: [] },
  { id: 'stamp_duty',   label: 'Stamp Duty & Registration',       section: 'indirect', mapKeys: ['n7_stamp'] },
  { id: 'subscr',       label: 'Subscription Expenses',           section: 'indirect', mapKeys: ['n7_subscription'] },
  { id: 'travel',       label: 'Travel & Conveyance',             section: 'indirect', mapKeys: ['n7_travelling'] },
];

// COA group names → budget item IDs (used for ancestor-chain matching in P&L extractions)
const GROUP_ITEMS = {
  elec_util:    ['Electricity Expense'],
  hk_materials: ['Housekeeping Material Expense'],
  hk_service:   ['Housekeeping Service'],
  internet:     ['Internet Connect. Charges'],
  office_rent:  ['Office Rent'],
  prop_maint:   ['Property Maintenance', 'Property Maintenance Charges'],
  repairs:      ['Repairs and Maintenance Expense', 'Repairs & Maintenance_Vad_Notus_D_10Th & 11Th Floor', 'Repairs & Maintenance_Vad_Ishan_Block-F', 'Repairs & Maintenance_Udai_Paras Prime_5Th Floor', 'Repairs & Maintenance_Pun_Mccia_6Th Floor', 'Repairs & Maintenance_Pun_Amar Busi.Zone_13Th Floor', 'Repairs & Maintenance_Raj_Om 9 Square', 'Repairs & Maintenance_Amd_The First_10Th Floor', 'Repairs & Maintenance_Amd_Gift City_Gandhinagar', 'Repairs & Maintenance_Amd_The First_C_2Nd Floor', 'Repairs & Maintenance_Amd_Capital One', 'Repairs & Maintenance_Hyd_Laxmi Pinnacale_Zomoto', 'Repairs & Maintenance_Hyd_Purva Summit_B_4Th Floor', 'Repairs & Maintenance_Ind_Nrk Busi. Park_B-1_3Rd Floor', 'Repairs & Maintenance_Jai_Pinkcity Multiplex_8Th Floor', 'Repairs & Maintenance_Mum_215-Atrium_8Th Floor', 'Repairs & Maintenance_Noi_Embassy'],
  security:     ['Security Services'],
  tea_coffee:   ['Tea & Coffee Machine Maint. Charges', 'Tea_Coffee & Milk Expense'],
  brokerage:    ['Brokerage Charges', 'Client Brokerage Charges'],
  emp_sal:      ['Employee Benefit Expense', 'Salaries and Employee Wages_', 'Contribution to Provident & other Funds', 'Gratuity Expense', 'Staff Welfare Expense', 'DevX Salaries & Wages_Vad_Notus_D_10Th & 11Th Floor', 'DevX Salaries & Wages_Udaipur - Paras Prime', 'DevX Salaries & Wages_Vad_Ishan_Block-F', 'DevX Salaries & Wages_Pun_Mccia_6Th Floor', 'DevX Salaries & Wages_Pun_Amar Busi.Zone_13Th Floor', 'DevX Salaries & Wages_Raj_Om 9 Square', 'DevX Salaries & Wages_Amd_The First_10Th Floor', 'DevX Salaries & Wages_Amd_Gift City_Gandhinagar', 'DevX Salaries & Wages_Amd_The First_11Th Floor', 'DevX Salaries & Wages_Amd_Capital One', 'DevX Salaries & Wages_Hyd_Purva Summit_B_4Th Floor', 'DevX Salaries & Wages_Ind_Nrk Busi. Park_B-1_3Rd Floor', 'DevX Salaries & Wages_Jai_Fort Anand_5Th Floor', 'DevX Salaries & Wages_Jai_Pinkcity Multiplex_8Th Floor', 'DevX Salaries & Wages_Mum_Dynasty_7Th Floor'],
  mkt_promo:    ['Advertising And Marketing', 'Marketing & Business Promotion Expense', 'Marketing & Distribution Expense'],
  other_ind:    ['Other General Charges', 'General Charges', 'Sundry Balances written off'],
  prof_fees:    ['Other Direct Exp._Professional Fees_Charges', 'Legal & Professional Charges'],
  prop_tax:     ['Property Tax', 'Rates & Taxes'],
  stamp_duty:   ['Stamp Duty', 'Other Stamp Duty Expense', 'Capital One Stamp Duty Charges', 'Stamp Duty_Noi_Embassy_6th Floor', 'Stamp Duty Charges_Noi_Embassy_5th Floor', 'Stamp Duty_Noi_Jask_7th Floor', 'Stamp Duty Charges_Noi_Jask_7th Floor'],
  subscr:       ['Subscription Expense', 'Subscription and Membership Expense'],
  travel:       ['Other Direct Exp._ Travelling Charges', 'Travelling Charges'],
};

// Budget COA — returns Zoho chart of accounts for mapping setup
app.get('/api/budget/coa', async (req, res) => {
  const cacheKey = 'budget-coa';
  const hit = cache.get(cacheKey);
  if (hit) return res.json(hit);
  try {
    let all = [], pg = 1;
    while (pg <= 15) {
      const d = await zohoGet('/chartofaccounts', { per_page: 200, page: pg });
      const items = d.chartofaccounts || [];
      all = all.concat(items);
      if (!d.page_context?.has_more_page) break;
      pg++;
    }
    const result = all.map(a => ({
      account_id:   a.account_id,
      account_name: a.account_name,
      account_type: a.account_type,
      account_code: a.account_code || '',
    })).sort((a, b) => {
      if (a.account_type !== b.account_type) return a.account_type.localeCompare(b.account_type);
      return a.account_name.localeCompare(b.account_name);
    });
    cache.set(cacheKey, result, 3600);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Budget COA mappings (budget item id → [account_id, ...])
app.get('/api/budget/mappings', async (req, res) => res.json(await readBudgetMappings()));
app.put('/api/budget/mappings', async (req, res) => {
  try { await writeBudgetMappings(req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Config: branches + items metadata
app.get('/api/budget/config', (req, res) => {
  res.json({ branches: BUDGET_BRANCHES, items: BUDGET_ITEMS, totalSqft: BUDGET_TOTAL_SQFT });
});

// Get budget assumptions
app.get('/api/budget/assumptions', async (req, res) => {
  res.json(await readBudgetData());
});

// Save budget assumptions (growthPct + manual lastYrAnnual)
app.put('/api/budget/assumptions', async (req, res) => {
  const { assumptions } = req.body || {};
  if (!assumptions) return res.status(400).json({ error: 'assumptions required' });
  const current = await readBudgetData();
  current.assumptions = assumptions;
  await writeBudgetData(current);
  res.json({ ok: true });
});

// FY25-26 manual monthly averages per branch (editable override)
const FY_MANUAL_PATH = path.join(__dirname, 'branch_fy_manual.json');
async function readFyManual() {
  return await db.readJSON('branch_fy_manual', FY_MANUAL_PATH, {});
}
async function writeFyManual(data) {
  await db.writeJSON('branch_fy_manual', FY_MANUAL_PATH, data);
}

app.get('/api/budget/fy-manual', async (req, res) => {
  res.json(await readFyManual());
});

app.put('/api/budget/fy-manual', async (req, res) => {
  const { branchId, itemId, value } = req.body || {};
  if (!branchId || !itemId) return res.status(400).json({ error: 'branchId and itemId required' });
  const data = await readFyManual();
  if (!data[branchId]) data[branchId] = {};
  data[branchId][itemId] = value == null ? null : Number(value);
  await writeFyManual(data);
  res.json({ ok: true });
});

// ── CRM Actuals (field team expense submissions) ──────────────────────────────
const CRM_ACTUALS_PATH = path.join(__dirname, 'crm_actuals.json');
async function readCrmActuals()  { return await db.readJSON('crm_actuals', CRM_ACTUALS_PATH, {}); }
async function writeCrmActuals(d){ await db.writeJSON('crm_actuals', CRM_ACTUALS_PATH, d); }

// Serve the standalone CRM form
app.get('/crm-form', (req, res) => {
  res.sendFile(path.join(__dirname, 'crm_form.html'));
});

// Branches list for the form
app.get('/api/crm/branches', (req, res) => {
  res.json(BUDGET_BRANCHES.filter(b => b.active !== false).map(b => ({ id: b.id, name: b.name })));
});

// GET all CRM actuals
app.get('/api/crm/actuals', async (req, res) => {
  res.json(await readCrmActuals());
});

// POST CRM submission — merges only provided (non-empty) fields
app.post('/api/crm/actuals', async (req, res) => {
  const { branchId, month, submittedBy, ...fields } = req.body || {};
  if (!branchId || !month) return res.status(400).json({ error: 'branchId and month required' });
  const data = await readCrmActuals();
  if (!data[branchId]) data[branchId] = {};
  const existing = data[branchId][month] || {};
  const updated = { ...existing };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined && v !== '') {
      const num = Number(v);
      updated[k] = isNaN(num) ? v : num;
    }
  }
  if (submittedBy) updated.submittedBy = submittedBy;
  updated.submittedAt = existing.submittedAt || new Date().toISOString();
  updated.updatedAt   = new Date().toISOString();
  data[branchId][month] = updated;
  await writeCrmActuals(data);
  res.json({ ok: true, data: updated });
});

// CRM bill file uploads — saved to OneDrive month-wise folders
const CRM_BILLS_ROOT = 'D:\\OneDrive - Dev Accelerator Limited\\Submitted Documents\\CRM Team Bills Folder';

// <month>/<branch name> folder of a bill (office PC: under CRM_BILLS_ROOT; Vercel: Blob crm-bills/)
function crmBillFolder({ branchId, month }) {
  const branch = BUDGET_BRANCHES.find(b => b.id === branchId);
  const safeBranch = (branch ? branch.name : branchId).replace(/[\/\\:*?"<>|]/g, '_');
  return [month || 'unknown', safeBranch];
}
function crmBillFileName({ itemId }, original) {
  return `${itemId || 'bill'}_${Date.now()}${path.extname(original) || '.pdf'}`;
}

const crmBillStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(CRM_BILLS_ROOT, ...crmBillFolder(req.body));
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return cb(e); } // e.g. read-only disk on Vercel
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, crmBillFileName(req.body, file.originalname)),
});
const crmBillUpload = multer({ storage: fileStore.enabled ? multer.memoryStorage() : crmBillStorage, limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/api/crm/upload-bill', crmBillUpload.single('bill'), async (req, res) => {
  const { branchId, month, itemId } = req.body;
  if (!branchId || !month || !itemId || !req.file) {
    return res.status(400).json({ error: 'branchId, month, itemId and file required' });
  }
  if (fileStore.enabled) {   // Vercel: into Blob storage (crm-bills/<month>/<branch>/<file>)
    req.file.filename = crmBillFileName(req.body, req.file.originalname);
    await fileStore.save(['crm-bills', ...crmBillFolder(req.body), req.file.filename].join('/'), req.file.buffer, req.file.mimetype);
  }
  const data = await readCrmActuals();
  if (!data[branchId]) data[branchId] = {};
  if (!data[branchId][month]) data[branchId][month] = {};
  data[branchId][month][itemId + '_bill'] = req.file.filename;
  await writeCrmActuals(data);
  res.json({ ok: true, filename: req.file.filename });
});

// Debug: inspect raw Zoho API responses for fetch diagnostics
app.get('/api/budget/debug-zoho', async (req, res) => {
  try {
    const what = req.query.what || 'coa';
    if (what === 'coa') {
      const d = await zohoGet('/chartofaccounts', { page: 1, per_page: 10 });
      const sample = (d.chartofaccounts || []).slice(0, 3);
      res.json({ total_keys: Object.keys(d), sample_accounts: sample });
    } else if (what === 'tb') {
      const d = await zohoGet('/reports/trialbalance', { from_date: '2025-04-01', to_date: '2026-03-31' });
      const keys = Object.keys(d);
      // Get one full account entry from the trial balance to see structure
      const tb = d.trialbalance || [];
      let sampleAcct = null;
      function findAcct(node) {
        if (!node || sampleAcct) return;
        if (Array.isArray(node)) { node.forEach(findAcct); return; }
        if (typeof node === 'object') {
          if (node.account_id) { sampleAcct = node; return; }
          for (const v of Object.values(node)) findAcct(v);
        }
      }
      findAcct(tb);
      res.json({ keys, tb_type: typeof tb, tb_is_array: Array.isArray(tb), tb_len: Array.isArray(tb) ? tb.length : null, tb_first_keys: Array.isArray(tb) && tb[0] ? Object.keys(tb[0]) : null, sample_account: sampleAcct });
    } else if (what === 'pl') {
      const d = await zohoGet('/reports/profitandloss', { from_date: '2025-04-01', to_date: '2026-03-31' });
      const keys = Object.keys(d);
      const raw = JSON.stringify(d).slice(0, 3000);
      res.json({ keys, raw });
    } else if (what === 'pl_branch_test') {
      // Test whether branch_id actually filters P&L results — compare 2 branches
      const from = req.query.from || '2026-04-01';
      const to   = req.query.to   || '2026-04-30';
      const b1   = req.query.b1   || '1714732000007239001'; // Binori
      const b2   = req.query.b2   || '1714732000000080003'; // The First C 2nd
      const [d1, d2] = await Promise.all([
        zohoGet('/reports/profitandloss', { from_date: from, to_date: to, branch_id: b1 }),
        zohoGet('/reports/profitandloss', { from_date: from, to_date: to, branch_id: b2 }),
      ]);
      // Extract total income+expense summary from each
      function sumLeafs(node, acc = { count: 0, total: 0 }) {
        if (!node || typeof node !== 'object') return acc;
        if (Array.isArray(node)) { node.forEach(n => sumLeafs(n, acc)); return acc; }
        if (node.account_id && node.is_child_present === false) { acc.count++; acc.total += parseFloat(node.total || 0); }
        for (const v of Object.values(node)) if (typeof v === 'object') sumLeafs(v, acc);
        return acc;
      }
      const s1 = sumLeafs(d1.profit_and_loss || d1);
      const s2 = sumLeafs(d2.profit_and_loss || d2);
      const same = Math.abs(s1.total - s2.total) < 1;
      res.json({ b1_summary: s1, b2_summary: s2, same_totals: same, raw_b1_top500: JSON.stringify(d1).slice(0, 500), raw_b2_top500: JSON.stringify(d2).slice(0, 500) });
    } else if (what === 'acct_branch_test') {
      // Test: fetch account transactions for one account, with vs without branch_id
      const aid  = req.query.aid  || '1714732000000035001';
      const from = req.query.from || '2026-04-01';
      const to   = req.query.to   || '2026-04-30';
      const bid1 = req.query.b1   || '1714732000007239001'; // Binori
      const bid2 = req.query.b2   || '1714732000000080003'; // The First C 2nd
      const [dAll, d1, d2] = await Promise.all([
        zohoGet('/reports/accounttransactions', { account_id: aid, from_date: from, to_date: to }),
        zohoGet('/reports/accounttransactions', { account_id: aid, from_date: from, to_date: to, branch_id: bid1 }),
        zohoGet('/reports/accounttransactions', { account_id: aid, from_date: from, to_date: to, branch_id: bid2 }),
      ]);
      const getTotal = d => { const t = d.account_transactions || []; return t.reduce((s, r) => s + (parseFloat(r.debit_amount || 0) - parseFloat(r.credit_amount || 0)), 0); };
      res.json({ all_total: getTotal(dAll), b1_total: getTotal(d1), b2_total: getTotal(d2), same_b1_all: Math.abs(getTotal(dAll) - getTotal(d1)) < 1, raw_all: JSON.stringify(dAll).slice(0, 600) });
    } else if (what === 'bills_branch_test') {
      // Test: fetch bills for a branch vs all
      const from = req.query.from || '2026-04-01';
      const to   = req.query.to   || '2026-04-30';
      const bid1 = req.query.b1   || '1714732000007239001'; // Binori
      const [dAll, d1] = await Promise.all([
        zohoGet('/bills', { filter_by: 'Status.All', date_start: from, date_end: to, per_page: 200 }),
        zohoGet('/bills', { filter_by: 'Status.All', date_start: from, date_end: to, branch_id: bid1, per_page: 200 }),
      ]);
      const countAll = (dAll.bills || []).length;
      const countB1  = (d1.bills || []).length;
      const sample5  = (d1.bills || []).slice(0, 5).map(b => ({ id: b.bill_id, vendor: b.vendor_name, amount: b.total, branch: b.branch_name || b.branch_id }));
      res.json({ total_all_bills: countAll, b1_bills: countB1, different: countAll !== countB1, sample5_branch_bills: sample5 });
    } else if (what === 'acct') {
      const aid = req.query.aid;
      const d = await zohoGet('/reports/accounttransactions', { account_id: aid, from_date: '2025-04-01', to_date: '2026-03-31' });
      const keys = Object.keys(d);
      const raw = JSON.stringify(d).slice(0, 2000);
      res.json({ keys, raw });
    } else if (what === 'acct_nofilter') {
      // Test account_transactions WITHOUT branch_id filter for a specific account.
      // Use this to verify that branch-specific COA accounts return correct amounts.
      // Example: ?what=acct_nofilter&from=2026-04-01&to=2026-08-31
      // The account_id must be the Zoho account_id of a branch-specific expense account.
      const { coaFull, coaParentIds, getGroupId } = await getCoaData();
      const from = req.query.from || '2026-04-01';
      const to   = req.query.to   || '2026-08-31';

      // Find "Office Rent" leaf accounts and fetch one for Binori as a test
      const rentLeaves = [];
      for (const [accountId, acct] of Object.entries(coaFull)) {
        if (coaParentIds.has(accountId)) continue;
        const gid = getGroupId(accountId);
        if (gid === 'office_rent') rentLeaves.push({ accountId, name: acct.name });
      }

      // Sample up to 5 accounts
      const sample = rentLeaves.filter(a => a.name.toLowerCase().includes('binori')).slice(0, 5);
      const allRentSample = rentLeaves.slice(0, 3);

      // Fetch transactions for sample accounts
      const txnResults = await Promise.all(
        [...sample, ...allRentSample].slice(0, 5).map(async ({ accountId, name }) => {
          const r = await zohoGet('/reports/accounttransactions', {
            account_id: accountId, from_date: from, to_date: to,
          });
          const txns = r.account_transactions || r.transactions || [];
          const total = txns.reduce((s, t) => s + Math.abs((parseFloat(t.debit_amount || 0) - parseFloat(t.credit_amount || 0))), 0);
          const byMonth = {};
          txns.forEach(t => {
            const ym = (t.date || t.transaction_date || '').slice(0, 7);
            if (ym) byMonth[ym] = (byMonth[ym] || 0) + Math.abs(parseFloat(t.debit_amount || 0) - parseFloat(t.credit_amount || 0));
          });
          return { accountId, name, txnCount: txns.length, total: Math.round(total), byMonth };
        })
      );

      res.json({
        office_rent_leaf_count: rentLeaves.length,
        binori_accounts: sample,
        all_rent_leaves_sample: allRentSample,
        txn_results: txnResults,
      });
    } else if (what === 'acct_match_preview') {
      // Preview the account→(budgetItem,branch) matching that sync-bills-cache uses.
      // Returns a count of matched accounts per branch and sample matched accounts.
      const { coaFull, coaParentIds, getGroupId } = await getCoaData();
      const mappings = await readBudgetMappings();
      const activeBranches2 = BUDGET_BRANCHES.filter(b => b.active !== false && b.zohoBranchId);
      const branchList2 = activeBranches2.slice().sort((a, b) => b.name.length - a.name.length);
      function findBranchId2(name) {
        const lower = name.toLowerCase();
        const normalized = lower.replace(/__+/g, '_');
        for (const b of branchList2) {
          const bLower = b.name.toLowerCase();
          if (lower.includes(bLower)) return b.id;
          if (normalized.includes(bLower.replace(/__+/g, '_'))) return b.id;
          for (const alias of (BRANCH_COA_ALIASES[b.id] || [])) {
            if (lower.includes(alias.toLowerCase())) return b.id;
          }
        }
        return null;
      }
      const nonGroupItemByAcct2 = {};
      for (const [itemId, aids] of Object.entries(mappings)) {
        if (!GROUP_ITEMS[itemId]) aids.forEach(a => { if (!nonGroupItemByAcct2[a]) nonGroupItemByAcct2[a] = itemId; });
      }
      const matched = [], unmatched = [];
      for (const [accountId, acct] of Object.entries(coaFull)) {
        if (coaParentIds.has(accountId)) continue;
        const gid = getGroupId(accountId);
        const budgetItem = gid || nonGroupItemByAcct2[accountId];
        if (!budgetItem) continue;
        const branchId = findBranchId2(acct.name);
        if (branchId) matched.push({ accountId, name: acct.name, budgetItem, branchId });
        else unmatched.push({ accountId, name: acct.name, budgetItem });
      }
      const byBranch = {};
      for (const m of matched) { byBranch[m.branchId] = (byBranch[m.branchId] || 0) + 1; }
      const branchFilter = req.query.branch || '';
      const filteredMatched = branchFilter ? matched.filter(m => m.branchId === branchFilter) : matched;
      res.json({
        totalMatched: matched.length,
        totalUnmatched: unmatched.length,
        byBranch,
        filteredBranch: branchFilter || null,
        filteredMatched: filteredMatched.slice(0, 50),
        sampleUnmatched: unmatched.slice(0, 20),
      });
    } else if (what === 'coa_search') {
      // Search all COA accounts containing a keyword (case-insensitive)
      const { coaFull, coaParentIds, getGroupId } = await getCoaData();
      const keyword = (req.query.kw || '').toLowerCase();
      const hits = [];
      for (const [accountId, acct] of Object.entries(coaFull)) {
        const name = (acct.name || '').toLowerCase();
        if (!keyword || name.includes(keyword)) {
          const gid = getGroupId(accountId);
          hits.push({ accountId, name: acct.name, isParent: coaParentIds.has(accountId), budgetItem: gid || null, parentId: acct.parentId });
        }
      }
      res.json({ count: hits.length, hits: hits.slice(0, 100) });
    } else if (what === 'bills1') {
      // Check how many bills exist in FY 2025-26
      const list = await zohoGet('/bills', { page: 1, per_page: 200, filter_by: 'Status.All', date_start: '2025-04-01', date_end: '2026-03-31' });
      const pageCtx = list.page_context;
      const billId = list.bills?.[0]?.bill_id;
      const detail = billId ? await zohoGet(`/bills/${billId}`, {}) : null;
      res.json({
        total_bills_page1: list.bills?.length,
        page_context: pageCtx,
        bill_list_keys: Object.keys(list.bills?.[0] || {}),
        sample_bill: list.bills?.[0],
        sample_line_items: detail?.bill?.line_items?.slice(0, 2)
      });
    } else if (what === 'coaexpense') {
      // Find expense accounts in COA
      let found = [];
      for (let pg = 1; pg <= 10; pg++) {
        const d = await zohoGet('/chartofaccounts', { page: pg, per_page: 200, account_type: 'expense' });
        const accts = d.chartofaccounts || [];
        if (!accts.length) break;
        found = found.concat(accts.filter(a => a.parent_account_name).map(a => ({ id: a.account_id, name: a.account_name, parent: a.parent_account_name })));
        if (!d.page_context?.has_more_page) break;
      }
      res.json({ count: found.length, sample: found.slice(0, 10) });
    } else if (what === 'billsfy') {
      // Fetch bills sorted by DATE desc — page 1 will have the most recent dates
      const pg = parseInt(req.query.pg || '1');
      const d = await zohoGet('/bills', { page: pg, per_page: 50, filter_by: 'Status.All', sort_column: 'date', sort_order: 'D' });
      const bills = d.bills || [];
      const fyBills = bills.filter(b => b.date >= '2025-04-01' && b.date <= '2026-03-31');
      res.json({
        page: pg, total_in_page: bills.length, fy_bills: fyBills.length,
        sort: d.page_context?.sort_column,
        sample: fyBills.slice(0, 5).map(b => ({
          date: b.date, total: b.total, vendor: b.vendor_name,
          project: b.project_name, cf_project: b.cf_project_name,
          cf_vendor_cat: b.cf_vendor_category, branch: b.branch_name
        })),
        all_dates: bills.slice(0, 10).map(b => b.date)
      });
    } else if (what === 'zoho_branches') {
      // Discover all branch IDs by scanning bills — collect unique branch_id+branch_name pairs
      const branchMap = {};
      for (let pg = 1; pg <= 15; pg++) {
        const d = await zohoGet('/bills', { page: pg, per_page: 200, filter_by: 'Status.All', sort_column: 'created_time', sort_order: 'D' });
        const bills = d.bills || [];
        for (const b of bills) {
          if (b.branch_id && b.branch_name && !branchMap[b.branch_id]) {
            branchMap[b.branch_id] = b.branch_name;
          }
        }
        if (!d.page_context?.has_more_page) break;
        // Stop early if we already have a lot of branches
        if (Object.keys(branchMap).length >= 35) break;
      }
      res.json({ count: Object.keys(branchMap).length, branch_map: branchMap });
    } else if (what === 'branch_pl') {
      // Test P&L API with various branch filter params
      const bid = req.query.branch_id;
      const FROM = req.query.from || '2025-07-01', TO = req.query.to || '2025-07-31', LAKH = 100000;
      // Try different parameter names Zoho might accept for branch filtering
      const paramVariants = [
        { label: 'location_id', params: { from_date: FROM, to_date: TO, location_id: bid } },
        { label: 'branch_id',   params: { from_date: FROM, to_date: TO, branch_id: bid } },
        { label: 'filter_by_location', params: { from_date: FROM, to_date: TO, filter_by: `Location.${bid}` } },
      ];
      if (!bid) {
        // No branch — just test org-wide
        const plResp = await zohoGet('/reports/profitandloss', { from_date: FROM, to_date: TO });
        const acctMap = {};
        function extractLeaves0(node) {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { node.forEach(extractLeaves0); return; }
          if (node.account_id && node.is_child_present === false) {
            const total = parseFloat(node.total || 0) || 0;
            if (total !== 0) acctMap[node.account_id] = (acctMap[node.account_id] || 0) + total;
          }
          for (const v of Object.values(node)) if (typeof v === 'object' && v !== null) extractLeaves0(v);
        }
        extractLeaves0(plResp.profit_and_loss || plResp.profitandloss || plResp);
        const total = Object.values(acctMap).reduce((s, v) => s + v, 0);
        return res.json({ branch_id_used: 'none', total_leaf_accounts: Object.keys(acctMap).length, grand_total_lakhs: Math.round(total / LAKH * 100) / 100 });
      }
      const results = {};
      for (const { label, params } of paramVariants) {
        try {
          const plResp = await zohoGet('/reports/profitandloss', params);
          const acctMap = {};
          function extractLeaves(node) {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) { node.forEach(extractLeaves); return; }
            if (node.account_id && node.is_child_present === false) {
              const total = parseFloat(node.total || 0) || 0;
              if (total !== 0) acctMap[node.account_id] = (acctMap[node.account_id] || 0) + total;
            }
            for (const v of Object.values(node)) if (typeof v === 'object' && v !== null) extractLeaves(v);
          }
          extractLeaves(plResp.profit_and_loss || plResp.profitandloss || plResp);
          const total = Object.values(acctMap).reduce((s, v) => s + v, 0);
          results[label] = { total_leaf_accounts: Object.keys(acctMap).length, grand_total_lakhs: Math.round(total / LAKH * 100) / 100 };
        } catch (e) { results[label] = { error: e.message }; }
      }
      return res.json({ branch_id_tested: bid, from: FROM, to: TO, results });
    } else if (what === 'bills_branches') {
      // Show unique branch names from April 2026 bills
      const FROM = req.query.from || '2026-04-01', TO = req.query.to || '2026-04-30';
      const allBills = [];
      for (let pg = 1; pg <= 10; pg++) {
        const d = await zohoGet('/bills', { page: pg, per_page: 200, filter_by: 'Status.All', date_start: FROM, date_end: TO });
        const bills = (d.bills || []).filter(b => b.date >= FROM && b.date <= TO);
        allBills.push(...bills);
        if (!d.page_context?.has_more_page) break;
      }
      const branchCounts = {};
      for (const b of allBills) {
        const bn = b.branch_name || '(none)';
        branchCounts[bn] = (branchCounts[bn] || 0) + 1;
      }
      res.json({ total: allBills.length, branch_counts: branchCounts, sample_5: allBills.slice(0, 5).map(b => ({ date: b.date, vendor: b.vendor_name, branch_id: b.branch_id, branch_name: b.branch_name })) });
    } else if (what === 'expenses1') {
      // Check expenses list structure - do they have account_id directly?
      const d = await zohoGet('/expenses', { page: 1, per_page: 10, filter_by: 'Status.All' });
      const exp = d.expenses || [];
      res.json({
        keys: Object.keys(exp[0] || {}),
        sample: exp.slice(0, 3).map(e => ({
          date: e.date, total: e.total, account_id: e.account_id, account_name: e.account_name,
          project: e.project_name, amount: e.amount
        }))
      });
    } else if (what === 'grouptotals') {
      // ROOT-level ancestor totals — uses parent_account_id to traverse full hierarchy
      const FROM = '2025-04-01', TO = '2026-03-31', LAKH = 100000;
      const coaFull = {}; // account_id → { name, parentId }
      let pg = 1;
      while (true) {
        const coaData = await zohoGet('/chartofaccounts', { page: pg, per_page: 200 });
        const accts = coaData.chartofaccounts || [];
        if (!accts.length) break;
        for (const a of accts) {
          if (a.account_id) coaFull[a.account_id] = { name: a.account_name, parentId: a.parent_account_id || null };
        }
        if (!coaData.page_context?.has_more_page) break;
        pg++;
      }
      function getRootName(accountId) {
        const visited = new Set();
        let cur = accountId;
        while (cur && coaFull[cur]?.parentId && !visited.has(cur)) { visited.add(cur); cur = coaFull[cur].parentId; }
        return coaFull[cur]?.name || null;
      }
      const tbResp = await zohoGet('/reports/trialbalance', { from_date: FROM, to_date: TO });
      const acctMap = {}, acctNameMap = {};
      function extractTB2(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(extractTB2); return; }
        if (node.account_id) {
          const d = parseFloat(node.net_debit_total || 0) || 0;
          const c = parseFloat(node.net_credit_total || 0) || 0;
          const net = d - c;
          if (net) acctMap[node.account_id] = (acctMap[node.account_id] || 0) + net;
          if (node.name) acctNameMap[node.account_id] = node.name;
        }
        for (const v of Object.values(node)) if (typeof v === 'object') extractTB2(v);
      }
      extractTB2(tbResp.trialbalance || tbResp);
      const rootTotals = {};
      for (const [aid, amt] of Object.entries(acctMap)) {
        const root = getRootName(aid);
        if (root) rootTotals[root] = (rootTotals[root] || 0) + amt;
      }
      const keywords = ['electric', 'brokerage', 'salary', 'wage', 'office rent', 'maintenance', 'professional', 'property tax', 'stamp', 'travel', 'market', 'advertis', 'subscri', 'general', 'cost of good', 'housekeep'];
      const keywordRoots = {};
      for (const [g, v] of Object.entries(rootTotals)) {
        for (const kw of keywords) {
          if (new RegExp(kw, 'i').test(g)) { if (!keywordRoots[kw]) keywordRoots[kw] = []; keywordRoots[kw].push({ root: g, lakhs: Math.round(v / LAKH * 100) / 100 }); break; }
        }
      }
      const allPositiveRoots = Object.entries(rootTotals).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a).slice(0, 60).map(([g, v]) => ({ root: g, lakhs: Math.round(v / LAKH * 100) / 100 }));
      res.json({ coa_accounts: Object.keys(coaFull).length, tb_accounts: Object.keys(acctMap).length, root_groups: Object.keys(rootTotals).length, keyword_roots: keywordRoots, all_positive_roots: allPositiveRoots });
    } else if (what === 'rent_debug') {
      // Show all P&L leaf accounts under 'Office Rent' ancestor with amounts
      const FROM = '2025-04-01', TO = '2026-03-31', LAKH = 100000;
      const coaFull2 = {};
      let cp2 = 1;
      while (true) {
        const d = await zohoGet('/chartofaccounts', { page: cp2, per_page: 200 });
        const accts = d.chartofaccounts || [];
        if (!accts.length) break;
        for (const a of accts) {
          if (a.account_id) coaFull2[a.account_id] = { name: a.account_name || '', parentId: a.parent_account_id || null };
        }
        if (!d.page_context?.has_more_page) break;
        cp2++;
      }
      function getAncestorNames(aid) {
        const chain = []; const visited = new Set();
        let cur = aid;
        while (cur && coaFull2[cur] && !visited.has(cur)) {
          chain.push(coaFull2[cur].name); visited.add(cur); cur = coaFull2[cur].parentId;
        }
        return chain;
      }
      const plR = await zohoGet('/reports/profitandloss', { from_date: FROM, to_date: TO });
      const rentLeaves = [], allLeaves = [];
      function extractRentLeaves(node) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(extractRentLeaves); return; }
        if (node.account_id && node.is_child_present === false) {
          const total = parseFloat(node.total || 0) || 0;
          const ancestors = getAncestorNames(node.account_id);
          const isRent = ancestors.some(n => n === 'Office Rent');
          if (isRent) rentLeaves.push({ name: node.name, total_lakhs: Math.round(total / LAKH * 100) / 100, ancestors: ancestors.slice(0, 5) });
          if (total !== 0) allLeaves.push({ name: node.name, total_lakhs: Math.round(total / LAKH * 100) / 100, is_child_present: node.is_child_present, has_coa_entry: !!coaFull2[node.account_id] });
        }
        for (const v of Object.values(node)) if (typeof v === 'object') extractRentLeaves(v);
      }
      extractRentLeaves(plR.profit_and_loss || plR);
      const positiveRent = rentLeaves.filter(r => r.total_lakhs > 0);
      const negativeRent = rentLeaves.filter(r => r.total_lakhs < 0);
      res.json({
        total_rent_leaves: rentLeaves.length, positive_rent: positiveRent.length, negative_rent: negativeRent.length,
        positive_sum_lakhs: Math.round(positiveRent.reduce((s, r) => s + r.total_lakhs, 0) * 100) / 100,
        negative_sum_lakhs: Math.round(negativeRent.reduce((s, r) => s + r.total_lakhs, 0) * 100) / 100,
        net_lakhs: Math.round(rentLeaves.reduce((s, r) => s + r.total_lakhs, 0) * 100) / 100,
        total_pl_leaves: allLeaves.length,
        positive_rent_sample: positiveRent.slice(0, 20).map(r => ({ name: r.name, lakhs: r.total_lakhs })),
        negative_rent_sample: negativeRent.slice(0, 10).map(r => ({ name: r.name, lakhs: r.total_lakhs, ancestors: r.ancestors })),
      });
    } else if (what === 'pl_tree') {
      // Fetch the actual Zoho P&L and parse every expense line item with amounts
      const FROM = '2025-04-01', TO = '2026-03-31', LAKH = 100000;
      const plResp = await zohoGet('/reports/profitandloss', { from_date: FROM, to_date: TO });
      const lines = [];
      function walkPL(node, path) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(n => walkPL(n, path)); return; }
        // Collect named nodes with a total/amount
        const name = node.name || node.account_name || node.label || node.title || null;
        const amount = parseFloat(node.total || node.amount || node.net || node.closing_balance || 0) || 0;
        const currentPath = name ? [...path, name] : path;
        if (name && amount !== 0) {
          lines.push({ path: currentPath.join(' > '), name, lakhs: Math.round(amount / LAKH * 100) / 100 });
        }
        for (const [k, v] of Object.entries(node)) {
          if (typeof v === 'object' && !['name','account_name','label','title'].includes(k)) {
            walkPL(v, currentPath);
          }
        }
      }
      walkPL(plResp, []);
      // Also show top-level keys
      res.json({
        top_keys: Object.keys(plResp),
        raw_preview: JSON.stringify(plResp).slice(0, 5000),
        parsed_lines: lines.sort((a, b) => Math.abs(b.lakhs) - Math.abs(a.lakhs)).slice(0, 80),
      });
    } else if (what === 'plmatch') {
      // Full P&L-style breakdown: every intermediate COA group with its TB total
      // Use this to cross-reference with Zoho Books P&L export line by line
      const FROM = '2025-04-01', TO = '2026-03-31', LAKH = 100000;

      // Fetch full COA hierarchy (parent_account_id for traversal + parent_account_name for display)
      const coaFull = {}; // account_id → { name, parentId, parentName, depth }
      let pg2 = 1;
      while (true) {
        const coaData = await zohoGet('/chartofaccounts', { page: pg2, per_page: 200 });
        const accts = coaData.chartofaccounts || [];
        if (!accts.length) break;
        for (const a of accts) {
          if (a.account_id) coaFull[a.account_id] = {
            name: a.account_name || '',
            parentId: a.parent_account_id || null,
            parentName: a.parent_account_name || null,
          };
        }
        if (!coaData.page_context?.has_more_page) break;
        pg2++;
      }

      // Fetch TB (paginated)
      const acctMap2 = {};
      let tbPg2 = 1;
      while (true) {
        const tbResp = await zohoGet('/reports/trialbalance', { from_date: FROM, to_date: TO, page: tbPg2 });
        function extractTB3(node) {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { node.forEach(extractTB3); return; }
          if (node.account_id) {
            const d = parseFloat(node.net_debit_total || 0) || 0;
            const c = parseFloat(node.net_credit_total || 0) || 0;
            const net = d - c;
            if (net) acctMap2[node.account_id] = (acctMap2[node.account_id] || 0) + net;
          }
          for (const v of Object.values(node)) if (typeof v === 'object') extractTB3(v);
        }
        extractTB3(tbResp.trialbalance || tbResp);
        if (!tbResp.page_context?.has_more_page) break;
        tbPg2++;
        if (tbPg2 > 20) break;
      }

      // For each account in TB, walk up ancestor chain to get all ancestors
      function getAncestors(accountId) {
        const chain = [];
        const visited = new Set();
        let cur = coaFull[accountId]?.parentId;
        while (cur && coaFull[cur] && !visited.has(cur)) {
          visited.add(cur);
          chain.push({ id: cur, name: coaFull[cur].name });
          cur = coaFull[cur].parentId;
        }
        return chain; // [direct parent, grandparent, ..., root]
      }

      // Build totals keyed by account_name at each level:
      // directParentTotals[parentName] = sum of all TB accounts whose DIRECT parent is parentName
      // ancestorTotals[ancestorName] = sum of all TB accounts that have this anywhere in chain
      const directParentTotals = {};
      const level2Totals = {}; // grandparent level
      for (const [aid, amt] of Object.entries(acctMap2)) {
        if (!coaFull[aid]) continue;
        const directParent = coaFull[aid].parentName;
        if (directParent) directParentTotals[directParent] = (directParentTotals[directParent] || 0) + amt;
        const ancestors = getAncestors(aid);
        if (ancestors[1]) { // grandparent
          const gp = ancestors[1].name;
          level2Totals[gp] = (level2Totals[gp] || 0) + amt;
        }
      }

      // Build root totals
      function getRootName2(accountId) {
        const visited = new Set();
        let cur = accountId;
        while (cur && coaFull[cur]?.parentId && !visited.has(cur)) { visited.add(cur); cur = coaFull[cur].parentId; }
        return coaFull[cur]?.name || null;
      }
      const rootTotals2 = {};
      for (const [aid, amt] of Object.entries(acctMap2)) {
        const root = getRootName2(aid);
        if (root) rootTotals2[root] = (rootTotals2[root] || 0) + amt;
      }

      // Return sorted by amount
      const fmt = (totals) => Object.entries(totals)
        .filter(([, v]) => Math.abs(v) > 0)
        .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
        .map(([name, v]) => ({ name, lakhs: Math.round(v / LAKH * 100) / 100 }));

      res.json({
        tb_accounts: Object.keys(acctMap2).length,
        coa_accounts: Object.keys(coaFull).length,
        root_totals: fmt(rootTotals2),
        direct_parent_totals: fmt(directParentTotals).slice(0, 100),
        level2_totals: fmt(level2Totals).slice(0, 60),
      });
    } else if (what === 'tokeninfo') {
      // Check what scopes the current access token has
      const axios = require('axios');
      const { zohoGet: _z, ...rest } = require('./zoho');
      // Get a fresh token by hitting a known endpoint
      const booksResp = await zohoGet('/organizations', {});
      const token = booksResp ? 'obtained' : 'failed';
      // Try to hit the token info endpoint
      const tokenFile = require('path').join(__dirname, '.token_cache.json');
      const tokenData = await db.readZohoToken(tokenFile);
      const infoResp = await axios.get('https://accounts.zoho.in/oauth/v2/tokeninfo', {
        params: { access_token: tokenData?.token }
      });
      res.json(infoResp.data);
    } else if (what === 'altreports') {
      // Try report paths and capture full error body
      const results = {};
      for (const path of [
        '/reports/trialbalance',
        '/reports/profitandloss',
        '/reports/balancesheet',
        '/reports/cashflow',
        '/reports/generalledger',
      ]) {
        try {
          const d = await zohoGet(path, { from_date: '2025-04-01', to_date: '2026-03-31' });
          results[path] = { status: 200, keys: Object.keys(d) };
        } catch (e) {
          results[path] = { status: e.response?.status, body: e.response?.data, msg: e.message };
        }
      }
      res.json(results);
    } else if (what === 'journal1') {
      // Check journal list structure
      const d = await zohoGet('/journals', { page: 1, per_page: 5 });
      const journals = d.journals || [];
      const jId = journals[0]?.journal_id;
      const detail = jId ? await zohoGet(`/journals/${jId}`, {}) : null;
      res.json({
        list_keys: Object.keys(journals[0] || {}),
        sample_list: journals.slice(0, 3).map(j => ({ id: j.journal_id, date: j.journal_date, total: j.total, project: j.project_name })),
        detail_line_items: detail?.journal?.line_items?.slice(0, 3)
      });
    } else if (what === 'journals_salary') {
      // Test: fetch journals Apr-Jul 2026 to find Vad_Notus salary entries
      const from = req.query.from || '2026-04-01';
      const to   = req.query.to   || '2026-07-31';
      const vadBranchId = '1714732000038832007';
      // Try with filter_by CustomDate
      let d1, d1err;
      try { d1 = await zohoGet('/journals', { filter_by: 'JournalDate.CustomDate', from_date: from, to_date: to, per_page: 20, page: 1 }); }
      catch (e) { d1err = e.message; d1 = {}; }
      // Also try without filter_by (returns latest journals regardless of date)
      let d2, d2err;
      try { d2 = await zohoGet('/journals', { from_date: from, to_date: to, per_page: 20, page: 1 }); }
      catch (e) { d2err = e.message; d2 = {}; }
      const j1 = (d1.journals || d1.journal_details || []);
      const j2 = (d2.journals || d2.journal_details || []);
      // Find any that look like salary
      const salaryKeyword = /salary|wage/i;
      const salaryJournals = j2.filter(j => salaryKeyword.test(j.notes || j.reference_number || ''));
      res.json({
        with_filter_by: { count: j1.length, error: d1err, raw_keys: Object.keys(d1), journals: j1.map(j => ({ id: j.journal_id, date: j.journal_date, ref: j.reference_number, notes: j.notes, branch: j.branch_name, branch_id: j.branch_id, total: j.total })) },
        without_filter_by: { count: j2.length, error: d2err, salary_matches: salaryJournals.length, journals: j2.map(j => ({ id: j.journal_id, date: j.journal_date, ref: j.reference_number, notes: j.notes, branch: j.branch_name, branch_id: j.branch_id, total: j.total })) },
      });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch FY25-26 actuals from Zoho Books to populate Last Yr Annual values.
//
// Primary — P&L Report            : leaf accounts only (exact Zoho P&L match)
// Fallback — Trial Balance        : if P&L fails
// Last resort — Account Txns     : one call per account (parallel)
//
// GROUP_ITEMS: 14 budget items are summed by COA ancestor group name so every
// sub-account is picked up automatically via ancestor-chain traversal.
// HK sub-items keep budget_mappings.json since they share one COA group.
app.post('/api/budget/fetch-fy2526', async (req, res) => {
  const FROM = '2025-04-01';
  const TO   = '2026-03-31';
  const LAKH = 100000;

  try {
    const mappings = await readBudgetMappings();

    // ── Step 1: COA — build full hierarchy map for ancestor-chain traversal ──
    // coaFull[account_id] = { name, parentId } — allows walking up any depth
    const coaFull = {};
    try {
      let coaPage = 1;
      while (true) {
        const coaData = await zohoGet('/chartofaccounts', { page: coaPage, per_page: 200 });
        const accounts = coaData.chartofaccounts || [];
        if (accounts.length === 0) break;
        for (const a of accounts) {
          if (!a.account_id) continue;
          coaFull[a.account_id] = {
            name:     a.account_name || a.name || '',
            parentId: a.parent_account_id || null,
          };
        }
        if (!coaData.page_context?.has_more_page) break;
        coaPage++;
      }
      console.log(`[budget-fy2526] COA: ${Object.keys(coaFull).length} accounts`);
    } catch (coaErr) {
      console.warn(`[budget-fy2526] COA failed: ${coaErr.message}`);
    }

    // Build set of COA parent IDs (accounts that are parents of other accounts)
    // These are GROUP accounts — when they appear as P&L "leaves" they carry section
    // totals/adjustments (like Ind AS 116 reversals), NOT leaf expense amounts.
    const coaParentIds = new Set();
    for (const { parentId } of Object.values(coaFull)) {
      if (parentId) coaParentIds.add(parentId);
    }

    // Build reverse lookup: groupName → groupId (from GROUP_ITEMS)
    const nameToGroupId = {};
    for (const [groupId, names] of Object.entries(GROUP_ITEMS)) {
      for (const name of names) {
        if (!nameToGroupId[name]) nameToGroupId[name] = groupId;
      }
    }

    // Walk up ancestor chain to find the FIRST ancestor matching GROUP_ITEMS
    function getGroupId(accountId) {
      const visited = new Set();
      let cur = accountId;
      while (cur && coaFull[cur] && !visited.has(cur)) {
        const gid = nameToGroupId[coaFull[cur].name];
        if (gid) return gid;
        visited.add(cur);
        cur = coaFull[cur].parentId;
      }
      return null;
    }

    // Also build acctIdsByGroup for Tier-3 fallback (accounts under each GROUP_ITEMS group)
    const acctIdsByGroup = {};
    for (const [aid] of Object.entries(coaFull)) {
      if (coaParentIds.has(aid)) continue; // skip group/parent accounts
      const gid = getGroupId(aid);
      if (gid) {
        if (!acctIdsByGroup[gid]) acctIdsByGroup[gid] = [];
        acctIdsByGroup[gid].push(aid);
      }
    }

    // acctMap: account_id → rupees (positive = expense, negative = income/credit)
    const acctMap = {};
    let source = 'none';

    // P&L extractor: only true leaf accounts (is_child_present===false AND not a COA parent).
    // Skipping COA parent accounts prevents capturing Ind AS 116 section totals/reversals
    // that Zoho posts directly to group accounts (e.g. "Office Rent" = -6,624L).
    function extractPLLeafAccounts(node, out) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(n => extractPLLeafAccounts(n, out)); return; }
      if (node.account_id && node.is_child_present === false && !coaParentIds.has(node.account_id)) {
        const total = parseFloat(node.total || 0) || 0;
        if (total !== 0) out[node.account_id] = (out[node.account_id] || 0) + total;
      }
      for (const v of Object.values(node)) if (typeof v === 'object' && v !== null) extractPLLeafAccounts(v, out);
    }

    // TB extractor (fallback): uses net_debit_total / net_credit_total
    function extractAcctAmounts(node, out) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(n => extractAcctAmounts(n, out)); return; }
      if (node.account_id) {
        const debit  = parseFloat(node.net_debit_total  || node.debit  || node.debit_amount  || 0) || 0;
        const credit = parseFloat(node.net_credit_total || node.credit || node.credit_amount || 0) || 0;
        const net    = (debit || credit) ? (debit - credit)
                     : (parseFloat(node.total || node.closing_balance || node.net || 0) || 0);
        if (net) out[node.account_id] = (out[node.account_id] || 0) + net;
      }
      for (const v of Object.values(node)) if (typeof v === 'object' && v !== null) extractAcctAmounts(v, out);
    }

    // ── Primary: P&L Report (leaf accounts = exact Zoho P&L amounts) ─────────
    try {
      const plResp = await zohoGet('/reports/profitandloss', { from_date: FROM, to_date: TO });
      extractPLLeafAccounts(plResp.profit_and_loss || plResp.profitandloss || plResp, acctMap);
      if (Object.keys(acctMap).length > 0) {
        source = 'pl_report';
        console.log(`[budget-fy2526] Primary P&L: ${Object.keys(acctMap).length} leaf accounts`);
      }
    } catch (e) { console.warn(`[budget-fy2526] P&L: ${e.message}`); }

    // ── Fallback: Trial Balance ───────────────────────────────────────────────
    if (source === 'none') {
      try {
        let tbPage = 1;
        while (true) {
          const tbResp = await zohoGet('/reports/trialbalance', { from_date: FROM, to_date: TO, page: tbPage });
          extractAcctAmounts(tbResp.trial_balance || tbResp.trialbalance || tbResp, acctMap);
          if (!tbResp.page_context?.has_more_page) break;
          tbPage++;
          if (tbPage > 20) break;
        }
        if (Object.keys(acctMap).length > 0) {
          source = 'trial_balance';
          console.log(`[budget-fy2526] Fallback Trial Balance: ${Object.keys(acctMap).length} accounts`);
        }
      } catch (e) { console.warn(`[budget-fy2526] Trial Balance: ${e.message}`); }
    }

    // ── Last resort: P&L for accounts from mappings (old Tier-2 path) ────────
    if (source === 'none') {
      try {
        const plResp2 = await zohoGet('/reports/profitandloss', { from_date: FROM, to_date: TO });
        extractPLLeafAccounts(plResp2.profit_and_loss || plResp2.profitandloss || plResp2, acctMap);
        if (Object.keys(acctMap).length > 0) {
          source = 'pl_report_2';
          console.log(`[budget-fy2526] Last resort P&L: ${Object.keys(acctMap).length} accounts`);
        }
      } catch (e) { console.warn(`[budget-fy2526] Last resort P&L: ${e.message}`); }
    }

    // ── Tier 3: Account Transactions per account (parallel, ~10-30s) ─────────
    // Fetches the net movement for every account in the relevant COA groups
    // and every account in budget_mappings.json. No transaction detail calls needed.
    if (source === 'none') {
      const toFetch = new Set();
      // Add accounts mapped by ancestor-chain (acctIdsByGroup is now keyed by groupId)
      for (const ids of Object.values(acctIdsByGroup)) ids.forEach(id => toFetch.add(id));
      // Add accounts from budget_mappings for items NOT covered by GROUP_ITEMS
      for (const item of BUDGET_ITEMS) {
        if (!GROUP_ITEMS[item.id]) (mappings[item.id] || []).forEach(id => toFetch.add(id));
      }

      const ids = [...toFetch];
      console.log(`[budget-fy2526] Tier-3 Account Transactions: ${ids.length} accounts`);
      const BATCH = 8;
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = await Promise.allSettled(
          ids.slice(i, i + BATCH).map(async (aid) => {
            const r = await zohoGet('/reports/accounttransactions', { account_id: aid, from_date: FROM, to_date: TO });
            const txns = r.account_transactions || r.transactions || [];
            let net = 0;
            for (const t of txns) {
              net += (parseFloat(t.debit_amount || t.debit || 0) || 0)
                   - (parseFloat(t.credit_amount || t.credit || 0) || 0);
            }
            return { aid, net };
          })
        );
        for (const r of batch) {
          if (r.status === 'fulfilled' && r.value.net) acctMap[r.value.aid] = (acctMap[r.value.aid] || 0) + r.value.net;
        }
        if (i + BATCH < ids.length) await new Promise(ok => setTimeout(ok, 300));
      }
      source = 'account_transactions';
    }

    // ── Aggregate account amounts using ancestor-chain group matching ─────────
    // groupTotals[groupId] = total rupees for that budget item
    const groupTotals = {};
    for (const [aid, amt] of Object.entries(acctMap)) {
      const gid = getGroupId(aid);
      if (gid) groupTotals[gid] = (groupTotals[gid] || 0) + amt;
    }
    console.log('[budget-fy2526] group totals (Lakhs):',
      Object.fromEntries(Object.entries(groupTotals).map(([k, v]) => [k, Math.round(v / LAKH * 100) / 100])));

    // ── Compute budget items ─────────────────────────────────────────────────
    const computed = {};
    for (const item of BUDGET_ITEMS) {
      if (GROUP_ITEMS[item.id]) {
        computed[item.id] = Math.round((Math.abs(groupTotals[item.id] || 0) / LAKH) * 100) / 100;
      } else {
        let total = 0;
        (mappings[item.id] || []).forEach(aid => { total += acctMap[aid] || 0; });
        computed[item.id] = Math.round((Math.abs(total) / LAKH) * 100) / 100;
      }
    }
    console.log('[budget-fy2526] computed:', computed);

    // Persist lastYrAnnual into budget_data.json
    const budgetData = await readBudgetData();
    for (const [itemId, val] of Object.entries(computed)) {
      if (!budgetData.assumptions[itemId]) budgetData.assumptions[itemId] = { lastYrAnnual: 0, growthPct: 0 };
      budgetData.assumptions[itemId].lastYrAnnual = val;
    }
    budgetData.lastFetchedAt = new Date().toISOString();
    await writeBudgetData(budgetData);

    res.json({ ok: true, computed, source, fetchedAt: budgetData.lastFetchedAt });
  } catch (e) {
    console.error('[budget-fy2526] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET branch FY actuals (stored result from fetch-branch-fy2526) ────────────
app.get('/api/budget/branch-fy-actuals', async (req, res) => {
  const data = await readBranchFyActuals();
  res.json(data || { branchActuals: {}, fetchedAt: null });
});

// ── In-memory progress state for fetch-branch-fy2526 ──────────────────────────
let _fyFetchProgress = null; // null = idle, object = running or done

// ── GET fetch progress ─────────────────────────────────────────────────────────
app.get('/api/budget/fetch-progress', (req, res) => {
  res.json(_fyFetchProgress || { status: 'idle' });
});

// ── POST fetch-branch-fy2526: per-branch FY 2025-26 annual totals ─────────────
// Budget = branch annual total ÷ 12 × (1 + growth%) = monthly average × growth.
// Strategy: parallel page fetch for bill list (fast), then parallel detail fetches.
// Stores result in budget_branch_fy.json. Typical time: 3-8 minutes.
app.post('/api/budget/fetch-branch-fy2526', async (req, res) => {
  // If already running, return current progress
  if (_fyFetchProgress && _fyFetchProgress.status === 'running') {
    return res.json({ ok: false, message: 'Already running', progress: _fyFetchProgress });
  }

  const FROM = '2025-04-01', TO = '2026-03-31';

  // Load any partial data saved from a previous interrupted run
  const existingData = await readBranchFyActuals();
  const savedActuals = (existingData && !existingData.complete) ? (existingData.branchActuals || {}) : {};
  const savedBranches = new Set(Object.keys(savedActuals));
  const resuming = savedBranches.size > 0;

  _fyFetchProgress = { status: 'running', phase: 'bill_list', startedAt: new Date().toISOString(),
    totalBills: 0, billsPagesLoaded: 0, totalBranches: 0, branchesProcessed: savedBranches.size,
    currentBranch: null, currentBranchBills: 0, currentBranchBillsDone: 0,
    branchLog: resuming ? [...savedBranches].map(id => ({ branch: id, bills: 0, officeRentL: 0, skipped: true })) : [],
    pct: 0, resumedFrom: savedBranches.size };

  // Respond immediately so the caller knows it started; actual work continues async
  res.json({ ok: true, message: resuming ? `Resuming from ${savedBranches.size} saved branches` : 'Fetch started', resumedFrom: savedBranches.size });

  try {
    const { getGroupId } = await getCoaData();
    const mappings = await readBudgetMappings();

    // Step 1: Fast parallel bill list fetch
    _fyFetchProgress.phase = 'bill_list';
    console.log('[branch-fy2526] parallel bill list fetch...');
    const firstResp = await zohoGet('/bills', { date_start: FROM, date_end: TO, per_page: 200, page: 1 });
    let allListBills = firstResp.bills || [];
    _fyFetchProgress.billsPagesLoaded = 1;

    if (firstResp.page_context?.has_more_page) {
      let nextPage = 2;
      let morePages = true;
      while (morePages) {
        const pageNums = Array.from({ length: 8 }, (_, k) => nextPage + k);
        const pageResults = await Promise.allSettled(
          pageNums.map(p => zohoGet('/bills', { date_start: FROM, date_end: TO, per_page: 200, page: p }))
        );
        morePages = false;
        for (const r of pageResults) {
          if (r.status !== 'fulfilled') continue;
          const bills = r.value.bills || [];
          allListBills = allListBills.concat(bills);
          _fyFetchProgress.billsPagesLoaded++;
          if (r.value.page_context?.has_more_page) morePages = true;
        }
        nextPage += 8;
        if (nextPage > 500) break;
        if (morePages) await new Promise(ok => setTimeout(ok, 200));
      }
    }
    const totalBills = allListBills.length;
    _fyFetchProgress.totalBills = totalBills;
    _fyFetchProgress.phase = 'bill_details';
    console.log(`[branch-fy2526] bill list done: ${totalBills} total bills`);

    // Step 2: Group bill_ids by Zoho branch_id
    const billsByZohoBranch = {};
    for (const b of allListBills) {
      if (!b.branch_id) continue;
      if (!billsByZohoBranch[b.branch_id]) billsByZohoBranch[b.branch_id] = [];
      billsByZohoBranch[b.branch_id].push(b.bill_id);
    }

    // Step 3: For each budget branch fetch ALL its bill details in parallel batches
    const eligibleBranches = BUDGET_BRANCHES.filter(b => b.zohoBranchId);
    _fyFetchProgress.totalBranches = eligibleBranches.length;
    // Start with any previously saved branch data (resume support)
    const branchActuals = { ...savedActuals };

    for (const branch of eligibleBranches) {
      // Skip branches already saved from a previous run
      if (savedBranches.has(branch.id)) {
        console.log(`[branch-fy2526] ${branch.name}: skipped (already saved)`);
        continue;
      }

      const billIds = billsByZohoBranch[branch.zohoBranchId] || [];
      _fyFetchProgress.currentBranch = branch.name;
      _fyFetchProgress.currentBranchBills = billIds.length;
      _fyFetchProgress.currentBranchBillsDone = 0;
      _fyFetchProgress.pct = Math.round((_fyFetchProgress.branchesProcessed / eligibleBranches.length) * 100);
      console.log(`[branch-fy2526] ${branch.name}: ${billIds.length} bills`);

      const groupTotals = {};
      const BATCH = 15;
      for (let i = 0; i < billIds.length; i += BATCH) {
        const results = await Promise.allSettled(
          billIds.slice(i, i + BATCH).map(async (billId) => {
            const detail = await zohoGet(`/bills/${billId}`);
            const lineItems = (detail.bill || {}).line_items || [];
            const entries = [];
            for (const li of lineItems) {
              if (!li.account_id) continue;
              const amt = parseFloat(li.item_total || li.amount || 0) || 0;
              if (Math.abs(amt) < 0.01) continue;
              entries.push({ accountId: li.account_id, amt });
            }
            return entries;
          })
        );
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          for (const { accountId, amt } of r.value) {
            const gid = getGroupId(accountId);
            if (gid) {
              groupTotals[gid] = (groupTotals[gid] || 0) + amt;
            } else {
              for (const [itemId, aids] of Object.entries(mappings)) {
                if (!GROUP_ITEMS[itemId] && aids.includes(accountId)) {
                  groupTotals[itemId] = (groupTotals[itemId] || 0) + amt;
                }
              }
            }
          }
        }
        _fyFetchProgress.currentBranchBillsDone = Math.min(i + BATCH, billIds.length);
        if (i + BATCH < billIds.length) await new Promise(ok => setTimeout(ok, 80));
      }

      branchActuals[branch.id] = {};
      for (const item of BUDGET_ITEMS) {
        branchActuals[branch.id][item.id] = Math.round(Math.abs(groupTotals[item.id] || 0) * 100) / 100;
      }
      _fyFetchProgress.branchesProcessed++;
      _fyFetchProgress.pct = Math.round((_fyFetchProgress.branchesProcessed / eligibleBranches.length) * 100);
      const rentL = Math.round((branchActuals[branch.id].office_rent || 0) / 100000);
      _fyFetchProgress.branchLog.push({ branch: branch.name, bills: billIds.length, officeRentL: rentL });
      console.log(`[branch-fy2526] ${branch.name} done: office_rent annual = ${rentL}L`);

      // Incremental save after each branch — marks complete:false so resume logic picks it up
      await writeBranchFyActuals({ fetchedAt: new Date().toISOString(), from: FROM, to: TO, totalBills, complete: false, branchActuals });
    }

    const stored = { fetchedAt: new Date().toISOString(), from: FROM, to: TO, totalBills, complete: true, branchActuals };
    await writeBranchFyActuals(stored);
    _fyFetchProgress.status = 'done';
    _fyFetchProgress.pct = 100;
    _fyFetchProgress.finishedAt = stored.fetchedAt;
    console.log('[branch-fy2526] complete → budget_branch_fy.json');
  } catch (e) {
    _fyFetchProgress.status = 'error';
    _fyFetchProgress.error = e.message;
    console.error('[branch-fy2526] error:', e.message);
  }
});

// ── Shared COA cache (populated on first use) ──────────────────────────────
let _coaCache = null; // { coaFull, coaParentIds, nameToGroupId, getGroupId }
let _coaCacheTime = 0;
const COA_CACHE_TTL = 3600 * 1000; // 1 hour

async function getCoaData() {
  if (_coaCache && Date.now() - _coaCacheTime < COA_CACHE_TTL) return _coaCache;
  const coaFull = {};
  let coaPage = 1;
  while (true) {
    const coaData = await zohoGet('/chartofaccounts', { page: coaPage, per_page: 200 });
    const accounts = coaData.chartofaccounts || [];
    if (accounts.length === 0) break;
    for (const a of accounts) {
      if (!a.account_id) continue;
      coaFull[a.account_id] = { name: a.account_name || a.name || '', parentId: a.parent_account_id || null };
    }
    if (!coaData.page_context?.has_more_page) break;
    coaPage++;
  }
  const coaParentIds = new Set();
  for (const { parentId } of Object.values(coaFull)) { if (parentId) coaParentIds.add(parentId); }
  const nameToGroupId = {};
  for (const [groupId, names] of Object.entries(GROUP_ITEMS)) {
    for (const name of names) { if (!nameToGroupId[name]) nameToGroupId[name] = groupId; }
  }
  function getGroupId(accountId) {
    const visited = new Set(); let cur = accountId;
    while (cur && coaFull[cur] && !visited.has(cur)) {
      const acctName = coaFull[cur].name;
      const gid = nameToGroupId[acctName];
      if (gid) return gid;
      // Prefix match: any "DevX Salaries & Wages_*" account → emp_sal
      if (acctName.startsWith('DevX Salaries & Wages_')) return 'emp_sal';
      visited.add(cur); cur = coaFull[cur].parentId;
    }
    return null;
  }
  _coaCache = { coaFull, coaParentIds, nameToGroupId, getGroupId };
  _coaCacheTime = Date.now();
  console.log(`[coa-cache] loaded ${Object.keys(coaFull).length} accounts`);
  return _coaCache;
}

// Branch P&L — fetch Zoho P&L filtered to a specific branch + date range.
// Returns per-budget-item totals in Rupees for a specific branch + date range.
// Uses /reports/accounttransactions with branch_id filter — queries each COA leaf account
// individually and sums only transactions tagged to this branch. This avoids the P&L API
// branch_id filter bug (which returns org-wide amounts regardless of filter).
// Query params: branchId (our internal id), from (YYYY-MM-DD), to (YYYY-MM-DD)
app.get('/api/budget/branch-pl', async (req, res) => {
  const { branchId, from: FROM, to: TO } = req.query;
  if (!branchId || !FROM || !TO) return res.status(400).json({ error: 'branchId, from, to required' });

  const branch = BUDGET_BRANCHES.find(b => b.id === branchId);
  if (!branch) return res.status(400).json({ error: 'Unknown branchId' });
  if (!branch.zohoBranchId) return res.status(400).json({ error: 'No Zoho branch_id mapped for this branch' });

  const cacheKey = `branch-pl-v2:${branchId}:${FROM}:${TO}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json(hit);

  try {
    const { coaFull, coaParentIds, getGroupId } = await getCoaData();
    const mappings = await readBudgetMappings();

    // Collect all leaf accounts mapped to our budget groups (via ancestor chain)
    const allLeafIds = new Set();
    for (const [aid] of Object.entries(coaFull)) {
      if (coaParentIds.has(aid)) continue; // skip group/parent accounts
      const gid = getGroupId(aid);
      if (gid) allLeafIds.add(aid);
    }
    // Also add accounts from budget_mappings for non-GROUP items
    for (const item of BUDGET_ITEMS) {
      if (!GROUP_ITEMS[item.id]) (mappings[item.id] || []).forEach(id => allLeafIds.add(id));
    }

    // Fetch accounttransactions for each leaf account filtered by branch_id (8 concurrent)
    const acctMap = {};
    const allIds = [...allLeafIds];
    const BATCH = 8;
    for (let i = 0; i < allIds.length; i += BATCH) {
      const results = await Promise.allSettled(
        allIds.slice(i, i + BATCH).map(async (aid) => {
          const r = await zohoGet('/reports/accounttransactions', {
            account_id: aid, from_date: FROM, to_date: TO,
            branch_id: branch.zohoBranchId
          });
          const txns = r.account_transactions || r.transactions || [];
          let net = 0;
          for (const t of txns) {
            net += (parseFloat(t.debit_amount || t.debit || 0) || 0)
                 - (parseFloat(t.credit_amount || t.credit || 0) || 0);
          }
          return { aid, net, txns: txns.length };
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && Math.abs(r.value.net) > 0.01)
          acctMap[r.value.aid] = (acctMap[r.value.aid] || 0) + r.value.net;
      }
      if (i + BATCH < allIds.length) await new Promise(ok => setTimeout(ok, 200));
    }
    console.log(`[branch-pl] ${branch.name} ${FROM}→${TO}: ${Object.keys(acctMap).length}/${allIds.length} accounts had data`);

    // Aggregate by budget group
    const groupTotals = {};
    for (const [aid, amt] of Object.entries(acctMap)) {
      const gid = getGroupId(aid);
      if (gid) groupTotals[gid] = (groupTotals[gid] || 0) + amt;
    }

    // Build computed per BUDGET_ITEM (Rupees)
    const computed = {};
    for (const item of BUDGET_ITEMS) {
      if (GROUP_ITEMS[item.id]) {
        computed[item.id] = Math.round(Math.abs(groupTotals[item.id] || 0) * 100) / 100;
      } else {
        let total = 0;
        (mappings[item.id] || []).forEach(aid => { total += acctMap[aid] || 0; });
        computed[item.id] = Math.round(Math.abs(total) * 100) / 100;
      }
    }

    // Build account-level detail for audit trail
    const detail = {};
    for (const [aid, amt] of Object.entries(acctMap)) {
      if (Math.abs(amt) < 1) continue;
      const gid = getGroupId(aid);
      if (!gid) continue;
      if (!detail[gid]) detail[gid] = [];
      detail[gid].push({ account_id: aid, account_name: coaFull[aid]?.name || aid, amount: Math.round(amt) });
    }

    const result = {
      ok: true, branchId, branchName: branch.name, zohoBranchId: branch.zohoBranchId,
      from: FROM, to: TO, computed, detail,
      accountsQueried: allIds.length, accountsWithData: Object.keys(acctMap).length,
      source: 'account_transactions'
    };
    cache.set(cacheKey, result, 1800);
    res.json(result);
  } catch (e) {
    console.error('[branch-pl] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get actuals for a year-month (e.g. "2026-07")
app.get('/api/budget/actuals/:ym', async (req, res) => {
  const all = await readBudgetActuals();
  res.json(all[req.params.ym] || {});
});

// Save actuals for a year-month (body = { branchId: { itemId: { amount, units?, persons? } } })
app.put('/api/budget/actuals/:ym', async (req, res) => {
  const all = await readBudgetActuals();
  all[req.params.ym] = req.body || {};
  await writeBudgetActuals(all);
  res.json({ ok: true });
});

// ── GET actuals cache (all months × all branches, sourced from P&L API) ───────
app.get('/api/budget/bills-cache', async (req, res) => {
  const c = await readBillsCache();
  res.json(c || { computed: {}, syncedAt: null, syncedMonths: [] });
});

// ── In-memory progress for bills cache sync ────────────────────────────────────
let _billsSyncProgress = null;
let _branchSyncProgress = null;
app.get('/api/budget/bills-sync-progress', (req, res) => {
  res.json(_billsSyncProgress || { status: 'idle' });
});

// ── Quick diagnostic: fetch one bill detail to test Zoho connectivity ─────────
app.get('/api/budget/test-bill', async (req, res) => {
  try {
    const listResp = await zohoGet('/bills', { per_page: 1, page: 1 });
    const bill = (listResp.bills || [])[0];
    if (!bill) return res.json({ ok: false, error: 'No bills found in list' });
    const detail = await zohoGet(`/bills/${bill.bill_id}`);
    res.json({ ok: true, bill_id: bill.bill_id, branch_id: bill.branch_id, branch_name: bill.branch_name, has_detail: !!detail.bill, line_items_count: (detail.bill?.line_items || []).length });
  } catch (e) {
    res.json({ ok: false, error: e.message, zoho_code: e.response?.data?.code, zoho_msg: e.response?.data?.message, http_status: e.response?.status, retry_after: e.response?.headers?.['retry-after'] });
  }
});

// ── POST sync-bills-cache: bills-based branch/month cache ────────────────────
// Strategy: fetch all bills list → client-side filter by bill.branch_id → fetch
// bill details one-at-a-time with delay → aggregate using COA ancestry.
// Rate-safe: BATCH=5 with 5000ms delay = 60 calls/min (right at Zoho's limit).
// If 429 rate-limit is hit mid-sync, waits the retry-after period then continues.
// Full sync (~800 bills) ≈ 15-20 min. If 3000+ bills, may take 50-80 min.
app.post('/api/budget/sync-bills-cache', async (req, res) => {
  if (_billsSyncProgress?.status === 'running') {
    return res.json({ ok: false, message: 'Already running', progress: _billsSyncProgress });
  }

  // Quick Zoho auth check
  try {
    await zohoGet('/settings/currencies');
  } catch (e) {
    const code = e.response?.data?.code;
    const retryAfter = e.response?.headers?.['retry-after'];
    if (e.response?.status === 429) {
      return res.json({ ok: false, message: `Zoho rate-limited (code ${code}). Retry after ${retryAfter}s.`, retry_after_seconds: parseInt(retryAfter || '60', 10) });
    }
    return res.json({ ok: false, message: `Zoho API error: ${e.message}` });
  }

  const existing = await readBillsCache();
  const isIncremental = !!(existing?.syncedAt && existing?.syncedMonths?.length > 0);

  // FY 2026-27: Apr 2026 → Mar 2027 (capped at today)
  const FY_END   = '2027-03-31';
  const todayStr = new Date().toISOString().slice(0, 10);
  const syncTo   = todayStr < FY_END ? todayStr : FY_END;

  const allMonths = [];
  { let d = new Date('2026-04-01T00:00:00Z');
    while (d.toISOString().slice(0, 10) <= syncTo) {
      allMonths.push(d.toISOString().slice(0, 7));
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    }
  }

  const syncedMonths = existing?.syncedMonths || [];
  const monthsToSync = isIncremental
    ? allMonths.filter(m => !syncedMonths.includes(m) || m >= syncTo.slice(0, 7))
    : allMonths;

  monthsToSync.sort((a, b) => b.localeCompare(a)); // most recent first

  const activeBranches = BUDGET_BRANCHES.filter(b => b.active !== false && b.zohoBranchId);

  // zohoBranchId → branch.id (our internal id)
  const zohoIdToInternalId = {};
  for (const b of activeBranches) zohoIdToInternalId[b.zohoBranchId] = b.id;

  const fetchFrom = monthsToSync[monthsToSync.length - 1] + '-01';
  const fetchTo   = syncTo;

  _billsSyncProgress = {
    status: 'running', isIncremental,
    fetchFrom, fetchTo,
    startedAt: new Date().toISOString(),
    phase: 'bill_list',
    totalTasks: 0, doneTasks: 0, pct: 0,
    currentMonth: '', currentBranch: '',
    monthsSeen: [],
    totalBills: 0, billsDone: 0,
  };

  res.json({ ok: true, message: isIncremental
    ? `Incremental sync (${monthsToSync.length} months)`
    : `Full sync (${monthsToSync.length} months) — fetching bills…` });

  try {
    const { getGroupId } = await getCoaData();
    const mappings = await readBudgetMappings();

    // Carry forward existing months
    const computed = {};
    if (existing?.computed) {
      for (const [ym, brData] of Object.entries(existing.computed)) {
        computed[ym] = JSON.parse(JSON.stringify(brData));
      }
    }
    const syncedSet = new Set(syncedMonths.filter(m => !monthsToSync.includes(m)));

    // ── Step 1: Fetch ALL bills list in one paginated pass ─────────────────────
    console.log(`[sync-bills-cache] fetching bill list ${fetchFrom}→${fetchTo}...`);
    const allBills = [];
    let listPage = 1, noMatchPages = 0;

    async function fetchBillsPage(page) {
      while (true) {
        try {
          return await zohoGet('/bills', { filter_by: 'Status.All', per_page: 200, page }, 1);
        } catch (e) {
          if (e.response?.status === 429) {
            const waitSecs = parseInt(e.response.headers?.['retry-after'] || '120', 10) + 15;
            console.warn(`[sync-bills-cache] 429 on list page ${page}, waiting ${waitSecs}s...`);
            _billsSyncProgress.phase = `rate_limit_wait_${waitSecs}s`;
            await new Promise(ok => setTimeout(ok, waitSecs * 1000));
            _billsSyncProgress.phase = 'bill_list';
          } else { throw e; }
        }
      }
    }

    while (listPage <= 150) {
      const d = await fetchBillsPage(listPage);
      const bills = d.bills || [];
      if (!bills.length) break;
      let anyInWindow = false;
      for (const b of bills) {
        if (!b.date) continue;
        if (b.date >= fetchFrom && b.date <= fetchTo) { allBills.push(b); anyInWindow = true; }
      }
      _billsSyncProgress.totalBills = allBills.length;
      if (!d.page_context?.has_more_page) break;
      if (!anyInWindow && bills.every(b => !b.date || b.date < fetchFrom)) {
        noMatchPages++;
        if (noMatchPages >= 3) break;
      } else { noMatchPages = 0; }
      listPage++;
      await new Promise(ok => setTimeout(ok, 400));
    }

    // Deduplicate bill IDs for the months we need
    const billIds = [...new Set(allBills
      .filter(b => b.date && b.branch_id && monthsToSync.includes(b.date.slice(0, 7)))
      .map(b => b.bill_id))];

    _billsSyncProgress.totalBills = billIds.length;
    _billsSyncProgress.phase = 'bill_details';
    console.log(`[sync-bills-cache] ${billIds.length} bills to detail-fetch (${fetchFrom}→${fetchTo})`);

    // Build a quick lookup: bill_id → branch internal_id (from the list)
    const billBranchMap = {};
    for (const b of allBills) {
      if (b.bill_id && b.branch_id) {
        billBranchMap[b.bill_id] = zohoIdToInternalId[b.branch_id] || null;
      }
    }

    // ── Step 2: Fetch bill details SEQUENTIALLY with 1200ms delay ──────────────
    // 1 call/1200ms = 50/min — safely below Zoho's 60/min limit.
    // On 429: wait the retry-after period then continue (don't abort).
    const billDetails = {}; // bill_id → line_items[]

    async function fetchBillDetail(billId) {
      while (true) {
        try {
          const r = await zohoGet(`/bills/${billId}`, {}, 1); // retries=1 to avoid internal double-wait
          billDetails[billId] = (r.bill || {}).line_items || [];
          return;
        } catch (e) {
          if (e.response?.status === 429) {
            const waitSecs = parseInt(e.response.headers?.['retry-after'] || '120', 10) + 15;
            console.warn(`[sync-bills-cache] 429 on bill ${billId}, waiting ${waitSecs}s...`);
            _billsSyncProgress.phase = `rate_limit_wait_${waitSecs}s`;
            await new Promise(ok => setTimeout(ok, waitSecs * 1000));
            _billsSyncProgress.phase = 'bill_details';
            // retry (loop continues)
          } else {
            console.warn(`[sync-bills-cache] skip bill ${billId}: ${e.message}`);
            billDetails[billId] = []; // treat as empty on other errors
            return;
          }
        }
      }
    }

    for (let i = 0; i < billIds.length; i++) {
      await fetchBillDetail(billIds[i]);
      _billsSyncProgress.billsDone = i + 1;
      _billsSyncProgress.pct = Math.round(((i + 1) / Math.max(billIds.length, 1)) * 75);
      if (i + 1 < billIds.length) await new Promise(ok => setTimeout(ok, 1200));
    }

    // ── Step 3: Aggregate per month × branch ───────────────────────────────────
    _billsSyncProgress.phase = 'aggregating';
    const totalTasks = monthsToSync.length * activeBranches.length;
    let doneTasks = 0;

    for (const ym of monthsToSync) {
      _billsSyncProgress.currentMonth = ym;
      computed[ym] = {};

      for (const branch of activeBranches) {
        _billsSyncProgress.currentBranch = branch.name;
        const groupTotals = {};

        // Find bills for this month × branch
        const branchBills = allBills.filter(b =>
          b.date?.slice(0, 7) === ym &&
          zohoIdToInternalId[b.branch_id] === branch.id
        );

        for (const b of branchBills) {
          const lineItems = billDetails[b.bill_id] || [];
          for (const li of lineItems) {
            if (!li.account_id) continue;
            const amt = parseFloat(li.item_total || li.amount || 0) || 0;
            if (Math.abs(amt) < 0.01) continue;
            const gid = getGroupId(li.account_id);
            if (gid) {
              groupTotals[gid] = (groupTotals[gid] || 0) + amt;
            } else {
              for (const [itemId, aids] of Object.entries(mappings)) {
                if (!GROUP_ITEMS[itemId] && aids.includes(li.account_id)) {
                  groupTotals[itemId] = (groupTotals[itemId] || 0) + amt;
                  break;
                }
              }
            }
          }
        }

        const branchData = {};
        for (const item of BUDGET_ITEMS) {
          branchData[item.id] = Math.round(Math.abs(groupTotals[item.id] || 0) * 100) / 100;
        }
        computed[ym][branch.id] = branchData;

        doneTasks++;
        _billsSyncProgress.doneTasks = doneTasks;
        _billsSyncProgress.pct = 75 + Math.round((doneTasks / totalTasks) * 25);
      }

      syncedSet.add(ym);
      _billsSyncProgress.monthsSeen = [...syncedSet].sort();
      await writeBillsCache({ syncedAt: new Date().toISOString(), syncedMonths: [...syncedSet], complete: false, computed });
    }

    const finalData = {
      syncedAt: new Date().toISOString(),
      syncedMonths: [...syncedSet].sort(),
      complete: true,
      computed,
    };
    await writeBillsCache(finalData);
    _billsSyncProgress.status = 'done';
    _billsSyncProgress.pct = 100;
    _billsSyncProgress.finishedAt = finalData.syncedAt;
    console.log(`[sync-bills-cache] done — ${billIds.length} bills, ${monthsToSync.length} months`);
  } catch (e) {
    _billsSyncProgress.status = 'error';
    _billsSyncProgress.error = e.message;
    console.error('[sync-bills-cache] error:', e.message);
  }
});

// ── P&L expected values from Zoho Books (verified manually from screenshots) ──
// These are the source-of-truth figures per branch × month × budget item.
// Used for cross-verification after bill sync.
const PNL_EXPECTED = {
  'amd_binori_b_square_3': {
    '2026-04': { office_rent: 12012008.21, elec_util: 1371850.00, hk_materials: 38340.00,   hk_service: 598788.30, internet: 367330.00, security: 60200.00,    tea_coffee: 176006.00, repairs: 160470.00,   prop_maint: 657620.00, emp_sal: 168812.34, brokerage: 54574.00, prop_tax: 0.00,       subscr: 3389.20  },
    '2026-05': { office_rent: 12032903.21, elec_util: 2089180.00, hk_materials: 21586.72,   hk_service: 615052.19, internet: 180330.00, security: 439213.50,  tea_coffee: 168006.00, repairs: 686399.87,  prop_maint: 657620.00, emp_sal: 238514.80, brokerage: 33094.00, prop_tax: 0.00,       subscr: 6070.61  },
    '2026-06': { office_rent: 12216615.21, elec_util: 1468800.00, hk_materials: 135441.70,  hk_service: 679521.95, internet: 0.00,       security: 433548.45,  tea_coffee: 503756.00, repairs: 842755.00,  prop_maint: 657620.00, emp_sal: 444237.32, brokerage: 33094.00, prop_tax: 0.00,       subscr: 15475.30 },
    '2026-07': { office_rent: 12304724.21, elec_util: 2253700.00, hk_materials: 286112.78,  hk_service: 652857.29, internet: 297850.00,  security: 617861.44,  tea_coffee: 307116.00, repairs: 65265.00,   prop_maint: 0.00,      emp_sal: 0.00,      brokerage: 33094.00, prop_tax: 5617837.00, subscr: 7028.90  },
  },
  'amd_the_first_c_2nd': {
    '2026-04': { office_rent: 6282359.00, elec_util: 492850.00, hk_materials: 141894.10, hk_service: 382099.82, internet: 57380.00, security: 58561.80, tea_coffee: 206000.00, repairs: 86644.00, prop_maint: 101100.00 },
    '2026-05': { office_rent: 10106359.00, elec_util: 379480.00, hk_materials: 135130.98, hk_service: 422312.84, internet: 57380.00, security: 58561.80, tea_coffee: 187600.00, repairs: 660031.00, prop_maint: 101100.00 },
    '2026-06': { office_rent: 6330786.00, elec_util: 314210.00, hk_materials: 15850.00, hk_service: 441470.91, internet: 57380.00, security: 58562.10, tea_coffee: 217080.00, repairs: 574711.00, prop_maint: 101100.00 },
    '2026-07': { office_rent: 5846709.00, elec_util: 857000.00, hk_materials: 122155.49, hk_service: 494624.96, internet: 0.00, security: 0.00, tea_coffee: 0.00, repairs: 97250.00, prop_maint: 101100.00 },
  },
  'vad_notus_d_10th_11th': {
    '2026-04': { office_rent: 1682967.00, elec_util: 635345.00, hk_materials: 33294.45, hk_service: 147441.90, internet: 106850.00, security: 120400.00, tea_coffee: 113650.00, repairs: 0.00, prop_maint: 0.00, emp_sal: 1843105.97, brokerage: 0.00 },
    '2026-05': { office_rent: 1632589.00, elec_util: 0.00,      hk_materials: 42582.00,  hk_service: 146148.01, internet: 106850.00, security: 120400.00, tea_coffee: 94105.00,  repairs: 55500.00,  prop_maint: 0.00, emp_sal: 1721675.99, brokerage: 138240.00 },
    '2026-06': { office_rent: 1525626.00, elec_util: 0.00,      hk_materials: 41726.90,  hk_service: 146982.33, internet: 0.00,       security: 120400.00, tea_coffee: 126040.00, repairs: 87183.00,  prop_maint: 0.00, emp_sal: 1696081.63, brokerage: 0.00 },
    '2026-07': { office_rent: 1915866.00, elec_util: 811873.00, hk_materials: 38626.85,  hk_service: 159372.83, internet: 0.00,       security: 0.00,      tea_coffee: 104700.00, repairs: 104137.50, prop_maint: 0.00, emp_sal: 1809821.28, brokerage: 153316.50 },
  },
  'udai_paras_prime_5th': {
    '2026-04': { office_rent: 360000.00, elec_util: 119671.00, hk_materials: 2000.00,    hk_service: 101000.00, internet: 87710.00, security: 46280.00,   tea_coffee: 22620.00, repairs: 0.00,      prop_maint: 80000.00, emp_sal: 98843.00,     brokerage: 0.00 },
    '2026-05': { office_rent: 360000.00, elec_util: 130058.00, hk_materials: 25190.38,   hk_service: 99506.32,  internet: 18960.00, security: 46039.80,   tea_coffee: 18159.00, repairs: 0.00,      prop_maint: 40000.00, emp_sal: 125776.00,    brokerage: 0.00 },
    '2026-06': { office_rent: 360000.00, elec_util: 122813.97, hk_materials: 2000.00,    hk_service: 104885.42, internet: 0.00,     security: 0.00,        tea_coffee: 25675.00, repairs: 58921.90,  prop_maint: 40000.00, emp_sal: 154681.34,    brokerage: 0.00 },
    '2026-07': { office_rent: 0.00,      elec_util: 116510.23, hk_materials: 24224.00,   hk_service: 25820.00,  internet: 18960.00, security: 0.00,        tea_coffee: 42843.50, repairs: 0.00,      prop_maint: 40000.00, emp_sal: 107724.28,    brokerage: 26400.00 },
  },
  'vad_ishan_block_f': {
    '2026-04': { office_rent: 2292735.00, elec_util: 685917.00, hk_materials: 48209.90,  hk_service: 167071.24, internet: 48400.00, security: 150500.00,  tea_coffee: 75504.00,  repairs: -15650.00, prop_maint: 0.00, prop_tax: 0.00,       emp_sal: 107866.00,    brokerage: 30221.13 },
    '2026-05': { office_rent: 2292735.00, elec_util: 0.00,      hk_materials: 64025.11,  hk_service: 187009.34, internet: 48400.00, security: 150500.00,  tea_coffee: 80634.00,  repairs: 163600.00, prop_maint: 0.00, prop_tax: 0.00,       emp_sal: 111866.66,    brokerage: 30221.13 },
    '2026-06': { office_rent: 2292735.00, elec_util: 0.00,      hk_materials: 59022.85,  hk_service: 184159.03, internet: 0.00,     security: 149529.03,  tea_coffee: 122789.00, repairs: 62773.00,  prop_maint: 0.00, prop_tax: 174101.44,  emp_sal: 109866.66,    brokerage: 30221.13 },
    '2026-07': { office_rent: 2292735.00, elec_util: 734739.00, hk_materials: 50312.84,  hk_service: 190773.11, internet: 0.00,     security: 150500.00,  tea_coffee: 167305.00, repairs: 42019.16,  prop_maint: 0.00, prop_tax: 0.00,       emp_sal: 0.00,         brokerage: 30221.13 },
  },
  'surat_stalwart_3rd': {
    '2026-04': { office_rent: 666990.98, elec_util: 0.00,      hk_materials: 3929.00,      hk_service: 108094.74, internet: 16680.00, security: 60200.00, tea_coffee: 22680.00, repairs: 0.00, prop_maint: 0.00, emp_sal: 0.00, brokerage: 0.00 },
    '2026-05': { office_rent: 666990.98, elec_util: 68575.02,  hk_materials: 481929.79,    hk_service: 102106.59, internet: 16680.00, security: 60200.00, tea_coffee: 28798.00, repairs: 0.00, prop_maint: 0.00, emp_sal: 0.00, brokerage: 0.00 },
    '2026-06': { office_rent: 666990.98, elec_util: 94698.42,  hk_materials: 11836.00,     hk_service: 109955.44, internet: 0.00,     security: 60200.00, tea_coffee: 32486.00, repairs: 0.00, prop_maint: 0.00, emp_sal: 0.00, brokerage: 0.00 },
    '2026-07': { office_rent: 666990.98, elec_util: 24968.00,  hk_materials: 201185.57,    hk_service: 0.00,      internet: 0.00,     security: 0.00,     tea_coffee: 29630.00, repairs: 0.00, prop_maint: 0.00, emp_sal: 0.00, brokerage: 0.00 },
  },
  'pun_next_gen_4th_5th': {
    '2026-04': { office_rent: 2534700.00, elec_util: 429840.00, hk_materials: 18140.00, hk_service: 168625.26, internet: 144750.00, security: 123544.00,   tea_coffee: 26300.00, repairs: 0.00, prop_maint: 268380.00, emp_sal: 0.00, brokerage: 0.00 },
    '2026-05': { office_rent: 2534700.00, elec_util: 448120.00, hk_materials: 27374.00, hk_service: 141865.17, internet: 19750.00,  security: 123544.00,   tea_coffee: 40781.00, repairs: 0.00, prop_maint: 268380.00, emp_sal: 0.00, brokerage: 0.00 },
    '2026-06': { office_rent: 2534700.00, elec_util: 531280.00, hk_materials: 28498.00, hk_service: 155428.50, internet: 0.00,      security: 127529.29,   tea_coffee: 39845.00, repairs: 0.00, prop_maint: 268380.00, emp_sal: 0.00, brokerage: 0.00 },
    '2026-07': { office_rent: 2534700.00, elec_util: 495520.00, hk_materials: 33771.00, hk_service: 0.00,      internet: 0.00,      security: 0.00,        tea_coffee: 52400.00, repairs: 0.00, prop_maint: 268380.00, emp_sal: 0.00, brokerage: 0.00 },
  },
  'pun_mccia_6th': {
    '2026-04': { office_rent: 2221112.00, elec_util: 502348.10, hk_materials: 7492.00,  hk_service: 110042.06, internet: 50000.00, security: 61772.00,   tea_coffee: 23503.00, repairs: 0.00,      prop_maint: 344435.00, emp_sal: 61981.00,    brokerage: 102541.00 },
    '2026-05': { office_rent: 2221112.00, elec_util: 547896.38, hk_materials: 10802.00, hk_service: 111223.40, internet: 0.00,     security: 61772.00,   tea_coffee: 24079.00, repairs: 0.00,      prop_maint: 344435.00, emp_sal: 73274.99,    brokerage: 102541.00 },
    '2026-06': { office_rent: 2221112.00, elec_util: 350100.00, hk_materials: 9821.00,  hk_service: 117387.41, internet: 0.00,     security: 63764.65,   tea_coffee: 25279.00, repairs: 101670.00, prop_maint: 344435.00, emp_sal: 70291.99,    brokerage: 102541.00 },
    '2026-07': { office_rent: 2262931.00, elec_util: 692420.13, hk_materials: 8695.00,  hk_service: 0.00,      internet: 0.00,     security: 61772.00,   tea_coffee: 24779.00, repairs: 0.00,      prop_maint: 344435.00, emp_sal: 66149.98,    brokerage: 102541.00 },
  },
  'pun_amar_busi_13th': {
    '2026-04': { office_rent: 1648486.00, elec_util: 282080.00, hk_materials: 12809.00, hk_service: 74048.48,  internet: 15800.00, security: 61772.00,   tea_coffee: 22600.00, repairs: 0.00,    prop_maint: 162732.00, emp_sal: 85634.00,    brokerage: 0.00 },
    '2026-05': { office_rent: 1648486.00, elec_util: 324840.00, hk_materials: 15920.00, hk_service: 75881.37,  internet: 103300.00,security: 61772.00,   tea_coffee: 18435.00, repairs: 0.00,    prop_maint: 162732.00, emp_sal: 119066.66,   brokerage: 0.00 },
    '2026-06': { office_rent: 1648486.00, elec_util: 331100.00, hk_materials: 17997.00, hk_service: 64884.07,  internet: 0.00,     security: 63764.65,   tea_coffee: 23471.00, repairs: 50965.00, prop_maint: 162732.00, emp_sal: 106566.66,   brokerage: 0.00 },
    '2026-07': { office_rent: 1648486.00, elec_util: 317410.00, hk_materials: 18507.00, hk_service: 0.00,      internet: 0.00,     security: 61772.00,   tea_coffee: 20810.00, repairs: 0.00,    prop_maint: 162732.00, emp_sal: 96066.66,    brokerage: 0.00 },
  },
  'raj_om9_square': {
    '2026-04': { office_rent: 0.00, elec_util: 0.00, hk_materials: 19976.70, hk_service: 102167.66, internet: 21450.00, security: 90300.00,  tea_coffee: 29440.00, repairs: 0.00,     prop_maint: 0.00, emp_sal: 28200.00,    brokerage: 0.00, subscr: 194.94  },
    '2026-05': { office_rent: 0.00, elec_util: 0.00, hk_materials: 9043.24,  hk_service: 104372.02, internet: 21450.00, security: 90300.00,  tea_coffee: 34878.00, repairs: 0.00,     prop_maint: 0.00, emp_sal: 24561.29,    brokerage: 0.00, subscr: 194.94  },
    '2026-06': { office_rent: 0.00, elec_util: 0.00, hk_materials: 6050.00,  hk_service: 106577.38, internet: 21450.00, security: 90300.00,  tea_coffee: 45730.00, repairs: 41203.00, prop_maint: 0.00, emp_sal: 50383.34,    brokerage: 0.00, subscr: 172.63  },
    '2026-07': { office_rent: 0.00, elec_util: 0.00, hk_materials: 6050.00,  hk_service: 0.00,      internet: 0.00,     security: 180600.00, tea_coffee: 29126.00, repairs: 0.00,     prop_maint: 0.00, emp_sal: 58450.00,    brokerage: 0.00, subscr: 863.27  },
  },
  'amd_the_first_10th': {
    '2026-04': { office_rent: 2602697.22, elec_util: 403120.00, hk_materials: 0.00, hk_service: 0.00, internet: 40550.00,  security: 58560.00,   tea_coffee: 0.00, repairs: 183360.00, prop_maint: 100800.00, emp_sal: 70688.00,    brokerage: 0.00 },
    '2026-05': { office_rent: 2602697.22, elec_util: 430640.00, hk_materials: 0.00, hk_service: 0.00, internet: 60300.00,  security: 58561.80,   tea_coffee: 0.00, repairs: 0.00,      prop_maint: 100800.00, emp_sal: 72208.00,    brokerage: 0.00 },
    '2026-06': { office_rent: 2602697.22, elec_util: 438230.00, hk_materials: 0.00, hk_service: 0.00, internet: 20800.00,  security: 58562.10,   tea_coffee: 0.00, repairs: 11431.00,  prop_maint: 100800.00, emp_sal: 49516.65,   brokerage: 0.00 },
    '2026-07': { office_rent: 2677427.90, elec_util: 439950.00, hk_materials: 0.00, hk_service: 0.00, internet: 20800.00,  security: 27330.64,   tea_coffee: 0.00, repairs: 0.00,      prop_maint: 100800.00, emp_sal: 0.00,        brokerage: 0.00 },
  },
  'amd_sci_city_3rd': {
    '2026-04': { office_rent: 333334.00, elec_util: 0.00, hk_materials: 0.00, hk_service: 0.00, internet: 0.00, security: 0.00, tea_coffee: 0.00, repairs: 0.00, prop_maint: 0.00, emp_sal: 0.00, brokerage: 0.00 },
    '2026-05': { office_rent: 333334.00, elec_util: 0.00, hk_materials: 0.00, hk_service: 0.00, internet: 0.00, security: 0.00, tea_coffee: 0.00, repairs: 0.00, prop_maint: 0.00, emp_sal: 0.00, brokerage: 0.00 },
    '2026-06': { office_rent: 333334.00, elec_util: 0.00, hk_materials: 0.00, hk_service: 0.00, internet: 0.00, security: 0.00, tea_coffee: 0.00, repairs: 0.00, prop_maint: 0.00, emp_sal: 0.00, brokerage: 0.00 },
    '2026-07': { office_rent: 333334.00, elec_util: 0.00, hk_materials: 0.00, hk_service: 0.00, internet: 0.00, security: 0.00, tea_coffee: 0.00, repairs: 0.00, prop_maint: 0.00, emp_sal: 0.00, brokerage: 0.00 },
  },
  'amd_gift_city': {
    '2026-04': { office_rent: 1413942.00, elec_util: 534124.00, hk_materials: 45209.68, hk_service: 455626.30, internet: 321500.00, security: 243023.00,   tea_coffee: 38292.00, repairs: 179957.50, prop_maint: 0.00, emp_sal: 121022.00, brokerage: 317108.33 },
    '2026-05': { office_rent: 1413942.00, elec_util: 623812.00, hk_materials: 49932.42, hk_service: 431975.01, internet: 334000.00, security: 243023.00,   tea_coffee: 50152.00, repairs: 215625.00, prop_maint: 0.00, emp_sal: 125508.00, brokerage: 225118.33 },
    '2026-06': { office_rent: 1413942.00, elec_util: 793642.00, hk_materials: 47754.91, hk_service: 417298.89, internet: 333000.00, security: 243023.00,   tea_coffee: 54702.00, repairs: 234342.00, prop_maint: 0.00, emp_sal: 123266.00, brokerage: 225118.33 },
    '2026-07': { office_rent: 1413942.00, elec_util: 1039826.00,hk_materials: 42664.78, hk_service: 0.00,       internet: 153000.00, security: 243097.10,   tea_coffee: 31490.00, repairs: 161706.25, prop_maint: 0.00, emp_sal: 123266.00, brokerage: 225118.33 },
  },
  'amd_the_first_11th': {
    '2026-04': { office_rent: 895221.00, elec_util: 165900.00,  hk_materials: 9500.00,  hk_service: 163854.28, internet: 27650.00,  security: 120400.00,   tea_coffee: 0.00, repairs: 65440.00,  prop_maint: 76950.00, emp_sal: 219782.97, subscr: 793.12    },
    '2026-05': { office_rent: 895221.00, elec_util: 197170.00,  hk_materials: 0.00,     hk_service: 186637.00, internet: 27650.00,  security: 178961.80,   tea_coffee: 0.00, repairs: 0.00,      prop_maint: 76950.00, emp_sal: 247982.66, subscr: 2267.87   },
    '2026-06': { office_rent: 895221.00, elec_util: 219620.00,  hk_materials: 0.00,     hk_service: 176348.32, internet: 27650.00,  security: 58562.10,    tea_coffee: 0.00, repairs: 53393.00,  prop_maint: 76950.00, emp_sal: 119166.68, subscr: 23389.72  },
    '2026-07': { office_rent: 895221.00, elec_util: 220710.00,  hk_materials: 0.00,     hk_service: 161648.92, internet: 0.00,      security: 396685.13,   tea_coffee: 0.00, repairs: 0.00,      prop_maint: 76950.00, emp_sal: 113534.31, subscr: 974.68    },
  },
  'amd_the_first_a03': {
    '2026-04': { office_rent: 574645.00, elec_util: 111690.00,  hk_materials: 0.00, hk_service: 0.00, internet: 55590.00,    security: 0.00, tea_coffee: 0.00, repairs: 0.00,     prop_maint: 37230.00, emp_sal: 183934.00    },
    '2026-05': { office_rent: 574645.00, elec_util: 127220.00,  hk_materials: 0.00, hk_service: 0.00, internet: 63991.10,   security: 0.00, tea_coffee: 0.00, repairs: 42000.00,  prop_maint: 37230.00, emp_sal: 180982.99    },
    '2026-06': { office_rent: 574645.00, elec_util: 135930.00,  hk_materials: 0.00, hk_service: 0.00, internet: 62090.00,   security: 0.00, tea_coffee: 0.00, repairs: 0.00,      prop_maint: 37230.00, emp_sal: 229690.99    },
    '2026-07': { office_rent: 574645.00, elec_util: 137550.00,  hk_materials: 0.00, hk_service: 0.00, internet: 45500.00,   security: 0.00, tea_coffee: 0.00, repairs: 0.00,      prop_maint: 37230.00, emp_sal: 183649.99    },
  },
  'amd_the_first_a_6th': {
    '2026-04': { office_rent: 361200.00, elec_util: 0.00,       hk_materials: 0.00, hk_service: 0.00, internet: 7900.00,    security: 0.00, tea_coffee: 0.00, repairs: 0.00,     prop_maint: 66482.00, brokerage: 0.00       },
    '2026-05': { office_rent: 361200.00, elec_util: 82180.00,   hk_materials: 0.00, hk_service: 0.00, internet: 7900.00,    security: 0.00, tea_coffee: 0.00, repairs: 27300.00,  prop_maint: 25890.00, brokerage: 700000.00  },
    '2026-06': { office_rent: 361200.00, elec_util: 123200.00,  hk_materials: 0.00, hk_service: 0.00, internet: 7900.00,    security: 0.00, tea_coffee: 0.00, repairs: 0.00,      prop_maint: 25890.00, brokerage: -680000.00 },
    '2026-07': { office_rent: 361200.00, elec_util: 202070.00,  hk_materials: 0.00, hk_service: 0.00, internet: 0.00,       security: 0.00, tea_coffee: 0.00, repairs: 0.00,      prop_maint: 25890.00, brokerage: 20000.00   },
  },
  'amd_capital_one': {
    '2026-04': { office_rent: 2483250.00, elec_util: 1287730.00, hk_materials: 14050.00,    hk_service: 0.00,       internet: 392450.00,   security: 0.00, tea_coffee: 0.00,      repairs: 0.00,   prop_maint: 0.00, emp_sal: 0.00, brokerage: 154981.00,   prop_tax: 743918.00,  subscr: 0.00,   mkt_promo: 0.00     },
    '2026-05': { office_rent: 6772500.00, elec_util: 1642370.00, hk_materials: 105971.55,   hk_service: 0.00,       internet: 447687.29,   security: 0.00, tea_coffee: 191390.00, repairs: 0.00,   prop_maint: 0.00, emp_sal: 0.00, brokerage: 4846153.00,  prop_tax: 743918.00,  subscr: 0.00,   mkt_promo: 0.00     },
    '2026-06': { office_rent: 6772500.00, elec_util: 2320250.00, hk_materials: 135914.00,   hk_service: 0.00,       internet: 0.00,        security: 0.00, tea_coffee: 536997.00, repairs: 420.00, prop_maint: 0.00, emp_sal: 0.00, brokerage: 680983.00,   prop_tax: 743918.00,  subscr: 116.96, mkt_promo: 30100.00 },
    '2026-07': { office_rent: 9603842.00, elec_util: 2205820.00, hk_materials: 122187.12,   hk_service: 782455.74,  internet: 212500.00,   security: 0.00, tea_coffee: 0.00,      repairs: 35000.00, prop_maint: 0.00, emp_sal: 0.00, brokerage: 196738.00, prop_tax: 9670934.00, subscr: 250.63, mkt_promo: 8000.00  },
  },
  'hyd_laxmi_pinnacle': {
    '2026-04': { office_rent: 1294594.00, elec_util: 0.00,       hk_materials: 17102.00,  hk_service: 194105.00, internet: 157500.00, security: 113090.00, tea_coffee: 29392.00, repairs: 0.00,     prop_maint: 293324.00, emp_sal: 0.00, brokerage: 257674.07 },
    '2026-05': { office_rent: 1319447.00, elec_util: 213835.00,  hk_materials: 17102.00,  hk_service: 198265.00, internet: 157500.00, security: 116738.00, tea_coffee: 32848.00, repairs: 0.00,     prop_maint: 299064.00, emp_sal: 0.00, brokerage: 89775.00  },
    '2026-06': { office_rent: 1319447.00, elec_util: 238787.00,  hk_materials: 20925.73,  hk_service: 204565.00, internet: 0.00,      security: 116860.00, tea_coffee: 43500.00, repairs: 48000.00, prop_maint: 299064.00, emp_sal: 0.00, brokerage: 89775.00  },
    '2026-07': { office_rent: 1319447.00, elec_util: 191984.00,  hk_materials: 111883.00, hk_service: 197965.00, internet: 157500.00, security: 113090.00, tea_coffee: 28716.00, repairs: 0.00,     prop_maint: 299064.00, emp_sal: 0.00, brokerage: 0.00      },
  },
  'hyd_purva_summit_4th': {
    '2026-04': { office_rent: 4630500.00, elec_util: 0.00,       hk_materials: 36042.00,  hk_service: 205224.00, internet: 233100.00, security: 54756.00,  tea_coffee: 32950.00,  repairs: 0.00,       prop_maint: 0.00,      emp_sal: 221851.01, brokerage: 129735.00 },
    '2026-05': { office_rent: 4630500.00, elec_util: 297692.00,  hk_materials: 38271.00,  hk_service: 211403.00, internet: 233100.00, security: 56523.00,  tea_coffee: 76700.00,  repairs: 0.00,       prop_maint: 0.00,      emp_sal: 164490.79, brokerage: 129735.00 },
    '2026-06': { office_rent: 4630500.00, elec_util: 239278.00,  hk_materials: 31717.00,  hk_service: 208800.00, internet: 233100.00, security: 56581.00,  tea_coffee: 67900.00,  repairs: 111420.47,  prop_maint: 98210.00,  emp_sal: 120774.66, brokerage: 129735.00 },
    '2026-07': { office_rent: 4630500.00, elec_util: 218477.00,  hk_materials: 11742.00,  hk_service: 205492.00, internet: 233100.00, security: 54756.00,  tea_coffee: 71400.00,  repairs: 35000.00,   prop_maint: 85206.00,  emp_sal: 115785.41, brokerage: 129735.00 },
  },
  'ind_nrk_busi_park': {
    '2026-04': { office_rent: 861299.00, elec_util: 204849.00,    hk_materials: 13696.90,  hk_service: 102382.10, internet: 107355.00, security: 43411.78, tea_coffee: 30865.00,   repairs: 3500.00,    prop_maint: 154592.00, emp_sal: 103956.29 },
    '2026-05': { office_rent: 861299.00, elec_util: 220671.10,    hk_materials: 36929.45,  hk_service: 99826.31,  internet: 29230.00,  security: 43411.80, tea_coffee: 35977.50,   repairs: 0.00,       prop_maint: 154592.00, emp_sal: 79641.34  },
    '2026-06': { office_rent: 861299.00, elec_util: 231145.42,    hk_materials: 4232.00,   hk_service: 101764.39, internet: 62500.00,  security: 43411.78, tea_coffee: 38305.00,   repairs: 150635.00,  prop_maint: 154592.00, emp_sal: 141901.34 },
    '2026-07': { office_rent: 861299.00, elec_util: 211657.18,    hk_materials: 22292.25,  hk_service: 204764.20, internet: 68750.00,  security: 43411.80, tea_coffee: 37840.00,   repairs: 0.00,       prop_maint: 154592.00, emp_sal: 64533.35  },
  },
  'jai_fort_anand_5th': {
    '2026-04': { office_rent: 1187723.00, elec_util: 0.00,       hk_materials: 9637.80,   hk_service: 112484.10, internet: 83700.00,  security: 92560.00,   tea_coffee: 34832.00, repairs: 0.00,      prop_maint: 208373.00, emp_sal: 126330.00,   subscr: 6283.33 },
    '2026-05': { office_rent: 1187723.00, elec_util: 184083.00,  hk_materials: 9632.00,   hk_service: 110390.43, internet: 22850.00,  security: 88242.95,   tea_coffee: 32828.00, repairs: 0.00,      prop_maint: 208373.00, emp_sal: 138923.45,   subscr: 0.00    },
    '2026-06': { office_rent: 1187723.00, elec_util: 202631.00,  hk_materials: 16618.57,  hk_service: 113585.73, internet: 14950.00,  security: 92560.00,   tea_coffee: 29558.00, repairs: 99236.00,  prop_maint: 208373.00, emp_sal: 109033.35,   subscr: 0.00    },
    '2026-07': { office_rent: 1187723.00, elec_util: 187058.00,  hk_materials: 31044.80,  hk_service: 0.00,      internet: 68750.00,  security: 0.00,       tea_coffee: 42712.00, repairs: 89000.00,  prop_maint: 208373.00, emp_sal: 109033.35,   subscr: 0.00    },
  },
  'jai_pinkcity_8th': {
    '2026-04': { office_rent: 1356201.00, elec_util: 166894.14,  hk_materials: 24647.47,  hk_service: 211122.00,  internet: 653000.00, security: 92560.00,   tea_coffee: 40031.00, repairs: 0.00,      prop_maint: 383145.00,  emp_sal: 46950.00 },
    '2026-05': { office_rent: 1356201.00, elec_util: 193736.07,  hk_materials: 40078.75,  hk_service: 225730.10,  internet: 96750.00,  security: 92079.60,   tea_coffee: 46620.00, repairs: 0.00,      prop_maint: 383145.00,  emp_sal: 46950.00 },
    '2026-06': { office_rent: 1356201.00, elec_util: 269290.14,  hk_materials: 36514.98,  hk_service: 218936.64,  internet: 1950.00,   security: 92560.00,   tea_coffee: 53980.00, repairs: 56887.00,  prop_maint: 383145.00,  emp_sal: 46950.00 },
    '2026-07': { office_rent: 1424011.00, elec_util: 221059.25,  hk_materials: 5400.00,   hk_service: 25820.00,   internet: 0.00,      security: 0.00,       tea_coffee: 50370.00, repairs: 44500.00,  prop_maint: 402302.25,  emp_sal: 46950.00 },
  },
  'mum_215_atrium_10th': {
    '2026-04': { office_rent: 2771285.00, elec_util: 213712.53,  hk_materials: 29861.00,  hk_service: 244446.71, internet: 57250.00,  security: 123543.60,  tea_coffee: 59750.00, repairs: 22500.00, prop_maint: 0.00, emp_sal: 0.00, brokerage: 27000.00  },
    '2026-05': { office_rent: 2815983.00, elec_util: 216080.00,  hk_materials: 4900.00,   hk_service: 256868.23, internet: 54750.00,  security: 123543.60,  tea_coffee: 63910.00, repairs: 0.00,     prop_maint: 0.00, emp_sal: 0.00, brokerage: 27000.00  },
    '2026-06': { office_rent: 2909849.00, elec_util: 218750.00,  hk_materials: 34801.00,  hk_service: 255425.78, internet: 54750.00,  security: 127528.96,  tea_coffee: 59930.00, repairs: 50866.00, prop_maint: 0.00, emp_sal: 0.00, brokerage: 27010.00  },
    '2026-07': { office_rent: 2909849.00, elec_util: 250040.00,  hk_materials: 5800.00,   hk_service: 0.00,      internet: 0.00,      security: 0.00,       tea_coffee: 71815.00, repairs: 58000.00, prop_maint: 0.00, emp_sal: 0.00, brokerage: 0.00      },
  },
  'mum_dynasty_7th': {
    '2026-04': { office_rent: 3572100.00, elec_util: 122190.00,  hk_materials: 15875.00,  hk_service: 95000.71,  internet: 17650.00,  security: 61772.00,   tea_coffee: 40035.00, repairs: 0.00,     prop_maint: 0.00, emp_sal: 201927.00,   brokerage: 98299.16 },
    '2026-05': { office_rent: 3572100.00, elec_util: 124470.00,  hk_materials: 2400.00,   hk_service: 97590.52,  internet: 17650.00,  security: 61772.00,   tea_coffee: 41655.00, repairs: 0.00,     prop_maint: 0.00, emp_sal: 229264.33,   brokerage: 98299.16 },
    '2026-06': { office_rent: 3572100.00, elec_util: 157680.00,  hk_materials: 19501.00,  hk_service: 94358.71,  internet: 9750.00,   security: 63764.65,   tea_coffee: 0.00,     repairs: 65000.00, prop_maint: 0.00, emp_sal: 285797.32,   brokerage: 98299.16 },
    '2026-07': { office_rent: 3572100.00, elec_util: 171770.00,  hk_materials: 1500.00,   hk_service: 0.00,      internet: 7900.00,   security: 0.00,       tea_coffee: 40980.00, repairs: 0.00,     prop_maint: 0.00, emp_sal: 181654.55,   brokerage: 98299.40 },
  },
  'noi_embassy_5th': {
    '2026-04': { office_rent: 1124452.00, elec_util: 121094.00,  hk_materials: 15304.66,  hk_service: 140246.24, internet: 61584.00,  security: 101132.40,  tea_coffee: 32830.00, repairs: 0.00,     prop_maint: 481908.00, emp_sal: 0.00, stamp_duty: 20596.15 },
    '2026-05': { office_rent: 1124452.00, elec_util: 142921.00,  hk_materials: 27528.00,  hk_service: 142489.61, internet: 63267.00,  security: 101132.40,  tea_coffee: 36630.00, repairs: 0.00,     prop_maint: 481908.00, emp_sal: 0.00, stamp_duty: 20596.15 },
    '2026-06': { office_rent: 1124452.00, elec_util: 0.00,       hk_materials: 22693.00,  hk_service: 155928.22, internet: 64850.00,  security: 101131.92,  tea_coffee: 39730.00, repairs: 32500.00, prop_maint: 481908.00, emp_sal: 0.00, stamp_duty: 20596.15 },
    '2026-07': { office_rent: 1293120.00, elec_util: 330293.00,  hk_materials: 25695.44,  hk_service: 0.00,      internet: 29167.00,  security: 0.00,       tea_coffee: 32500.00, repairs: 0.00,     prop_maint: 481908.00, emp_sal: 0.00, stamp_duty: 20596.15 },
  },
  'noi_jask_7th': {
    '2026-04': { office_rent: 605696.00, elec_util: 143603.00,   hk_materials: 0.00,      hk_service: 117899.00, internet: 19650.00,  security: 50566.20,   tea_coffee: 9950.00,  repairs: 52650.00, prop_maint: 140000.00, emp_sal: 0.00, stamp_duty: 46457.22 },
    '2026-05': { office_rent: 605696.00, elec_util: 139653.00,   hk_materials: 31372.56,  hk_service: 90311.47,  internet: 7800.00,   security: 50566.20,   tea_coffee: 24070.00, repairs: 0.00,     prop_maint: 168000.00, emp_sal: 0.00, stamp_duty: 46457.22 },
    '2026-06': { office_rent: 605696.00, elec_util: 165376.00,   hk_materials: 16644.00,  hk_service: 93801.40,  internet: 0.00,      security: 50565.96,   tea_coffee: 38780.00, repairs: 32500.00, prop_maint: 154000.00, emp_sal: 0.00, stamp_duty: 46457.22 },
    '2026-07': { office_rent: 605696.00, elec_util: 176973.00,   hk_materials: 19493.50,  hk_service: 0.00,      internet: 0.00,      security: 0.00,       tea_coffee: 24227.50, repairs: 0.00,     prop_maint: 154000.00, emp_sal: 0.00, stamp_duty: 46457.22 },
  },
};

// ── GET /api/budget/branch-bills-progress ─────────────────────────────────────
app.get('/api/budget/branch-bills-progress', (req, res) => {
  res.json(_branchSyncProgress || { status: 'idle' });
});

// ── GET /api/budget/branch-bills-data ─────────────────────────────────────────
// Returns the cached data for a branch (reads branch_bills_cache/{branchId}.json)
app.get('/api/budget/branch-bills-data', async (req, res) => {
  const { branchId } = req.query;
  if (!branchId) return res.status(400).json({ error: 'branchId required' });
  const data = await readBranchBillsCache(branchId);
  if (!data) return res.json({ ok: false, message: 'No cache found — run sync first', branchId });
  res.json({ ok: true, ...data });
});

// ── POST /api/budget/sync-branch-bills ────────────────────────────────────────
// Fetches all bills for ONE specific branch and caches to branch_bills_cache/{branchId}.json
// Progress is streamed via GET /api/budget/branch-bills-progress
// After sync, cross-verifies against PNL_EXPECTED if known values exist.
//
// Process (visible to user):
//   Phase 1 — bill_list   : Page through /bills API, collect all bills for this branch
//   Phase 2 — bill_details: Fetch each bill's line items one-by-one (1200ms gap = 50/min)
//                           On 429: waits retry-after+15s then resumes automatically
//   Phase 3 — aggregate   : Group line items by budget category using COA ancestry
//   Phase 4 — verify      : Compare totals against PNL_EXPECTED if available
//   Phase 5 — save        : Write to branch_bills_cache/{branchId}.json
app.post('/api/budget/sync-branch-bills', async (req, res) => {
  if (_branchSyncProgress?.status === 'running') {
    return res.json({ ok: false, message: 'Already running', progress: _branchSyncProgress });
  }

  const { branchId, fromMonth, toMonth } = req.body || {};
  if (!branchId) return res.status(400).json({ error: 'branchId is required' });

  const branch = BUDGET_BRANCHES.find(b => b.id === branchId);
  if (!branch) return res.status(400).json({ error: `Unknown branchId: ${branchId}` });
  if (!branch.zohoBranchId) return res.status(400).json({ error: `Branch ${branchId} has no zohoBranchId` });

  // Quick Zoho connectivity check
  try {
    await zohoGet('/settings/currencies');
  } catch (e) {
    if (e.response?.status === 429) {
      const ra = e.response?.headers?.['retry-after'];
      return res.json({ ok: false, message: `Zoho rate-limited. Retry after ${ra}s.`, retry_after_seconds: parseInt(ra || '60', 10) });
    }
    return res.json({ ok: false, message: `Zoho API error: ${e.message}` });
  }

  const FY_START = fromMonth ? fromMonth + '-01' : '2026-04-01';
  const FY_END   = '2027-03-31';
  const todayStr = new Date().toISOString().slice(0, 10);
  const fetchTo  = toMonth ? toMonth + '-' + new Date(parseInt(toMonth.slice(0, 4)), parseInt(toMonth.slice(5, 7)), 0).getDate()
                           : (todayStr < FY_END ? todayStr : FY_END);
  const fetchFrom = FY_START;

  _branchSyncProgress = {
    status: 'running',
    branchId, branchName: branch.name,
    zohoBranchId: branch.zohoBranchId,
    fetchFrom, fetchTo,
    startedAt: new Date().toISOString(),
    phase: 'bill_list',
    pct: 0,
    // Phase 1
    listPagesScanned: 0, billsFound: 0,
    // Phase 2
    totalBills: 0, billsDone: 0, currentBillId: '',
    // Phase 3+
    currentAction: 'Scanning bill list...',
    log: [],
  };

  const addLog = (msg) => {
    _branchSyncProgress.log.push(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);
    console.log(`[branch-sync:${branchId}] ${msg}`);
  };

  res.json({
    ok: true,
    message: `Sync started for ${branch.name}. Poll GET /api/budget/branch-bills-progress for status.`,
    branchId, branchName: branch.name, fetchFrom, fetchTo,
  });

  try {
    const { getGroupId } = await getCoaData();
    const mappings = await readBudgetMappings();

    // Build accountId → budgetItemId from budget_mappings (fallback for all items)
    // GROUP_ITEMS.getGroupId() takes priority; mappings serve as fallback via the || operator
    const mappingAcctToItem = {};
    for (const [itemId, aids] of Object.entries(mappings)) {
      for (const aid of aids) {
        if (!mappingAcctToItem[aid]) mappingAcctToItem[aid] = itemId;
      }
    }

    // ── Phase 1: Fetch bill list and filter by this branch ──────────────────────
    addLog(`Phase 1: Scanning bill list for branch ${branch.zohoBranchId}...`);
    _branchSyncProgress.phase = 'bill_list';

    const branchBills = []; // bills belonging to this branch in the date window
    const seenBillIds = new Set();
    let listPage = 1, noMatchPages = 0;

    while (listPage <= 200) {
      _branchSyncProgress.listPagesScanned = listPage;
      _branchSyncProgress.currentAction = `Scanning bill list page ${listPage}...`;
      _branchSyncProgress.pct = Math.min(Math.round((listPage / 50) * 20), 20);

      const d = await zohoGet('/bills', { filter_by: 'Status.All', per_page: 200, page: listPage });
      const bills = d.bills || [];
      if (!bills.length) { addLog(`Page ${listPage}: empty — stopping list scan`); break; }

      let anyInWindow = false;
      for (const b of bills) {
        if (!b.date || !b.bill_id) continue;
        if (b.date < fetchFrom || b.date > fetchTo) continue;
        if (b.branch_id !== branch.zohoBranchId) continue;
        if (seenBillIds.has(b.bill_id)) continue;
        seenBillIds.add(b.bill_id);
        branchBills.push(b);
        anyInWindow = true;
      }

      _branchSyncProgress.billsFound = branchBills.length;
      addLog(`Page ${listPage}: ${bills.length} bills scanned, ${branchBills.length} matched this branch so far`);

      if (!d.page_context?.has_more_page) { addLog('No more pages'); break; }

      // Stop early if pages have no match AND dates are all before our window (bills sorted newest→oldest)
      const allBeforeWindow = bills.every(b => b.date && b.date < fetchFrom);
      if (allBeforeWindow) { noMatchPages++; if (noMatchPages >= 3) { addLog('3 pages before window — stopping'); break; } }
      else if (anyInWindow) { noMatchPages = 0; }
      else { noMatchPages++; if (noMatchPages >= 5) { addLog('5 no-match pages — stopping'); break; } }

      listPage++;
      await new Promise(ok => setTimeout(ok, 400)); // gentle pacing on list calls
    }

    addLog(`Phase 1 done: ${branchBills.length} bills found for ${branch.name} (${fetchFrom} → ${fetchTo})`);
    _branchSyncProgress.totalBills = branchBills.length;
    _branchSyncProgress.billsFound = branchBills.length;

    if (branchBills.length === 0) {
      addLog('WARNING: No bills found for this branch in the date range. Expenses may be journal entries only.');
    }

    // ── Phase 2: Fetch bill details sequentially (1200ms gap = 50/min) ─────────
    _branchSyncProgress.phase = 'bill_details';
    addLog(`Phase 2: Fetching ${branchBills.length} bill details (1 per 1.2s = 50/min)...`);

    const billDetails = {}; // bill_id → line_items[]

    for (let i = 0; i < branchBills.length; i++) {
      const b = branchBills[i];
      _branchSyncProgress.billsDone = i;
      _branchSyncProgress.currentBillId = b.bill_id;
      _branchSyncProgress.currentAction = `Fetching bill ${i + 1}/${branchBills.length}: ${b.bill_id} (${b.date}, ₹${b.total || 0})`;
      _branchSyncProgress.pct = 20 + Math.round(((i + 1) / Math.max(branchBills.length, 1)) * 60);

      // Retry loop for rate limiting
      while (true) {
        try {
          const r = await zohoGet(`/bills/${b.bill_id}`, {}, 1);
          const lineItems = (r.bill || {}).line_items || [];
          billDetails[b.bill_id] = lineItems;
          if (i % 10 === 0) addLog(`  ✓ bill ${i + 1}/${branchBills.length} (${lineItems.length} line items)`);
          break;
        } catch (e) {
          if (e.response?.status === 429) {
            const waitSecs = parseInt(e.response.headers?.['retry-after'] || '120', 10) + 15;
            addLog(`  ⚠ 429 rate limit on bill ${b.bill_id} — waiting ${waitSecs}s then resuming...`);
            _branchSyncProgress.currentAction = `Rate limited — waiting ${waitSecs}s then resuming at bill ${i + 1}/${branchBills.length}`;
            _branchSyncProgress.phase = 'rate_limit_wait';
            await new Promise(ok => setTimeout(ok, waitSecs * 1000));
            _branchSyncProgress.phase = 'bill_details';
            // loop continues → retry same bill
          } else {
            addLog(`  ✗ skip bill ${b.bill_id}: ${e.message}`);
            billDetails[b.bill_id] = []; // treat as empty
            break;
          }
        }
      }

      if (i + 1 < branchBills.length) await new Promise(ok => setTimeout(ok, 1200));
    }

    _branchSyncProgress.billsDone = branchBills.length;
    addLog('Phase 2 done: all bill details fetched');

    // ── Phase 2b: Fetch journal entries for this branch ───────────────────────────
    _branchSyncProgress.phase = 'journal_list';
    addLog(`Phase 2b: Fetching journal entries (${fetchFrom} → ${fetchTo})...`);

    const branchJournalItems = []; // { date, ref, type:'journal', account_id, account_name, signedAmt }

    try {
      let jPage = 1;
      let jTotalScanned = 0;
      while (jPage <= 100) {
        _branchSyncProgress.currentAction = `Scanning journal page ${jPage}...`;
        let jd;
        try {
          // Zoho journals API does NOT support filter_by date — fetch all pages in descending
          // date order and stop when we've scrolled past the start of our window.
          jd = await zohoGet('/journals', {
            per_page: 200,
            page:     jPage,
          });
        } catch (e) {
          if (e.response?.status === 429) {
            const ws = parseInt(e.response.headers?.['retry-after'] || '120', 10) + 15;
            addLog(`  ⚠ 429 on journals page ${jPage} — waiting ${ws}s...`);
            await new Promise(ok => setTimeout(ok, ws * 1000));
            continue;
          }
          addLog(`  ✗ journals list error: ${e.message} — skipping journal phase`);
          break;
        }

        // Zoho returns the array under 'journals' key
        const journals = jd.journals || jd.journal_details || [];
        if (!journals.length) {
          addLog(`  Journal page ${jPage}: 0 entries — done`);
          break;
        }

        // Track whether any entry on this page falls in our target window.
        // Journals are returned newest-first; when the ENTIRE page is before
        // fetchFrom we have scrolled past all entries we care about.
        let anyInRange = false;
        let allBeforeRange = true;

        for (const j of journals) {
          if (!j.journal_id) continue;
          // Zoho journals list uses 'journal_date' not 'date'
          const jDate = j.journal_date || j.date || '';
          if (!jDate) continue;

          if (jDate >= fetchFrom) allBeforeRange = false;

          // Skip future-dated entries (stamp duty 2031-2033 etc.) and past entries
          if (jDate > fetchTo || jDate < fetchFrom) continue;

          anyInRange = true;
          jTotalScanned++;

          // Branch filter: skip only if journal is explicitly tagged to a DIFFERENT branch
          // (empty branch_id = org-level journal — include, let account name disambiguate)
          const jBranchId = j.branch_id || j.cf_branch_id || '';
          if (jBranchId && jBranchId !== branch.zohoBranchId) continue;

          // Fetch full journal detail for line_items (list endpoint rarely includes them)
          let lineItems = j.line_items || [];
          if (!lineItems.length) {
            let detErr = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const det = await zohoGet(`/journals/${j.journal_id}`);
                // Zoho returns journal under 'journal' key
                const jObj = det.journal || det.journalentry || det.data || det;
                lineItems = jObj.line_items || jObj.line_entries || [];
                break;
              } catch (de) {
                if (de.response?.status === 429) {
                  const ws = parseInt(de.response.headers?.['retry-after'] || '60', 10) + 10;
                  addLog(`    ⚠ 429 on journal ${j.journal_id} detail — waiting ${ws}s...`);
                  await new Promise(ok => setTimeout(ok, ws * 1000));
                } else {
                  detErr = de;
                  break;
                }
              }
            }
            if (detErr) addLog(`    ✗ journal ${j.reference_number || j.journal_id} detail error: ${detErr.message}`);
            await new Promise(ok => setTimeout(ok, 800));
          }

          let matchedLines = 0;
          for (const li of lineItems) {
            if (!li.account_id) continue;

            // For org-level journals (no branch_id on header), filter by line-item branch
            // This prevents e.g. Mum_Dynasty salary lines leaking into Binori's sync
            if (!jBranchId) {
              const liBranch = li.branch_id || '';
              if (liBranch && liBranch !== branch.zohoBranchId) continue;
            }

            const gid = getGroupId(li.account_id);
            const itemId = gid || mappingAcctToItem[li.account_id];
            if (!itemId) continue;

            const rawAmt = parseFloat(li.amount || 0) || 0;
            if (Math.abs(rawAmt) < 0.01) continue;

            // Debits = positive expense, Credits = negative (reduces expense)
            const doc = (li.debit_or_credit || '').toLowerCase();
            const signedAmt = doc === 'credit' ? -rawAmt : rawAmt;

            branchJournalItems.push({
              date:         jDate,
              ref:          j.reference_number || j.journal_id,
              notes:        j.notes || '',
              type:         'journal',
              itemId,
              account_id:   li.account_id,
              account_name: li.account_name || '',
              signedAmt,
            });
            matchedLines++;
          }
          if (matchedLines > 0) {
            addLog(`    ✓ journal ${j.reference_number || j.journal_id} (${jDate}): ${matchedLines} matching line(s)`);
          }
        }

        addLog(`  Journal page ${jPage}: ${journals.length} entries, inRange=${anyInRange}, allBefore=${allBeforeRange} (total matched: ${jTotalScanned})`);
        // Stop when the whole page is before our date window — we've scrolled past it
        if (allBeforeRange) {
          addLog(`  All journals on page ${jPage} are before ${fetchFrom} — stopping scan`);
          break;
        }
        if (!jd.page_context?.has_more_page) break;
        jPage++;
        await new Promise(ok => setTimeout(ok, 600));
      }
      addLog(`Phase 2b done: ${branchJournalItems.length} journal line items found for budget categories`);
    } catch (e) {
      addLog(`Phase 2b error (journals skipped): ${e.message}`);
    }

    // ── Phase 3: Aggregate by month × budget category ────────────────────────────
    _branchSyncProgress.phase = 'aggregate';
    _branchSyncProgress.currentAction = 'Aggregating by month and category...';
    addLog('Phase 3: Aggregating...');

    // Determine all months in the window
    const months = [];
    { let d = new Date(fetchFrom + 'T00:00:00Z');
      const endD = new Date(fetchTo + 'T00:00:00Z');
      while (d <= endD) {
        months.push(d.toISOString().slice(0, 7));
        d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      }
    }

    const monthlyTotals      = {}; // ym → { budgetItemId: amount }
    const monthlyBillsByItem = {}; // ym → { budgetItemId: [{ bill_id, date, vendor, bill_total, line_item_total, account_name }] }

    for (const ym of months) {
      monthlyTotals[ym] = {};
      monthlyBillsByItem[ym] = {};
      for (const item of BUDGET_ITEMS) { monthlyTotals[ym][item.id] = 0; monthlyBillsByItem[ym][item.id] = []; }
    }

    for (const b of branchBills) {
      const ym = (b.date || '').slice(0, 7);
      if (!monthlyTotals[ym]) continue;
      const lineItems = billDetails[b.bill_id] || [];

      for (const li of lineItems) {
        if (!li.account_id) continue;
        const amt = parseFloat(li.item_total || li.amount || 0) || 0;
        if (Math.abs(amt) < 0.01) continue;

        const gid = getGroupId(li.account_id);
        const itemId = gid || mappingAcctToItem[li.account_id];
        if (!itemId) continue;

        monthlyTotals[ym][itemId] = (monthlyTotals[ym][itemId] || 0) + amt;
        if (!monthlyBillsByItem[ym][itemId]) monthlyBillsByItem[ym][itemId] = [];
        monthlyBillsByItem[ym][itemId].push({
          bill_id:         b.bill_id,
          bill_number:     b.bill_number || '',
          date:            b.date,
          vendor:          b.vendor_name || '',
          bill_total:      parseFloat(b.total || 0),
          line_item_total: Math.round(Math.abs(amt) * 100) / 100,
          account_name:    li.account || li.account_name || '',
        });
      }
    }

    // Aggregate journal entries into monthly totals (Phase 2b results)
    for (const ji of branchJournalItems) {
      const ym = (ji.date || '').slice(0, 7);
      if (!monthlyTotals[ym]) continue;
      monthlyTotals[ym][ji.itemId] = (monthlyTotals[ym][ji.itemId] || 0) + ji.signedAmt;
      if (!monthlyBillsByItem[ym][ji.itemId]) monthlyBillsByItem[ym][ji.itemId] = [];
      monthlyBillsByItem[ym][ji.itemId].push({
        bill_id:         ji.ref,
        date:            ji.date,
        vendor:          ji.notes || 'Journal Entry',
        bill_total:      Math.abs(ji.signedAmt),
        line_item_total: Math.round(Math.abs(ji.signedAmt) * 100) / 100,
        account_name:    ji.account_name,
        type:            'journal',
      });
    }

    // Round to 2 decimal places (abs to ensure positives — credits already reduced totals via signed aggregation)
    for (const ym of months) {
      for (const k of Object.keys(monthlyTotals[ym])) {
        monthlyTotals[ym][k] = Math.round(Math.abs(monthlyTotals[ym][k]) * 100) / 100;
      }
    }

    addLog('Phase 3 done: aggregation complete');

    // ── Phase 3b: Override totals with account_transactions (exact Zoho P&L match) ──
    // Bills-based aggregation (Phase 3) can include Draft/Void bills and miss journals.
    // account_transactions uses the posted GL — identical to what Zoho P&L reports show.
    _branchSyncProgress.phase = 'acct_txn';
    _branchSyncProgress.currentAction = 'Fetching account transactions for P&L-accurate totals...';
    addLog('Phase 3b: Fetching account_transactions for P&L-accurate monthly totals...');
    try {
      const { coaFull: coaFull3b, coaParentIds: coaPIDs3b, getGroupId: getGid3b } = await getCoaData();
      const mappings3b = await readBudgetMappings();

      // Collect all leaf account IDs that map to any budget item
      const leafToItem3b = {}; // account_id → itemId
      for (const [aid] of Object.entries(coaFull3b)) {
        if (coaPIDs3b.has(aid)) continue; // skip parent accounts
        const gid = getGid3b(aid);
        if (gid) leafToItem3b[aid] = gid;
      }
      // Add non-GROUP items from budget_mappings
      for (const item of BUDGET_ITEMS) {
        if (!GROUP_ITEMS[item.id]) {
          for (const aid of (mappings3b[item.id] || [])) {
            if (!leafToItem3b[aid]) leafToItem3b[aid] = item.id;
          }
        }
      }

      const acctTxnTotals = {}; // ym → { itemId: amount }
      for (const ym of months) { acctTxnTotals[ym] = {}; }

      const leafIds3b = Object.keys(leafToItem3b);
      addLog(`  ${leafIds3b.length} leaf accounts to query for branch ${branch.zohoBranchId}`);

      const BATCH3B = 5;
      for (let i = 0; i < leafIds3b.length; i += BATCH3B) {
        const batchIds = leafIds3b.slice(i, i + BATCH3B);
        const results = await Promise.allSettled(
          batchIds.map(async (aid) => {
            const r = await zohoGet('/reports/accounttransactions', {
              account_id: aid, from_date: fetchFrom, to_date: fetchTo,
              branch_id: branch.zohoBranchId,
            });
            const txns = r.account_transactions || r.transactions || [];
            const itemId = leafToItem3b[aid];
            for (const t of txns) {
              const ym = (t.transaction_date || t.date || '').slice(0, 7);
              if (!acctTxnTotals[ym]) continue;
              const net = (parseFloat(t.debit_amount || 0) || 0) - (parseFloat(t.credit_amount || 0) || 0);
              acctTxnTotals[ym][itemId] = (acctTxnTotals[ym][itemId] || 0) + net;
            }
          })
        );
        const errors = results.filter(r => r.status === 'rejected');
        if (errors.length) addLog(`  Batch ${i / BATCH3B + 1}: ${errors.length} errors (${errors.map(e => e.reason?.message).join(', ')})`);
        if (i + BATCH3B < leafIds3b.length) await new Promise(ok => setTimeout(ok, 400));
      }

      // Override monthlyTotals with account_transactions values (round to 2dp)
      let overrideCount = 0;
      for (const ym of months) {
        for (const [itemId, amt] of Object.entries(acctTxnTotals[ym])) {
          const rounded = Math.round(Math.abs(amt) * 100) / 100;
          if (monthlyTotals[ym] && monthlyTotals[ym][itemId] !== undefined) {
            monthlyTotals[ym][itemId] = rounded;
            overrideCount++;
          }
        }
        // Zero out items that had no account_transactions (= truly zero in Zoho P&L)
        for (const item of BUDGET_ITEMS) {
          if (acctTxnTotals[ym][item.id] === undefined && monthlyTotals[ym]) {
            // Only zero out GROUP_ITEMS — non-GROUP items rely on bill detail which may be correct
            if (GROUP_ITEMS[item.id]) monthlyTotals[ym][item.id] = 0;
          }
        }
      }
      addLog(`Phase 3b done: overrode ${overrideCount} monthly totals with account_transactions values`);
    } catch (e3b) {
      addLog(`Phase 3b error (using Phase 3 bill-based totals as fallback): ${e3b.message}`);
    }

    // ── Phase 4: Cross-verify against P&L ─────────────────────────────────────
    _branchSyncProgress.phase = 'verify';
    _branchSyncProgress.currentAction = 'Cross-verifying against P&L...';
    addLog('Phase 4: Cross-verifying against P&L expected values...');

    const verification = {};
    const pnlRef = PNL_EXPECTED[branchId];

    if (pnlRef) {
      for (const ym of Object.keys(pnlRef)) {
        verification[ym] = {};
        for (const [itemId, expected] of Object.entries(pnlRef[ym])) {
          const actual = monthlyTotals[ym]?.[itemId] || 0;
          const diff = Math.round((actual - expected) * 100) / 100;
          const match = Math.abs(diff) < 1; // within ₹1 tolerance
          verification[ym][itemId] = { expected, actual, diff, match };
          if (!match) addLog(`  ✗ ${ym} ${itemId}: expected ₹${expected.toLocaleString('en-IN')} | got ₹${actual.toLocaleString('en-IN')} | diff ₹${diff.toLocaleString('en-IN')}`);
          else addLog(`  ✓ ${ym} ${itemId}: ₹${actual.toLocaleString('en-IN')} matches`);
        }
      }
    } else {
      addLog('  No P&L expected values defined for this branch — skipping verification');
    }

    addLog('Phase 4 done');

    // ── Phase 5: Save to cache ────────────────────────────────────────────────
    _branchSyncProgress.phase = 'save';
    _branchSyncProgress.currentAction = 'Saving to branch_bills_cache/...';

    const cacheData = {
      branchId, branchName: branch.name, zohoBranchId: branch.zohoBranchId,
      syncedAt: new Date().toISOString(),
      fetchFrom, fetchTo, months,
      totalBillsFetched: branchBills.length,
      monthlyTotals,
      monthlyBillsByItem, // per-item bill lists for drill-down UI
      verification: Object.keys(verification).length ? verification : null,
    };

    await writeBranchBillsCache(branchId, cacheData);
    addLog(`Phase 5 done: saved to branch_bills_cache/${branchId}.json`);

    _branchSyncProgress.status = 'done';
    _branchSyncProgress.pct = 100;
    _branchSyncProgress.finishedAt = cacheData.syncedAt;
    _branchSyncProgress.currentAction = 'Complete';
    _branchSyncProgress.summary = {
      totalBillsFetched: branchBills.length,
      months,
      verificationPassed: pnlRef ? Object.values(verification).every(v => Object.values(v).every(x => x.match)) : null,
    };
    addLog(`Sync complete for ${branch.name}`);

  } catch (e) {
    _branchSyncProgress.status = 'error';
    _branchSyncProgress.error = e.message;
    console.error(`[branch-sync:${branchId}] error:`, e.message);
  }
});

// ── POST /api/budget/recalibrate-cache ─────────────────────────────────────
// Recalibrates monthly totals in ALL existing branch cache files using account_transactions.
// This gives exact Zoho P&L match without requiring a full re-sync.
// Streams progress as newline-delimited JSON.
app.post('/api/budget/recalibrate-cache', async (req, res) => {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('X-Accel-Buffering', 'no');
  const log = (msg, extra = {}) => { res.write(JSON.stringify({ msg, ...extra }) + '\n'); };

  try {
    const { from: fromQ, to: toQ } = req.body || {};
    const FROM = fromQ || '2026-04-01';
    const TO   = toQ   || new Date().toISOString().slice(0, 10);

    log(`Starting recalibrate-cache from=${FROM} to=${TO}`);

    const { coaFull, coaParentIds, getGroupId } = await getCoaData();
    const mappings = await readBudgetMappings();

    // Build leaf account → itemId map
    const leafToItem = {};
    for (const [aid] of Object.entries(coaFull)) {
      if (coaParentIds.has(aid)) continue;
      const gid = getGroupId(aid);
      if (gid) leafToItem[aid] = gid;
    }
    for (const item of BUDGET_ITEMS) {
      if (!GROUP_ITEMS[item.id]) {
        for (const aid of (mappings[item.id] || [])) {
          if (!leafToItem[aid]) leafToItem[aid] = item.id;
        }
      }
    }
    const leafIds = Object.keys(leafToItem);
    log(`COA loaded: ${Object.keys(coaFull).length} accounts, ${leafIds.length} leaf accounts map to budget items`);

    // Find all month keys in the range
    const allMonths = [];
    { let d = new Date(FROM + 'T00:00:00Z');
      const endD = new Date(TO + 'T00:00:00Z');
      while (d <= endD) {
        allMonths.push(d.toISOString().slice(0, 7));
        d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
      }
    }

    const cacheFiles = await db.listBranchCacheFiles(BRANCH_BILLS_DIR);
    log(`Found ${cacheFiles.length} branch cache files`);

    for (const fname of cacheFiles) {
      const branchId = fname.replace('.json', '');
      const branch = BUDGET_BRANCHES.find(b => b.id === branchId);
      if (!branch || !branch.zohoBranchId) {
        log(`SKIP ${branchId}: no Zoho branch ID`);
        continue;
      }

      log(`Processing ${branchId} (${branch.name})...`);
      const cacheData = await readBranchBillsCache(branchId);
      if (!cacheData) { log(`  SKIP: cache file not readable`); continue; }

      // Determine months present in this cache
      const cacheMonths = new Set(Object.keys(cacheData.monthlyTotals || {}));
      const relevantMonths = allMonths.filter(m => cacheMonths.has(m));
      if (!relevantMonths.length) { log(`  SKIP: no relevant months in cache`); continue; }

      // Fetch account_transactions per leaf account for this branch
      const acctTotals = {}; // ym → { itemId: net }
      for (const ym of relevantMonths) acctTotals[ym] = {};

      const BATCH = 6;
      let batchNum = 0;
      for (let i = 0; i < leafIds.length; i += BATCH) {
        batchNum++;
        const batchIds = leafIds.slice(i, i + BATCH);
        await Promise.allSettled(
          batchIds.map(async (aid) => {
            try {
              const r = await zohoGet('/reports/accounttransactions', {
                account_id: aid, from_date: FROM, to_date: TO,
                branch_id: branch.zohoBranchId,
              });
              const txns = r.account_transactions || r.transactions || [];
              for (const t of txns) {
                const ym = (t.transaction_date || t.date || '').slice(0, 7);
                if (!acctTotals[ym]) continue;
                const net = (parseFloat(t.debit_amount || 0) || 0) - (parseFloat(t.credit_amount || 0) || 0);
                const itemId = leafToItem[aid];
                acctTotals[ym][itemId] = (acctTotals[ym][itemId] || 0) + net;
              }
            } catch (e) { /* skip failed accounts */ }
          })
        );
        if (i + BATCH < leafIds.length) await new Promise(ok => setTimeout(ok, 350));
      }

      // Update monthlyTotals in cache with account_transactions values
      let changed = false;
      for (const ym of relevantMonths) {
        if (!cacheData.monthlyTotals[ym]) continue;
        for (const [itemId, amt] of Object.entries(acctTotals[ym])) {
          const rounded = Math.round(Math.abs(amt) * 100) / 100;
          if (cacheData.monthlyTotals[ym][itemId] !== undefined) {
            cacheData.monthlyTotals[ym][itemId] = rounded;
            changed = true;
          }
        }
        // Zero GROUP_ITEMS that had no transactions (truly zero in Zoho P&L)
        for (const item of BUDGET_ITEMS) {
          if (GROUP_ITEMS[item.id] && acctTotals[ym][item.id] === undefined) {
            cacheData.monthlyTotals[ym][item.id] = 0;
          }
        }
      }

      if (changed) {
        cacheData.recalibratedAt = new Date().toISOString();
        await writeBranchBillsCache(branchId, cacheData);
        log(`  ${branchId}: updated and saved`, { branch: branchId, months: relevantMonths });
      } else {
        log(`  ${branchId}: no changes`);
      }

      await new Promise(ok => setTimeout(ok, 300));
    }

    log('Recalibration complete', { done: true });
  } catch (e) {
    log(`Error: ${e.message}`, { error: true });
  }
  res.end();
});

app.get('/api/budget/bills-actuals', async (req, res) => {
  const { ym, branchId } = req.query;
  if (!ym || !branchId) return res.status(400).json({ error: 'ym and branchId required' });

  // ── Serve from pre-computed P&L cache (instant) when available ──
  const billsCache = await readBillsCache();
  if (billsCache?.computed?.[ym]?.[branchId]) {
    return res.json({
      computed: billsCache.computed[ym][branchId],
      branchName: BUDGET_BRANCHES.find(b => b.id === branchId)?.name || branchId,
      source: 'pl_cache',
      syncedAt: billsCache.syncedAt,
    });
  }

  // ── Live fetch from P&L API (single request per branch/month) ──
  const cacheKey = `pl-actuals-v1:${ym}:${branchId}`;
  const hit = cache.get(cacheKey);
  if (hit) return res.json(hit);

  try {
    const branch = BUDGET_BRANCHES.find(b => b.id === branchId);
    if (!branch) return res.status(400).json({ error: 'Unknown branchId' });
    if (!branch.zohoBranchId) return res.status(400).json({ error: 'Branch has no Zoho branch ID' });

    const [yr, mo] = ym.split('-').map(Number);
    const FROM = `${ym}-01`;
    const TO = new Date(Date.UTC(yr, mo, 0)).toISOString().slice(0, 10);

    const mappings = await readBudgetMappings();
    const { nameToGroupId } = await getCoaData();

    const acctToItem = {};
    for (const [itemId, acctIds] of Object.entries(mappings)) {
      for (const aId of acctIds) {
        if (!acctToItem[aId]) acctToItem[aId] = [];
        acctToItem[aId].push(itemId);
      }
    }

    function extractPLv2(node, leafAmts, groupAmts) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(n => extractPLv2(n, leafAmts, groupAmts)); return; }
      if (node.account_name && nameToGroupId[node.account_name]) {
        const gid = nameToGroupId[node.account_name];
        const total = parseFloat(node.total || 0) || 0;
        if (total !== 0) groupAmts[gid] = (groupAmts[gid] || 0) + Math.abs(total);
        return;
      }
      if (node.account_id && node.is_child_present === false) {
        const total = parseFloat(node.total || 0) || 0;
        if (total !== 0) leafAmts[node.account_id] = (leafAmts[node.account_id] || 0) + total;
      }
      for (const v of Object.values(node)) if (typeof v === 'object' && v !== null) extractPLv2(v, leafAmts, groupAmts);
    }

    const plResp = await zohoGet('/reports/profitandloss', {
      from_date: FROM, to_date: TO, branch_id: branch.zohoBranchId,
    });
    const leafAmts = {}, groupAmts = {};
    extractPLv2(plResp.profit_and_loss || plResp.profitandloss || plResp, leafAmts, groupAmts);

    const computed = {};
    for (const item of BUDGET_ITEMS) computed[item.id] = 0;

    for (const [gid, total] of Object.entries(groupAmts)) computed[gid] = total;
    for (const [aId, total] of Object.entries(leafAmts)) {
      const amt = Math.abs(total);
      if (acctToItem[aId]) {
        for (const itemId of acctToItem[aId]) {
          if (!GROUP_ITEMS[itemId]) computed[itemId] = (computed[itemId] || 0) + amt;
        }
      }
    }
    for (const k of Object.keys(computed)) computed[k] = Math.round(computed[k] * 100) / 100;

    const result = { computed, branchName: branch.name, source: 'pl_live', from: FROM, to: TO };
    cache.set(cacheKey, result, 1800);

    // Persist to bills_cache so next load is instant (served from DB, not Zoho)
    try {
      const bc = (await readBillsCache()) || { computed: {}, syncedMonths: [], syncedAt: null, complete: false };
      if (!bc.computed[ym]) bc.computed[ym] = {};
      bc.computed[ym][branchId] = computed;
      if (!bc.syncedAt) bc.syncedAt = new Date().toISOString();
      await writeBillsCache(bc);
    } catch (_) {}

    return res.json(result);
  } catch (e) {
    console.error('[bills-actuals] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST quick-fetch-branch: fetch all FY months for ONE branch, save to bills_cache.json ──
// ~5 Zoho P&L calls (~10-15 seconds). Use when you need a specific branch's data immediately
// without waiting for the full 28-branch sync.
app.post('/api/budget/quick-fetch-branch', async (req, res) => {
  const { branchId } = req.body || {};
  if (!branchId) return res.status(400).json({ error: 'branchId required' });

  const branch = BUDGET_BRANCHES.find(b => b.id === branchId);
  if (!branch)            return res.status(400).json({ error: 'Unknown branchId' });
  if (!branch.zohoBranchId) return res.status(400).json({ error: 'Branch has no Zoho branch ID' });

  // Zoho auth check using lightweight non-report endpoint
  try {
    await zohoGet('/settings/currencies');
  } catch (e) {
    if (e.response?.status === 429) {
      const ra = e.response?.headers?.['retry-after'];
      return res.json({ ok: false, message: `Zoho rate-limited. Retry after ${ra}s.`, retry_after_seconds: parseInt(ra || '60', 10) });
    }
    return res.json({ ok: false, message: `Zoho API error: ${e.message}` });
  }

  const FY_START = '2026-04-01';
  const FY_END   = '2027-03-31';
  const todayStr = new Date().toISOString().slice(0, 10);
  const syncTo   = todayStr < FY_END ? todayStr : FY_END;

  // Build month list, most recent first (first result visible fastest)
  const allMonths = [];
  { let d = new Date('2026-04-01T00:00:00Z');
    while (d.toISOString().slice(0, 10) <= syncTo) {
      allMonths.push(d.toISOString().slice(0, 7));
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    }
  }
  allMonths.sort((a, b) => b.localeCompare(a));

  const mappings = await readBudgetMappings();
  const { nameToGroupId } = await getCoaData();

  const acctToItem = {};
  for (const [itemId, acctIds] of Object.entries(mappings)) {
    for (const aId of acctIds) {
      if (!acctToItem[aId]) acctToItem[aId] = [];
      acctToItem[aId].push(itemId);
    }
  }

  function extractPLv2(node, leafAmts, groupAmts) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(n => extractPLv2(n, leafAmts, groupAmts)); return; }
    if (node.account_name && nameToGroupId[node.account_name]) {
      const gid = nameToGroupId[node.account_name];
      const total = parseFloat(node.total || 0) || 0;
      if (total !== 0) groupAmts[gid] = (groupAmts[gid] || 0) + Math.abs(total);
      return;
    }
    if (node.account_id && node.is_child_present === false) {
      const total = parseFloat(node.total || 0) || 0;
      if (total !== 0) leafAmts[node.account_id] = (leafAmts[node.account_id] || 0) + total;
    }
    for (const v of Object.values(node)) if (typeof v === 'object' && v !== null) extractPLv2(v, leafAmts, groupAmts);
  }

  const bc = (await readBillsCache()) || { computed: {}, syncedMonths: [], syncedAt: null, complete: false };
  const fetchedMonths = [];
  const errors = {};

  for (const ym of allMonths) {
    const ymFrom = `${ym}-01`;
    const [yr, mo] = ym.split('-').map(Number);
    const ymTo = new Date(Date.UTC(yr, mo, 0)).toISOString().slice(0, 10);
    const effectiveTo = ymTo < syncTo ? ymTo : syncTo;

    try {
      const plResp = await zohoGet('/reports/profitandloss', {
        from_date: ymFrom, to_date: effectiveTo, branch_id: branch.zohoBranchId,
      });
      const leafAmts = {}, groupAmts = {};
      extractPLv2(plResp.profit_and_loss || plResp.profitandloss || plResp, leafAmts, groupAmts);

      const computed = {};
      for (const item of BUDGET_ITEMS) computed[item.id] = 0;

      for (const [gid, total] of Object.entries(groupAmts)) computed[gid] = total;
      for (const [aId, total] of Object.entries(leafAmts)) {
        const amt = Math.abs(total);
        if (acctToItem[aId]) {
          for (const itemId of acctToItem[aId]) {
            if (!GROUP_ITEMS[itemId]) computed[itemId] = (computed[itemId] || 0) + amt;
          }
        }
      }
      for (const k of Object.keys(computed)) computed[k] = Math.round(computed[k] * 100) / 100;

      if (!bc.computed[ym]) bc.computed[ym] = {};
      bc.computed[ym][branchId] = computed;
      fetchedMonths.push(ym);

      // Write after each month so data is available immediately
      bc.syncedAt = new Date().toISOString();
      await writeBillsCache(bc);
    } catch (e) {
      errors[ym] = e.message;
      if (e.response?.status === 429) {
        const ra = e.response?.headers?.['retry-after'];
        return res.json({ ok: false, message: `Rate-limited at ${ym}. Retry after ${ra}s.`, fetchedMonths, errors });
      }
    }

    await new Promise(ok => setTimeout(ok, 1200));
  }

  return res.json({ ok: true, branchName: branch.name, fetchedMonths, errors: Object.keys(errors).length ? errors : undefined });
});

// External form submission — CORS open so the shared Artifact form can POST from any browser
const CORS_OPEN = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
app.options('/api/budget/actuals/submit', (req, res) => res.set(CORS_OPEN).sendStatus(200));
app.post('/api/budget/actuals/submit', async (req, res) => {
  res.set(CORS_OPEN);
  const { ym, branchId, items } = req.body || {};
  if (!ym || !branchId || !items || typeof items !== 'object')
    return res.status(400).json({ error: 'Missing ym, branchId or items' });
  const all = await readBudgetActuals();
  if (!all[ym]) all[ym] = {};
  // Merge at item level — preserves entries already set by admin for this branch
  all[ym][branchId] = Object.assign({}, all[ym][branchId] || {}, items);
  await writeBudgetActuals(all);
  console.log(`[actuals-submit] ${branchId} / ${ym} saved`);
  res.json({ ok: true });
});

// ─── Actuals entry form (served at /actuals-form, no CORS issues) ─────────────
app.get('/actuals-form', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'actuals-form.html'));
});

// ── Vercel Cron: scheduled syncs (schedule lives in vercel.json) ──────────────
// Locally the in-process timers run these instead (startScheduler / startPocmScheduler).
// Vercel sends "Authorization: Bearer <CRON_SECRET>"; without CRON_SECRET set, always 401.
function cronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
app.get('/api/cron/sync', cronAuth, async (req, res) => {
  await syncEngine.runScheduledTick(); // logs its own errors
  cache.flushAll();
  // MSME companies after DevX, each on its own engine (a failure stays in that company's status)
  for (const [co, eng] of Object.entries(_companyEngines)) {
    await eng.runScheduledTick();
    companyCtx.run(co, () => cache.flushAll());
  }
  res.json({ ok: true });
});
app.get('/api/cron/pl', cronAuth, async (req, res) => {
  try {
    await plDailyRefresh('daily-cron'); // stops before Vercel's time limit; next run continues
    res.json({ ok: true, status: _plPrefetchStatus[currentFYTag()] || null });
  } catch (e) {
    console.error('[pl/daily-sync] Cron error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/cron/pocm', cronAuth, async (req, res) => {
  try {
    await pocmSync.ensureLoaded();   // Neon mode: the POCM store, before syncing onto it
    await pocmSync.syncAll({ trigger: 'scheduled' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[pocm-sync] Cron sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: Excel workbooks the server reads (Sync Monitor → Excel Files) ──────
// Office PC: read from the project folder (replace the file there). Neon (Vercel): the
// stored copy, replaced by uploading a new .xlsx here.
const WORKBOOK_INFO = {
  branch_seats: { label: 'Branch-wise Total Seats',   used_by: 'Occupancy & capacity',  file: () => BRANCH_SEATS_FILE },
  payroll:      { label: 'Group Salary Sheet',        used_by: 'Payroll Dashboard',     file: () => PAYROLL_WORKBOOK },
  loans:        { label: 'Loan Data',                 used_by: 'Loan Module',           file: () => LOAN_FILE },
  rent_module:  { label: 'Rent Recurring Module',     used_by: 'Rent report — Agreed',  file: () => { const p = require('./rent-agreed').pickLocalWorkbook(); return p ? path.join(__dirname, '..', p.f) : null; } },
};
const workbookUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

app.get('/api/admin/workbooks', authMiddleware, adminOnly, (req, res) => {
  res.json({
    mode: db.USE_DB ? 'database' : 'files',
    workbooks: workbooks.KEYS.map(key => {
      const info = WORKBOOK_INFO[key];
      if (db.USE_DB) {
        const s = workbooks.stored(key);
        return { key, label: info.label, used_by: info.used_by, name: s?.name || null, size: s?.size || null, updated_at: s ? new Date(s.mtime).toISOString() : null };
      }
      const f = info.file();
      const st = f && fs.existsSync(f) ? fs.statSync(f) : null;
      return { key, label: info.label, used_by: info.used_by, name: st ? path.basename(f) : null, size: st?.size || null, updated_at: st ? st.mtime.toISOString() : null };
    }),
  });
});

app.post('/api/admin/workbooks/:key', authMiddleware, adminOnly, (req, res, next) => {
  workbookUpload.single('file')(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 4 MB' : err.message });
    next();
  });
}, async (req, res) => {
  const { key } = req.params;
  if (!workbooks.KEYS.includes(key)) return res.status(400).json({ error: `Unknown workbook: ${key}` });
  if (!db.USE_DB) return res.status(409).json({ error: 'On the office PC the dashboard reads this Excel file from the project folder — replace the file there.' });
  if (!req.file || !/\.xlsx$/i.test(req.file.originalname)) return res.status(400).json({ error: 'Choose an .xlsx file' });
  try { XLSX.read(req.file.buffer, { type: 'buffer' }); }
  catch { return res.status(400).json({ error: 'This file could not be read as an Excel workbook' }); }
  try {
    await workbooks.save(key, req.file.originalname, req.file.buffer);
    cache.flushAll();   // reports built from this sheet recompute
    const s = workbooks.stored(key);
    res.json({ ok: true, key, name: s.name, size: s.size, updated_at: new Date(s.mtime).toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: Sync status (read-only) ────────────────────────────────────────────
app.get('/api/admin/sync/status', authMiddleware, adminOnly, async (req, res) => {
  try {
    res.json(await syncEngine.getSyncStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: Sync Now — one entity (+ dependents) or all, waits for completion ──
// Kept for back-compat; the Sync Monitor uses /run + /progress.
app.post('/api/admin/sync/now', authMiddleware, adminOnly, async (req, res) => {
  const { entity } = req.body || {};
  try {
    const result = entity
      ? await syncEngine.syncEntity(entity)
      : await syncEngine.syncRun({ mode: 'normal', trigger: 'manual' });
    if (result?.status === 'busy') return res.status(409).json({ error: 'A sync is already running', run_id: result.run_id });
    cache.flushAll(); // clear in-memory node-cache so next request reads fresh synced data
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: Full Re-Sync — legacy name for Full Sync Data (full re-fetch of every entity) ─
app.post('/api/admin/sync/full-resync', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await syncEngine.syncRun({ mode: 'full', trigger: 'manual' });
    if (result?.status === 'busy') return res.status(409).json({ error: 'A sync is already running', run_id: result.run_id });
    cache.flushAll();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: start a sync run in the background (poll /progress) ─────────────────
// body: { mode: normal|recheck|full|full_refresh, entity?, confirm? }
app.post('/api/admin/sync/run', authMiddleware, adminOnly, async (req, res) => {
  const { mode = 'normal', entity } = req.body || {};
  if (!syncEngine.MODES[mode]) return res.status(400).json({ error: `Unknown mode: ${mode}` });
  if (entity && !syncEngine.ENTITY_DEFS[entity]) return res.status(400).json({ error: `Unknown entity: ${entity}` });
  if (mode === 'full_refresh' && !entity && req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Full Data Refresh requires confirm: true' });
  }
  const elsewhere = await syncEngine.sharedRunning();   // Neon: a run on another Vercel instance
  if (elsewhere) return res.status(409).json({ error: 'A sync is already running', run_id: elsewhere.run_id });
  const onComplete = () => cache.flushAll();
  const r = entity
    ? syncEngine.startRun({ mode, trigger: 'entity', entities: syncEngine.withDependents(entity), onComplete })
    : syncEngine.startRun({ mode, trigger: 'manual', onComplete });
  if (r.status === 'busy') return res.status(409).json({ error: 'A sync is already running', run_id: r.run_id });
  res.status(202).json(r);
});

// ── Admin: remove records deleted in Zoho (targeted correction) ───────────────
// Body: { records: { bills_fy: [ids], vendor_payments_fy: [ids], vendor_credits_all: [ids], … } }.
// Each record is re-checked by ID and removed only when Zoho reports it does not exist; the
// derived entities built from those caches (e.g. MSME Form-1 settlements) are then rebuilt.
app.post('/api/admin/sync/remove-deleted', authMiddleware, adminOnly, async (req, res) => {
  const records = req.body?.records;
  if (!records || typeof records !== 'object' || !Object.keys(records).length) {
    return res.status(400).json({ error: 'records required: { entity: [record ids] }' });
  }
  for (const [k, ids] of Object.entries(records)) {
    const def = syncEngine.ENTITY_DEFS[k];
    if (!def || def.run || !def.idField) return res.status(400).json({ error: `Not a Zoho list entity: ${k}` });
    if (!Array.isArray(ids) || !ids.length || ids.length > 300) return res.status(400).json({ error: `${k}: 1–300 record IDs required` });
  }
  const elsewhere = await syncEngine.sharedRunning();
  if (elsewhere) return res.status(409).json({ error: 'A sync is already running', run_id: elsewhere.run_id });
  try {
    const entry = await syncEngine.removeDeletedRecords(records, { trigger: 'manual' });
    cache.flushAll();
    const changed = Object.values(entry.entities).filter(r => r.removed > 0).map(r => r.entity);
    // Only derived entities already built: one never synced has nothing stale (and its first build is a full one)
    const st = (await syncEngine.getSyncStatus()).entities;
    const derived = [...new Set(changed.flatMap(k => syncEngine.withDependents(k)))]
      .filter(k => syncEngine.ENTITY_DEFS[k]?.run && st[k]?.last_synced_at);
    const rebuild = derived.length
      ? { entities: derived, ...syncEngine.startRun({ mode: 'normal', trigger: 'entity', entities: derived, onComplete: () => cache.flushAll() }) }
      : null;
    res.json({ ...entry, rebuild });
  } catch (e) {
    console.error('[sync] remove-deleted:', e.message);
    res.status(e.busy ? 409 : e.response?.status === 429 ? 429 : 500).json({ error: e.response?.data?.message || e.message });
  }
});

// ── Admin: retry a failed entity (same mode it failed in) ─────────────────────
app.post('/api/admin/sync/retry', authMiddleware, adminOnly, async (req, res) => {
  const { entity } = req.body || {};
  if (!syncEngine.ENTITY_DEFS[entity]) return res.status(400).json({ error: `Unknown entity: ${entity}` });
  const elsewhere = await syncEngine.sharedRunning();
  if (elsewhere) return res.status(409).json({ error: 'A sync is already running', run_id: elsewhere.run_id });
  const r = syncEngine.startRetry(entity, () => cache.flushAll());
  if (r.status === 'busy') return res.status(409).json({ error: 'A sync is already running', run_id: r.run_id });
  res.status(202).json(r);
});

// ── Admin: live progress of the current / last run (never triggers a sync) ───
app.get('/api/admin/sync/progress', authMiddleware, adminOnly, async (req, res) => {
  res.json(await syncEngine.getSharedProgress());
});

// ── Data freshness for dashboards ("Data as of …") — any signed-in user ───────
app.get('/api/sync/freshness', authMiddleware, async (req, res) => {
  try { res.json(await syncEngine.getFreshness()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin: Invoice sub_total enrichment status + manual trigger ───────────────
app.get('/api/admin/invoice-subtotals/status', authMiddleware, adminOnly, (req, res) => {
  res.json({ cached: Object.keys(_invSubTotals).length, enriching: _enrichingNow });
});
app.post('/api/admin/invoice-subtotals/refresh', authMiddleware, adminOnly, async (req, res) => {
  if (_enrichingNow) return res.status(409).json({ message: 'Enrichment already in progress' });
  const { start: fyStart, end: fyEnd } = getFYRange();
  let invoices;
  try {
    const r = await syncEngine.getSyncedOrFetch(
      'invoices_fy',
      () => zohoGetAll('/invoices', 'invoices', { filter_by: 'Status.All' }, { dateFrom: fyStart, dateTo: fyEnd })
    );
    invoices = r.data || [];
  } catch (e) { return res.status(500).json({ error: e.message }); }
  // Force-clear map so ALL invoices are re-enriched (full refresh)
  if (req.body?.full) _invSubTotals = {};
  const toFetch = invoices.filter(i => i.invoice_id && _invSubTotals[i.invoice_id] == null).length;
  background(enrichSubTotalsBackground(invoices).catch(() => {}));
  res.json({ message: `Sub_total enrichment started for ${toFetch} invoices`, total: invoices.length });
});

// ── Admin: Sync run log ────────────────────────────────────────────────────────
app.get('/api/admin/sync/log', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { run_log } = await syncEngine.getSyncStatus();
    res.json(run_log);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Neon mode (Vercel): steps 7, 8 and 15 read their documents from memory (fpa-store.js),
// refreshed here with anything changed since the last request
const fpaStore = require('./fpa-store');
app.use(['/api/fpa/step15', '/api/fpa/step8', '/api/fpa/step7'], (req, res, next) => {
  fpaStore.ensureLoaded().then(() => next(), e => res.status(503).json({ error: `FP&A data could not be loaded: ${e.message}` }));
});

// ─── FP&A Step 15 — Management Data Completion & Forecast Activation ──────────
app.use('/api/fpa/step15', require('./step15'));

// ─── FP&A Step 8 — Data Closure, Live Zoho Validation & Final UAT ─────────────
app.use('/api/fpa/step8', require('./fpa-step8'));

// ─── FP&A Step 7 — Data Completion & Migration Readiness ─────────────────────
app.use('/api/fpa/step7', require('./fpa-step7'));

// ─── FP&A Integrated Financial Statements (Step 6 — PARALLEL MODEL — must mount first) ─
app.use('/api/fpa/integrated', require('./fpa-integrated'));

// ─── FP&A Cost/EBITDA/Capex Engine (Step 5 — must mount before /api/fpa) ──────
app.use('/api/fpa/cost', require('./fpa-cost'));

// ─── FP&A Revenue Projection Engine (Step 4 — must mount before /api/fpa) ─────
app.use('/api/fpa/projection', require('./fpa-projection'));

// ─── FP&A Actual Revenue routes (Step 3 — must mount before /api/fpa) ─────────
app.use('/api/fpa/revenue', require('./fpa-revenue'));

// ─── FP&A Master Data routes (Step 2 — isolated from production calculations) ─
app.use('/api/fpa', require('./fpa-routes'));

// ─── POCM Sync & Quarter Freeze endpoints ─────────────────────────────────────

// GET /api/pocm/sync/status — coverage by FY, last sync, next scheduled run
app.get('/api/pocm/sync/status', authMiddleware, async (req, res) => {
  try { res.json(await pocmSync.getSyncStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pocm/sync/now — incremental sync for one FY or all relevant FYs (admin)
app.post('/api/pocm/sync/now', authMiddleware, adminOnly, async (req, res) => {
  const { fy } = req.body || {};
  try {
    const result = fy
      ? await pocmSync.syncFY(parseInt(fy))
      : await pocmSync.syncAll({ trigger: 'manual' });
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pocm/sync/full — full re-sync (admin, clears existing cache for selected FYs)
app.post('/api/pocm/sync/full', authMiddleware, adminOnly, async (req, res) => {
  const { fy } = req.body || {};
  try {
    const result = fy
      ? await pocmSync.syncFY(parseInt(fy), { full: true })
      : await pocmSync.syncAll({ full: true, trigger: 'full_resync' });
    res.json({ ok: true, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/pocm/sync/mapping-exceptions — unmapped project transactions
app.get('/api/pocm/sync/mapping-exceptions', authMiddleware, async (req, res) => {
  try { res.json(await pocmSync.getMappingExceptions()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Quarter locks ────────────────────────────────────────────────────────────

// GET /api/pocm/quarters/locks — all lock state
app.get('/api/pocm/quarters/locks', authMiddleware, async (req, res) => {
  try { res.json(await pocmSync.getQuarterLocks()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pocm/quarters/lock — lock a quarter and capture snapshot
app.post('/api/pocm/quarters/lock', authMiddleware, adminOnly, async (req, res) => {
  const { fy, quarter, reason, snapshot } = req.body || {};
  if (!fy || !quarter) return res.status(400).json({ error: 'fy and quarter are required' });
  try {
    const result = await pocmSync.lockQuarter(
      parseInt(fy), parseInt(quarter),
      req.user?.username || 'admin',
      reason || '',
      snapshot || null
    );
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/pocm/quarters/unlock — unlock with mandatory reason
app.post('/api/pocm/quarters/unlock', authMiddleware, adminOnly, async (req, res) => {
  const { fy, quarter, reason } = req.body || {};
  if (!fy || !quarter) return res.status(400).json({ error: 'fy and quarter are required' });
  try {
    const result = await pocmSync.unlockQuarter(
      parseInt(fy), parseInt(quarter),
      req.user?.username || 'admin',
      reason || ''
    );
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// GET /api/pocm/quarters/snapshot?fy=&quarter= — retrieve frozen snapshot data
app.get('/api/pocm/quarters/snapshot', authMiddleware, async (req, res) => {
  const { fy, quarter } = req.query;
  if (!fy || !quarter) return res.status(400).json({ error: 'fy and quarter are required' });
  try {
    const snap = await pocmSync.getSnapshot(parseInt(fy), parseInt(quarter));
    if (!snap) return res.status(404).json({ error: 'No snapshot found for this quarter' });
    res.json(snap);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Compliance Dashboard (tasks, masters, documents, period Zoho sync) ───────
// Self-contained module — see server/compliance/ and "Compliance Dashboard/FILE_MAP.md"
app.use('/api/compliance', require('./compliance'));

// ─── Serve React build (must be after all API routes) ─────────────────────────

const buildPath = path.join(__dirname, '..', 'client', 'build');

// Never cache index.html so the browser always gets the latest JS bundle hash.
// Hashed JS/CSS assets are safe to cache forever (content-addressed).
app.use(express.static(buildPath, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(buildPath, 'index.html'));
});

const PORT = process.env.PORT || 3002;
db.initDB()
  .then(async () => {
    // Load persisted invoice sub_totals (detail-fetched) so revenue KPIs are accurate on startup
    await _loadInvSubTotals();
    await workbooks.preload(); // Neon mode: stored Excel copies (office PC reads the files)

    // Initialise POCM sync module — injects dependencies and pre-loads disk cache into node-cache
    pocmSync.init(_rawCache, _zoho.zohoGet, _zoho.zohoGetAll);
    pocmSync.preloadAtStartup();
    _devxSyncEngine.init(_zoho.zohoGetAll, _zoho.zohoGet);
    // MSME companies: their engines read only their own Zoho organisation
    for (const [co, eng] of Object.entries(_companyEngines)) {
      const z = companyCtx.companyZoho(_zoho, co);
      eng.init(z.zohoGetAll, z.zohoGet);
    }
    _markReady();

    // Vercel runs the app as a function: no port, no timers, no start-up sync.
    // Vercel Cron calls /api/cron/sync and /api/cron/pocm instead (see vercel.json).
    if (IS_VERCEL) return;

    // POCM has its own dedicated 11PM IST daily scheduler (separate from main sync engine)
    pocmSync.startPocmScheduler();
    // MSME Vendor Master (MSME Sector → Major Activity) is now the sync entity
    // 'vendor_msme_master' (stage 4), so it runs inside every sync instead of as a post-sync hook.

    app.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://localhost:${PORT}`));
    syncEngine.startScheduler();
    // Complete initial sync of newly introduced entities (Vendors — All, Vendor Credits, …)
    setTimeout(() => {
      syncEngine.ensureInitialSync()
        .then(r => { if (r && r.run_id) cache.flushAll(); })
        .catch(e => console.error('[sync] initial sync error:', e.message));
    }, 60000);
    // Vendor Payment Report: continue a first-build backlog the previous process left (it waits for any sync run)
    setTimeout(() => vendorPaymentReport.resume().catch(e => console.error('[vendor-payment-report] resume:', e.message)), 120000);
    // MSME companies: own scheduler (a few minutes after DevX) and own first full sync. A failure
    // there is logged and stays in that company's sync status — DevX is not affected.
    for (const [co, eng] of Object.entries(_companyEngines)) {
      eng.startScheduler();
      setTimeout(() => {
        eng.ensureInitialSync()
          .then(r => { if (r && r.run_id) companyCtx.run(co, () => cache.flushAll()); })
          .catch(e => console.error(`[sync:${co}] initial sync error:`, e.message));
      }, 90000);
    }
  })
  .catch(err => {
    console.error('[db] initDB failed:', err.message);
    if (IS_VERCEL) _markReady(); // let requests through so they fail visibly instead of hanging
    else process.exit(1);
  });

// Vercel imports the app from api/index.js; `node server/index.js` ignores this.
module.exports = app;
