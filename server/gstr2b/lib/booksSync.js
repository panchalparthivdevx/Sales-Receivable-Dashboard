/**
 * Zoho Books → GSTR-2B Reco sync (read-only).
 *
 * Modes
 *   period       initial / selectable history: lists every document posted in [from, to] month by month, then fetches the
 *                detail of each in-scope one (the list has no GST amounts). Safe to repeat: upserts are idempotent.
 *   incremental  change feed: documents modified since the last high-water mark (15-minute safety margin), then details.
 *   recheck      re-lists the window and removes what Zoho no longer has (a deleted document never shows up in a
 *                "modified since" list, so only an ID comparison finds it — each candidate is confirmed by a GET first).
 *
 * Resumable by design: the detail queue IS the stored documents that still say detail_pending, so an interrupted run
 * (crash, rate limit, Vercel time limit, daily budget) simply continues where it stopped on the next run.
 * Zoho calls are counted against a per-day budget for this module and paced (see config sync.*).
 */

'use strict';

const store = require('./store');
const books = require('./booksStore');
const C = require('./canonBooks');
const N = require('./normalize');
const { ZohoLimit } = require('./zohoRead');
const { uid, nowIso, sleep } = require('./util');

const KINDS = {
  bill:          { path: '/bills',         key: 'bills',          detail: id => `/bills/${id}`,         dkey: 'bill',          label: 'bills' },
  vendor_credit: { path: '/vendorcredits', key: 'vendor_credits', detail: id => `/vendorcredits/${id}`, dkey: 'vendor_credit', label: 'vendor credits' },
  expense:       { path: '/expenses',      key: 'expenses',       detail: id => `/expenses/${id}`,      dkey: 'expense',       label: 'GST-bearing expenses' },
};
const MARGIN_MS = 15 * 60000;

class Stop extends Error { constructor(kind, msg) { super(msg); this.stop = kind; } }   // budget | time | cancel

const monthsBetween = (from, to) => {                               // ["2026-11", "2026-10", …] newest first
  const out = [];
  let y = +to.slice(0, 4), m = +to.slice(5, 7);
  const fy = +from.slice(0, 4), fm = +from.slice(5, 7);
  while (y > fy || (y === fy && m >= fm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); if (--m === 0) { m = 12; y--; } }
  return out;
};
const lastDay = ym => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)); return `${ym}-${String(d.getUTCDate()).padStart(2, '0')}`; };

/** What a list row changes on a stored document: a void applies at once; an edit marks the old details stale */
function mergeList(old, light) {
  if (!old) return light;
  if (light.excluded && light.excluded !== 'recipient_unmapped') {
    return { ...old, status: light.status, excluded: light.excluded, excluded_text: light.excluded_text, detail_pending: false, stale: false, hash: light.hash, source: { ...old.source, lmt: light.source.lmt, list_at: light.source.list_at } };
  }
  const changed = (old.source.lmt || '') !== (light.source.lmt || '');
  if (old.amounts && !changed && !old.excluded) return { ...old, status: light.status, source: { ...old.source, list_at: light.source.list_at } };
  if (old.amounts) return { ...old, status: light.status, detail_pending: true, stale: true, source: { ...old.source, lmt_listed: light.source.lmt, list_at: light.source.list_at } };
  return { ...light, detail_fail: old.detail_fail || 0 };
}

function create({ zr, cfgNow, readSynced = async () => null, audit = { log: async () => {} }, log = console, sleepFn = sleep }) {
  const running = new Map();                                        // company id → { run_id, cancel, started_at }
  const stateKey = co => `sync_${co}`;
  const EMPTY = () => ({ branches: {}, branches_at: null, hwm: {}, windows: {}, budget: { day: '', used: 0 }, runs: [], last_ok_at: null, last_error: null });
  const loadState = async co => ({ ...EMPTY(), ...((await store.read(stateKey(co), null)) || {}) });
  const saveState = (co, st) => store.write(stateKey(co), st);

  async function buildCtx(co, st, before) {
    const list = await zr.listBranches(co.org_id);
    st.branches = Object.fromEntries(list.map(b => [b.id, b])); st.branches_at = nowIso();
    const vendors = new Map();
    try { const v = await readSynced(co.id, 'vendors_all'); for (const x of (v && v.data) || []) vendors.set(String(x.contact_id), { gstin: x.gst_no, pan: x.pan_no, name: x.contact_name }); } catch (_) { /* optional enrichment */ }
    return { company: co, branches: new Map(list.map(b => [b.id, { name: b.name, gstin: b.gstin, state: b.state_code }])), vendors };
  }

  /** The Zoho call options for one run: pacing, per-day budget, time slice and cancel, checked between calls */
  function guard(co, st, cfg, run, deadline) {
    return {
      paceMs: cfg.sync.pace_ms,
      before: () => {
        const today = N.todayIST();
        if (st.budget.day !== today) st.budget = { day: today, used: 0 };
        if (run.cancel) throw new Stop('cancel', 'Stopped by a user');
        if (Date.now() > deadline) throw new Stop('time', 'This slice used its time; the run continues next time');
        if (st.budget.used >= cfg.sync.daily_budget) throw new Stop('budget', `The daily Zoho call budget for this module (${cfg.sync.daily_budget}) is used up — it continues tomorrow, or raise the budget in Settings`);
        st.budget.used++;
      },
    };
  }

  async function listWindow(co, ctx, kind, month, g, summary, { recheck = false } = {}) {
    const K = KINDS[kind];
    const ids = new Set();
    let rows = 0, kept = 0;
    await zr.list(co.org_id, K.path, K.key, { date_start: `${month}-01`, date_end: lastDay(month), sort_column: 'date', sort_order: 'A' }, {
      ...g, onPage: async page => {
        const docs = [];
        for (const r of page) {
          rows++; ids.add(String(r.bill_id || r.vendor_credit_id || r.expense_id));
          if (kind === 'expense' && C.listExclusion(r, ctx, kind)) continue;          // only GST-bearing expenses are kept
          docs.push(C.fromList(r, ctx, kind)); kept++;
        }
        const s = await books.upsertMany(co.id, docs, mergeList);
        summary.lists[kind].added += s.added; summary.lists[kind].changed += s.changed;
      },
    });
    summary.lists[kind].rows += rows;
    if (recheck) await removeMissing(co, ctx, kind, month, ids, g, summary);
    return { rows, kept };
  }

  /** Documents we hold for `month` that the list no longer returns: confirm each by a GET, then mark deleted */
  async function removeMissing(co, ctx, kind, month, listed, g, summary) {
    const local = (await books.all(co.id, { fromYm: month, toYm: month })).filter(d => d.kind === kind && !d.deleted && !listed.has(d.zoho_id));
    if (!local.length) return;
    if (local.length > 300) { summary.warnings.push(`${local.length} ${KINDS[kind].label} of ${month} are missing from Zoho's list — more than 300, so nothing was removed (the list looks incomplete).`); return; }
    const K = KINDS[kind], gone = [];
    for (const d of local) {
      try { await zr.get(co.org_id, K.detail(d.zoho_id), {}, g); summary.warnings.push(`${d.kind} ${d.doc_no || d.zoho_id} was not in Zoho's list for ${month} but still exists — kept.`); }
      catch (e) { if (zr.isGone(e)) gone.push({ ...d, deleted: true, deleted_at: nowIso(), excluded: 'deleted', excluded_text: C.EXCLUSIONS.deleted, detail_pending: false, stale: false, hash: `deleted:${d.id}` }); else throw e; }
    }
    if (gone.length) { await books.upsertMany(co.id, gone); summary.details.deleted += gone.length; }
  }

  /** Documents modified since the high-water mark, newest first, until older than the mark (minus the margin) */
  async function feed(co, ctx, kind, st, g, summary, runStart) {
    const hwm = st.hwm[kind];
    if (!hwm) { summary.warnings.push(`No initial sync yet for ${KINDS[kind].label} — run "Sync a period" first.`); return false; }
    const cutoff = Date.parse(hwm) - MARGIN_MS;
    const K = KINDS[kind];
    await zr.list(co.org_id, K.path, K.key, { sort_column: 'last_modified_time', sort_order: 'D' }, {
      ...g, maxPages: 60, onPage: async page => {
        const docs = [];
        for (const r of page) {
          summary.lists[kind].rows++;
          if (Date.parse(r.last_modified_time) < cutoff) continue;
          if (kind === 'expense' && C.listExclusion(r, ctx, kind)) continue;
          docs.push(C.fromList(r, ctx, kind));
        }
        const s = await books.upsertMany(co.id, docs, mergeList);
        summary.lists[kind].added += s.added; summary.lists[kind].changed += s.changed;
        const oldest = page.length ? Date.parse(page[page.length - 1].last_modified_time) : 0;
        return oldest >= cutoff;                                                 // false = stop paging
      },
    });
    st.hwm[kind] = runStart;
    return true;
  }

  async function fetchDetails(co, ctx, g, summary, st) {
    const pending = (await books.pendingDetails(co.id)).filter(d => (d.detail_fail || 0) < 3);
    summary.details.queued = pending.length;
    let buf = [];
    const flush = async () => { if (!buf.length) return; const b = buf; buf = []; await books.upsertMany(co.id, b, (o, n) => n); await saveState(co.id, st); };
    try {
      for (const d of pending) {
        const K = KINDS[d.kind];
        try {
          const data = await zr.get(co.org_id, K.detail(d.zoho_id), {}, g);
          const raw = data[K.dkey];
          if (!raw) throw new Error(`Zoho returned no ${K.dkey}`);
          buf.push(C.fromDetail(raw, null, ctx, d.kind));
          summary.details.fetched++;
        } catch (e) {
          if (e instanceof Stop || e instanceof ZohoLimit) throw e;
          if (zr.isGone(e)) { buf.push({ ...d, deleted: true, deleted_at: nowIso(), excluded: 'deleted', excluded_text: C.EXCLUSIONS.deleted, detail_pending: false, stale: false, hash: `deleted:${d.id}` }); summary.details.deleted++; }
          else { summary.details.failed++; buf.push({ ...d, detail_fail: (d.detail_fail || 0) + 1, detail_error: zr.errText(e).slice(0, 200) }); log.error && log.error(`[gstr2b:${co.id}] detail ${d.kind} ${d.zoho_id}: ${zr.errText(e)}`); }
        }
        if (buf.length >= 20) await flush();
      }
    } finally { await flush(); }
  }

  /**
   * @param {object} o { company, mode: 'period'|'incremental'|'recheck', from: 'YYYY-MM', to: 'YYYY-MM', by, maxMs, kinds }
   * @returns the run summary (never throws for Zoho limits / budget / time — those end the run as "partial")
   */
  async function run(o) {
    const cfg = await cfgNow();
    const co = cfg.companies.find(c => c.id === o.company);
    if (!co) throw new Error(`Unknown company "${o.company}"`);
    if (co.demo) throw new Error('The demo company has no Zoho organisation — it cannot be synced');
    if (!co.active) throw new Error(`${co.name} is switched off in Settings`);
    if (running.has(co.id)) return { busy: true, message: `A sync of ${co.name} is already running`, run_id: running.get(co.id).run_id };
    const mode = o.mode || 'incremental';
    const runInfo = { run_id: uid('run_'), cancel: false, started_at: nowIso() };
    running.set(co.id, runInfo);
    const st = await loadState(co.id);
    const summary = {
      run_id: runInfo.run_id, company: co.id, mode, by: o.by || 'system', started_at: runInfo.started_at, finished_at: null, status: 'running',
      from: o.from || null, to: o.to || null,
      lists: Object.fromEntries(Object.keys(KINDS).map(k => [k, { rows: 0, added: 0, changed: 0 }])),
      details: { queued: 0, fetched: 0, failed: 0, deleted: 0 }, warnings: [], calls: 0, error: null, message: '',
    };
    const deadline = Date.now() + (o.maxMs || cfg.sync.slice_seconds * 1000);
    if (st.budget.day !== N.todayIST()) st.budget = { day: N.todayIST(), used: 0 };      // new IST day → fresh budget
    const startCalls = st.budget.used;
    const g = guard(co, st, cfg, runInfo, deadline);
    const kinds = o.kinds || Object.keys(KINDS);
    try {
      const ctx = await buildCtx(co, st, g.before);
      st.budget.used += 1;                                                      // the branches call
      if (mode === 'period' || mode === 'recheck') {
        const today = N.todayIST();
        const from = o.from || `${N.fyStart(today) - 1}-04`, to = o.to || today.slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || from > to) throw new Error('Choose a period like 2025-04 to 2026-11');
        summary.from = from; summary.to = to;
        for (const month of monthsBetween(from, to)) {
          for (const kind of kinds) {
            if (kind === 'vendor_credit') continue;                               // credits are few: one full list below, not per month
            const r = await listWindow(co, ctx, kind, month, g, summary, { recheck: mode === 'recheck' });
            st.windows[`${kind}:${month}`] = { at: nowIso(), rows: r.rows, kept: r.kept };
          }
          await saveState(co.id, st);
        }
        if (kinds.includes('vendor_credit')) await listAllCredits(co, ctx, g, summary, mode === 'recheck');
        // The change feed starts from the first full listing; a later period run never moves it (changes in between stay covered)
        for (const kind of kinds) if (!st.hwm[kind]) st.hwm[kind] = runInfo.started_at;
      } else {
        for (const kind of kinds) await feed(co, ctx, kind, st, g, summary, runInfo.started_at);
      }
      await fetchDetails(co, ctx, g, summary, st);
      summary.status = 'completed';
      st.last_ok_at = nowIso(); st.last_error = null;
    } catch (e) {
      if (e instanceof Stop) { summary.status = e.stop === 'cancel' ? 'cancelled' : e.stop === 'budget' ? 'paused_budget' : 'partial'; summary.message = e.message; }
      else if (e instanceof ZohoLimit) { summary.status = 'paused_limit'; summary.message = e.message; }
      else { summary.status = 'failed'; summary.error = zr.errText(e); st.last_error = { at: nowIso(), message: summary.error }; log.error && log.error(`[gstr2b:${co.id}] sync failed: ${summary.error}`); }
    } finally {
      summary.finished_at = nowIso();
      summary.calls = Math.max(0, st.budget.used - startCalls);
      st.runs = [summary, ...st.runs].slice(0, 30);
      try { await saveState(co.id, st); } catch (e) { log.error && log.error(`[gstr2b:${co.id}] could not save sync state: ${e.message}`); }
      running.delete(co.id);
    }
    await audit.log({ by: summary.by, action: `sync.${mode}`, company: co.id, detail: `${summary.status}: ${summary.details.fetched} detail(s), ${Object.values(summary.lists).reduce((a, l) => a + l.added + l.changed, 0)} list change(s), ${summary.calls} Zoho call(s)${summary.message ? ` — ${summary.message}` : ''}` });
    return summary;
  }

  async function listAllCredits(co, ctx, g, summary, recheck) {
    const ids = new Set();
    await zr.list(co.org_id, KINDS.vendor_credit.path, KINDS.vendor_credit.key, { sort_column: 'date', sort_order: 'A' }, {
      ...g, onPage: async page => {
        const docs = page.map(r => { summary.lists.vendor_credit.rows++; ids.add(String(r.vendor_credit_id)); return C.fromList(r, ctx, 'vendor_credit'); });
        const s = await books.upsertMany(co.id, docs, mergeList);
        summary.lists.vendor_credit.added += s.added; summary.lists.vendor_credit.changed += s.changed;
      },
    });
    if (recheck) {
      const local = (await books.all(co.id)).filter(d => d.kind === 'vendor_credit' && !d.deleted && !ids.has(d.zoho_id));
      const gone = [];
      for (const d of local.slice(0, 300)) {
        try { await zr.get(co.org_id, KINDS.vendor_credit.detail(d.zoho_id), {}, g); }
        catch (e) { if (zr.isGone(e)) gone.push({ ...d, deleted: true, deleted_at: nowIso(), excluded: 'deleted', excluded_text: C.EXCLUSIONS.deleted, detail_pending: false, hash: `deleted:${d.id}` }); else throw e; }
      }
      if (gone.length) { await books.upsertMany(co.id, gone); summary.details.deleted += gone.length; }
    }
  }

  /** Re-read one document from Zoho now (the workbench "refresh from Zoho" action) */
  async function refreshOne(companyId, docId, by = 'user') {
    const cfg = await cfgNow();
    const co = cfg.companies.find(c => c.id === companyId);
    if (!co || co.demo) throw new Error('This company cannot be refreshed from Zoho');
    const doc = await books.get(co.id, docId);
    if (!doc) throw new Error('Document not found');
    const st = await loadState(co.id);
    const ctx = await buildCtx(co, st, null);
    const K = KINDS[doc.kind];
    let full;
    try { full = C.fromDetail((await zr.get(co.org_id, K.detail(doc.zoho_id), {}, { paceMs: 300 }))[K.dkey], null, ctx, doc.kind); }
    catch (e) {
      if (!zr.isGone(e)) throw e;
      full = { ...doc, deleted: true, deleted_at: nowIso(), excluded: 'deleted', excluded_text: C.EXCLUSIONS.deleted, detail_pending: false, hash: `deleted:${doc.id}` };
    }
    await books.upsertMany(co.id, [full]);
    await saveState(co.id, st);
    await audit.log({ by, action: 'sync.refresh_one', company: co.id, ref: docId, detail: full.deleted ? 'deleted in Zoho' : 'refreshed' });
    return full;
  }

  async function status(companyId) {
    const cfg = await cfgNow();
    const co = cfg.companies.find(c => c.id === companyId);
    if (!co) throw new Error('Unknown company');
    const st = await loadState(co.id);
    const stats = await books.stats(co.id);
    const today = N.todayIST();
    const used = st.budget.day === today ? st.budget.used : 0;
    const ri = running.get(co.id);
    const fails = (await books.all(co.id)).filter(d => (d.detail_fail || 0) >= 3).length;
    return {
      company: co.id, running: !!ri, run_id: ri ? ri.run_id : null, last_ok_at: st.last_ok_at, last_error: st.last_error,
      hwm: st.hwm, runs: st.runs.slice(0, 10), stats, failing_documents: fails,
      budget: { day: today, used, limit: cfg.sync.daily_budget, remaining: Math.max(0, cfg.sync.daily_budget - used) },
      eta_days: stats.pending ? Math.ceil(stats.pending / Math.max(1, cfg.sync.daily_budget - 60)) : 0,
      branches: Object.values(st.branches || {}).length, branches_at: st.branches_at,
      windows: st.windows, credentials: zr.identity(),
    };
  }

  const cancel = companyId => { const r = running.get(companyId); if (r) { r.cancel = true; return true; } return false; };
  const isRunning = companyId => running.has(companyId);

  return { run, status, cancel, isRunning, refreshOne, loadState, KINDS };
}

module.exports = { create, mergeList, monthsBetween, KINDS };
