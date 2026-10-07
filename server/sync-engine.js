/**
 * Centralized Sync Engine
 *
 * Fetches Zoho entity data on a schedule and caches it locally.
 * Dashboard endpoints read from this cache instead of hitting Zoho on every request.
 *
 * Entities run in dependency order (stage 1 → 4):
 *   1 Master data        vendors_all
 *   2 Primary txns       invoices_fy, bills_fy
 *   3 Settlements        vendor_credits_all, vendor_payments_fy, customer_payments_fy, credit_notes_fy
 *   4 Status views       invoices_unpaid, invoices_paid_12mo, bills_open, bills_overdue
 *     + derived          vendor_msme_master (registered by index.js — MSME Sector / Enterprise Type)
 *
 * Sync modes:
 *   normal        "Sync Data"          incremental (Zoho last_modified_time) — scheduler uses this
 *   recheck       "Recheck Data"       incremental + ID reconciliation of the last 90 days
 *   full          "Full Sync Data"     full re-fetch of every entity, diffed against the cache
 *   full_refresh  "Full Data Refresh"  full re-fetch + count/total/MSME validation report
 *
 * All writes are idempotent upserts keyed on Zoho IDs. A failed entity never overwrites its
 * previous cache. Frozen snapshots (MSME quarters, Form-1 halves, POCM quarters) live in
 * their own stores and are never touched by any sync mode.
 *
 * Storage: kv_store (PostgreSQL) or server/sync_data/*.json (local dev fallback)
 * Scheduler: 1 PM, 3 PM, 6 PM, 9 PM IST (Asia/Kolkata)
 */

const path = require('path');
const fs   = require('fs');
const db   = require('./db');
const { background } = require('./background');

const SYNC_DIR           = path.join(__dirname, 'sync_data');
const CHECKPOINTS_FILE   = path.join(__dirname, 'sync_checkpoints.json');
const RUN_LOG_FILE       = path.join(__dirname, 'sync_run_log.json');
// Synced data older than this triggers a live Zoho fallback (4 h on the office PC). On Vercel a
// live fetch of a whole list can outlast the 300-second function limit and eats the daily Zoho
// quota shared with the PC, so synced data is served there until a day old; its scheduled syncs
// (vercel.json + .github/workflows/scheduled-sync.yml) run every 2 h in office hours.
const STALE_HOURS        = process.env.VERCEL ? 24 : 4;
const MAX_RUN_LOG        = 100; // keep last N run entries
const ENGINE_VERSION     = 2;   // caches written by an older engine get one full fetch
const MAX_PAGES          = 250; // 50,000 records; exceeding it fails the entity instead of truncating
const INC_OVERLAP_MS     = 15 * 60000; // incremental re-reads 15 min before the high-water mark
const RECHECK_DAYS       = 90;  // Recheck Data reconciles IDs over this many recent days

const MODES = {
  normal:       'Sync Data',
  recheck:      'Recheck Data',
  full:         'Full Sync Data',
  full_refresh: 'Full Data Refresh',
};

// ── Entity definitions ────────────────────────────────────────────────────────
// List entities: path/listKey/idField/params describe the Zoho list API.
//   window(d)     → { from, to } date window; records dated after `to` are held in `future`
//                   and promoted once their date arrives (they never change in Zoho, so an
//                   incremental fetch would otherwise never see them enter the window).
//   rolling       → window.from moves daily; old records are pruned instead of forcing a full fetch.
//   incremental   → false for status views: Zoho flips open→overdue on due date without
//                   touching last_modified_time, so those are always re-fetched in full (cheap).
//   member(r)     → record belongs in this entity (used when fetching via Status.All).
//   statusRoll    → apply Zoho's date-driven status change locally after incremental merges.
// Custom entities (run function) are added with registerEntity().
const ENTITY_DEFS = {
  // Always full-fetched (~16 pages): Zoho does not reliably bump a contact's
  // last_modified_time on every edit, so an incremental fetch could miss a change to
  // a vendor custom field such as Vendor Category.
  vendors_all: {
    label: 'Vendors — All', stage: 1, kind: 'master',
    path: '/contacts', listKey: 'contacts', idField: 'contact_id',
    params: { contact_type: 'vendor' }, sortKey: 'contact_name',
    incremental: false, dependents: ['vendor_msme_master'],
    description: 'Vendor master (all statuses): names, outstanding payable, unused credits, last modified.',
  },
  invoices_fy: {
    label: 'Invoices — FY All', stage: 2, kind: 'source',
    path: '/invoices', listKey: 'invoices', idField: 'invoice_id',
    params: { filter_by: 'Status.All' },
    window: d => ({ from: d.fyStart, to: d.today }),
    incremental: true, statusRoll: 'invoice',
    description: 'All invoices dated in the current FY up to today.',
  },
  bills_fy: {
    label: 'Bills — FY All', stage: 2, kind: 'source',
    path: '/bills', listKey: 'bills', idField: 'bill_id',
    params: { filter_by: 'Status.All' },
    window: d => ({ from: d.fyStart, to: d.today }),
    incremental: true, statusRoll: 'bill',
    description: 'All bills dated in the current FY up to today.',
  },
  vendor_credits_all: {
    label: 'Vendor Credits — All', stage: 3, kind: 'source',
    path: '/vendorcredits', listKey: 'vendor_credits', idField: 'vendor_credit_id',
    params: { filter_by: 'Status.All' },
    incremental: true,
    description: 'All vendor credits / debit notes (all time) — net purchase cost and credit aging.',
  },
  vendor_payments_fy: {
    label: 'Vendor Payments — FY', stage: 3, kind: 'source',
    path: '/vendorpayments', listKey: 'vendorpayments', idField: 'payment_id',
    params: {},
    window: d => ({ from: d.fyStart, to: d.fyEnd }),
    incremental: true,
    description: 'Vendor payments dated in the current FY.',
  },
  customer_payments_fy: {
    label: 'Customer Payments — FY', stage: 3, kind: 'source',
    path: '/customerpayments', listKey: 'customerpayments', idField: 'payment_id',
    params: {},
    window: d => ({ from: d.fyStart, to: d.fyEnd }),
    incremental: true,
    description: 'Customer payments dated in the current FY.',
  },
  credit_notes_fy: {
    label: 'Credit Notes — FY', stage: 3, kind: 'source',
    path: '/creditnotes', listKey: 'creditnotes', idField: 'creditnote_id',
    params: { filter_by: 'Status.All' },
    window: d => ({ from: d.fyStart, to: d.fyEnd }),
    incremental: true,
    description: 'Customer credit notes dated in the current FY.',
  },
  invoices_unpaid: {
    label: 'Invoices — All Unpaid', stage: 4, kind: 'status_view',
    path: '/invoices', listKey: 'invoices', idField: 'invoice_id',
    params: { filter_by: 'Status.Unpaid' },
    incremental: false,
    description: 'Zoho Status.Unpaid (all time). Re-fetched in full every run.',
  },
  invoices_paid_12mo: {
    label: 'Invoices — Paid (12 mo)', stage: 4, kind: 'status_view',
    path: '/invoices', listKey: 'invoices', idField: 'invoice_id',
    params: { filter_by: 'Status.Paid' },
    incParams: { filter_by: 'Status.All' }, member: r => r.status === 'paid',
    window: d => ({ from: d.past12Start, to: d.today }), rolling: true,
    incremental: true,
    description: 'Paid invoices dated in the last 12 months (incremental via Status.All).',
  },
  bills_open: {
    label: 'Bills — Open', stage: 4, kind: 'status_view',
    path: '/bills', listKey: 'bills', idField: 'bill_id',
    params: { filter_by: 'Status.Open' },
    incremental: false,
    description: 'Zoho Status.Open (all time). Re-fetched in full every run.',
  },
  bills_overdue: {
    label: 'Bills — Overdue', stage: 4, kind: 'status_view',
    path: '/bills', listKey: 'bills', idField: 'bill_id',
    params: { filter_by: 'Status.Overdue' },
    incremental: false,
    description: 'Zoho Status.Overdue (all time). Re-fetched in full every run.',
  },
};

// ── Internal state ────────────────────────────────────────────────────────────
const _locks = new Set(); // per-entity in-process concurrency locks
let _zohoGetAll = null;
let _zohoGet    = null;
let _activeRun  = null;   // the run currently executing (one at a time)
let _progress   = null;   // live/last run progress for the Sync Monitor

// Neon mode (Vercel): requests can land on different instances, so the live progress and
// the "already running" lock are shared through kv_store 'sync_progress'. A running record
// whose heartbeat is older than SHARED_STALE_MS belongs to a run Vercel cut off.
const SHARED_PROGRESS_KEY = 'sync_progress';
const SHARED_STALE_MS     = 6 * 60 * 1000;

let _publishChain = Promise.resolve();   // writes land in order, so 'running' never overwrites the final state
function _publishProgress(progress) {
  if (!db.USE_DB || !progress) return;
  const doc = { ...JSON.parse(JSON.stringify(progress)), heartbeat_at: new Date().toISOString() };
  _publishChain = _publishChain
    .then(() => db.writeJSON(SHARED_PROGRESS_KEY, null, doc))
    .catch(e => console.warn('[sync] progress publish failed:', e.message));
  background(_publishChain);
}

async function _sharedRunning() {
  if (!db.USE_DB) return null;
  const p = await db.readJSON(SHARED_PROGRESS_KEY, null, null).catch(() => null);
  if (!p || p.status !== 'running') return null;
  return Date.now() - new Date(p.heartbeat_at).getTime() < SHARED_STALE_MS ? p : null;
}

function init(zohoGetAll, zohoGet) {
  _zohoGetAll = zohoGetAll;
  _zohoGet    = zohoGet || require('./zoho').zohoGet;
}

// Custom (non-list) entity, e.g. the MSME Vendor Master. def: { label, stage, kind, run, description }
// run({ mode, trigger, runId, dates, ctx, readSyncedData, isInitial }) → { record_count, stats, extra }
function registerEntity(key, def) {
  ENTITY_DEFS[key] = { kind: 'derived', ...def };
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function _localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getCurrentDates() {
  const now = new Date();
  const fyStart = now.getMonth() >= 3
    ? new Date(now.getFullYear(), 3, 1)
    : new Date(now.getFullYear() - 1, 3, 1);
  const fyEnd = new Date(fyStart.getFullYear() + 1, 2, 31);
  const past12 = new Date(now);
  past12.setMonth(past12.getMonth() - 12);
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const recheck = new Date(now);
  recheck.setDate(recheck.getDate() - RECHECK_DAYS);
  return {
    today:        _localDate(now),
    fyStart:      _localDate(fyStart),
    fyEnd:        _localDate(fyEnd),
    past12Start:  _localDate(past12),
    mStart:       _localDate(mStart),
    recheckStart: _localDate(recheck),
  };
}

// Zoho timestamps look like 2026-09-29T17:10:12+0530
function lmtMs(s) {
  if (!s) return 0;
  const t = Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return isNaN(t) ? 0 : t;
}

// ── Storage helpers ───────────────────────────────────────────────────────────
function _ensureSyncDir() {
  // Optional on Vercel: its disk is read-only and synced data lives in Neon there
  try { if (!fs.existsSync(SYNC_DIR)) fs.mkdirSync(SYNC_DIR, { recursive: true }); } catch (_) {}
}

function _syncDataKey(entityKey)  { return `sync_data_${entityKey}`; }
function _syncDataFile(entityKey) { _ensureSyncDir(); return path.join(SYNC_DIR, `${entityKey}.json`); }

async function readSyncedData(entityKey) {
  return db.readJSON(_syncDataKey(entityKey), _syncDataFile(entityKey), null);
}

async function _writeSyncedData(entityKey, records, runId, extra = {}) {
  const payload = {
    data:         records,
    record_count: records.length,
    synced_at:    new Date().toISOString(),
    run_id:       runId || null,
    engine_v:     ENGINE_VERSION,
    ...extra,
  };
  await db.writeJSON(_syncDataKey(entityKey), _syncDataFile(entityKey), payload);
  return payload;
}

async function _readCheckpoints() {
  return db.readJSON('sync_checkpoints', CHECKPOINTS_FILE, {});
}

async function _updateCheckpoint(entityKey, update) {
  const cp = await _readCheckpoints();
  cp[entityKey] = { ...(cp[entityKey] || {}), ...update, entity_key: entityKey };
  await db.writeJSON('sync_checkpoints', CHECKPOINTS_FILE, cp);
}

async function _readRunLog() {
  return db.readJSON('sync_run_log', RUN_LOG_FILE, []);
}

async function _appendRunLog(entry) {
  const log = await _readRunLog();
  log.unshift(entry);
  await db.writeJSON('sync_run_log', RUN_LOG_FILE, log.slice(0, MAX_RUN_LOG));
}

// ── Freshness check ───────────────────────────────────────────────────────────
function isFresh(syncedAt, maxAgeHours) {
  if (!syncedAt) return false;
  const ageH = (Date.now() - new Date(syncedAt).getTime()) / 3600000;
  return ageH < (maxAgeHours ?? STALE_HOURS);
}

// ── Zoho paging ───────────────────────────────────────────────────────────────
// dateFrom:     stop once a page holds nothing dated on/after it (list sorted date desc)
// stopBeforeMs: stop once records are older than this last_modified_time (sorted lmt desc)
async function _pageAll(def, params, ctx, { dateFrom = null, stopBeforeMs = null } = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) {
      const err = new Error(`Page cap (${MAX_PAGES} pages) reached on ${def.path} — cache left unchanged to avoid truncated data`);
      err.errType = 'page_cap';
      throw err;
    }
    const d = await _zohoGet(def.path, { ...params, page, per_page: 200 });
    const items = d[def.listKey] || [];
    ctx.pages++;
    if (items.length === 0) break;

    let stop = false;
    if (dateFrom) {
      for (const i of items) if (i.date && i.date >= dateFrom) out.push(i);
      if (!items.some(i => i.date && i.date >= dateFrom)) stop = true;
    } else if (stopBeforeMs != null) {
      for (const i of items) {
        if (lmtMs(i.last_modified_time) >= stopBeforeMs) out.push(i);
        else stop = true;
      }
    } else {
      out.push(...items);
    }
    ctx.fetched += items.length;
    if (ctx.prog) { ctx.prog.pages = ctx.pages; ctx.prog.fetched = ctx.fetched; }
    if (stop || !d.page_context?.has_more_page) break;
  }
  return out;
}

function _dedupe(records, idField) {
  const m = new Map();
  let dup = 0;
  for (const r of records) {
    const id = r[idField];
    if (!id) continue;
    if (m.has(id)) dup++;
    m.set(id, r);
  }
  return { map: m, duplicates: dup };
}

// Record changed if Zoho's last_modified_time moved (or, without one, any field differs).
// custom_field_hash (contacts) catches custom-field edits that leave last_modified_time as is.
function _changed(a, b) {
  if (a.last_modified_time || b.last_modified_time) {
    if (a.last_modified_time !== b.last_modified_time) return true;
    if (JSON.stringify(a.custom_field_hash) !== JSON.stringify(b.custom_field_hash)) return true;
    return a.status !== b.status || a.balance !== b.balance;
  }
  return JSON.stringify(a) !== JSON.stringify(b);
}

function _maxLmt(records) {
  let m = 0;
  for (const r of records) { const t = lmtMs(r.last_modified_time); if (t > m) m = t; }
  return m;
}

// Zoho's own date-driven transitions, which do not bump last_modified_time
function _applyStatusRoll(records, kind, today) {
  let rolled = 0;
  for (const r of records) {
    if (!r.due_date || r.due_date >= today) continue;
    if (kind === 'invoice' && r.status === 'sent' && (r.balance || 0) > 0) { r.status = 'overdue'; rolled++; }
    if (kind === 'bill'    && r.status === 'open') { r.status = 'overdue'; rolled++; }
  }
  return rolled;
}

// ── List entity sync ──────────────────────────────────────────────────────────
async function _syncListEntity(key, def, mode, run, ctx) {
  const d      = run.dates;
  const idF    = def.idField;
  const member = def.member || (() => true);
  const win    = def.window ? def.window(d) : null;
  const prev   = await readSyncedData(key);
  const prevUniverse = prev ? [...(prev.data || []), ...(prev.future || [])] : [];
  const inWin  = r => !win || (r.date && r.date >= win.from);

  let strategy;
  if (!def.incremental || mode === 'full' || mode === 'full_refresh') strategy = 'full';
  else if (!prev || prev.engine_v !== ENGINE_VERSION) strategy = 'full';           // first run on this engine
  else if (win && !def.rolling && prev.window_from !== win.from) strategy = 'full'; // FY rolled over
  else if (mode === 'recheck') strategy = win ? 'recheck' : 'full';
  else strategy = 'incremental';

  const stats = { checked: 0, added: 0, updated: 0, removed: 0, unchanged: 0, failed: 0, duplicates: 0, status_rolled: 0 };
  let universe;           // Map id → record (includes future-dated)
  let validation = null;

  if (strategy === 'full') {
    const sortP = win ? { sort_column: 'date', sort_order: 'D' } : {};
    const fetched = await _pageAll(def, { ...def.params, ...sortP }, ctx, { dateFrom: win?.from });
    const { map, duplicates } = _dedupe(fetched.filter(member), idF);
    stats.checked = fetched.length;
    stats.duplicates = duplicates;
    const prevMap = new Map(prevUniverse.map(r => [r[idF], r]));
    for (const [id, r] of map) {
      const p = prevMap.get(id);
      if (!p) stats.added++;
      else if (_changed(p, r)) stats.updated++;
      else stats.unchanged++;
    }
    for (const id of prevMap.keys()) if (!map.has(id)) stats.removed++;
    universe = map;
    const cachedBefore = (prev?.data || []).length;
    const zohoNow = [...map.values()].filter(r => !win || !r.date || r.date <= win.to).length;
    validation = {
      zoho_count: zohoNow, cached_before: cachedBefore, difference: zohoNow - cachedBefore,
      missing_in_cache: stats.added, changed: stats.updated, removed_from_zoho: stats.removed,
      duplicates_from_zoho: duplicates,
    };
  } else {
    universe = new Map(prevUniverse.map(r => [r[idF], r]));
    const hwm = prev.hwm || _maxLmt(prevUniverse);
    const since = hwm ? hwm - INC_OVERLAP_MS : null;
    const changed = await _pageAll(def,
      { ...(def.incParams || def.params), sort_column: 'last_modified_time', sort_order: 'D' },
      ctx, { stopBeforeMs: since });
    stats.checked += changed.length;
    for (const r of changed) {
      const id = r[idF];
      if (!id) continue;
      const p = universe.get(id);
      if (member(r) && inWin(r)) {
        if (!p) stats.added++;
        else if (_changed(p, r)) stats.updated++;
        universe.set(id, r);
      } else if (p) {
        universe.delete(id); stats.removed++;
      }
    }

    // Recheck: reconcile IDs over the recent window — finds records missed or deleted in Zoho
    if (strategy === 'recheck') {
      const rf = win.from > d.recheckStart ? win.from : d.recheckStart;
      const fetched = await _pageAll(def,
        { ...(def.incParams || def.params), sort_column: 'date', sort_order: 'D' }, ctx, { dateFrom: rf });
      stats.checked += fetched.length;
      const seen = new Set();
      for (const r of fetched) {
        const id = r[idF];
        if (!id) continue;
        seen.add(id);
        if (!member(r)) { if (universe.delete(id)) stats.removed++; continue; }
        const p = universe.get(id);
        if (!p) stats.added++;
        else if (_changed(p, r)) stats.updated++;
        universe.set(id, r);
      }
      for (const [id, r] of [...universe]) {
        if (r.date && r.date >= rf && !seen.has(id)) { universe.delete(id); stats.removed++; }
      }
    }

    // Rolling window: prune records that fell out of the date range
    if (win) for (const [id, r] of [...universe]) if (!inWin(r)) { universe.delete(id); stats.removed++; }
  }

  let all = [...universe.values()];
  if (def.statusRoll && strategy !== 'full') stats.status_rolled = _applyStatusRoll(all, def.statusRoll, d.today);
  if (def.sortKey) all.sort((a, b) => String(a[def.sortKey] || '').localeCompare(String(b[def.sortKey] || '')));
  else all.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const data   = win ? all.filter(r => !r.date || r.date <= win.to) : all;
  const future = win ? all.filter(r => r.date && r.date > win.to) : [];
  if (strategy !== 'full') stats.unchanged = Math.max(0, data.length - stats.added - stats.updated);

  const hwm = _maxLmt(all);
  await _writeSyncedData(key, data, run.runId, {
    future, hwm, window_from: win?.from || null, window_to: win?.to || null, strategy,
  });
  return { record_count: data.length, strategy, stats, validation };
}

// ── Error classification ──────────────────────────────────────────────────────
function _classifyError(err) {
  if (err.errType) return err.errType;
  const msg = err.message || '';
  const st  = err.response?.status;
  if (msg.startsWith('ZOHO_DAILY_LIMIT')) return 'daily_limit';
  if (st === 429) return 'rate_limit';
  if (st === 401) return 'auth';
  if (st) return `http_${st}`;
  if (['ECONNABORTED', 'ETIMEDOUT'].includes(err.code) || /timeout/i.test(msg)) return 'timeout';
  if (['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(err.code)) return 'network';
  return 'unknown';
}

// ── Core: run one entity inside a run ─────────────────────────────────────────
async function _runEntity(key, mode, run) {
  const def  = ENTITY_DEFS[key];
  const prog = run.progress.entities[key];
  if (_locks.has(key)) {
    prog.state = 'skipped';
    return { entity: key, status: 'skipped' };
  }
  _locks.add(key);
  const t0 = Date.now();
  prog.state = 'running';
  prog.started_at = new Date().toISOString();
  run.progress.current = key;
  await _updateCheckpoint(key, { label: def.label, status: 'in_progress', last_attempt_at: prog.started_at });

  let retryStatus = null;
  try {
    for (let attempt = 0; ; attempt++) {
      const ctx = { pages: 0, fetched: 0, prog };
      try {
        const r = def.run
          ? await def.run({
              mode, trigger: run.trigger, runId: run.runId, dates: run.dates, ctx,
              readSyncedData, isInitial: run.initialKeys.has(key),
            })
          : await _syncListEntity(key, def, mode, run, ctx);
        const dur   = Date.now() - t0;
        const stats = { checked: 0, added: 0, updated: 0, removed: 0, unchanged: 0, failed: 0, ...(r.stats || {}) };
        if (attempt > 0) retryStatus = `recovered after ${attempt} retry`;
        await _updateCheckpoint(key, {
          status:         'success',
          last_synced_at: new Date().toISOString(),
          record_count:   r.record_count,
          duration_ms:    dur,
          last_sync_type: mode,
          last_trigger:   run.trigger,
          last_strategy:  r.strategy || mode,
          last_stats:     stats,
          pages:          ctx.pages,
          error_detail:   null,
          error:          null,
        });
        Object.assign(prog, { state: 'completed', record_count: r.record_count, ...stats, duration_ms: dur });
        console.log(`[sync] ${key} OK (${r.strategy || mode}) — ${r.record_count} records, +${stats.added} ~${stats.updated} -${stats.removed} in ${dur}ms`);
        return {
          entity: key, status: 'success', record_count: r.record_count, duration_ms: dur,
          strategy: r.strategy || mode, ...stats, retry_status: retryStatus,
          validation: r.validation || null, extra: r.extra || null,
        };
      } catch (err) {
        const type = _classifyError(err);
        // One automatic retry for transient network faults; rate/daily limits are not retried
        if (attempt === 0 && (type === 'network' || type === 'timeout')) {
          retryStatus = 'auto-retried once';
          console.warn(`[sync] ${key} ${type} error — retrying in 5s`);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        const dur = Date.now() - t0;
        const error = {
          entity:          key,
          endpoint:        def.path || '(custom)',
          error_type:      type,
          message:         err.response?.data?.message || err.message,
          http_status:     err.response?.status || null,
          timestamp:       new Date().toISOString(),
          pages_completed: ctx.pages,
          records_fetched: ctx.fetched,
          retry_status:    retryStatus ? `${retryStatus}, failed again` : 'not retried',
          mode,
          run_id:          run.runId,
        };
        // Previous cache (data, record_count, last_synced_at) is deliberately left in place
        await _updateCheckpoint(key, {
          status:       'failed',
          duration_ms:  dur,
          last_sync_type: mode,
          last_trigger: run.trigger,
          error_detail: `${type}: ${error.message}`,
          error,
        });
        Object.assign(prog, { state: 'failed', error: error.message, error_type: type, duration_ms: dur });
        console.error(`[sync] ${key} FAILED (${type}):`, error.message);
        return { entity: key, status: 'failed', error: error.message, error_type: type, duration_ms: dur, error_info: error, failed: 1 };
      }
    }
  } finally {
    _locks.delete(key);
  }
}

function _orderedKeys(keys) {
  const all = Object.keys(ENTITY_DEFS);
  return [...keys].sort((a, b) => (ENTITY_DEFS[a].stage - ENTITY_DEFS[b].stage) || (all.indexOf(a) - all.indexOf(b)));
}

function _withDependents(key) {
  const out = new Set([key]);
  const walk = k => (ENTITY_DEFS[k]?.dependents || []).forEach(dk => {
    if (ENTITY_DEFS[dk] && !out.has(dk)) { out.add(dk); walk(dk); }
  });
  walk(key);
  return _orderedKeys(out);
}

// ── Full Data Refresh: cross-entity key totals ────────────────────────────────
async function _keyTotals() {
  const [vend, open, over] = await Promise.all(['vendors_all', 'bills_open', 'bills_overdue'].map(readSyncedData));
  if (!vend || !open || !over) return null;
  const vendorPayable = vend.data.reduce((s, v) => s + (v.outstanding_payable_amount || 0), 0);
  const seen = new Set();
  let billBalance = 0;
  for (const b of [...open.data, ...over.data]) {
    if (seen.has(b.bill_id)) continue;
    seen.add(b.bill_id);
    billBalance += (b.balance || 0) * (b.exchange_rate || 1);
  }
  const diff = Math.round(vendorPayable - billBalance);
  return [{
    check: 'Payables: Σ vendor outstanding (Vendors — All) vs Σ open+overdue bill balances',
    zoho_total: Math.round(vendorPayable), cached_total: Math.round(billBalance), difference: diff,
    status: Math.abs(diff) <= 1 ? 'match' : 'review',
    note: 'A difference usually means partially-paid / non-open bills or opening balances not in Open/Overdue.',
  }];
}

// ── Core: one sync run (all entities, or a subset) ────────────────────────────
// opts: { mode, trigger, entities?: [keys], initialKeys?: [keys] }
async function syncRun(opts = {}) {
  if (!_zohoGet) throw new Error('Sync engine not initialised — call init(zohoGetAll) first');
  const mode    = MODES[opts.mode] ? opts.mode : 'normal';
  const trigger = opts.trigger || 'manual';
  if (_activeRun) {
    console.log(`[sync] ${trigger} ${mode} run requested while ${_activeRun.runId} is running — skipped`);
    return { status: 'busy', run_id: _activeRun.runId };
  }
  const runId = opts.runId || `run_${Date.now()}`;
  _activeRun = { runId };   // reserve synchronously so concurrent callers see 'busy'
  const shared = await _sharedRunning();   // Neon: a run on another Vercel instance
  if (shared && shared.run_id !== runId) {
    _activeRun = null;
    console.log(`[sync] ${trigger} ${mode} run requested while ${shared.run_id} is running elsewhere — skipped`);
    return { status: 'busy', run_id: shared.run_id };
  }
  const started = new Date().toISOString();
  let run;
  try {
    const keys = _orderedKeys((opts.entities && opts.entities.length) ? opts.entities.filter(k => ENTITY_DEFS[k]) : Object.keys(ENTITY_DEFS));
    // Entities with no cache yet get a complete initial sync regardless of mode
    const cps = await _readCheckpoints();
    const initialKeys = new Set([...(opts.initialKeys || []), ...keys.filter(k => !cps[k]?.last_synced_at)]);
    run = {
      runId, mode, trigger, dates: getCurrentDates(), initialKeys, keys,
      progress: {
        run_id: runId, mode, mode_label: MODES[mode], trigger, status: 'running',
        started_at: started, completed_at: null, current: null,
        entities: Object.fromEntries(keys.map(k => [k, { label: ENTITY_DEFS[k].label, stage: ENTITY_DEFS[k].stage, state: 'pending' }])),
      },
    };
  } catch (e) {
    _activeRun = null;
    throw e;
  }
  const keys = run.keys;
  const initialKeys = run.initialKeys;
  _activeRun = run;
  _progress  = run.progress;
  _publishProgress(run.progress);
  console.log(`[sync] Starting ${trigger} ${mode} run — ${runId} (${keys.length} entities)`);

  const results = {};
  let entry;
  try {
    for (const key of keys) {
      const effMode = initialKeys.has(key) && mode === 'normal' ? 'full' : mode;
      results[key] = await _runEntity(key, effMode, run);
      _publishProgress(run.progress);
    }

    const rs = Object.values(results);
    const sum = f => rs.reduce((s, r) => s + (r?.[f] || 0), 0);
    const failedCount = rs.filter(r => r?.status === 'failed').length;
    const status = failedCount === 0 ? 'success' : failedCount < rs.length ? 'partial' : 'failed';

    let validation = null;
    if (mode === 'full_refresh') {
      validation = {
        entities: Object.fromEntries(rs.filter(r => r.validation).map(r => [r.entity, r.validation])),
        key_totals: await _keyTotals().catch(e => [{ check: 'key totals', status: 'error', note: e.message }]),
        msme: results.vendor_msme_master?.extra || null,
      };
    }

    entry = {
      run_id:             runId,
      trigger,
      mode,
      mode_label:         MODES[mode],
      started_at:         started,
      completed_at:       new Date().toISOString(),
      duration_ms:        Date.now() - new Date(started).getTime(),
      status,
      entities_processed: rs.length,
      total_records:      sum('record_count'),
      records_checked:    sum('checked'),
      added:              sum('added'),
      updated:            sum('updated'),
      removed:            sum('removed'),
      unchanged:          sum('unchanged'),
      failed_count:       failedCount,
      errors:             rs.filter(r => r.status === 'failed').map(r => r.error_info),
      entities:           results,
      validation,
    };
    await _appendRunLog(entry);
    console.log(`[sync] ${trigger} ${mode} run complete — ${status}, ${entry.total_records} records, +${entry.added} ~${entry.updated} -${entry.removed}`);
    Object.assign(run.progress, {
      status, completed_at: entry.completed_at, current: null,
      summary: {
        entities_processed: entry.entities_processed, records_checked: entry.records_checked,
        added: entry.added, updated: entry.updated, removed: entry.removed, unchanged: entry.unchanged,
        failed: failedCount, duration_ms: entry.duration_ms,
      },
    });
    _publishProgress(run.progress);
  } catch (e) {
    Object.assign(run.progress, { status: 'failed', completed_at: new Date().toISOString(), error: e.message });
    _publishProgress(run.progress);
    throw e;
  } finally {
    _activeRun = null;
  }

  // Post-sync hooks after whole-system runs — failures never fail the run
  if (trigger !== 'entity' && trigger !== 'retry') {
    for (const hook of _postSyncHooks) {
      try { await hook(entry); } catch (e) { console.error('[sync] post-sync hook error:', e.message); }
    }
  }
  return entry;
}

// Starts a run without waiting for it (UI polls getProgress). Returns { run_id } or { status: 'busy' }.
function startRun(opts = {}) {
  if (_activeRun) return { status: 'busy', run_id: _activeRun.runId };
  const runId = `run_${Date.now()}`;
  background(syncRun({ ...opts, runId })
    .then(entry => { if (entry && opts.onComplete) opts.onComplete(entry); })
    .catch(e => console.error('[sync] background run error:', e.message)));
  return { status: 'started', run_id: runId };
}

// ── Back-compat wrappers ──────────────────────────────────────────────────────
// syncEntity: one entity + its dependents (e.g. vendors_all → vendor_msme_master)
async function syncEntity(entityKey, opts = {}) {
  if (!ENTITY_DEFS[entityKey]) throw new Error(`Unknown sync entity: ${entityKey}`);
  return syncRun({ mode: opts.mode || 'normal', trigger: opts.trigger || 'entity', entities: _withDependents(entityKey) });
}

// syncAll: legacy callers — { trigger: 'full_resync' } / { force: true } map to Full Sync Data
async function syncAll(opts = {}) {
  const mode = opts.mode || ((opts.trigger === 'full_resync' || opts.force) ? 'full' : 'normal');
  const trigger = opts.trigger === 'full_resync' ? 'manual' : (opts.trigger || 'manual');
  return syncRun({ mode, trigger });
}

// Background retry of a failed entity in the mode it failed in (UI polls getProgress)
async function _retryMode(entityKey) {
  const cp = (await _readCheckpoints())[entityKey] || {};
  return cp.error?.mode || 'normal';
}

function startRetry(entityKey, onComplete) {
  if (_activeRun) return { status: 'busy', run_id: _activeRun.runId };
  const runId = `run_${Date.now()}`;
  _activeRun = { runId };
  background(_retryMode(entityKey)
    .then(mode => { _activeRun = null; return syncRun({ mode, trigger: 'retry', entities: _withDependents(entityKey), runId, onComplete }); })
    .then(entry => { if (entry && entry.run_id && onComplete) onComplete(entry); })
    .catch(e => { _activeRun = null; console.error('[sync] retry error:', e.message); }));
  return { status: 'started', run_id: runId };
}

async function retryEntity(entityKey) {
  if (!ENTITY_DEFS[entityKey]) throw new Error(`Unknown sync entity: ${entityKey}`);
  const cp = (await _readCheckpoints())[entityKey] || {};
  const mode = cp.error?.mode || 'normal';
  return syncRun({ mode, trigger: 'retry', entities: _withDependents(entityKey) });
}

// ── Public: get synced data with live Zoho fallback ───────────────────────────
// Returns { data: [...], source: 'sync'|'live', synced_at: ISO|null }
async function getSyncedOrFetch(entityKey, zohoFallbackFn, maxAgeHours) {
  try {
    const cached = await readSyncedData(entityKey);
    if (cached && isFresh(cached.synced_at, maxAgeHours)) {
      return { data: cached.data, source: 'sync', synced_at: cached.synced_at };
    }
  } catch (e) {
    console.warn(`[sync] getSyncedOrFetch(${entityKey}) cache read error:`, e.message);
  }
  const data = await zohoFallbackFn();
  return { data, source: 'live', synced_at: null };
}

// ── Filter helpers for endpoint code ─────────────────────────────────────────
function filterByDateRange(records, dateField, from, to) {
  return records.filter(r => {
    const d = r[dateField];
    return d && (!from || d >= from) && (!to || d <= to);
  });
}

// ── Status: get sync state for all entities + run log ─────────────────────────
async function getSyncStatus() {
  const [checkpoints, log] = await Promise.all([_readCheckpoints(), _readRunLog()]);
  const entities = {};
  for (const key of _orderedKeys(Object.keys(ENTITY_DEFS))) {
    const def = ENTITY_DEFS[key];
    entities[key] = {
      ...(checkpoints[key] || { status: 'never_synced' }),
      label:       def.label,
      stage:       def.stage,
      kind:        def.kind,
      source:      def.path || null,
      description: def.description || '',
      dependents:  def.dependents || [],
      locked:      _locks.has(key),
    };
  }
  const systemRun = log.find(r => r.trigger !== 'entity' && r.trigger !== 'retry') || null;
  const lastValidation = log.find(r => r.mode === 'full_refresh' && r.validation) || null;
  return {
    entities,
    last_run:        log[0] || null,
    last_system_run: systemRun,
    last_validation: lastValidation && { run_id: lastValidation.run_id, completed_at: lastValidation.completed_at, ...lastValidation.validation },
    run_log:         log.slice(0, 20),
    stale_hours:     STALE_HOURS,
    modes:           MODES,
    running:         !!_activeRun,
    progress:        _progress,
  };
}

function getProgress() {
  return { running: !!_activeRun, progress: _progress };
}

// Sync Monitor: this instance's run, else (Neon) the shared record from whichever instance runs it
async function getSharedProgress() {
  if (_activeRun || !db.USE_DB) return getProgress();
  const p = await db.readJSON(SHARED_PROGRESS_KEY, null, null).catch(() => null);
  if (!p) return getProgress();
  const live = p.status === 'running' && Date.now() - new Date(p.heartbeat_at).getTime() < SHARED_STALE_MS;
  if (p.status === 'running' && !live) p.status = 'interrupted';
  return { running: live, progress: p };
}

// Lightweight freshness map for dashboards ("Data as of …")
async function getFreshness() {
  const cp = await _readCheckpoints();
  const out = {};
  for (const [key, def] of Object.entries(ENTITY_DEFS)) {
    out[key] = { label: def.label, last_synced_at: cp[key]?.last_synced_at || null, status: cp[key]?.status || 'never_synced' };
  }
  return { entities: out, stale_hours: STALE_HOURS };
}

// ── IST Scheduler (4×/day) ────────────────────────────────────────────────────
// Fires at 13:00, 15:00, 18:00, 21:00 IST without any external library.
function _scheduleIST(hourIST, minuteIST) {
  const IST_OFFSET_MS = (5 * 60 + 30) * 60000;

  // The shifted Date's UTC fields read as IST wall-clock time, so this is correct whatever
  // the server's own time zone is. (The previous version used setHours() — local time — which
  // on an IST machine applied the offset twice and fired 5½ h early: 7:30 AM instead of 1 PM.)
  function msUntilNext() {
    const nowUTC  = Date.now();
    const nowIST  = new Date(nowUTC + IST_OFFSET_MS);
    const nextIST = new Date(nowIST);
    nextIST.setUTCHours(hourIST, minuteIST, 0, 0);
    if (nextIST <= nowIST) nextIST.setUTCDate(nextIST.getUTCDate() + 1);
    return nextIST.getTime() - IST_OFFSET_MS - nowUTC;
  }

  function schedule() {
    const ms = msUntilNext();
    const inMin = Math.round(ms / 60000);
    console.log(`[sync] ${hourIST}:${String(minuteIST).padStart(2, '0')} IST sync scheduled in ${inMin}m`);
    setTimeout(async () => {
      await runScheduledTick();
      schedule();
    }, ms);
  }

  schedule();
}

// One scheduled tick: normal incremental Sync Data (main org only)
// POCM NT org has its own dedicated 11PM IST scheduler in pocm-sync.js — not here.
async function runScheduledTick() {
  try {
    await syncRun({ mode: 'normal', trigger: 'scheduled' });
  } catch (e) {
    console.error('[sync] scheduled run error:', e.message);
  }
}

// Optional POCM sync module — registered by index.js after initialisation.
// When set, POCM sync runs on every scheduled tick after the main sync.
let _pocmSync = null;
function registerPocmSync(pocmSyncModule) { _pocmSync = pocmSyncModule; }

// Hooks run after every whole-system run (scheduled, manual, full).
const _postSyncHooks = [];
function registerPostSyncHook(fn) { _postSyncHooks.push(fn); }

let _schedulerStarted = false;
function startScheduler() {
  if (_schedulerStarted) return; // never create duplicate timers
  _schedulerStarted = true;
  [13, 15, 18, 21].forEach(h => _scheduleIST(h, 0));
  console.log('[sync] Scheduler active — 1 PM, 3 PM, 6 PM, 9 PM IST (main + POCM NT)');
}

// First start after new entities are introduced: complete initial sync of any entity that
// has never been synced (e.g. Vendors — All → Vendor MSME Master), without waiting for 1 PM.
async function ensureInitialSync() {
  const cp = await _readCheckpoints();
  const missing = Object.keys(ENTITY_DEFS).filter(k => !cp[k]?.last_synced_at);
  if (!missing.length) return null;
  const withDeps = _orderedKeys(new Set(missing.flatMap(_withDependents)));
  console.log(`[sync] Initial sync for never-synced entities: ${withDeps.join(', ')}`);
  return syncRun({ mode: 'full', trigger: 'initial', entities: withDeps, initialKeys: withDeps });
}

module.exports = {
  init,
  registerEntity,
  syncRun,
  startRun,
  syncEntity,
  syncAll,
  retryEntity,
  startRetry,
  withDependents: _withDependents,
  ensureInitialSync,
  runScheduledTick,
  getSyncedOrFetch,
  getSyncStatus,
  getProgress,
  getSharedProgress,
  sharedRunning: _sharedRunning,
  getFreshness,
  readSyncedData,
  filterByDateRange,
  getCurrentDates,
  startScheduler,
  registerPocmSync,
  registerPostSyncHook,
  isFresh,
  lmtMs,
  ENTITY_DEFS,
  MODES,
  STALE_HOURS,
};
