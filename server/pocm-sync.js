/**
 * POCM Sync Module — Needle And Thread Designs LLP (NT org)
 * Organization ID: 60007894213
 *
 * Handles scheduled + manual data synchronization for the POCM dashboard.
 * Extends the centralized sync-engine (sync-engine.js) with NT-org-specific
 * entities: bills (with line items), invoices, and vendor credits.
 *
 * Storage: server/pocm_disk_cache/<key>.json  (survives restarts)
 * Coverage: server/pocm_sync_coverage.json
 * Quarter locks: server/pocm_quarter_locks.json
 * Run log: appended to the main sync_run_log.json via sync-engine helpers
 *
 * Design rules
 * ─────────────
 * • A browser action NEVER triggers a full historical Zoho fetch.
 * • Scheduled sync runs independently of browser/login activity.
 * • Incremental sync fetches only records modified since the last checkpoint.
 * • Coverage distinguishes: success / partial / failed / never_synced.
 * • Locked quarters return their frozen snapshot; live data is NOT substituted.
 * • No credentials or raw Zoho payloads appear in API responses.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const db   = require('./db');
const { background } = require('./background');

// ── Constants ────────────────────────────────────────────────────────────────
const NT_ORG_ID    = '60007894213';
const CACHE_DIR    = path.join(__dirname, 'pocm_disk_cache');
const COVERAGE_FILE = path.join(__dirname, 'pocm_sync_coverage.json');
const LOCKS_FILE    = path.join(__dirname, 'pocm_quarter_locks.json');
const SNAPSHOTS_DIR = path.join(__dirname, 'pocm_snapshots');

// Node-cache instance injected from index.js
let _nodeCache   = null;
let _zohoGet     = null;
let _zohoGetAll  = null;
let _syncInFlight = new Set(); // prevents concurrent runs for same FY+entity
let _runInProgress = false;    // a syncAll run is active (spans the gaps between entities)

// Zoho rejects "YYYY-MM-DD HH:MM:SS" for last_modified_time (HTTP 400, code 2);
// it needs ISO 8601 with an offset.
function zohoLmtParam(date) { return date.toISOString().slice(0, 19) + '+0000'; }

// Next 23:00 IST (= 17:30 UTC) after `now`
function nextPocmRun(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(17, 30, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

// Cross-process lock (a manual one-off run and the server must not sync the same store at once).
// Neon mode (Vercel) has no shared disk; the in-process _syncInFlight guard still applies.
function acquireFileLock(file) {
  if (db.USE_DB) return true;
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    let alive = false;
    try { process.kill(cur.pid, 0); alive = true; } catch (_) {}
    if (alive && cur.pid !== process.pid && Date.now() - cur.at < 6 * 3600000) return false;
  } catch (_) {}
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }));
  return true;
}
function releaseFileLock(file) {
  if (db.USE_DB) return;
  try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch (_) {}
}

// Bill detail fetch concurrency (ms between sequential calls)
const BILL_DETAIL_GAP_MS = 1200;

// FYs to keep in sync — rebuilt at runtime from project start dates
// plus a rolling window of the last 4 FYs
const OVERLAP_DAYS = 2; // re-fetch this many calendar days of data to catch edits near the cutoff

try { fs.mkdirSync(CACHE_DIR,    { recursive: true }); } catch (_) {} // read-only disk on Vercel
try { fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true }); } catch (_) {}

// ── Dependency injection ─────────────────────────────────────────────────────
function init(nodeCache, zohoGet, zohoGetAll) {
  _nodeCache  = nodeCache;
  _zohoGet    = zohoGet;
  _zohoGetAll = zohoGetAll;
}

// ── Coverage helpers ─────────────────────────────────────────────────────────
async function readCoverage() {
  return db.readJSON('pocm_sync_coverage', COVERAGE_FILE, {});
}

async function writeCoverage(data) {
  await db.writeJSON('pocm_sync_coverage', COVERAGE_FILE, data);
}

async function setCoverage(fyFrom, entity, update) {
  const cov = await readCoverage();
  if (!cov[fyFrom]) cov[fyFrom] = {};
  cov[fyFrom][entity] = { ...(cov[fyFrom][entity] || {}), ...update, fy_from: fyFrom, entity };
  if (update.status === 'success') { delete cov[fyFrom][entity].error; delete cov[fyFrom][entity].failed_at; }
  await writeCoverage(cov);
}

// ── Quarter lock helpers ─────────────────────────────────────────────────────
async function readLocks() {
  return db.readJSON('pocm_quarter_locks', LOCKS_FILE, {});
}
async function writeLocks(data) {
  await db.writeJSON('pocm_quarter_locks', LOCKS_FILE, data);
}

function lockKey(fy, quarter) { return `${fy}_Q${quarter}`; }

async function isQuarterLocked(fy, quarter) {
  const locks = await readLocks();
  return !!(locks[lockKey(fy, quarter)]?.locked);
}

// ── Cache file helpers ───────────────────────────────────────────────────────
// Office PC: JSON files in pocm_disk_cache/. Neon mode (Vercel): kv_store
// 'pocm_cache_<key>' = { saved_at, data }, held in memory once ensureLoaded() has run
// (the POCM routes and syncs call it), so these helpers stay synchronous.
const NEON_PREFIX     = 'pocm_cache_';
const NEON_RECHECK_MS = 10 * 60 * 1000;   // pick up writes made by other Vercel instances
let _neon = null;                          // key → { saved_at, data }
let _neonLoadedAt = 0;
let _neonLoading  = null;
const _neonWrites = {};                    // key → promise chain, so writes land in order

async function ensureLoaded() {
  if (!db.USE_DB) return;
  if (_neon && Date.now() - _neonLoadedAt < NEON_RECHECK_MS) return;
  if (!_neonLoading) {
    _neonLoading = (async () => {
      const map = {};
      for (const { key } of await db.listKeys(NEON_PREFIX)) {
        const doc = await db.readJSON(key, null, null);
        if (doc) map[key.slice(NEON_PREFIX.length)] = doc;
      }
      _neon = map;
      _neonLoadedAt = Date.now();
      for (const [key, doc] of Object.entries(map)) warmNodeCache(key, doc.data, 86400);
    })().finally(() => { _neonLoading = null; });
  }
  await _neonLoading;
}

function cacheFile(key) { return path.join(CACHE_DIR, `${key}.json`); }

function readDiskCache(key) {
  if (db.USE_DB) return _neon?.[key]?.data ?? null;
  try {
    const raw = fs.readFileSync(cacheFile(key), 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function writeDiskCache(key, data) {
  if (db.USE_DB) {
    const doc = { saved_at: Date.now(), data };
    if (_neon) _neon[key] = doc;
    _neonWrites[key] = (_neonWrites[key] || Promise.resolve())
      .then(() => db.writeJSON(NEON_PREFIX + key, null, doc))
      .catch(e => console.warn(`[pocm-sync] save failed for ${key}: ${e.message}`));
    background(_neonWrites[key]);
    return;
  }
  try { fs.writeFileSync(cacheFile(key), JSON.stringify(data), 'utf8'); } catch (_) {}
}

function removeDiskCache(key) {
  if (db.USE_DB) {
    if (_neon) delete _neon[key];
    _neonWrites[key] = (_neonWrites[key] || Promise.resolve())
      .then(() => db.deleteKey(NEON_PREFIX + key)).catch(() => {});
    background(_neonWrites[key]);
    return;
  }
  try { fs.unlinkSync(cacheFile(key)); } catch (_) {}
}

// When the cache was last written (ms), or 0 if it doesn't exist
function diskCacheSavedAt(key) {
  if (db.USE_DB) return _neon?.[key]?.saved_at || 0;
  try { return fs.statSync(cacheFile(key)).mtimeMs; } catch (_) { return 0; }
}

function warmNodeCache(key, data, ttlSecs) {
  if (_nodeCache) {
    try { _nodeCache.set(key, data, ttlSecs); } catch (_) {}
  }
}

// ── FY utilities ─────────────────────────────────────────────────────────────
function fyFromDate(fy) { return `${fy}-04-01`; }
function fyToDate(fy)   { return `${fy + 1}-03-31`; }
function dateToFY(dateStr) {
  const m = parseInt(dateStr.slice(5, 7));
  const y = parseInt(dateStr.slice(0, 4));
  return m >= 4 ? y : y - 1;
}

/** Returns all FYs to sync: project start FYs + last 4 rolling FYs */
async function relevantFYs() {
  const now = new Date();
  const curFY = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;

  // Collect from project master
  const projFile = path.join(__dirname, 'pocm_projects.json');
  let minFY = curFY - 3;
  try {
    const projects = (await db.readJSON('pocm_projects', projFile, [])) || [];
    for (const p of (Array.isArray(projects) ? projects : [])) {
      if (p.startDate) minFY = Math.min(minFY, dateToFY(p.startDate));
    }
  } catch (_) {}

  const fys = [];
  for (let fy = minFY; fy <= curFY; fy++) fys.push(fy);
  return fys;
}

// ── COA / category helpers (mirrored from index.js, kept in sync) ────────────
// These are duplicated here so pocm-sync.js is self-contained for background
// scheduled runs that don't have the full Express context.
let _cachedNameMap = null;
async function getNameCategoryMap() {
  if (_cachedNameMap) return _cachedNameMap;
  const mappingFile = path.join(__dirname, 'pocm_mapping.json');
  let mapping = {};
  try { mapping = (await db.readJSON('pocm_mapping', mappingFile, {})) || {}; } catch (_) {}

  const nameMap = {};
  for (const [accountName, category] of Object.entries(mapping.accountCategories || {})) {
    nameMap[accountName.toLowerCase().trim()] = category;
  }
  _cachedNameMap = nameMap;
  return nameMap;
}

function isCOGS(name) { return (name || '').toLowerCase().includes('cost of goods sold'); }
function overheadCat(name, nameMap) { return nameMap[(name || '').toLowerCase().trim()] || null; }

// ── Core: sync bills for one FY (incremental or full) ───────────────────────
async function syncBillsFY(fy, opts = {}) {
  const fromDate  = fyFromDate(fy);
  const toDate    = fyToDate(fy);
  const cacheKey  = `pocm-bills-v8-${fromDate}`;
  const lockId    = `bills-${fromDate}`;

  if (_syncInFlight.has(lockId)) {
    return { status: 'skipped', reason: 'already_in_progress' };
  }
  _syncInFlight.add(lockId);
  const t0 = Date.now();

  try {
    const nameMap   = await getNameCategoryMap();
    const existing  = opts.full ? null : readDiskCache(cacheKey);    // null = full re-fetch
    const lastSync  = (await readCoverage())[fromDate]?.bills?.synced_at;

    // Build fetch params — incremental uses last_modified_time if supported
    const listParams = { organization_id: NT_ORG_ID, sort_column: 'date', sort_order: 'D' };
    if (existing && lastSync && !opts.full) {
      // Overlap window: re-fetch records modified in the last OVERLAP_DAYS days from the checkpoint
      const overlapDate = new Date(new Date(lastSync).getTime() - OVERLAP_DAYS * 86400000);
      listParams.last_modified_time = zohoLmtParam(overlapDate);
    } else {
      // Full fetch for the FY date range
      listParams.date_start = fromDate;
      listParams.date_end   = toDate;
    }

    console.log(`[pocm-sync] bills ${fy}-${fy + 1}: ${opts.full || !lastSync ? 'FULL' : 'incremental'} fetch`);
    const billList = await _zohoGetAll('/bills', 'bills', listParams,
      { maxPages: 30, dateField: 'date', dateFrom: fromDate, dateTo: toDate });

    const active = billList.filter(b => (b.status || '').toLowerCase() !== 'void');
    console.log(`[pocm-sync] bills ${fy}-${fy + 1}: ${active.length} active bills to process`);

    // For incremental: start from existing cache, then upsert changed bills
    // For full: start from scratch
    const entryMap = {}; // bill_id -> array of mapped entries
    if (existing && !opts.full) {
      for (const e of existing) {
        if (!entryMap[e.bill_id]) entryMap[e.bill_id] = [];
        entryMap[e.bill_id].push(e);
      }
    }

    let detailsFetched = 0;
    for (let i = 0; i < active.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, BILL_DETAIL_GAP_MS));
      const b = active[i];
      try {
        const d    = await _zohoGet(`/bills/${b.bill_id}`, { organization_id: NT_ORG_ID });
        const bill = d.bill || {};
        detailsFetched++;

        // Build the line-item entries for this bill (same logic as index.js)
        const newEntries = [];
        const billProject = (bill.project_name ||
          bill.custom_field_hash?.cf_project_formatted ||
          bill.custom_field_hash?.cf_project || '').trim();

        for (const li of (bill.line_items || [])) {
          const isCogs    = isCOGS(li.account_name);
          const ohCat     = overheadCat(li.account_name, nameMap);
          if (!isCogs && !ohCat) continue;

          const liProject      = (li.project_name || '').trim();
          const effectiveProj  = liProject || billProject;
          const amount         = parseFloat(li.item_total) || 0;
          if (amount <= 0) continue;

          newEntries.push({
            bill_id:      b.bill_id,
            bill_number:  bill.bill_number || b.bill_number || b.bill_id,
            vendor:       bill.vendor_name || b.vendor_name || '',
            date:         bill.date || b.date || '',
            bill_project: effectiveProj,
            _category:    isCogs ? 'projectCost' : ohCat,
            _last_modified: bill.last_modified_time || b.last_modified_time || '',
            line_items: [{
              account_name:            li.account_name,
              project_name:            effectiveProj,
              item_total:              amount,
              description:             li.description || li.name || '',
              quantity:                li.quantity || 0,
              rate:                    li.rate || 0,
              cf_project_sub_category: li.cf_project_sub_category || '',
            }],
          });
        }
        entryMap[b.bill_id] = newEntries; // replace or add
      } catch (err) {
        if (err.message?.startsWith('ZOHO_DAILY_LIMIT')) throw err;
        console.warn(`[pocm-sync] bill detail ${b.bill_id} failed: ${err.message}`);
      }
      if ((i + 1) % 20 === 0) console.log(`[pocm-sync] bills ${fy}: ${i + 1}/${active.length} processed`);
    }

    // Also fetch direct expenses (list-only, no detail call needed)
    const expenses = await _zohoGetAll('/expenses', 'expenses',
      { organization_id: NT_ORG_ID, date_start: fromDate, date_end: toDate },
      { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 10 });

    for (const exp of expenses) {
      const isCogs  = isCOGS(exp.account_name);
      const ohCat   = overheadCat(exp.account_name, nameMap);
      if (!isCogs && !ohCat) continue;
      const amount = parseFloat(exp.total) || parseFloat(exp.amount) || 0;
      if (amount <= 0) continue;
      entryMap[exp.expense_id] = [{
        bill_id:      exp.expense_id,
        bill_number:  exp.expense_id,
        vendor:       exp.vendor_name || exp.paid_through_account_name || '',
        date:         exp.date || '',
        bill_project: (exp.project_name || '').trim(),
        _category:    isCogs ? 'projectCost' : ohCat,
        _last_modified: exp.last_modified_time || '',
        line_items: [{
          account_name: exp.account_name,
          project_name: (exp.project_name || '').trim(),
          item_total:   amount,
          description:  exp.description || '',
          quantity:     1,
          rate:         amount,
        }],
      }];
    }

    const allEntries = Object.values(entryMap).flat();
    const dur = Date.now() - t0;

    // Persist to disk and node-cache
    writeDiskCache(cacheKey, allEntries);
    warmNodeCache(cacheKey, allEntries, 14400);

    await setCoverage(fromDate, 'bills', {
      status:        'success',
      synced_at:     new Date().toISOString(),
      record_count:  allEntries.length,
      bills_fetched: active.length,
      details_fetched: detailsFetched,
      duration_ms:   dur,
      mode:          (opts.full || !lastSync) ? 'full' : 'incremental',
    });

    console.log(`[pocm-sync] bills ${fy}: done — ${allEntries.length} entries, ${dur}ms`);
    return { status: 'success', record_count: allEntries.length, duration_ms: dur };

  } catch (err) {
    await setCoverage(fromDate, 'bills', {
      status: 'failed', error: err.message, failed_at: new Date().toISOString(),
    });
    console.error(`[pocm-sync] bills ${fy} FAILED:`, err.message);
    return { status: 'failed', error: err.message };
  } finally {
    _syncInFlight.delete(lockId);
  }
}

// ── Core: sync invoices for one FY ──────────────────────────────────────────
async function syncInvoicesFY(fy, opts = {}) {
  const fromDate = fyFromDate(fy);
  const toDate   = fyToDate(fy);
  const cacheKey = `pocm-invoices-v5-${fromDate}`;
  const lockId   = `invoices-${fromDate}`;

  if (_syncInFlight.has(lockId)) return { status: 'skipped', reason: 'already_in_progress' };
  _syncInFlight.add(lockId);
  const t0 = Date.now();

  try {
    const existing = opts.full ? null : readDiskCache(cacheKey);
    const lastSync = (await readCoverage())[fromDate]?.invoices?.synced_at;

    const listParams = { organization_id: NT_ORG_ID, sort_column: 'date', sort_order: 'D' };
    if (existing && lastSync && !opts.full) {
      const overlapDate = new Date(new Date(lastSync).getTime() - OVERLAP_DAYS * 86400000);
      listParams.last_modified_time = zohoLmtParam(overlapDate);
    } else {
      listParams.date_start = fromDate;
      listParams.date_end   = toDate;
    }

    const invoices = await _zohoGetAll('/invoices', 'invoices', listParams,
      { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 10 });

    const active = invoices.filter(inv => !['void', 'draft'].includes((inv.status || '').toLowerCase()));

    // Upsert by invoice_id into existing dataset
    const invMap = {};
    if (existing && !opts.full) {
      for (const inv of existing) invMap[inv.invoice_id] = inv;
    }
    for (const inv of active) {
      invMap[inv.invoice_id] = {
        invoice_id:     inv.invoice_id,
        invoice_number: inv.invoice_number || inv.invoice_id,
        customer:       inv.customer_name || '',
        date:           inv.date || '',
        inv_project:    (inv.project_name || '').trim(),
        _last_modified: inv.last_modified_time || '',
        line_items: [{
          project_name: (inv.project_name || '').trim(),
          item_total:   parseFloat(inv.sub_total || inv.total) || 0,
          description:  inv.reference_number || '',
          quantity:     1,
          rate:         parseFloat(inv.sub_total || inv.total) || 0,
        }],
      };
    }

    const allDetails = Object.values(invMap)
      .filter(inv => inv.date >= fromDate && inv.date <= toDate);
    const dur = Date.now() - t0;

    writeDiskCache(cacheKey, allDetails);
    warmNodeCache(cacheKey, allDetails, 7200);

    await setCoverage(fromDate, 'invoices', {
      status: 'success', synced_at: new Date().toISOString(),
      record_count: allDetails.length, duration_ms: dur,
      mode: (opts.full || !lastSync) ? 'full' : 'incremental',
    });

    console.log(`[pocm-sync] invoices ${fy}: done — ${allDetails.length} entries, ${dur}ms`);
    return { status: 'success', record_count: allDetails.length, duration_ms: dur };

  } catch (err) {
    await setCoverage(fromDate, 'invoices', {
      status: 'failed', error: err.message, failed_at: new Date().toISOString(),
    });
    console.error(`[pocm-sync] invoices ${fy} FAILED:`, err.message);
    return { status: 'failed', error: err.message };
  } finally {
    _syncInFlight.delete(lockId);
  }
}

// ── Core: sync vendor credits for one FY ─────────────────────────────────────
async function syncVendorCreditsFY(fy, opts = {}) {
  const fromDate = fyFromDate(fy);
  const toDate   = fyToDate(fy);
  const cacheKey = `pocm-vendorcredits-v1-${fromDate}`;
  const lockId   = `vc-${fromDate}`;

  if (_syncInFlight.has(lockId)) return { status: 'skipped', reason: 'already_in_progress' };
  _syncInFlight.add(lockId);
  const t0 = Date.now();

  try {
    const nameMap  = await getNameCategoryMap();
    const existing = opts.full ? null : readDiskCache(cacheKey);
    const lastSync = (await readCoverage())[fromDate]?.vendor_credits?.synced_at;

    const listParams = { organization_id: NT_ORG_ID, sort_column: 'date', sort_order: 'D' };
    if (existing && lastSync && !opts.full) {
      const overlapDate = new Date(new Date(lastSync).getTime() - OVERLAP_DAYS * 86400000);
      listParams.last_modified_time = zohoLmtParam(overlapDate);
    } else {
      listParams.date_start = fromDate;
      listParams.date_end   = toDate;
    }

    const credits = await _zohoGetAll('/vendorcredits', 'vendor_credits', listParams,
      { dateField: 'date', dateFrom: fromDate, dateTo: toDate, maxPages: 10 });

    const active = credits.filter(c => (c.status || '').toLowerCase() !== 'void');

    const entryMap = {};
    if (existing && !opts.full) {
      for (const e of existing) {
        if (!entryMap[e.credit_id]) entryMap[e.credit_id] = [];
        entryMap[e.credit_id].push(e);
      }
    }

    for (let i = 0; i < active.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, BILL_DETAIL_GAP_MS));
      const c = active[i];
      try {
        const d  = await _zohoGet(`/vendorcredits/${c.vendor_credit_id}`, { organization_id: NT_ORG_ID });
        const vc = d.vendor_credit || {};
        const headerProject = (vc.custom_field_hash?.cf_project_formatted ||
          vc.custom_field_hash?.cf_project || '').trim();
        const appliedBills  = (vc.bills_credited || []).map(b => b.bill_number).filter(Boolean).join(', ');

        const newEntries = [];
        for (const li of (vc.line_items || [])) {
          const isCogs  = isCOGS(li.account_name);
          const ohCat   = overheadCat(li.account_name, nameMap);
          if (!isCogs && !ohCat) continue;
          const liProject = (li.project_name || '').trim();
          const effProj   = liProject || headerProject;
          const amount    = parseFloat(li.item_total) || 0;
          if (amount <= 0) continue;
          newEntries.push({
            credit_id:      c.vendor_credit_id,
            credit_number:  vc.vendor_credit_number || c.vendor_credit_number,
            vendor:         vc.vendor_name || c.vendor_name || '',
            date:           vc.date || c.date || '',
            credit_project: effProj,
            applied_bills:  appliedBills,
            _category:      isCogs ? 'projectCost' : ohCat,
            _last_modified: vc.last_modified_time || '',
            line_items: [{
              account_name: li.account_name,
              project_name: effProj,
              item_total:   amount,
              description:  li.description || li.name || '',
              quantity:     li.quantity || 0,
              rate:         li.rate || 0,
            }],
          });
        }
        entryMap[c.vendor_credit_id] = newEntries;
      } catch (err) {
        if (err.message?.startsWith('ZOHO_DAILY_LIMIT')) throw err;
        console.warn(`[pocm-sync] vendor credit ${c.vendor_credit_id} failed: ${err.message}`);
      }
    }

    const allEntries = Object.values(entryMap).flat();
    const dur = Date.now() - t0;

    writeDiskCache(cacheKey, allEntries);
    warmNodeCache(cacheKey, allEntries, 14400);

    await setCoverage(fromDate, 'vendor_credits', {
      status: 'success', synced_at: new Date().toISOString(),
      record_count: allEntries.length, duration_ms: dur,
      mode: (opts.full || !lastSync) ? 'full' : 'incremental',
    });

    return { status: 'success', record_count: allEntries.length, duration_ms: dur };

  } catch (err) {
    await setCoverage(fromDate, 'vendor_credits', {
      status: 'failed', error: err.message, failed_at: new Date().toISOString(),
    });
    return { status: 'failed', error: err.message };
  } finally {
    _syncInFlight.delete(lockId);
  }
}

// ── Core: sync customer payments (all dates, single store) ───────────────────
// Feeds the Project-wise P&L "Amount Recd. Till Date" column. The list (~4 pages)
// already carries date, cash, client TDS, unused and refunded amounts. A detail
// call is made only for payments split across several invoices or partly
// refunded (per-invoice allocation / refund dates) and is reused until the
// payment changes in Zoho. Zoho projects are stored too, for the
// project → customer_id link.
const CUSTPAY_KEY = 'pocm-custpayments-v1';

async function syncCustomerPayments(opts = {}) {
  const lockId = 'custpayments';
  if (_syncInFlight.has(lockId)) return { status: 'skipped', reason: 'already_in_progress' };
  _syncInFlight.add(lockId);
  const t0 = Date.now();

  try {
    const prevById = {};
    if (!opts.full) {
      for (const p of (readDiskCache(CUSTPAY_KEY)?.payments || [])) prevById[p.payment_id] = p;
    }

    const list = await _zohoGetAll('/customerpayments', 'customerpayments',
      { organization_id: NT_ORG_ID, sort_column: 'date', sort_order: 'D' }, { maxPages: 50 });
    const zohoProjects = await _zohoGetAll('/projects', 'projects',
      { organization_id: NT_ORG_ID }, { maxPages: 10 });

    const payments = [];
    let detailsFetched = 0;
    for (const p of list) {
      const invoiceNumbers = (p.invoice_numbers || '').split(',').map(s => s.trim()).filter(Boolean);
      const refunded = parseFloat(p.bcy_refunded_amount) || 0;
      const sig = `${p.last_modified_time}|${p.amount}|${p.unused_amount}|${refunded}|${p.invoice_numbers || ''}`;
      const rec = {
        payment_id:      p.payment_id,
        payment_number:  p.payment_number || p.payment_id,
        date:            p.date || '',
        customer_id:     p.customer_id || '',
        customer_name:   p.customer_name || '',
        amount:          parseFloat(p.amount) || 0,
        tds:             parseFloat(p.tax_amount_withheld) || 0,
        unused:          parseFloat(p.unused_amount) || 0,
        refunded,
        invoice_numbers: invoiceNumbers,
        allocations:     null,   // [{ invoice_id, invoice_number, applied, tds }] — detail only
        refunds:         null,   // [{ date, amount }] — detail only
        _sig:            sig,
      };

      if (invoiceNumbers.length > 1 || refunded > 0) {
        const prev = prevById[p.payment_id];
        if (prev && prev._sig === sig && (prev.allocations || prev.refunds)) {
          rec.allocations = prev.allocations;
          rec.refunds     = prev.refunds;
        } else {
          if (detailsFetched > 0) await new Promise(r => setTimeout(r, BILL_DETAIL_GAP_MS));
          try {
            const d  = await _zohoGet(`/customerpayments/${p.payment_id}`, { organization_id: NT_ORG_ID });
            const pm = d.payment || {};
            detailsFetched++;
            rec.allocations = (pm.invoices || []).map(i => ({
              invoice_id:     i.invoice_id,
              invoice_number: i.invoice_number,
              applied:        parseFloat(i.amount_applied) || 0,
              tds:            parseFloat(i.tax_amount_withheld) || 0,
            }));
            rec.refunds = (pm.payment_refunds || []).map(r => ({
              date:   r.date || '',
              amount: parseFloat(r.amount_bcy) || 0,
            }));
          } catch (err) {
            if (err.message?.startsWith('ZOHO_DAILY_LIMIT')) throw err;
            console.warn(`[pocm-sync] customer payment ${p.payment_id} detail failed: ${err.message}`);
          }
        }
      }
      payments.push(rec);
    }

    const store = {
      synced_at: new Date().toISOString(),
      projects:  zohoProjects.map(z => ({
        project_id:    z.project_id,
        project_name:  (z.project_name || '').trim(),
        customer_id:   z.customer_id || '',
        customer_name: z.customer_name || '',
      })),
      payments,
    };
    const dur = Date.now() - t0;
    writeDiskCache(CUSTPAY_KEY, store);
    warmNodeCache(CUSTPAY_KEY, store, 86400);

    console.log(`[pocm-sync] customer payments: done — ${payments.length} payments, ${detailsFetched} detail calls, ${dur}ms`);
    return { status: 'success', record_count: payments.length, details_fetched: detailsFetched, duration_ms: dur };

  } catch (err) {
    console.error('[pocm-sync] customer payments FAILED:', err.message);
    return { status: 'failed', error: err.message };
  } finally {
    _syncInFlight.delete(lockId);
  }
}

// ── Core: sync vendor payments (Project-wise P&L "Utilised by Project") ─────
// Store: payments since the first relevant FY with their bill allocations
// (bill_id, amount_applied, apply_date), refunds, PO Number and "Project Name-"
// custom fields, plus the PO → project and bill_id → bill header maps, and line
// projects for bills that the COGS bills cache does not hold.
// Detail calls: a payment needs one when it is split over several bills, has an
// unapplied balance, has no bill, or its single bill can't be identified from
// the bill list. Bills absent from the bills cache need one detail call for their
// line projects — fetched POCM/blank-tagged first, within a per-run budget, and
// resumed on the next run. Everything is reused until Zoho changes the record.
const VENDPAY_KEY = 'pocm-vendorpayments-v1';
const VENDPAY_PARTIAL_KEY = 'pocm-vendorpayments-v1-partial';   // in-run checkpoint, used only to resume
const VENDPAY_FILE = () => cacheFile(VENDPAY_KEY);

const VENDPAY_LOCK_FILE = path.join(__dirname, 'pocm_vendorpayments.lock');

async function syncVendorPayments(opts = {}) {
  const lockId = 'vendorpayments';
  if (_syncInFlight.has(lockId)) return { status: 'skipped', reason: 'already_in_progress' };
  if (!acquireFileLock(VENDPAY_LOCK_FILE)) return { status: 'skipped', reason: 'running_in_another_process' };
  _syncInFlight.add(lockId);
  const t0 = Date.now();
  const maxBillDetails = opts.maxBillDetails ?? 3000;
  let store = null;

  try {
    // A Full Sync re-lists everything but still reuses details whose Zoho record is
    // unchanged (signature/lmt match) — re-fetching ~4,600 identical details would cost
    // ~2 hours of API quota for no difference in the result.
    const prev    = readDiskCache(VENDPAY_KEY);
    const partial = readDiskCache(VENDPAY_PARTIAL_KEY);   // an interrupted run's progress
    const prevById = {};
    for (const p of (prev?.payments || [])) prevById[p.payment_id] = p;
    for (const p of (partial?.payments || [])) if (p.detail) prevById[p.payment_id] = p;
    const fys = await relevantFYs();
    const windowFrom = fyFromDate(fys[0]);

    const pocmNames = new Set();
    try {
      for (const p of (await db.readJSON('pocm_projects', path.join(__dirname, 'pocm_projects.json'), [])) || []) {
        pocmNames.add((p.zohoProjectName || p.name || '').trim());
      }
    } catch (_) {}

    // Lists: payments, POs, bills, projects
    const rawList = await _zohoGetAll('/vendorpayments', 'vendorpayments',
      { organization_id: NT_ORG_ID, sort_column: 'date', sort_order: 'D' }, { maxPages: 150 });
    const seen = new Set();
    let duplicatesDropped = 0;
    const list = [];
    for (const p of rawList) {
      if (seen.has(p.payment_id)) { duplicatesDropped++; continue; }
      seen.add(p.payment_id);
      if ((p.date || '') >= windowFrom) list.push(p);
    }
    const poList = await _zohoGetAll('/purchaseorders', 'purchaseorders',
      { organization_id: NT_ORG_ID }, { maxPages: 150 });
    const billList = await _zohoGetAll('/bills', 'bills',
      { organization_id: NT_ORG_ID }, { maxPages: 200 });
    const projList = await _zohoGetAll('/projects', 'projects',
      { organization_id: NT_ORG_ID }, { maxPages: 10 });

    const pos = {};
    for (const po of poList) {
      pos[po.purchaseorder_id] = {
        po_number:    po.purchaseorder_number || '',
        project_id:   po.cf_project_name_1_unformatted || '',
        project_name: (po.cf_project_name_1 || '').trim(),
        vendor_name:  po.vendor_name || '',
        status:       po.status || '',
      };
    }
    const bills = {};
    const billIndex = {};   // vendor_id|bill_number → [bill_id]
    for (const b of billList) {
      if ((b.status || '').toLowerCase() === 'void') continue;
      bills[b.bill_id] = {
        bill_number: b.bill_number || '', vendor_id: b.vendor_id || '', vendor_name: b.vendor_name || '',
        date: b.date || '', total: (parseFloat(b.total) || 0) * (parseFloat(b.exchange_rate) || 1),   // INR
        lmt: b.last_modified_time || '',
      };
      const k = `${b.vendor_id}|${(b.bill_number || '').trim()}`;
      (billIndex[k] = billIndex[k] || []).push(b.bill_id);
    }

    store = {
      synced_at:   null,
      window_from: windowFrom,
      projects:    projList.map(z => ({ project_id: z.project_id, project_name: (z.project_name || '').trim() })),
      pos, bills,
      bill_details: { ...(prev?.bill_details || {}), ...(partial?.bill_details || {}) },
      payments: [],
      stats: { list_count: rawList.length, duplicates_dropped: duplicatesDropped },
    };
    const checkpoint = () => writeDiskCache(VENDPAY_PARTIAL_KEY, store);

    // Payments
    let detailsFetched = 0, calls = 0, lastCheckpoint = 0;
    const gap = async () => { if (calls++ > 0) await new Promise(r => setTimeout(r, BILL_DETAIL_GAP_MS)); };
    for (const p of list) {
      const billNumbers = (p.bill_numbers || '').split(',').map(s => s.trim()).filter(Boolean);
      // INR (base currency) — some vendors are paid in USD
      const rate    = parseFloat(p.exchange_rate) || 1;
      const amount  = parseFloat(p.bcy_amount ?? p.amount) || 0;
      const balance = parseFloat(p.bcy_balance ?? p.balance) || 0;
      const sig = `${p.last_modified_time}|${amount}|${balance}|${p.bill_numbers || ''}`;
      const rec = {
        payment_id: p.payment_id, payment_number: p.payment_number || p.payment_id, date: p.date || '',
        vendor_id: p.vendor_id || '', vendor_name: p.vendor_name || '',
        reference_number: p.reference_number || '',
        amount, balance, bill_numbers: billNumbers,
        project_id: p.cf_project_name_1_unformatted || '', project_name: (p.cf_project_name_1 || '').trim(),
        po_id: '', po_number: '', tds: 0,
        allocations: null, refunds: null, detail: false, _sig: sig,
      };

      // Single bill, fully applied: identify the bill from the bill list
      let needDetail = billNumbers.length !== 1 || balance > 0;
      if (!needDetail) {
        const ids = billIndex[`${p.vendor_id}|${billNumbers[0]}`] || [];
        const applied = amount - balance;
        if (ids.length === 1 && applied <= bills[ids[0]].total + 1) {
          rec.allocations = [{ bill_id: ids[0], bill_number: billNumbers[0], bill_date: bills[ids[0]].date, applied, apply_date: '' }];
        } else {
          needDetail = true;
        }
      }

      if (needDetail) {
        const old = prevById[p.payment_id];
        if (old && old._sig === sig && old.detail) {
          Object.assign(rec, { po_id: old.po_id, po_number: old.po_number, tds: old.tds,
            allocations: old.allocations, refunds: old.refunds, detail: true,
            project_id: old.project_id || rec.project_id, project_name: old.project_name || rec.project_name });
        } else {
          await gap();
          try {
            const vp = (await _zohoGet(`/vendorpayments/${p.payment_id}`, { organization_id: NT_ORG_ID })).vendorpayment || {};
            const cf = vp.custom_field_hash || {};
            detailsFetched++;
            rec.po_id        = cf.cf_po_number_1_unformatted || '';
            rec.po_number    = cf.cf_po_number_1 || '';
            rec.project_id   = cf.cf_project_name_1_unformatted || rec.project_id;
            rec.project_name = (cf.cf_project_name_1 || rec.project_name || '').trim();
            rec.tds          = parseFloat(vp.tax_amount_withheld) || 0;
            const vpRate     = parseFloat(vp.exchange_rate) || rate;
            rec.allocations  = (vp.bills || []).map(b => ({
              bill_id: b.bill_id, bill_number: b.bill_number || '', bill_date: b.date || '',
              applied: Math.round((parseFloat(b.amount_applied) || 0) * vpRate * 100) / 100,   // INR
              apply_date: b.apply_date || '',
              bill_payment_id: b.bill_payment_id || '',
            }));
            rec.refunds = (vp.vendorpayment_refunds || []).map(r => ({ date: r.date || '', amount: parseFloat(r.amount_bcy) || 0 }));
            rec.detail  = true;
          } catch (err) {
            if (err.message?.startsWith('ZOHO_DAILY_LIMIT')) throw err;
            console.warn(`[pocm-sync] vendor payment ${p.payment_id} detail failed: ${err.message}`);
          }
        }
      }
      store.payments.push(rec);
      if (detailsFetched - lastCheckpoint >= 100) {
        lastCheckpoint = detailsFetched;
        console.log(`[pocm-sync] vendor payments: ${detailsFetched} payment details fetched`);
        checkpoint();
      }
    }
    checkpoint();

    // Bills the COGS bills cache does not hold → line projects from bill detail
    const cachedBillIds = new Set();
    for (const fy of fys) for (const e of (readDiskCache(`pocm-bills-v8-${fyFromDate(fy)}`) || [])) cachedBillIds.add(e.bill_id);
    const needBill = new Map();   // bill_id → priority (0 = POCM/blank-tagged payment)
    for (const p of store.payments) {
      for (const a of (p.allocations || [])) {
        if (!a.bill_id || cachedBillIds.has(a.bill_id)) continue;
        const have = store.bill_details[a.bill_id];
        const lmt  = bills[a.bill_id]?.lmt || '';
        if (have && (have.error || have.lmt === lmt)) continue;
        const pri = (!p.project_name || pocmNames.has(p.project_name)) ? 0 : 1;
        needBill.set(a.bill_id, Math.min(needBill.get(a.bill_id) ?? 1, pri));
      }
    }
    const queue = [...needBill.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]);
    let billDetailsFetched = 0;
    for (const billId of queue) {
      if (billDetailsFetched >= maxBillDetails) break;
      await gap();
      try {
        const bill = (await _zohoGet(`/bills/${billId}`, { organization_id: NT_ORG_ID })).bill || {};
        const header = (bill.project_name || bill.custom_field_hash?.cf_project_formatted || bill.custom_field_hash?.cf_project || '').trim();
        store.bill_details[billId] = {
          lmt: bill.last_modified_time || bills[billId]?.lmt || '',
          lines: (bill.line_items || []).map(li => ({
            project_name: (li.project_name || header || '').trim(),
            amount: parseFloat(li.item_total) || 0,
          })),
        };
      } catch (err) {
        if (err.message?.startsWith('ZOHO_DAILY_LIMIT')) throw err;
        if (err.response?.status === 404) store.bill_details[billId] = { error: 'not_found' };
        else console.warn(`[pocm-sync] bill ${billId} detail failed: ${err.message}`);
      }
      billDetailsFetched++;
      if (billDetailsFetched % 100 === 0) { console.log(`[pocm-sync] vendor payments: ${billDetailsFetched}/${queue.length} bill details`); checkpoint(); }
    }

    const dur = Date.now() - t0;
    store.synced_at = new Date().toISOString();
    Object.assign(store.stats, {
      payments_in_window:    store.payments.length,
      details_fetched:       detailsFetched,
      bill_details_fetched:  billDetailsFetched,
      pending_bill_details:  Math.max(0, queue.length - billDetailsFetched),
      pending_payment_details: store.payments.filter(p => !p.allocations).length,
      duration_ms: dur,
    });
    writeDiskCache(VENDPAY_KEY, store);
    warmNodeCache(VENDPAY_KEY, store, 86400);
    removeDiskCache(VENDPAY_PARTIAL_KEY);
    if (_nodeCache) _nodeCache.del(VENDPAY_PARTIAL_KEY);
    console.log(`[pocm-sync] vendor payments: done — ${store.payments.length} payments, ${detailsFetched} payment + ${billDetailsFetched} bill detail calls, ${store.stats.pending_bill_details} bills pending, ${dur}ms`);
    return { status: 'success', ...store.stats };

  } catch (err) {
    // Keep progress for the next run; the last complete store (if any) stays in place
    if (store) { store.stats.error = err.message; writeDiskCache(VENDPAY_PARTIAL_KEY, store); }
    console.error('[pocm-sync] vendor payments FAILED:', err.message);
    return { status: 'failed', error: err.message };
  } finally {
    _syncInFlight.delete(lockId);
    releaseFileLock(VENDPAY_LOCK_FILE);
  }
}

/** Synced vendor-payment store (re-read when the file changes), or null. Never calls Zoho. */
let _vendPayMtime = 0;
function getVendorPayments() {
  let mtime = 0;
  mtime = diskCacheSavedAt(VENDPAY_KEY);
  if (!mtime) return null;
  const hit = _nodeCache && _nodeCache.get(VENDPAY_KEY);
  if (hit && mtime === _vendPayMtime) return hit;
  const disk = readDiskCache(VENDPAY_KEY);
  if (disk) { warmNodeCache(VENDPAY_KEY, disk, 86400); _vendPayMtime = mtime; }
  return disk;
}

/** Synced customer-payment store, or null if never synced. Never calls Zoho. */
function getCustomerPayments() {
  const hit = _nodeCache && _nodeCache.get(CUSTPAY_KEY);
  if (hit) return hit;
  const disk = readDiskCache(CUSTPAY_KEY);
  if (disk) warmNodeCache(CUSTPAY_KEY, disk, 86400);
  return disk;
}

// ── Sync one FY (bills + invoices + vendor credits, in sequence) ─────────────
async function syncFY(fy, opts = {}) {
  const results = {
    fy,
    bills:          await syncBillsFY(fy, opts),
    invoices:       await syncInvoicesFY(fy, opts),
    vendor_credits: await syncVendorCreditsFY(fy, opts),
  };
  const allOk = Object.values(results).every(r => !r?.status || r.status !== 'failed');
  results.status = allOk ? 'success' : 'partial';
  return results;
}

// ── Sync all relevant FYs (called by the scheduler) ─────────────────────────
async function syncAll(opts = {}) {
  if (!_zohoGet || !_zohoGetAll) {
    console.warn('[pocm-sync] Not initialised — skipping scheduled run');
    return { status: 'skipped', reason: 'not_initialised' };
  }
  if (_runInProgress) return { status: 'skipped', reason: 'already_in_progress' };
  _runInProgress = true;
  try {
    const fys     = await relevantFYs();
    const runId   = `pocm_${Date.now()}`;
    const started = new Date().toISOString();
    console.log(`[pocm-sync] Starting sync run ${runId} — FYs: ${fys.join(', ')}`);

    const results = {};
    for (const fy of fys) {
      results[fy] = await syncFY(fy, opts);
    }
    // Not FY-scoped — kept out of `results` so the FY status roll-up is unchanged
    const customerPayments = await syncCustomerPayments(opts);
    const vendorPayments   = await syncVendorPayments(opts);

    const failed = Object.values(results).filter(r => r.status === 'failed').length;
    const status = failed === 0 ? 'success' : failed < fys.length ? 'partial' : 'failed';
    console.log(`[pocm-sync] Run ${runId} complete — ${status}`);
    return { runId, started, completed: new Date().toISOString(), status, results, customer_payments: customerPayments, vendor_payments: vendorPayments };
  } finally {
    _runInProgress = false;
  }
}

// ── Sync status / coverage ───────────────────────────────────────────────────
async function getSyncStatus() {
  const coverage = await readCoverage();
  const fys      = await relevantFYs();
  const now      = new Date();
  const curFY    = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;

  const fyStatus = fys.map(fy => {
    const fyFrom = fyFromDate(fy);
    const fyInfo = coverage[fyFrom] || {};
    const label  = `FY ${fy}-${String(fy + 1).slice(2)}`;

    const entities = ['bills', 'invoices', 'vendor_credits'].map(entity => {
      const e = fyInfo[entity] || {};
      return {
        entity,
        status:       e.status || 'never_synced',
        synced_at:    e.synced_at || null,
        record_count: e.record_count ?? null,
        mode:         e.mode || null,
        error:        e.error || null,
      };
    });

    const anySuccess = entities.some(e => e.status === 'success');
    const anyFailed  = entities.some(e => e.status === 'failed');
    const allSuccess = entities.every(e => e.status === 'success');
    const overallStatus = allSuccess ? 'success'
      : anySuccess ? 'partial'
      : anyFailed  ? 'failed'
      : 'never_synced';

    const latestSync = entities.reduce((best, e) =>
      e.synced_at && (!best || e.synced_at > best) ? e.synced_at : best, null);

    return { fy, fy_from: fyFrom, label, status: overallStatus, last_sync: latestSync, entities };
  });

  const newestSync = fyStatus.reduce((best, f) =>
    f.last_sync && (!best || f.last_sync > best) ? f.last_sync : best, null);

  // POCM has a dedicated 11PM IST daily scheduler
  const nextRunIST = nextPocmRun().toISOString();

  return {
    org_id:      NT_ORG_ID,
    module:      'pocm_nt',
    data_as_of:  newestSync,
    next_run:    nextRunIST,
    in_progress: _runInProgress || _syncInFlight.size > 0,
    fy_coverage: fyStatus,
  };
}

// ── Quarter freeze ────────────────────────────────────────────────────────────
async function lockQuarter(fy, quarter, user, reason, snapshotData) {
  if (!reason || reason.trim().length < 3) {
    throw new Error('A reason (min 3 characters) is required to lock a quarter');
  }
  const locks  = await readLocks();
  const key    = lockKey(fy, quarter);
  const now    = new Date().toISOString();
  const snapId = `snap_${fy}_Q${quarter}_${Date.now()}`;

  // Save snapshot (office PC: pocm_snapshots/<id>.json; Neon: kv_store 'pocm_snapshot_<id>')
  const snapDoc = { snap_id: snapId, fy, quarter, locked_at: now, locked_by: user, data: snapshotData || null };
  let snapFile = null;
  if (db.USE_DB) {
    await db.writeJSON(`pocm_snapshot_${snapId}`, null, snapDoc);
  } else {
    snapFile = path.join(SNAPSHOTS_DIR, `${snapId}.json`);
    fs.writeFileSync(snapFile, JSON.stringify(snapDoc), 'utf8');
  }

  locks[key] = {
    locked:     true,
    fy, quarter,
    locked_at:  now,
    locked_by:  user,
    reason:     reason.trim(),
    snap_id:    snapId,
    snap_file:  snapFile,
    audit_trail: [...(locks[key]?.audit_trail || []), {
      action: 'lock', timestamp: now, user, reason: reason.trim(), snap_id: snapId,
    }],
  };

  await writeLocks(locks);
  console.log(`[pocm-sync] Quarter ${fy} Q${quarter} locked by ${user}: ${reason}`);
  return { ok: true, snap_id: snapId, locked_at: now };
}

async function unlockQuarter(fy, quarter, user, reason) {
  if (!reason || reason.trim().length < 3) {
    throw new Error('A reason (min 3 characters) is required to unlock a quarter');
  }
  const locks = await readLocks();
  const key   = lockKey(fy, quarter);
  if (!locks[key]?.locked) throw new Error(`Quarter ${fy} Q${quarter} is not locked`);

  const now = new Date().toISOString();
  const prev = { ...locks[key] };

  locks[key] = {
    ...prev,
    locked:      false,
    unlocked_at: now,
    unlocked_by: user,
    unlock_reason: reason.trim(),
    audit_trail: [...(prev.audit_trail || []), {
      action: 'unlock', timestamp: now, user, reason: reason.trim(),
      previous_snap_id: prev.snap_id,
    }],
  };

  await writeLocks(locks);
  console.log(`[pocm-sync] Quarter ${fy} Q${quarter} unlocked by ${user}: ${reason}`);
  return { ok: true, unlocked_at: now };
}

async function getQuarterLocks() {
  const locks = await readLocks();
  return locks;
}

async function getSnapshot(fy, quarter) {
  const locks = await readLocks();
  const entry = locks[lockKey(fy, quarter)];
  if (db.USE_DB && entry?.snap_id) return db.readJSON(`pocm_snapshot_${entry.snap_id}`, null, null);
  if (!entry?.snap_file) return null;
  try {
    return JSON.parse(fs.readFileSync(entry.snap_file, 'utf8'));
  } catch (_) { return null; }
}

// ── Mapping exceptions report ────────────────────────────────────────────────
async function getMappingExceptions() {
  const fys  = await relevantFYs();
  const unmapped  = [];   // bills with no project tagged
  const missingOh = [];  // bills with unknown account category

  for (const fy of fys) {
    const fromDate = fyFromDate(fy);
    const bills    = readDiskCache(`pocm-bills-v8-${fromDate}`) || [];
    for (const b of bills) {
      if (b._category === 'projectCost' && !b.bill_project) {
        unmapped.push({
          fy: `${fy}-${fy + 1}`, bill_number: b.bill_number, vendor: b.vendor,
          date: b.date, amount: b.line_items?.[0]?.item_total || 0,
        });
      }
    }
  }

  return { unmapped_project: unmapped };
}

// ── Pre-load all disk cache files into node-cache at startup ─────────────────
function preloadAtStartup() {
  if (!_nodeCache || db.USE_DB) return;   // Neon mode: ensureLoaded() on first POCM use
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const key  = f.replace(/\.json$/, '');
      const data = readDiskCache(key);
      if (data) {
        warmNodeCache(key, data, 86400); // 24h — aligned to 11PM→11PM sync cadence
      }
    }
    if (files.length > 0) {
      console.log(`[pocm-sync] Preloaded ${files.length} cache file(s) into node-cache`);
    }
  } catch (e) {
    console.warn('[pocm-sync] Preload error:', e.message);
  }
}

// ── Dedicated POCM 11PM IST scheduler (separate from main sync engine) ────────
// Fires once daily at 23:00 IST (Asia/Kolkata = UTC+5:30).
// Does NOT share the main sync-engine's 1PM/3PM/6PM/9PM slots.
function startPocmScheduler() {
  // UTC arithmetic — the old IST-shifted setHours() fired at 5:30 PM IST on an IST machine
  function msUntilNext() {
    return nextPocmRun() - new Date();
  }

  function schedule() {
    const ms = msUntilNext();
    const inHours = (ms / 3600000).toFixed(1);
    console.log(`[pocm-sync] Dedicated POCM scheduler: next run at 11:00 PM IST (in ${inHours}h)`);
    setTimeout(async () => {
      console.log('[pocm-sync] 11 PM IST — starting scheduled POCM incremental sync');
      try {
        await syncAll({ trigger: 'scheduled' });
      } catch (e) {
        console.error('[pocm-sync] Scheduled sync error:', e.message);
      }
      schedule(); // reschedule for next day
    }, ms);
  }

  schedule();
}

module.exports = {
  init,
  ensureLoaded,
  readDiskCache,
  writeDiskCache,
  diskCacheSavedAt,
  syncFY,
  syncAll,
  syncBillsFY,
  syncInvoicesFY,
  syncVendorCreditsFY,
  syncCustomerPayments,
  getCustomerPayments,
  syncVendorPayments,
  getVendorPayments,
  getSyncStatus,
  lockQuarter,
  unlockQuarter,
  getQuarterLocks,
  getSnapshot,
  isQuarterLocked,
  getMappingExceptions,
  preloadAtStartup,
  startPocmScheduler,
  relevantFYs,
  fyFromDate,
  fyToDate,
};
